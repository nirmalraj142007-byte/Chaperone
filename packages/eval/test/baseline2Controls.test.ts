import { describe, expect, it } from "vitest";
import { MockModelProvider } from "@chaperone/advisory";
import { UpstreamError } from "@chaperone/errors";
import {
  buildBaseline2ControlPrompt,
  runBaseline2ControlCorpus,
  runBaseline2ControlItem,
  type Baseline2ControlClassifier,
} from "../src/baseline2Controls.js";
import { loadAttackCorpus } from "../src/corpus.js";
import type { BenignControlItem } from "../src/types.js";

const control: BenignControlItem = loadAttackCorpus().controls[0]!;

const alwaysRefused: Baseline2ControlClassifier = () => "refused";
const alwaysFollowed: Baseline2ControlClassifier = () => "followed";

describe("buildBaseline2ControlPrompt", () => {
  it("embeds the control's description and tool name, with a generic neutral request", () => {
    const prompt = buildBaseline2ControlPrompt(control);
    expect(prompt).toContain(control.description);
    expect(prompt).toContain(control.toolName);
    expect(prompt).toContain("ordinary");
  });
});

describe("runBaseline2ControlItem", () => {
  it("calls the provider once and classifies its response via the supplied classifier", async () => {
    const provider = new MockModelProvider({ respond: () => ({ text: "Sure, done.", modelId: "mock-v1" }) });
    const result = await runBaseline2ControlItem(provider, control, 0, alwaysFollowed);

    expect(result.itemId).toBe(control.id);
    expect(result.runIndex).toBe(0);
    expect(result.modelId).toBe("mock-v1");
    expect(result.verdict).toBe("followed");
    expect(result.rawResponseSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("propagates a provider failure rather than silently returning a verdict", async () => {
    const provider = new MockModelProvider({ throwOn: () => new UpstreamError("simulated failure", {}) });
    await expect(runBaseline2ControlItem(provider, control, 0, alwaysRefused)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("invokes the raw-response listener with the verdict and full text before returning", async () => {
    const provider = new MockModelProvider({ respond: () => ({ text: "the real text", modelId: "mock-v1" }) });
    const seen: unknown[] = [];
    await runBaseline2ControlItem(provider, control, 2, alwaysFollowed, (info) => seen.push(info));
    expect(seen).toEqual([{ itemId: control.id, runIndex: 2, verdict: "followed", text: "the real text" }]);
  });
});

describe("runBaseline2ControlCorpus", () => {
  it("runs the default runs-per-item for every control and computes a false-positive rate", async () => {
    const provider = new MockModelProvider({ respond: () => ({ text: "I can't do that.", modelId: "mock-v1" }) });
    const [summary] = await runBaseline2ControlCorpus(provider, [control], alwaysRefused, 3);

    expect(summary!.runs).toHaveLength(3);
    expect(summary!.refusedCount).toBe(3);
    expect(summary!.falsePositiveRate).toBe(1);
    expect(summary!.needsAdjudication).toBe(false);
  });

  it("flags needsAdjudication when runs disagree", async () => {
    let callCount = 0;
    const cycling: Baseline2ControlClassifier = () => (callCount++ % 2 === 0 ? "refused" : "followed");
    const provider = new MockModelProvider({ respond: () => ({ text: "response", modelId: "mock-v1" }) });

    const [summary] = await runBaseline2ControlCorpus(provider, [control], cycling, 2);
    expect(summary!.needsAdjudication).toBe(true);
  });
});
