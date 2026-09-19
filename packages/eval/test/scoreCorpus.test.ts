import { describe, expect, it } from "vitest";
import { loadAttackCorpus } from "../src/corpus.js";
import { scoreBaseline1 } from "../src/scoreCorpus.js";
import { INJECTION_PATTERNS } from "../src/types.js";

describe("scoreBaseline1", () => {
  it("computes a real detection rate and a real false-positive rate against the committed corpus", () => {
    const corpus = loadAttackCorpus();
    const result = scoreBaseline1(corpus);

    expect(result.totalAttacks).toBe(corpus.attacks.length);
    expect(result.totalBenign).toBe(corpus.attacks.length + corpus.controls.length);

    // A blocklist that flags everything scores 100% and means nothing —
    // corpus/attacks/README.md. Assert both rates are real numbers in
    // [0, 1], not that they hit any particular value: the honest floor is
    // allowed to be mediocre.
    expect(result.detectionRate).toBeGreaterThanOrEqual(0);
    expect(result.detectionRate).toBeLessThanOrEqual(1);
    expect(result.falsePositiveRate).toBeGreaterThanOrEqual(0);
    expect(result.falsePositiveRate).toBeLessThanOrEqual(1);

    // A perfect 100% blocklist would be the "flags everything" failure
    // mode this whole design exists to catch — assert it didn't happen.
    expect(result.falsePositiveRate).toBeLessThan(1);
  });

  it("breaks detection down per pattern, covering all 5 patterns", () => {
    const corpus = loadAttackCorpus();
    const result = scoreBaseline1(corpus);

    expect(result.perPattern.map((p) => p.pattern).sort()).toEqual([...INJECTION_PATTERNS].sort());
    for (const breakdown of result.perPattern) {
      expect(breakdown.total).toBeGreaterThan(0);
      expect(breakdown.detected).toBeLessThanOrEqual(breakdown.total);
    }
  });

  it("counts and rates agree with each other (rate = count / total)", () => {
    const corpus = loadAttackCorpus();
    const result = scoreBaseline1(corpus);
    expect(result.detectionRate).toBeCloseTo(result.detectedCount / result.totalAttacks, 10);
    expect(result.falsePositiveRate).toBeCloseTo(result.falsePositiveCount / result.totalBenign, 10);
  });

  it("handles an empty corpus without dividing by zero", () => {
    const result = scoreBaseline1({ attacks: [], controls: [] });
    expect(result.detectionRate).toBe(0);
    expect(result.falsePositiveRate).toBe(0);
  });
});
