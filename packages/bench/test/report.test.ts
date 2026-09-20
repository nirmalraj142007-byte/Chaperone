import { describe, expect, it } from "vitest";
import { buildLatencyFile, renderConsolidated } from "../src/report.js";
import { LATENCY_BUDGET, checkBudget } from "../src/budget.js";
import { difference, summarise } from "../src/percentiles.js";
import type { LatencyResult } from "../src/latency.js";
import type { BootRateFinding } from "../src/boot-rate.js";
import { STORAGE_NOTE, STORAGE_WRITES_PER_TOOL_CALL, assertEnvironment, type Environment } from "../src/report.js";
import { BenchError } from "@chaperone/errors";

const ENVIRONMENT: Environment = {
  backend: "dynamodb-local",
  storageWritesPerToolCall: STORAGE_WRITES_PER_TOOL_CALL,
  gatewayUrl: "http://localhost:3000/mcp",
  directUrl: "http://localhost:4000/mcp",
  nodeVersion: "v24.14.1",
  platform: "win32-x64",
  cpus: 8,
  storageNote: STORAGE_NOTE,
};

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function result(mode: "proxied" | "direct", samples: number[]): LatencyResult {
  return {
    ...summarise(samples),
    commit: COMMIT,
    startedAt: "2026-09-20T10:00:00.000Z",
    upstream: "demo-upstream",
    mode,
  };
}

const proxied = result("proxied", [11, 12, 13, 14]);
const direct = result("direct", [1, 2, 3, 4]);
const added = difference(proxied, direct);

function file(overrides: Partial<Parameters<typeof buildLatencyFile>[0]> = {}) {
  return buildLatencyFile({
    proxied,
    direct,
    added,
    budget: LATENCY_BUDGET,
    budgetOk: true,
    commit: COMMIT,
    dirty: false,
    concurrency: 4,
    warmup: 200,
    environment: ENVIRONMENT,
    ...overrides,
  });
}

const bootRate: BootRateFinding = {
  source: "data/crawl-1-report.json",
  crawlId: "crawl-1",
  candidatesConsidered: 250,
  noInstallPath: 80,
  attempted: 100,
  booted: 37,
  refusedNoCreds: 21,
  failedInstall: 18,
  failedStart: 14,
  failedTimeout: 10,
  bootSuccessRate: 37,
  didNotStartRate: 63,
  findingSentence: "63.0% of public MCP servers ... did not start.",
};

describe("buildLatencyFile", () => {
  it("emits the canonical fields the acceptance checks read", () => {
    // jq '.addedLatency.p95, .commit, .n' benchmarks/latency.json
    const f = file();
    expect(f.commit).toBe(COMMIT);
    expect(f.n).toBe(4);
    expect(f.addedLatency.p95).toBe(10);
  });

  it("emits the flat fields packages/console's Latency interface already declared", () => {
    // The /bench screen was built in Phase 15 against these names, before
    // this harness existed. It is the contract, not the other way round.
    const f = file();
    expect(f.commitSha).toBe(COMMIT);
    expect(f.samples).toBe(4);
    expect(f.addedP50Ms).toBe(10);
    expect(f.addedP95Ms).toBe(10);
    expect(f.addedP99Ms).toBe(10);
    expect(f.budgetP95Ms).toBe(30);
  });

  it("keeps the two namings in agreement, since they come from one computation", () => {
    const f = file();
    expect(f.commit).toBe(f.commitSha);
    expect(f.n).toBe(f.samples);
    expect(f.addedP95Ms).toBe(f.addedLatency.p95);
    expect(f.addedP99Ms).toBe(f.addedLatency.p99);
  });

  it("records both raw runs, so the difference can be recomputed from the file", () => {
    const f = file();
    expect(f.proxied.p95 - f.direct.p95).toBeCloseTo(f.addedLatency.p95, 6);
    expect(f.proxied.mode).toBe("proxied");
    expect(f.direct.mode).toBe("direct");
  });

  it("records a dirty working tree rather than claiming a clean provenance", () => {
    expect(file({ dirty: true }).dirty).toBe(true);
  });

  it("publishes what addedLatency is a difference of", () => {
    expect(file().method).toContain("difference of percentiles, not a percentile of differences");
  });

  it("rounds to hundredths of a millisecond rather than to whole milliseconds", () => {
    // A sub-millisecond p50 is a real result here; rounding it to 0 would
    // read as "not measured".
    const sub = difference(result("proxied", [1.004]), result("direct", [0.6]));
    expect(file({ added: sub }).addedP50Ms).toBe(0.4);
  });
});

describe("the environment is a required field", () => {
  it("records which DynamoDB the number was measured against", () => {
    // Phase 18 produces a second file against dynamodb-aws. Without this
    // label the two files are indistinguishable and neither is comparable.
    expect(file().environment.backend).toBe("dynamodb-local");
  });

  it("records the write count, which is what transfers between backends", () => {
    // Four DynamoDB write operations per gated tools/call: one pin read
    // plus two SSE events, each a sequence UpdateItem and a PutItem.
    // Milliseconds belong to the backend; this count belongs to Chaperone.
    expect(file().environment.storageWritesPerToolCall).toBe(4);
  });

  it("refuses to build a file with no environment at all", () => {
    expect(() => file({ environment: undefined as unknown as Environment })).toThrow(BenchError);
    expect(() => file({ environment: undefined as unknown as Environment })).toThrow(/no environment recorded/);
  });

  it("refuses an unrecognised backend rather than writing it through", () => {
    // A typo must not become a published label that looks authoritative.
    const bad = { ...ENVIRONMENT, backend: "sqlite" as Environment["backend"] };
    expect(() => file({ environment: bad })).toThrow(BenchError);
    expect(() => file({ environment: bad })).toThrow(/dynamodb-local \| dynamodb-aws/);
  });

  it("accepts the aws backend Phase 18 will record", () => {
    expect(file({ environment: { ...ENVIRONMENT, backend: "dynamodb-aws" } }).environment.backend).toBe("dynamodb-aws");
  });

  it("assertEnvironment accepts a well-formed environment", () => {
    expect(() => assertEnvironment(ENVIRONMENT)).not.toThrow();
  });

  it("states the cost model in the file, including the per-call write count", () => {
    expect(file().environment.storageNote).toContain("four DynamoDB write operations per tool call");
    expect(file().environment.storageNote).toContain("transfers between environments");
  });
});

describe("renderConsolidated", () => {
  const block = (over: Partial<Parameters<typeof renderConsolidated>[0]> = {}): string =>
    renderConsolidated({
      latency: file(),
      budgetCheck: checkBudget(added),
      bootRate,
      ledger: { ok: true, summary: "chain OK — 42 events verified" },
      ...over,
    });

  it("shows all three percentiles with the budget beside the number it governs", () => {
    const text = block();
    expect(text).toContain("p50");
    expect(text).toContain("p95");
    expect(text).toContain("p99");
    expect(text).toContain("budget 30 ms — within");
  });

  it("states the sample size, concurrency and discarded warm-up", () => {
    // A number on screen with no sample size beside it is a number a
    // careful viewer has to distrust.
    const text = block();
    expect(text).toContain("4 measured samples per mode");
    expect(text).toContain("concurrency 4");
    expect(text).toContain("200 warm-up iterations discarded");
  });

  it("shows both raw runs next to the difference, so the subtraction is visible", () => {
    expect(block()).toMatch(/proxied .* direct /);
  });

  it("reads PASS when the budget is met and the chain is intact", () => {
    const text = block();
    expect(text).toContain("budget: PASS");
    expect(text).toContain("PASS   latency budget met · ledger chain intact");
  });

  it("reads FAIL and marks the offending percentile OVER when the budget is exceeded", () => {
    const over = difference(result("proxied", [100]), result("direct", [1]));
    const text = block({ latency: file({ added: over, budgetOk: false }), budgetCheck: checkBudget(over) });
    expect(text).toContain("OVER");
    expect(text).toContain("budget: FAIL");
    expect(text).toContain("latency budget exceeded");
  });

  it("fails the run when the ledger chain is broken even with latency inside budget", () => {
    const text = block({ ledger: { ok: false, summary: "chain BROKEN at index 7" } });
    expect(text).toContain("BROKEN");
    expect(text).toContain("FAIL");
  });

  it("says the boot rate is not recorded rather than printing a zero", () => {
    const text = block({ bootRate: null });
    expect(text).toContain("not recorded");
    expect(text).toContain("pnpm crawl:boot-rate");
  });

  it("prints the boot-rate finding sentence verbatim", () => {
    expect(block()).toContain(bootRate.findingSentence);
  });

  it("names the storage backend the number was measured against", () => {
    // Most of this number is storage, so a block that shows the number
    // without naming the backing store invites the flattering reading.
    expect(block()).toContain("dynamodb-local");
    expect(block()).toContain("4 storage writes per tools/call");
  });

  it("names the commit, and flags a dirty tree", () => {
    expect(block()).toContain(COMMIT);
    expect(block({ latency: file({ dirty: true }) })).toContain("working tree dirty");
  });
});
