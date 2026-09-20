/**
 * The statistics behind the one number in this project a judge can
 * reproduce on their own machine in an afternoon. Pure, synchronous, and
 * separated from the harness that collects the samples so it can be tested
 * against hand-computed values rather than against whatever the network
 * happened to do.
 *
 * Percentiles are computed by the nearest-rank method over the *full*
 * sorted sample, never a streaming estimate (t-digest, HDR histogram, a
 * reservoir). Those exist to bound memory when you cannot keep every
 * observation, and at n = 1000 doubles the whole sample is eight kilobytes.
 * A streaming estimator would introduce an approximation error of unstated
 * size into the headline number, in exchange for saving nothing.
 *
 * Nearest rank, rather than an interpolating definition: every value this
 * returns is an observation that actually occurred. An interpolated p95 is
 * a number no request ever took.
 */
import { BenchError } from "@chaperone/errors";

/** Ascending. Callers that already hold a sorted array should pass it to `percentile` directly. */
export function sortAscending(samples: readonly number[]): number[] {
  return [...samples].sort((a, b) => a - b);
}

/**
 * The nearest-rank percentile of an already-ascending sample.
 *
 * rank = ceil(p/100 × n), clamped into range, then indexed from zero. p=0
 * yields the minimum and p=100 the maximum.
 */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) {
    throw new BenchError("percentile of an empty sample", { p });
  }
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new BenchError("percentile p must be between 0 and 100", { p });
  }
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  const value = sortedAscending[index];
  if (value === undefined) {
    throw new BenchError("percentile index out of range", { p, index, n: sortedAscending.length });
  }
  return value;
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  max: number;
}

export function summarise(samples: readonly number[]): Summary {
  if (samples.length === 0) {
    throw new BenchError("cannot summarise an empty sample", {});
  }
  const sorted = sortAscending(samples);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: total / sorted.length,
    max: percentile(sorted, 100),
  };
}

/**
 * Proxied minus direct, percentile by percentile.
 *
 * This is a difference of percentiles, not a percentile of differences,
 * and the two are not the same statistic. The honest reason it has to be
 * this one: the proxied and direct samples are unpaired — sample i of one
 * run and sample i of the other are different requests at different
 * moments, so there is no per-request difference to take a percentile of.
 * Subtracting rank-matched values would invent a pairing that does not
 * exist.
 *
 * What the result therefore means: "the p95 request through Chaperone took
 * this much longer than the p95 request straight to the upstream" — a
 * comparison of two distributions' shapes, which is the right claim for a
 * latency budget. It is not "95% of requests were slowed by at most this
 * much."
 *
 * A negative value is possible and is reported as measured, never clamped
 * to zero: at a few milliseconds of true overhead, ordinary scheduling
 * noise between two adjacent runs can exceed the signal, and a floor at
 * zero would quietly turn that noise into a one-sided claim in this
 * project's favour.
 */
export function difference(proxied: Summary, direct: Summary): Summary {
  return {
    n: Math.min(proxied.n, direct.n),
    p50: proxied.p50 - direct.p50,
    p95: proxied.p95 - direct.p95,
    p99: proxied.p99 - direct.p99,
    mean: proxied.mean - direct.mean,
    max: proxied.max - direct.max,
  };
}
