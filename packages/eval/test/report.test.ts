import { describe, expect, it } from "vitest";
import { loadAttackCorpus } from "../src/corpus.js";
import { buildBaselineReport, TAUTOLOGY_DISCLOSURE } from "../src/report.js";

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
