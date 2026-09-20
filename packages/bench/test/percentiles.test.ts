import { describe, expect, it } from "vitest";
import { difference, percentile, sortAscending, summarise } from "../src/percentiles.js";
import { BenchError } from "@chaperone/errors";

describe("percentile (nearest rank, full sorted sample)", () => {
  // 1..100 makes every expected value checkable by hand: with n = 100,
  // rank = ceil(p) and the value at rank r is exactly r.
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("returns the value at ceil(p/100 * n), one-indexed", () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 95)).toBe(95);
    expect(percentile(oneToHundred, 99)).toBe(99);
  });

  it("returns the minimum at p0 and the maximum at p100", () => {
    expect(percentile(oneToHundred, 0)).toBe(1);
    expect(percentile(oneToHundred, 100)).toBe(100);
  });

  it("returns an observation that actually occurred, never an interpolated value", () => {
    // With n = 3, an interpolating definition would put p50 at 20 only by
    // coincidence; p95 would interpolate to 29.x. Nearest rank must return
    // a member of the sample.
    const sample = [10, 20, 30];
    for (const p of [0, 12, 33, 50, 66, 95, 99, 100]) {
      expect(sample).toContain(percentile(sample, p));
    }
  });

  it("rejects an empty sample rather than returning a default", () => {
    expect(() => percentile([], 95)).toThrow(BenchError);
  });

  it("rejects a p outside 0..100", () => {
    expect(() => percentile([1], -1)).toThrow(BenchError);
    expect(() => percentile([1], 101)).toThrow(BenchError);
    expect(() => percentile([1], Number.NaN)).toThrow(BenchError);
  });
});

describe("sortAscending", () => {
  it("sorts numerically, not lexicographically", () => {
    // The bug this guards: [].sort() with no comparator would give
    // [10, 100, 9, 90], making every percentile wrong.
    expect(sortAscending([100, 9, 90, 10])).toEqual([9, 10, 90, 100]);
  });

  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    sortAscending(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("summarise", () => {
  it("computes n, percentiles, mean and max over the full sample", () => {
    const summary = summarise([4, 1, 3, 2]);
    expect(summary.n).toBe(4);
    expect(summary.mean).toBe(2.5);
    expect(summary.max).toBe(4);
    expect(summary.p50).toBe(2);
  });

  it("rejects an empty sample", () => {
    expect(() => summarise([])).toThrow(BenchError);
  });
});

describe("difference (proxied minus direct)", () => {
  const proxied = summarise([12, 13, 14, 15]);
  const direct = summarise([10, 11, 12, 13]);

  it("subtracts percentile by percentile", () => {
    const added = difference(proxied, direct);
    expect(added.p50).toBe(proxied.p50 - direct.p50);
    expect(added.p95).toBe(proxied.p95 - direct.p95);
    expect(added.p99).toBe(proxied.p99 - direct.p99);
    expect(added.mean).toBeCloseTo(2, 10);
  });

  it("reports a negative difference as measured, never clamped to zero", () => {
    // A floor at zero would turn ordinary scheduling noise into a one-sided
    // claim in this project's favour. If the proxied run came out faster,
    // the report has to say so.
    const added = difference(direct, proxied);
    expect(added.p95).toBeLessThan(0);
  });

  it("reports n as the smaller of the two samples", () => {
    expect(difference(summarise([1, 2, 3]), summarise([1, 2])).n).toBe(2);
  });
});
