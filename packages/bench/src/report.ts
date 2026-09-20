/**
 * The bench run's two outputs: `benchmarks/latency.json`, and the
 * consolidated terminal block.
 *
 * The block is written to be *filmed*. That means fixed-width columns, the
 * budget printed next to the number it governs rather than in a legend,
 * and the verdict as a word — nothing that needs colour to be read, since
 * a terminal recording may be re-encoded and a judge may be watching at
 * 480p. It also means it says what it measured, not only what it found: a
 * number on screen with no sample size beside it is a number a careful
 * viewer has to distrust.
 */
import { BenchError } from "@chaperone/errors";
import type { Summary } from "./percentiles.js";
import type { Budget, BudgetCheck } from "./budget.js";
import type { LatencyResult } from "./latency.js";
import type { BootRateFinding } from "./boot-rate.js";

/**
 * `benchmarks/latency.json`.
 *
 * Two naming conventions coexist here on purpose, and the duplication is
 * deliberate rather than an oversight:
 *
 *   - `commit`, `n`, `addedLatency`, `proxied`, `direct` are the canonical
 *     shape, and what the acceptance checks read
 *     (`jq '.addedLatency.p95, .commit, .n'`).
 *   - `recordedAt`, `commitSha`, `samples`, `addedP50Ms`/`addedP95Ms`/
 *     `addedP99Ms`, `budgetP95Ms` are the flat fields
 *     `packages/console/evidence.load.ts`'s `Latency` interface already
 *     declared, in Phase 15, before this harness existed. The /bench
 *     screen was built against them and is the contract this file has to
 *     satisfy.
 *
 * Reconciling them by renaming would mean editing a finished screen to
 * match a file that did not exist when it was written. They are emitted
 * from one computation a few lines below, so they cannot disagree.
 */
export interface LatencyFile {
  /** ISO time the run started. */
  recordedAt: string;
  /** Full HEAD sha. The console flags its own build as stale when this is not HEAD. */
  commitSha: string;
  commit: string;
  /**
   * True when the working tree had uncommitted changes at measurement
   * time, so `commit` does not fully describe the code that was measured.
   * Nothing consumes this; it exists so a run cannot quietly claim a clean
   * provenance it did not have.
   */
  dirty: boolean;
  samples: number;
  n: number;
  concurrency: number;
  warmupDiscarded: number;
  addedP50Ms: number;
  addedP95Ms: number;
  addedP99Ms: number;
  budgetP95Ms: number;
  budgetP99Ms: number;
  addedLatency: Summary;
  proxied: LatencyResult;
  direct: LatencyResult;
  budgetOk: boolean;
  /** Plain-English statement of what `addedLatency` is a difference of. Published so the file explains itself. */
  method: string;
  /**
   * What produced these numbers. Recorded because "added latency" is not
   * a property of the gateway alone: most of it is storage, and the
   * gateway's storage under `docker compose` is DynamoDB Local, whose
   * SQLite backend is a single writer. A number measured against that is
   * not the number a deployed stack would produce, and a file that does
   * not say which one it is invites the reader to assume the flattering
   * one.
   */
  environment: Environment;
}

/**
 * Which DynamoDB the gateway under test was writing to.
 *
 * Required, never defaulted, and never inferred from the bench process's
 * own environment — it is read from the gateway's `/healthz`, because the
 * gateway is the process whose storage is being measured and the bench
 * talks to it over HTTP. A run that cannot establish this does not write a
 * file at all (see `assertEnvironment`).
 *
 * The reason it is load-bearing: the same gateway code produces added
 * latency an order of magnitude apart against these two backends, so a
 * number without this label cannot be compared to anything, including the
 * second measurement Phase 18 will take against `dynamodb-aws`.
 */
export type StorageBackend = "dynamodb-local" | "dynamodb-aws";

export const STORAGE_BACKENDS: readonly StorageBackend[] = ["dynamodb-local", "dynamodb-aws"];

export interface Environment {
  /** Required. See StorageBackend. */
  backend: StorageBackend;
  gatewayUrl: string;
  directUrl: string;
  nodeVersion: string;
  platform: string;
  cpus: number;
  /**
   * The count that transfers between environments. Milliseconds do not:
   * they are a property of the backend. "Four DynamoDB write operations
   * per tools/call" is a property of Chaperone, and it is what predicts
   * the cost anywhere.
   */
  storageWritesPerToolCall: number;
  /** Names the storage caveat in the file itself, not only in the README. */
  storageNote: string;
}

/**
 * Refuses to build a latency file whose environment is missing or
 * unrecognised. A published latency number is meaningless without the
 * backend label, and a file that silently defaulted it would be worse than
 * no file: the default would be read as a measurement.
 */
export function assertEnvironment(environment: Environment | undefined): asserts environment is Environment {
  if (environment === undefined) {
    throw new BenchError("refusing to write benchmarks/latency.json with no environment recorded", {});
  }
  if (!STORAGE_BACKENDS.includes(environment.backend)) {
    throw new BenchError(
      `refusing to write benchmarks/latency.json: environment.backend must be one of ${STORAGE_BACKENDS.join(" | ")}`,
      { backend: environment.backend },
    );
  }
}

/**
 * The measured cost model, stated once so both output files and the README
 * quote the same sentence.
 *
 * Every gated `tools/call` performs one pin read (GetItem) and two
 * resumable-SSE event-store events, each of which is a sequence UpdateItem
 * plus a PutItem — four write operations per tool call. Measured, not
 * assumed: `chaperone_event_store_writes_total` counted 42 events over 20
 * tools/call plus one handshake.
 */
export const STORAGE_WRITES_PER_TOOL_CALL = 4;

export const STORAGE_NOTE =
  "Every gated tools/call performs one pin read plus two resumable-SSE event-store events, each of which " +
  "is a sequence UpdateItem and a PutItem — four DynamoDB write operations per tool call. That count is " +
  "the property of Chaperone and transfers between environments; the millisecond cost of those four " +
  "writes does not, because it belongs to the backend. Against DynamoDB Local, whose SQLite backend is a " +
  "single writer saturating at roughly 60 writes/second regardless of client concurrency, those four " +
  "writes dominate added latency entirely and dominate it more as concurrency rises. Read the backend " +
  "field before comparing this number to anything.";

export const METHOD_NOTE =
  "addedLatency is the proxied percentile minus the direct-to-upstream percentile, measured back to back on one " +
  "machine in a single run. The samples are unpaired, so this is a difference of percentiles, not a percentile of " +
  "differences: it says the p95 call through Chaperone took this much longer than the p95 call straight to the " +
  "upstream, not that 95% of calls were slowed by at most this much.";

export function buildLatencyFile(input: {
  proxied: LatencyResult;
  direct: LatencyResult;
  added: Summary;
  budget: Budget;
  budgetOk: boolean;
  commit: string;
  dirty: boolean;
  concurrency: number;
  warmup: number;
  environment: Environment;
}): LatencyFile {
  const { proxied, direct, added, budget, budgetOk, commit, dirty, concurrency, warmup, environment } = input;
  // Throws rather than defaulting — see assertEnvironment.
  assertEnvironment(environment);
  return {
    recordedAt: proxied.startedAt,
    commitSha: commit,
    commit,
    dirty,
    samples: added.n,
    n: added.n,
    concurrency,
    warmupDiscarded: warmup,
    addedP50Ms: round(added.p50),
    addedP95Ms: round(added.p95),
    addedP99Ms: round(added.p99),
    budgetP95Ms: budget.p95Ms,
    budgetP99Ms: budget.p99Ms,
    addedLatency: roundSummary(added),
    proxied: roundResult(proxied),
    direct: roundResult(direct),
    budgetOk,
    method: METHOD_NOTE,
    environment,
  };
}

/**
 * Two decimal places — hundredths of a millisecond. Kept rather than
 * rounded to whole ms because a sub-millisecond p50 is a real and
 * interesting result here, and `0` would read as "not measured".
 */
function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function roundSummary(s: Summary): Summary {
  return { n: s.n, p50: round(s.p50), p95: round(s.p95), p99: round(s.p99), mean: round(s.mean), max: round(s.max) };
}

function roundResult(r: LatencyResult): LatencyResult {
  return { ...r, ...roundSummary(r) };
}

/* ───────────────────────────── the filmed block ───────────────────────────── */

const WIDTH = 78;
const rule = (char = "─"): string => char.repeat(WIDTH);
const ms = (value: number): string => `${value.toFixed(2)} ms`;

function row(label: string, value: string, note = ""): string {
  return `  ${label.padEnd(20)}${value.padStart(14)}   ${note}`;
}

export interface ConsolidatedInput {
  latency: LatencyFile;
  budgetCheck: BudgetCheck;
  bootRate: BootRateFinding | null;
  ledger: { ok: boolean; summary: string };
}

/**
 * The whole run on one screen: what Chaperone costs, what the ecosystem
 * looks like, and whether the evidence chain is intact. Returned as a
 * string rather than printed, so it can be asserted on in a test.
 */
export function renderConsolidated(input: ConsolidatedInput): string {
  const { latency, budgetCheck, bootRate, ledger } = input;
  const lines: string[] = [];

  lines.push(rule("═"));
  lines.push("  CHAPERONE BENCH");
  lines.push(`  commit ${latency.commit}${latency.dirty ? "  (working tree dirty)" : ""}`);
  lines.push(`  ${latency.recordedAt}`);
  lines.push(rule("═"));
  lines.push("");

  lines.push("  ADDED LATENCY  ·  gateway minus the same call direct to the upstream");
  lines.push(rule());
  lines.push(
    row("p50", ms(latency.addedLatency.p50), `proxied ${ms(latency.proxied.p50)} · direct ${ms(latency.direct.p50)}`),
  );
  lines.push(
    row(
      "p95",
      ms(latency.addedLatency.p95),
      `budget ${latency.budgetP95Ms} ms — ${latency.addedLatency.p95 > latency.budgetP95Ms ? "OVER" : "within"}`,
    ),
  );
  lines.push(
    row(
      "p99",
      ms(latency.addedLatency.p99),
      `budget ${latency.budgetP99Ms} ms — ${latency.addedLatency.p99 > latency.budgetP99Ms ? "OVER" : "within"}`,
    ),
  );
  lines.push(row("mean", ms(latency.addedLatency.mean), ""));
  lines.push("");
  lines.push(
    `  ${latency.n} measured samples per mode · concurrency ${latency.concurrency} · ` +
      `${latency.warmupDiscarded} warm-up iterations discarded`,
  );
  lines.push(`  budget: ${budgetCheck.ok ? "PASS" : "FAIL"}`);
  lines.push("");
  // On screen as well as in the file: a viewer reading a latency number
  // has to know what was underneath it.
  lines.push(
    `  backend: ${latency.environment.backend} · ` +
      `${latency.environment.storageWritesPerToolCall} storage writes per tools/call`,
  );
  lines.push("");

  lines.push("  BOOT SUCCESS  ·  other people's servers, not this one");
  lines.push(rule());
  if (bootRate === null) {
    lines.push("  not recorded — run: pnpm crawl:boot-rate --crawl-id=crawl-1");
  } else {
    lines.push(`  ${bootRate.findingSentence}`);
    lines.push(
      `  ${bootRate.booted} booted / ${bootRate.attempted} attempted · ` +
        `${bootRate.noInstallPath} with no install path · ${bootRate.candidatesConsidered} candidates · ${bootRate.crawlId}`,
    );
  }
  lines.push("");

  lines.push("  LEDGER CHAIN");
  lines.push(rule());
  lines.push(`  ${ledger.ok ? "OK" : "BROKEN"} — ${ledger.summary}`);
  lines.push("");

  lines.push(rule("═"));
  const verdict = budgetCheck.ok && ledger.ok ? "PASS" : "FAIL";
  lines.push(`  ${verdict}   latency budget ${budgetCheck.ok ? "met" : "exceeded"} · ledger chain ${ledger.ok ? "intact" : "broken"}`);
  lines.push(rule("═"));

  return lines.join("\n");
}
