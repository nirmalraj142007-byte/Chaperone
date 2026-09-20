/**
 * `GET /healthz`.
 *
 * The one thing this endpoint must never imply: that an unhealthy gateway
 * is a permissive gateway. CLAUDE.md's third non-negotiable is that a
 * DynamoDB failure withholds every gated tool — so a 503 here means
 * *fewer* tools are reachable, not more, and the response body says so in
 * `gateWhenUnhealthy` rather than leaving a reader to infer it. That field
 * is a constant, present on healthy and unhealthy responses alike, because
 * the property it describes does not depend on the current check result.
 *
 * Every probe is read-only. `/healthz` is the endpoint an ALB hits every
 * few seconds for the life of the service; a health check that wrote to
 * the ledger would make the append-only evidence chain a function of how
 * long the load balancer has been running.
 *
 * `degraded` is deliberately a 200. A dead upstream is normal operation
 * for a proxy — the gateway is doing its job, and the pool's own backoff
 * will reconnect. Only storage failure, which is what the gate depends on,
 * takes the task out of rotation.
 *
 * Nothing here calls `loadConfig()`. The identity fields are passed in,
 * resolved once when the app is built, because a health endpoint that
 * re-validates the environment on every scrape can answer 500 — "this
 * process is misconfigured" — for a process that has been serving traffic
 * for an hour. Real misconfiguration still fails loudly, at startup, in
 * index.ts.
 */
import * as ledger from "@chaperone/ledger";
import type { UpstreamPool } from "@chaperone/upstream";
import { childLogger } from "@chaperone/logger";

const log = childLogger({ component: "gateway-health" });

/** Bounds a single probe, well under a typical ALB health-check timeout. */
const PROBE_TIMEOUT_MS = 2_000;

export type ComponentState = "ok" | "unreachable";

export interface ComponentCheck {
  state: ComponentState;
  /** Present only on a failure, and only the error's message — never a stack, never a credential. */
  error?: string;
  latencyMs: number;
}

export interface UpstreamCheck {
  id: string;
  state: "connecting" | "ready" | "failed";
}

/**
 * Which DynamoDB this gateway writes to. Reported because it is the single
 * fact that makes a latency measurement interpretable: DynamoDB Local is a
 * single-writer SQLite process, provisioned DynamoDB is not, and the same
 * code produces different numbers against them by an order of magnitude.
 *
 * `packages/bench` reads this from /healthz rather than inferring it from
 * its own environment — the benchmark process talks to the gateway over
 * HTTP and has no idea what storage the gateway was configured with, so
 * its own `DDB_ENDPOINT` would be a guess about somebody else's process.
 */
export type StorageBackend = "dynamodb-local" | "dynamodb-aws";

/**
 * A configured `DDB_ENDPOINT` means the SDK was pointed somewhere other
 * than the AWS regional endpoint, which in this repo is always DynamoDB
 * Local (docker-compose.yml). No endpoint means the real service.
 */
export function storageBackendFor(ddbEndpoint: string | undefined): StorageBackend {
  return ddbEndpoint === undefined ? "dynamodb-aws" : "dynamodb-local";
}

export interface HealthReport {
  status: "ok" | "degraded" | "unhealthy";
  checks: {
    dynamodb: ComponentCheck;
    upstreams: UpstreamCheck[];
    eventStore: ComponentCheck;
    /** See StorageBackend — the fact that makes a latency number interpretable. */
    storageBackend: StorageBackend;
    version: string;
    commit: string;
    /** Whole seconds this process has been running. */
    uptime: number;
  };
  /**
   * Constant. A judge reading a 503 needs to know immediately that it is
   * not a permissive state — see this module's header.
   */
  gateWhenUnhealthy: string;
}

export const GATE_WHEN_UNHEALTHY =
  "Fails closed. When DynamoDB is unreachable the gateway cannot read the pin that authorises a tool, " +
  "so every gated tool is withheld and tools/call returns a frozen refusal. Unhealthy means fewer tools " +
  "are reachable, never more; a 503 here is not a permissive state.";

async function withTimeout<T>(operation: () => Promise<T>): Promise<T> {
  return Promise.race([
    operation(),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`health probe exceeded ${PROBE_TIMEOUT_MS}ms`));
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
}

async function probe(name: string, operation: () => Promise<unknown>): Promise<ComponentCheck> {
  const startedAt = Date.now();
  try {
    await withTimeout(operation);
    return { state: "ok", latencyMs: Date.now() - startedAt };
  } catch (error) {
    // Logged at warn, not error: an unreachable dependency is a condition
    // this endpoint exists to report, not an unhandled fault.
    log.warn({ error, probe: name }, "health probe failed");
    return {
      state: "unreachable",
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * Probes the one table the gate actually reads. A `GetItem` for a key that
 * cannot exist returns nothing and costs one read unit, while still
 * proving three things a port check cannot: DynamoDB is reachable, the
 * `pin` table exists, and this process's credentials can read it. Checking
 * some other table would leave the gate's real dependency unprobed.
 */
async function probeDynamo(householdId: string): Promise<ComponentCheck> {
  return probe("dynamodb", () => ledger.getPin(householdId, "__healthz__", "__healthz__"));
}

/**
 * Probes the `sse-event` table that backs resumable SSE — the flagship
 * technical claim, and a table nothing else in this health check touches.
 * A query for a session ID that was never minted returns an empty page.
 */
async function probeEventStore(): Promise<ComponentCheck> {
  return probe("eventStore", () => ledger.listSseEventsSince("__healthz__", "__healthz__", 0));
}

export interface HealthIdentity {
  householdId: string;
  version: string;
  commit: string;
  storageBackend: StorageBackend;
}

export async function buildHealthReport(pool: UpstreamPool, identity: HealthIdentity): Promise<HealthReport> {
  const { householdId, version, commit, storageBackend } = identity;

  const [dynamodb, eventStore] = await Promise.all([probeDynamo(householdId), probeEventStore()]);
  const upstreams: UpstreamCheck[] = pool.describe().map((u) => ({ id: u.id, state: u.state }));

  // Storage decides the status code; upstreams only ever downgrade to
  // `degraded`, which is still a 200 — see this module's header.
  const storageDown = dynamodb.state !== "ok" || eventStore.state !== "ok";
  const anyUpstreamFailed = upstreams.some((u) => u.state === "failed");
  const status: HealthReport["status"] = storageDown ? "unhealthy" : anyUpstreamFailed ? "degraded" : "ok";

  return {
    status,
    checks: {
      dynamodb,
      upstreams,
      eventStore,
      storageBackend,
      version,
      commit,
      uptime: Math.floor(process.uptime()),
    },
    gateWhenUnhealthy: GATE_WHEN_UNHEALTHY,
  };
}

export function healthStatusCode(report: HealthReport): number {
  return report.status === "unhealthy" ? 503 : 200;
}
