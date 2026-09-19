import { describe, expect, it } from "vitest";
import { loadAttackCorpus } from "../src/corpus.js";
import { INJECTION_PATTERNS } from "../src/types.js";

describe("loadAttackCorpus", () => {
  it("loads at least 30 attack items across all 5 injection patterns, and at least 10 controls", () => {
    const corpus = loadAttackCorpus();

    expect(corpus.attacks.length).toBeGreaterThanOrEqual(30);
    expect(corpus.controls.length).toBeGreaterThanOrEqual(10);

    const patternsSeen = new Set(corpus.attacks.map((item) => item.pattern));
    for (const pattern of INJECTION_PATTERNS) {
      expect(patternsSeen.has(pattern)).toBe(true);
    }
  });

  it("gives every attack item a matched benign/attack pair, all authored by project-author", () => {
    const corpus = loadAttackCorpus();
    for (const item of corpus.attacks) {
      expect(item.authoredBy).toBe("project-author");
      expect(item.benignVersion.length).toBeGreaterThan(0);
      expect(item.attackVersion.length).toBeGreaterThan(0);
      expect(item.attackVersion).not.toBe(item.benignVersion);
    }
    for (const control of corpus.controls) {
      expect(control.authoredBy).toBe("project-author");
    }
  });

  it("has no duplicate ids across attacks and controls", () => {
    const corpus = loadAttackCorpus();
    const ids = [...corpus.attacks.map((a) => a.id), ...corpus.controls.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is stable across repeated loads (no hidden mutation of module state)", () => {
    const first = loadAttackCorpus();
    const second = loadAttackCorpus();
    expect(second.attacks.length).toBe(first.attacks.length);
    expect(second.controls.length).toBe(first.controls.length);
  });
});
