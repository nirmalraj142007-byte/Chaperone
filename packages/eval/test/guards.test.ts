import { describe, expect, it } from "vitest";
// Static, not `await import()` inside the test: importing the package index pulls in the
// advisory package and the AWS Bedrock SDK, which is seconds of module loading on a starved
// machine. At file scope that cost is spent before the test clock starts; inside the test it
// counts against its 5s timeout and made this a load-dependent failure.
import * as evalExports from "../src/index.js";
import { loadAttackCorpus } from "../src/corpus.js";
import { findUnqualifiedAbsoluteChaperoneBlockRate, hasDeltaField } from "../src/guards.js";
import { buildBaselineReport } from "../src/report.js";
import { scoreBaseline1 } from "../src/scoreCorpus.js";

const corpus = loadAttackCorpus();

describe("findUnqualifiedAbsoluteChaperoneBlockRate", () => {
  it("flags a synthetic object that smuggles an absolute Chaperone block rate outside delta", () => {
    const bad = { chaperoneBlockRate: 0.92, delta: null };
    expect(findUnqualifiedAbsoluteChaperoneBlockRate(bad)).toEqual([{ path: "chaperoneBlockRate", value: 0.92 }]);
  });

  it("flags it however deeply it's nested, as long as it's outside delta", () => {
    const bad = { baseline: { nested: { chaperoneAbsoluteBlockRate: 1 } } };
    const violations = findUnqualifiedAbsoluteChaperoneBlockRate(bad);
    expect(violations).toEqual([{ path: "baseline.nested.chaperoneAbsoluteBlockRate", value: 1 }]);
  });

  it("does NOT flag the same field when nested under delta", () => {
    const ok = { delta: { chaperoneBlockRate: 0.92, baseline2DetectionRate: 0.5 } };
    expect(findUnqualifiedAbsoluteChaperoneBlockRate(ok)).toEqual([]);
  });

  it("ignores unrelated numeric fields entirely", () => {
    const ok = { detectionRate: 0.8, falsePositiveRate: 0.1, count: 30 };
    expect(findUnqualifiedAbsoluteChaperoneBlockRate(ok)).toEqual([]);
  });

  it("does not false-positive on a bare number or null", () => {
    expect(findUnqualifiedAbsoluteChaperoneBlockRate(42)).toEqual([]);
    expect(findUnqualifiedAbsoluteChaperoneBlockRate(null)).toEqual([]);
  });
});

describe("hasDeltaField", () => {
  it("is true for an object with a delta key, even when delta is null", () => {
    expect(hasDeltaField({ delta: null })).toBe(true);
  });

  it("is false for an object with no delta key", () => {
    expect(hasDeltaField({ notDelta: 1 })).toBe(false);
  });
});

describe("guard applied to the real eval package output", () => {
  it("buildBaselineReport's real output contains `delta` and no unqualified absolute Chaperone block rate", () => {
    const report = buildBaselineReport(corpus);
    expect(hasDeltaField(report)).toBe(true);
    expect(findUnqualifiedAbsoluteChaperoneBlockRate(report)).toEqual([]);
  });

  it("scoreBaseline1's real output — baseline 1's own rates, never a Chaperone rate — also carries no such field", () => {
    const result = scoreBaseline1(corpus);
    expect(findUnqualifiedAbsoluteChaperoneBlockRate(result)).toEqual([]);
  });

  it("no exported constant/value (as opposed to a guard function whose job is detecting this) is a raw Chaperone block rate", () => {
    // Functions are exempt from the name check: this package legitimately
    // exports functions whose *name* describes chaperone-block-rate
    // detection (findUnqualifiedAbsoluteChaperoneBlockRate, this test file's
    // own subject) without themselves *returning* one — that's the whole
    // point of the function. A non-function export named this way would be
    // the real smell: a constant baked in at module-load time rather than
    // measured, which is exactly what CLAUDE.md #7 forbids.
    const suspiciousNonFunctionExports = Object.entries(evalExports as Record<string, unknown>)
      .filter(([name]) => /chaperone.*block.*rate/i.test(name))
      .filter(([, value]) => typeof value !== "function");
    expect(suspiciousNonFunctionExports).toEqual([]);
  });
});
