import { describe, expect, it } from "vitest";
import { MockModelProvider } from "@chaperone/advisory";
import { UpstreamError } from "@chaperone/errors";
import {
  BASELINE2_RUNS_PER_ITEM,
  buildBaseline2Prompt,
  runBaseline2Corpus,
  runBaseline2Item,
  type Baseline2Classifier,
} from "../src/baseline-model.js";
import { loadAttackCorpus } from "../src/corpus.js";
import type { AttackCorpusItem } from "../src/types.js";

const item: AttackCorpusItem = loadAttackCorpus().attacks[0]!;

/** A trivial stand-in classifier: never reads real model output for meaning, only proves the harness plumbs `classify`'s verdict through correctly. */
const alwaysRefused: Baseline2Classifier = () => "refused";
const alwaysFollowed: Baseline2Classifier = () => "followed";
const alwaysAmbiguous: Baseline2Classifier = () => "ambiguous";

describe("buildBaseline2Prompt", () => {
  it("embeds the item's attackVersion verbatim, including its injected clause", () => {
    const prompt = buildBaseline2Prompt(item);
    expect(prompt).toContain(item.attackVersion);
    expect(prompt).toContain(item.userRequest);
    expect(prompt).toContain(item.toolName);
  });
});

describe("runBaseline2Item", () => {
  it("calls the provider once and classifies its response via the supplied classifier", async () => {
    const provider = new MockModelProvider({ respond: () => ({ text: "Sure, here you go.", modelId: "mock-v1" }) });
    const result = await runBaseline2Item(provider, item, 0, alwaysFollowed);

    expect(result.itemId).toBe(item.id);
    expect(result.runIndex).toBe(0);
    expect(result.modelId).toBe("mock-v1");
    expect(result.verdict).toBe("followed");
    expect(result.rawResponseSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("propagates a provider failure rather than silently returning a verdict", async () => {
    const provider = new MockModelProvider({
      throwOn: () => new UpstreamError("simulated failure", {}),
    });
    await expect(runBaseline2Item(provider, item, 0, alwaysRefused)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("runBaseline2Corpus", () => {
  it("runs BASELINE2_RUNS_PER_ITEM runs per item and summarizes mean refusal rate and disagreement", async () => {
    let callCount = 0;
    // Alternate refused/followed/ambiguous across calls so the summary's
    // disagreement detection has something real to catch.
    const cyclingClassifier: Baseline2Classifier = () => {
      const verdicts = ["refused", "followed", "ambiguous"] as const;
      return verdicts[callCount++ % verdicts.length]!;
    };
    const provider = new MockModelProvider({ respond: () => ({ text: "response", modelId: "mock-v1" }) });

    const [summary] = await runBaseline2Corpus(provider, [item], cyclingClassifier);

    expect(summary!.runs).toHaveLength(BASELINE2_RUNS_PER_ITEM);
    expect(summary!.refusedCount + summary!.followedCount + summary!.ambiguousCount).toBe(BASELINE2_RUNS_PER_ITEM);
    expect(summary!.needsAdjudication).toBe(true);
    expect(summary!.meanRefusalRate).toBeCloseTo(summary!.refusedCount / BASELINE2_RUNS_PER_ITEM, 10);
  });

  it("flags needsAdjudication when every run agrees but the verdict is ambiguous", async () => {
    const provider = new MockModelProvider({ respond: () => ({ text: "unclear", modelId: "mock-v1" }) });
    const [summary] = await runBaseline2Corpus(provider, [item], alwaysAmbiguous, 2);
    expect(summary!.needsAdjudication).toBe(true);
  });

  it("does not flag needsAdjudication when every run agrees on refused", async () => {
    const provider = new MockModelProvider({ respond: () => ({ text: "I can't do that.", modelId: "mock-v1" }) });
    const [summary] = await runBaseline2Corpus(provider, [item], alwaysRefused, 2);
    expect(summary!.needsAdjudication).toBe(false);
    expect(summary!.meanRefusalRate).toBe(1);
  });
});
