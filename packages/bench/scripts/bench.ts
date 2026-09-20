/**
 * `pnpm bench` — latency, then boot rate, then the ledger chain, then one
 * consolidated block and an exit code.
 *
 * The exit code is the point. Everything here could have been three
 * scripts printing three numbers; what makes the latency budget a claim
 * rather than a hope is that this process exits 1 when the added p95 is
 * over 30ms, so CI and a pre-demo check both catch a regression that a
 * printed number would not.
 *
 * Requires the docker-compose stack (`docker compose up -d`) with the demo
 * upstream's tools pinned (`pnpm pin:bootstrap`). Both are checked: an
 * unreachable gateway and an unpinned tool each fail loudly with the
 * command that fixes them, rather than producing a fast, wrong number.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LATENCY_BUDGET,
  buildLatencyFile,
  checkBudget,
  deriveBootRate,
  describeViolations,
  difference,
  renderConsolidated,
  runLatency,
  STORAGE_NOTE,
  STORAGE_BACKENDS,
  STORAGE_WRITES_PER_TOOL_CALL,
  DEFAULT_CONCURRENCY,
  DEFAULT_N,
  DEFAULT_WARMUP,
  DEFAULT_GATEWAY_URL,
  DEFAULT_DIRECT_URL,
  type BootRateFinding,
  type BootRateSource,
  type StorageBackend,
} from "../src/index.js";
import { BenchError } from "@chaperone/errors";

interface Args {
  n: number;
  concurrency: number;
  warmup: number;
  crawlId: string;
  gatewayUrl: string;
  directUrl: string;
  resetSse: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const read = (flag: string): string | undefined => {
    const match = argv.find((a) => a.startsWith(`--${flag}=`));
    return match?.slice(flag.length + 3);
  };
  const int = (flag: string, fallback: number): number => {
    const raw = read(flag);
    if (raw === undefined) {
      return fallback;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`--${flag} must be a non-negative integer, got "${raw}"`);
    }
    return value;
  };

  return {
    n: int("n", DEFAULT_N),
    concurrency: int("concurrency", DEFAULT_CONCURRENCY),
    warmup: int("warmup", DEFAULT_WARMUP),
    crawlId: read("crawl-id") ?? "crawl-1",
    gatewayUrl: process.env["BENCH_GATEWAY_URL"] ?? DEFAULT_GATEWAY_URL,
    directUrl: process.env["BENCH_DIRECT_URL"] ?? DEFAULT_DIRECT_URL,
    // On by default: see resetSseEvents. `--no-reset-sse` measures against
    // whatever the table already holds, which is what you want only when
    // investigating the growth effect itself.
    resetSse: !argv.includes("--no-reset-sse"),
  };
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * The commit the numbers describe, and whether the working tree actually
 * matched it. Outside a checkout both degrade to "unknown"/dirty rather
 * than throwing: the run is still worth having, it just cannot claim a
 * provenance, and the console flags an unknown commit as unverified.
 */
function resolveCommit(): { commit: string; dirty: boolean } {
  try {
    return { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]).length > 0 };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

async function loadBootRate(crawlId: string): Promise<BootRateFinding | null> {
  const source = `data/${crawlId}-report.json`;
  try {
    const report = JSON.parse(await readFile(source, "utf8")) as BootRateSource;
    return deriveBootRate(report, source);
  } catch (error) {
    // A missing crawl report is a legitimate state (this repo's crawl 2 has
    // not run yet), not a bench failure. The block says "not recorded" and
    // the run continues; the latency budget is what governs the exit code.
    console.error(`bench: no boot rate from ${source} — ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Runs one of this repo's tsx entry points and returns its output.
 *
 * node + tsx's own JS entry point, rather than the `.bin` shim with
 * `shell: true`. The shim is a `.cmd` on Windows, which needs a shell, and
 * passing an argument array through a shell is what Node 24 warns about in
 * DEP0190 (the arguments are concatenated, not escaped). Resolving
 * `tsx/cli` skips the shim, so there is no shell and no concatenation on
 * any platform.
 */
function runScript(script: string): { ok: boolean; summary: string } {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const result = spawnSync(process.execPath, [tsxCli, script], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const summary = output.split("\n").filter((line) => line.trim().length > 0).join(" / ") || "no output";
  return { ok: result.status === 0, summary };
}

/**
 * The real `verify-ledger` script as a subprocess rather than `verifyChain`
 * in-process, so the consolidated block reports exactly what
 * `pnpm verify-ledger` reports — including that the script itself still
 * works. Calling the library directly would leave the published entry
 * point untested by the thing that claims to have run it.
 */
function verifyLedger(): { ok: boolean; summary: string } {
  return runScript("packages/ledger/scripts/verify-ledger.ts");
}

/**
 * Clears the resumable-SSE replay table before measuring, so a run starts
 * from a defined storage state.
 *
 * Without this the benchmark is not reproducible and drifts silently. DDB
 * Local ignores TTL, so `sse-event` rows accumulate across runs, and its
 * SQLite backend slows as the table grows — successive runs at the same
 * commit measured 64ms and then 174ms added p50, purely from rows left
 * behind by the previous run. See packages/ledger/scripts/reset-sse.ts.
 *
 * A failure here is reported and does not abort: the run continues and
 * says the reset did not happen, which is more useful than refusing to
 * measure at all. `ledger-event` is never touched.
 */
function resetSseEvents(): { ok: boolean; summary: string } {
  return runScript("packages/ledger/scripts/reset-sse.ts");
}

/**
 * Asks the gateway which DynamoDB it writes to.
 *
 * Read from the gateway's own `/healthz` rather than inferred from this
 * process's `DDB_ENDPOINT`: the bench talks to the gateway over HTTP and
 * has no visibility into how that process was configured, so its own
 * environment would be a guess about somebody else's. A gateway too old to
 * report the field, or unreachable, throws — `benchmarks/latency.json` is
 * not written without this label, because a latency number nobody can
 * attribute to a backend is not a measurement anyone can use or compare to
 * the `dynamodb-aws` run.
 */
async function resolveBackend(gatewayUrl: string): Promise<StorageBackend> {
  const healthzUrl = new URL("/healthz", gatewayUrl).toString();
  let backend: unknown;
  try {
    const response = await fetch(healthzUrl, { signal: AbortSignal.timeout(5_000) });
    const body = (await response.json()) as { checks?: { storageBackend?: unknown } };
    backend = body.checks?.storageBackend;
  } catch (error) {
    throw new BenchError(
      `could not read the storage backend from ${healthzUrl}; refusing to record a latency number that ` +
        `cannot be attributed to a backend`,
      { healthzUrl, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (typeof backend !== "string" || !STORAGE_BACKENDS.includes(backend as StorageBackend)) {
    throw new BenchError(
      `${healthzUrl} did not report a recognised checks.storageBackend ` +
        `(expected ${STORAGE_BACKENDS.join(" | ")}, got ${JSON.stringify(backend)})`,
      { healthzUrl, backend },
    );
  }
  return backend as StorageBackend;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { commit, dirty } = resolveCommit();

  console.error(
    `bench: measuring ${args.n} samples per mode at concurrency ${args.concurrency} ` +
      `(${args.warmup} warm-up discarded) against ${args.gatewayUrl} and ${args.directUrl}`,
  );

  // Resolved before any measuring, so an unlabelled run fails in a second
  // rather than after two thousand samples.
  const backend = await resolveBackend(args.gatewayUrl);
  console.error(`bench: gateway storage backend is ${backend}`);

  if (args.resetSse) {
    const reset = resetSseEvents();
    console.error(`bench: ${reset.ok ? "reset" : "COULD NOT RESET"} sse-event — ${reset.summary}`);
  }

  // Direct first, then proxied. Order matters only in that both run back to
  // back on one machine; measuring them in separate invocations minutes
  // apart would let machine state drift into the difference, which is the
  // entire result.
  const direct = await runLatency({
    n: args.n,
    concurrency: args.concurrency,
    warmup: args.warmup,
    mode: "direct",
    gatewayUrl: args.gatewayUrl,
    directUrl: args.directUrl,
    commit,
  });
  console.error(`bench: direct   p50 ${direct.p50.toFixed(2)}ms  p95 ${direct.p95.toFixed(2)}ms`);

  const proxied = await runLatency({
    n: args.n,
    concurrency: args.concurrency,
    warmup: args.warmup,
    mode: "proxied",
    gatewayUrl: args.gatewayUrl,
    directUrl: args.directUrl,
    commit,
  });
  console.error(`bench: proxied  p50 ${proxied.p50.toFixed(2)}ms  p95 ${proxied.p95.toFixed(2)}ms`);

  const added = difference(proxied, direct);
  const budgetCheck = checkBudget(added, LATENCY_BUDGET);

  const latencyFile = buildLatencyFile({
    proxied,
    direct,
    added,
    budget: LATENCY_BUDGET,
    budgetOk: budgetCheck.ok,
    commit,
    dirty,
    concurrency: args.concurrency,
    warmup: args.warmup,
    environment: {
      backend,
      storageWritesPerToolCall: STORAGE_WRITES_PER_TOOL_CALL,
      gatewayUrl: args.gatewayUrl,
      directUrl: args.directUrl,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: os.cpus().length,
      storageNote: STORAGE_NOTE,
    },
  });

  await mkdir("benchmarks", { recursive: true });
  await writeFile(path.join("benchmarks", "latency.json"), `${JSON.stringify(latencyFile, null, 2)}\n`, "utf8");

  const bootRate = await loadBootRate(args.crawlId);
  if (bootRate !== null) {
    await writeFile(path.join("benchmarks", "boot-rate.json"), `${JSON.stringify(bootRate, null, 2)}\n`, "utf8");
  }

  const ledger = verifyLedger();

  console.log(renderConsolidated({ latency: latencyFile, budgetCheck, bootRate, ledger }));

  if (!budgetCheck.ok) {
    for (const line of describeViolations(budgetCheck.violations)) {
      console.error(`bench: BUDGET EXCEEDED — ${line}`);
    }
    process.exitCode = 1;
    return;
  }
  if (!ledger.ok) {
    console.error("bench: ledger chain verification failed");
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

main().catch((e: unknown) => {
  console.error("bench: failed —", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
