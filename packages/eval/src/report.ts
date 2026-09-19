import { BASELINE2_RUNS_PER_ITEM, BASELINE2_VERDICTS, BASELINE2_ADJUDICATION_FILE } from "./baseline-model.js";
import { scoreBaseline1, type Baseline1Result } from "./scoreCorpus.js";
import { INJECTION_PATTERNS, type LoadedCorpus } from "./types.js";

/**
 * Reproduced verbatim in the main README once it's written — CLAUDE.md #7's
 * required disclosure, and the same sentence corpus/attacks/README.md
 * states in full. Exported as a named constant, not copy-pasted, so the two
 * places that must say the same thing about the same fact can never drift
 * apart from each other.
 */
export const TAUTOLOGY_DISCLOSURE =
  "Chaperone's own block rate against an author-written corpus is near-tautological and is reported only as a delta against baseline 2.";

export const BASELINES_REPORT_SCHEMA_VERSION = 1;

export interface BaselineReport {
  schemaVersion: number;
  generatedAt: string;
  disclosure: string;
  corpus: {
    attackItems: number;
    injectionPatterns: readonly string[];
    benignControls: number;
    pairedBenignVersions: number;
  };
  baseline1RegexBlocklist: Baseline1Result;
  baseline2FrontierModelUnaided: {
    detectionRate: null;
    falsePositiveRate: null;
    pending: "provider unavailable";
    runsPerItem: number;
    scoringTaxonomy: readonly string[];
    ambiguousAdjudicationFile: string;
  };
  /**
   * CLAUDE.md #7: Chaperone's own block rate against this corpus is only
   * ever reported as (chaperone block rate) - (baseline 2 detection rate).
   * Both operands are currently unmeasured — Chaperone's own block rate
   * isn't computed by this package at all (that's the gateway's quarantine
   * mechanism, not eval tooling), and baseline 2 has no provider — so this
   * is null until both exist. See guards.ts / test/guards.test.ts, which
   * assert this key exists and that no unqualified absolute ever appears
   * outside it.
   */
  delta: null;
}

/** Pure and synchronous — no file I/O here; scripts/build-report.ts owns writing data/baselines.json, so this function is trivial to unit-test against an in-memory corpus. */
export function buildBaselineReport(corpus: LoadedCorpus, now: () => Date = () => new Date()): BaselineReport {
  return {
    schemaVersion: BASELINES_REPORT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    disclosure: TAUTOLOGY_DISCLOSURE,
    corpus: {
      attackItems: corpus.attacks.length,
      injectionPatterns: INJECTION_PATTERNS,
      benignControls: corpus.controls.length,
      pairedBenignVersions: corpus.attacks.length,
    },
    baseline1RegexBlocklist: scoreBaseline1(corpus),
    baseline2FrontierModelUnaided: {
      detectionRate: null,
      falsePositiveRate: null,
      pending: "provider unavailable",
      runsPerItem: BASELINE2_RUNS_PER_ITEM,
      scoringTaxonomy: BASELINE2_VERDICTS,
      ambiguousAdjudicationFile: BASELINE2_ADJUDICATION_FILE,
    },
    delta: null,
  };
}
