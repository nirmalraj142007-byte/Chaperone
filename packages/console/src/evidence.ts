/**
 * The evidence screens' data: committed JSON files, inlined at build time
 * by the `chaperone-evidence` Vite plugin. No fetch, no database, no
 * network — /corpus and /bench render in airplane mode (Risk R5).
 *
 * Everything below the context is a pure function of an `Evidence` value,
 * so the screens' three-way state resolution is unit-tested without
 * rendering anything.
 */
import { createContext, useContext } from "react";
import type { CapabilityClass, Drift, Evidence, Latency } from "../evidence.load";

export type { CapabilityClass, CrawlReport, Drift, DriftStratum, Evidence, Latency } from "../evidence.load";

/** Neutral default: every file absent. A screen rendered without a provider shows its empty state, never a crash. */
export const EMPTY_EVIDENCE: Evidence = {
  crawl1: null,
  crawl2: null,
  bootRate: null,
  drift: null,
  latency: null,
  headSha: null,
  builtAt: "1970-01-01T00:00:00.000Z",
};

export const EvidenceContext = createContext<Evidence>(EMPTY_EVIDENCE);

export function useEvidence(): Evidence {
  return useContext(EvidenceContext);
}

/* ────────────────────────────── /corpus ────────────────────────────── */

export type CorpusState = "empty" | "partial" | "complete";

/**
 * Which of the three designed states /corpus renders.
 *
 * `complete` is driven by drift.json's own `status`, not by the file
 * merely existing: the file is committed in `pending` form before crawl 2
 * so that the shape is pre-registered too. A drift file that exists but
 * says `pending` is still the partial state.
 */
export function corpusState(ev: Evidence): CorpusState {
  if (ev.drift?.status === "complete" && ev.drift.byCapability !== null) {
    return "complete";
  }
  return ev.crawl1 === null ? "empty" : "partial";
}

/** Axis 2 of corpus/TAXONOMY.md, in its documented order of consequence — not sorted by size, ever. */
export const CAPABILITY_ORDER: readonly CapabilityClass[] = ["transact", "communicate", "write", "read"];

export interface Stratum {
  capabilityClass: CapabilityClass;
  /** Tools captured in this class (partial), or semantic-intent drift rate as a percentage (complete). */
  value: number;
  /** The number printed at the end of the bar, already formatted. */
  display: string;
  /** Sub-label: the denominator, so a rate is never shown without what it is a rate of. */
  note: string;
  /**
   * True only for `read` in the partial state: `read` is the classifier's
   * unmatched-verb default, so its population carries no confidence. The
   * bar is hatched rather than solid so it cannot be read as a measurement.
   */
  lowConfidence: boolean;
}

const pct = (n: number): string => `${n.toFixed(1)}%`;
const int = (n: number): string => n.toLocaleString("en-US");

/**
 * The four strata, same four rows in both populated states. Partial plots
 * the sampling frame (a finished crawl-1 result); complete plots the
 * semantic-intent drift rate per class. They are not the same measure and
 * the axis caption says so — the point of sharing the rows is that crawl 2
 * is measured *against these strata*, so the partial chart is the frame,
 * not a placeholder for the drift chart.
 */
export function strata(ev: Evidence): Stratum[] {
  const drift = ev.drift;
  if (drift?.status === "complete" && drift.byCapability !== null) {
    const by = new Map(drift.byCapability.map((s) => [s.capabilityClass, s]));
    return CAPABILITY_ORDER.flatMap((capabilityClass) => {
      const s = by.get(capabilityClass);
      return s === undefined
        ? []
        : [{
            capabilityClass,
            value: s.ratePct,
            display: pct(s.ratePct),
            note: `${int(s.drifted)} of ${int(s.servers)} servers`,
            lowConfidence: false,
          }];
    });
  }
  const dist = ev.crawl1?.capabilityDistribution ?? {};
  const total = ev.crawl1?.totalToolsCaptured ?? 0;
  return CAPABILITY_ORDER.flatMap((capabilityClass) => {
    const value = dist[capabilityClass];
    return value === undefined
      ? []
      : [{
          capabilityClass,
          value,
          display: int(value),
          note: total > 0 ? `${((value / total) * 100).toFixed(1)}% of tools captured` : "",
          lowConfidence: capabilityClass === "read",
        }];
  });
}

/** Whole days from `now` to midnight UTC on an ISO date. Negative once the date has passed. */
export function daysUntil(isoDate: string, now: number): number {
  const target = Date.parse(`${isoDate}T00:00:00.000Z`);
  return Number.isNaN(target) ? 0 : Math.ceil((target - now) / 86_400_000);
}

/**
 * The measured day count between the two crawls. Derived from the two
 * recorded `startedAt` values once both exist — never from the calendar,
 * so a crawl that slipped a day reports the day it actually ran.
 * Falls back to drift.json's pre-registered `interval` while pending.
 */
export function intervalDays(drift: Drift | null): number | null {
  if (drift === null) {
    return null;
  }
  if (drift.crawl1StartedAt !== null && drift.crawl2StartedAt !== null) {
    const a = Date.parse(drift.crawl1StartedAt);
    const b = Date.parse(drift.crawl2StartedAt);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      return Math.round((b - a) / 86_400_000);
    }
  }
  return drift.interval;
}

/** Where a measured rate sits relative to the pre-registered band. Drives the mark's colour, and nothing else. */
export function bandVerdict(ratePct: number, drift: Drift): "inside" | "below" | "above" {
  if (ratePct < drift.prediction.lowPct) return "below";
  if (ratePct > drift.prediction.highPct) return "above";
  return "inside";
}

/* ─────────────────────────────── /bench ─────────────────────────────── */

export type BenchState = "empty" | "ready";

export function benchState(ev: Evidence): BenchState {
  return ev.latency === null ? "empty" : "ready";
}

export interface Staleness {
  stale: boolean;
  /** Present only when it can actually be decided — an unknown HEAD is not a claim of freshness. */
  reason: "match" | "mismatch" | "unknown";
  recorded: string | null;
  head: string | null;
}

/**
 * Whether the recorded latency numbers describe the code that is checked
 * out. If HEAD could not be read (no git, or a tarball export), the answer
 * is `unknown` and the screen says so rather than implying the numbers are
 * current — the same fail-closed reflex as the gate.
 */
export function staleness(latency: Latency | null, headSha: string | null): Staleness {
  if (latency === null || headSha === null) {
    return { stale: false, reason: "unknown", recorded: latency?.commitSha ?? null, head: headSha };
  }
  const match = latency.commitSha === headSha;
  return { stale: !match, reason: match ? "match" : "mismatch", recorded: latency.commitSha, head: headSha };
}
