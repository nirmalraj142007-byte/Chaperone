/**
 * Added-latency measurement: the same MCP `tools/call` driven through the
 * gateway and driven straight at the upstream, so the difference can be
 * attributed to Chaperone.
 *
 * Why the difference and not the absolute number. The absolute p95 of a
 * `tools/call` is mostly a property of demo-upstream — how fast that
 * server answers — and of the machine the bench ran on. Neither is a claim
 * about this project. Subtracting a direct-to-upstream run measured on the
 * same machine, minutes apart, cancels both and leaves the thing Chaperone
 * is actually responsible for: an Express hop, a `tools/list` refetch, a
 * DynamoDB pin read, a sha256, and a string compare.
 *
 * The call being timed is `read_list`, deliberately:
 *
 *   - it is a read, so ten thousand invocations leave no state behind and
 *     the last iteration measures the same work as the first;
 *   - it returns promptly and without a progress stream, so the number is
 *     gate-and-proxy overhead rather than a tool's own duration;
 *   - it is a *gated* tool with a real pin, so the proxied path executes
 *     the whole security mechanism. Timing an ungated first-party tool
 *     would produce a smaller, flattering, meaningless number.
 *
 * That last point has a failure mode worth naming, because it is silent
 * and it flatters: if the tool is not pinned, or its definition has
 * drifted, the gateway returns a *refusal* — which is fast, produces no
 * upstream call at all, and would show up as a suspiciously low added
 * latency rather than as an error. `assertRealResult` below rejects any
 * response carrying `isError` or a frozen refusal string, on every single
 * iteration, so that run fails loudly instead of publishing a good number
 * for the wrong reason.
 */
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  REFUSAL_TOOL_CHANGED,
  REFUSAL_TOOL_UNPINNED,
  REFUSAL_UPSTREAM_UNAVAILABLE,
} from "@chaperone/policy";
import { BenchError } from "@chaperone/errors";
import { summarise, type Summary } from "./percentiles.js";

export type Mode = "proxied" | "direct";

export interface LatencyResult {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  max: number;
  commit: string;
  startedAt: string;
  upstream: "demo-upstream";
  mode: Mode;
}

export interface RunLatencyOptions {
  n: number;
  concurrency: number;
  mode: Mode;
  /** Discarded before measurement begins. Defaults to `DEFAULT_WARMUP`. */
  warmup?: number;
  /** Defaults to the docker-compose port mapping. */
  gatewayUrl?: string;
  directUrl?: string;
  /** `git rev-parse HEAD`, resolved by the caller — this module runs no subprocesses. */
  commit?: string;
}

/**
 * Discarded, not measured. The first requests through either path pay for
 * things that happen exactly once and would otherwise land entirely in the
 * proxied sample: V8 tiering up the gate and hash code, the pool's first
 * upstream handshake, DynamoDB's first connection, and the SDK's lazily
 * built schema validators. 200 is comfortably past where those stop
 * showing up at this sample size.
 */
export const DEFAULT_WARMUP = 200;
export const DEFAULT_N = 1000;
export const DEFAULT_CONCURRENCY = 4;

export const DEFAULT_GATEWAY_URL = "http://localhost:3000/mcp";
export const DEFAULT_DIRECT_URL = "http://localhost:4000/mcp";

/** The upstream id the gateway namespaces demo-upstream's tools under (docker-compose.yml). */
const UPSTREAM_ID = "grocery";
const TOOL_NAME = "read_list";

const FROZEN_REFUSALS = [REFUSAL_TOOL_CHANGED, REFUSAL_TOOL_UNPINNED, REFUSAL_UPSTREAM_UNAVAILABLE];

export function targetFor(mode: Mode, gatewayUrl: string, directUrl: string): { url: string; toolName: string } {
  return mode === "proxied"
    ? { url: gatewayUrl, toolName: `${UPSTREAM_ID}__${TOOL_NAME}` }
    : { url: directUrl, toolName: TOOL_NAME };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Rejects anything that is not a real, successful tool result. Runs on
 * every iteration rather than only the first: a mutation landing mid-run
 * (demo-upstream's control endpoint can do exactly that) would otherwise
 * be measured as several hundred fast refusals averaged in with real
 * calls.
 */
export function assertRealResult(result: CallToolResult, mode: Mode): void {
  const text = textOf(result);
  const refusal = FROZEN_REFUSALS.find((message) => text.includes(message));
  if (refusal !== undefined) {
    throw new BenchError(
      `${mode} call returned a frozen refusal, not a result — the measured path was the gate's deny branch, ` +
        `not a real proxied call. Pin the demo upstream's tools (pnpm pin:bootstrap) and re-run.`,
      { mode, refusal },
    );
  }
  if (result.isError === true) {
    throw new BenchError(`${mode} call returned isError: ${text.slice(0, 200)}`, { mode });
  }
  if (result.content.length === 0) {
    throw new BenchError(`${mode} call returned an empty result`, { mode });
  }
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "chaperone-bench", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    // Same `Transport` cast as packages/upstream/src/pool.ts — the SDK's
    // `sessionId` getter is `string | undefined`, wider than the
    // exact-optional `sessionId?: string` the interface declares under this
    // repo's `exactOptionalPropertyTypes`. See friction-log.md Entry 012.
    await client.connect(transport as Transport, { timeout: 5_000 });
  } catch (error) {
    throw new BenchError(`could not connect to ${url} — is the stack up? (docker compose up -d)`, {
      url,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return client;
}

/** One timed call. Returns milliseconds as a float; `performance.now()` is sub-microsecond here. */
async function timedCall(client: Client, toolName: string, mode: Mode): Promise<number> {
  const startedAt = performance.now();
  const result = (await client.callTool({ name: toolName, arguments: {} }, CallToolResultSchema, {
    timeout: 30_000,
  })) as CallToolResult;
  const elapsed = performance.now() - startedAt;
  // Validation deliberately happens *after* the clock stops, so the cost of
  // checking never lands inside the measurement.
  assertRealResult(result, mode);
  return elapsed;
}

/**
 * Runs `total` calls across `clients`, returning the per-call durations of
 * the measured ones. Each client is one MCP session, and the `concurrency`
 * sessions draw from a single shared counter rather than each taking a
 * fixed slice — a slow session would otherwise still be running its slice
 * after the others finished, measuring a different, less-loaded machine
 * for its tail.
 */
async function drive(clients: readonly Client[], toolName: string, mode: Mode, total: number): Promise<number[]> {
  const durations: number[] = [];
  let issued = 0;

  await Promise.all(
    clients.map(async (client) => {
      for (;;) {
        if (issued >= total) {
          return;
        }
        issued += 1;
        durations.push(await timedCall(client, toolName, mode));
      }
    }),
  );

  return durations;
}

export async function runLatency(opts: RunLatencyOptions): Promise<LatencyResult> {
  const {
    n,
    concurrency,
    mode,
    warmup = DEFAULT_WARMUP,
    gatewayUrl = DEFAULT_GATEWAY_URL,
    directUrl = DEFAULT_DIRECT_URL,
    commit = "unknown",
  } = opts;

  if (!Number.isInteger(n) || n <= 0) {
    throw new BenchError("n must be a positive integer", { n });
  }
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new BenchError("concurrency must be a positive integer", { concurrency });
  }

  const { url, toolName } = targetFor(mode, gatewayUrl, directUrl);
  const startedAt = new Date().toISOString();
  const clients = await Promise.all(Array.from({ length: concurrency }, () => connect(url)));

  try {
    if (warmup > 0) {
      // Return value dropped on purpose — this is the discard.
      await drive(clients, toolName, mode, warmup);
    }
    const durations = await drive(clients, toolName, mode, n);
    if (durations.length !== n) {
      throw new BenchError("collected a different number of samples than requested", {
        requested: n,
        collected: durations.length,
      });
    }
    const summary: Summary = summarise(durations);
    return { ...summary, commit, startedAt, upstream: "demo-upstream", mode };
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
  }
}
