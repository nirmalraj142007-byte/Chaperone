import { describe, expect, it } from "vitest";
import { loadAttackCorpus } from "../src/corpus.js";
import { buildBaselineReport, summarizeBaseline2ForReport, TAUTOLOGY_DISCLOSURE } from "../src/report.js";
import { findUnqualifiedAbsoluteChaperoneBlockRate, hasDeltaField } from "../src/guards.js";
import type { Baseline2ItemSummary } from "../src/baseline-model.js";
import type { Baseline2ControlItemSummary } from "../src/baseline2Controls.js";

describe("buildBaselineReport", () => {
  it("populates baseline 1's real detection and false-positive rates", () => {
    const corpus = loadAttackCorpus();
    const report = buildBaselineReport(corpus, () => new Date("2026-09-19T00:00:00.000Z"));

    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe("2026-09-19T00:00:00.000Z");
    expect(report.disclosure).toBe(TAUTOLOGY_DISCLOSURE);
    expect(report.corpus.attackItems).toBe(corpus.attacks.length);
    expect(report.corpus.benignControls).toBe(corpus.controls.length);
    expect(typeof report.baseline1RegexBlocklist.detectionRate).toBe("number");
    expect(typeof report.baseline1RegexBlocklist.falsePositiveRate).toBe("number");
  });

  it("reports baseline 2's fields as null and explicitly pending, never a fabricated number", () => {
    const corpus = loadAttackCorpus();
    const report = buildBaselineReport(corpus);

    expect(report.baseline2FrontierModelUnaided.detectionRate).toBeNull();
    expect(report.baseline2FrontierModelUnaided.falsePositiveRate).toBeNull();
    expect(report.baseline2FrontierModelUnaided.pending).toBe("provider unavailable");
    expect(report.baseline2FrontierModelUnaided.runsPerItem).toBe(3);
    expect(report.baseline2FrontierModelUnaided.scoringTaxonomy).toEqual(["refused", "followed", "ambiguous"]);
    expect(report.baseline2FrontierModelUnaided.ambiguousAdjudicationFile).toBe("data/baseline2-adjudication.json");
  });

  it("includes a delta field, null for now", () => {
    const corpus = loadAttackCorpus();
    const report = buildBaselineReport(corpus);
    expect(report).toHaveProperty("delta");
    expect(report.delta).toBeNull();
  });
});

/** Hand-built summaries standing in for a real runBaseline2Corpus/runBaseline2ControlCorpus result — not a real model run, only exercising the reduction math. */
function attackSummary(itemId: string, verdicts: readonly ("refused" | "followed" | "ambiguous")[]): Baseline2ItemSummary {
  const runs = verdicts.map((verdict, runIndex) => ({ itemId, runIndex, modelId: "test-model", verdict, rawResponseSha: "x".repeat(64) }));
  const refusedCount = verdicts.filter((v) => v === "refused").length;
  const followedCount = verdicts.filter((v) => v === "followed").length;
  const ambiguousCount = verdicts.filter((v) => v === "ambiguous").length;
  return {
    itemId,
    runs,
    refusedCount,
    followedCount,
    ambiguousCount,
    meanRefusalRate: refusedCount / verdicts.length,
    needsAdjudication: ambiguousCount > 0 || (refusedCount > 0 && followedCount > 0),
  };
}

function controlSummary(itemId: string, verdicts: readonly ("refused" | "followed" | "ambiguous")[]): Baseline2ControlItemSummary {
  const runs = verdicts.map((verdict, runIndex) => ({ itemId, runIndex, modelId: "test-model", verdict, rawResponseSha: "x".repeat(64) }));
  const refusedCount = verdicts.filter((v) => v === "refused").length;
  const followedCount = verdicts.filter((v) => v === "followed").length;
  const ambiguousCount = verdicts.filter((v) => v === "ambiguous").length;
  return {
    itemId,
    runs,
    refusedCount,
    followedCount,
    ambiguousCount,
    falsePositiveRate: refusedCount / verdicts.length,
    needsAdjudication: ambiguousCount > 0 || (refusedCount > 0 && followedCount > 0),
  };
}

describe("summarizeBaseline2ForReport", () => {
  it("computes a pooled detection rate across every attack run and a per-run breakdown", () => {
    const summaries = [
      attackSummary("a1", ["refused", "refused", "followed"]),
      attackSummary("a2", ["refused", "followed", "followed"]),
    ];
    const controls = [controlSummary("c1", ["followed", "followed", "followed"])];

    const result = summarizeBaseline2ForReport(summaries, controls, "test-model");

    expect(result.detectionRate).toBeCloseTo(3 / 6, 10);
    expect(result.perRunRefusalRate).toEqual([1, 0.5, 0]);
    expect(result.falsePositiveRate).toBe(0);
    expect(result.itemsTotal).toBe(2);
    expect(result.model).toBe("test-model");
  });

  it("counts items where all runs fully agreed", () => {
    const summaries = [
      attackSummary("a1", ["refused", "refused", "refused"]),
      attackSummary("a2", ["refused", "followed", "followed"]),
    ];
    const result = summarizeBaseline2ForReport(summaries, [], "test-model");
    expect(result.itemsFullyAgreed).toBe(1);
  });

  it("counts ambiguous items across both attacks and controls", () => {
    const summaries = [attackSummary("a1", ["ambiguous", "refused", "followed"])];
    const controls = [controlSummary("c1", ["ambiguous", "ambiguous", "ambiguous"])];
    const result = summarizeBaseline2ForReport(summaries, controls, "test-model");
    expect(result.ambiguousCount).toBe(2);
  });
});

describe("buildBaselineReport with a real baseline2 result", () => {
  it("replaces the pending placeholder with real numbers and computes delta as 1 - detectionRate", () => {
    const corpus = loadAttackCorpus();
    const real = summarizeBaseline2ForReport(
      [attackSummary("a1", ["refused", "refused", "followed"])],
      [controlSummary("c1", ["followed", "followed", "followed"])],
      "us.amazon.nova-pro-v1:0",
    );
    const report = buildBaselineReport(corpus, () => new Date("2026-10-20T00:00:00.000Z"), real);

    expect(report.baseline2FrontierModelUnaided).toEqual(real);
    expect(report.delta).toBeCloseTo(1 - real.detectionRate, 10);
  });

  it("never introduces an unqualified absolute Chaperone block rate and still carries a delta field", () => {
    const corpus = loadAttackCorpus();
    const real = summarizeBaseline2ForReport(
      [attackSummary("a1", ["refused", "refused", "refused"])],
      [controlSummary("c1", ["followed"])],
      "us.amazon.nova-pro-v1:0",
    );
    const report = buildBaselineReport(corpus, () => new Date(), real);

    expect(hasDeltaField(report)).toBe(true);
    expect(findUnqualifiedAbsoluteChaperoneBlockRate(report)).toEqual([]);
  });
});
