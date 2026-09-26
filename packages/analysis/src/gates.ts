/**
 * Pre-registration gates. Each is a pure function over recorded facts
 * (timestamps from the crawl reports, a commit time looked up by the caller),
 * so each can be made to fire in a test.
 */
import { AnalysisError } from "@chaperone/errors";

/** The plan's minimum n for a rate to be quoted (corpus/DRIFT-JSON-APPENDIX-report-shape.md, `headlineEligible`). */
export const HEADLINE_FLOOR = 100;

/** Rider C runs only at or above this semantic-intent drift rate (and only when headline-eligible). */
export const RIDER_C_RATE_GATE = 0.2;

const DAY_MS = 86_400_000;

function utcDateMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new AnalysisError(`"${iso}" is not a timestamp`, { iso });
  }
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Whole days between the UTC calendar dates of two recorded timestamps. This
 * is how CRAWL_DATES.md counts 2026-09-15 -> 2026-10-20 as 35: by date, not
 * by elapsed hours, so a crawl 2 that starts a few minutes earlier in the day
 * than crawl 1 did is still 35 days on, not 34.
 */
export function utcCalendarDaysBetween(fromIso: string, toIso: string): number {
  return Math.round((utcDateMs(toIso) - utcDateMs(fromIso)) / DAY_MS);
}

export interface TaxonomyGateInput {
  /** The blob crawl 1's report names. */
  crawl1BlobSha: string;
  crawl1StartedAt: string;
  /** Committer time of the earliest commit containing that blob, or null if no commit contains it. */
  firstCommitAt: string | null;
  /** Every other place a blob is recorded (later reports, the working tree). All must equal crawl 1's. */
  otherBlobs: ReadonlyArray<{ source: string; blobSha: string }>;
}

/**
 * Refuses to run unless the taxonomy crawl 1 was classified under was
 * committed before crawl 1 started, and every later record names the same
 * blob. A taxonomy written after the data is a postdiction.
 */
export function assertTaxonomyPreRegistered(input: TaxonomyGateInput): void {
  if (input.firstCommitAt === null) {
    throw new AnalysisError(
      `no commit in this repository contains corpus/TAXONOMY.md blob ${input.crawl1BlobSha}, so its date cannot be checked. ` +
        "In a shallow clone, fetch full history first (git fetch --unshallow).",
      { blobSha: input.crawl1BlobSha },
    );
  }
  const committedMs = Date.parse(input.firstCommitAt);
  const startedMs = Date.parse(input.crawl1StartedAt);
  if (Number.isNaN(committedMs) || Number.isNaN(startedMs)) {
    throw new AnalysisError("taxonomy gate: unparseable timestamp", { firstCommitAt: input.firstCommitAt, crawl1StartedAt: input.crawl1StartedAt });
  }
  if (committedMs > startedMs) {
    throw new AnalysisError(
      `corpus/TAXONOMY.md blob ${input.crawl1BlobSha} was first committed at ${input.firstCommitAt}, ` +
        `after crawl 1 started at ${input.crawl1StartedAt}. The taxonomy is not pre-registered; refusing to run.`,
      { ...input },
    );
  }
  for (const other of input.otherBlobs) {
    if (other.blobSha !== input.crawl1BlobSha) {
      throw new AnalysisError(
        `${other.source} names corpus/TAXONOMY.md blob ${other.blobSha}, but crawl 1 was classified under ${input.crawl1BlobSha}. ` +
          "TAXONOMY.md is frozen; refusing to compare across two taxonomies.",
        { source: other.source },
      );
    }
  }
}

export interface Eligibility {
  eligible: boolean;
  reason: string | null;
}

export function headlineEligibility(n: number): Eligibility {
  return n >= HEADLINE_FLOOR
    ? { eligible: true, reason: null }
    : { eligible: false, reason: `n = ${n} servers captured in both crawls; the floor is ${HEADLINE_FLOOR}` };
}

export interface RiderCGate {
  met: boolean;
  reason: string;
}

export function riderCGate(semanticDriftRate: number, n: number): RiderCGate {
  if (n < HEADLINE_FLOOR) {
    return { met: false, reason: `rider C not run: n = ${n} is below the ${HEADLINE_FLOOR}-server floor, so prediction 3 is untested` };
  }
  if (semanticDriftRate < RIDER_C_RATE_GATE) {
    return {
      met: false,
      reason:
        `rider C not run: semantic-intent drift is ${semanticDriftRate.toFixed(3)}, below the ${RIDER_C_RATE_GATE.toFixed(2)} gate, ` +
        "so prediction 3 (conditional on drift >= 20%) is untested, neither confirmed nor refuted",
    };
  }
  return { met: true, reason: `gate met: semantic-intent drift ${semanticDriftRate.toFixed(3)} >= ${RIDER_C_RATE_GATE.toFixed(2)} and n = ${n} >= ${HEADLINE_FLOOR}` };
}

/** `ratePct` everywhere in drift.json: one decimal, or null below the floor. */
export function ratePct(count: number, of: number, eligible: boolean): number | null {
  if (!eligible || of === 0) {
    return null;
  }
  return Math.round((count / of) * 1000) / 10;
}
