import { describe, expect, it } from "vitest";
import { EXAMPLE_PHRASES, TOOLS, interpret, normalise } from "../src/rules";

function call(utterance: string) {
  const result = interpret(utterance);
  if (result.kind !== "call") throw new Error(`expected a tool call for "${utterance}", got a reply: ${result.text}`);
  return result;
}

describe("the rule-based stand-in: utterances map to fixed tool calls", () => {
  it.each([
    ["add batteries to my list", { item: "batteries" }],
    ["Add batteries to my list.", { item: "batteries" }],
    ["please add batteries", { item: "batteries" }],
    ["could you add batteries to the shopping list please", { item: "batteries" }],
    ["add 3 bananas", { item: "bananas", quantity: 3 }],
    ["add three bananas to my list", { item: "bananas", quantity: 3 }],
    ["put a jar of jam on my list", { item: "jar of jam" }],
    ["we need oat milk", { item: "oat milk" }],
    ["we're out of eggs", { item: "eggs" }],
    ["pick up 2 loaves of bread", { item: "loaves of bread", quantity: 2 }],
  ])('"%s" -> add_item %j', (utterance, args) => {
    const step = call(utterance);
    expect(step.tool).toBe(TOOLS.addItem);
    expect(step.args).toEqual(args);
    expect(step.ruleId).toBe("add-item");
  });

  it.each(["what's on my list", "What is on my shopping list?", "read my list", "show me the list", "check my cart"])('"%s" -> read_list', (utterance) => {
    expect(call(utterance)).toMatchObject({ tool: TOOLS.readList, args: {}, ruleId: "read-list" });
  });

  it.each(["place my order", "Place my order.", "check out", "submit the order", "order everything", "buy everything on my list"])('"%s" -> place_order', (utterance) => {
    expect(call(utterance)).toMatchObject({ tool: TOOLS.placeOrder, args: { confirm: true }, ruleId: "place-order" });
  });

  it.each(["where's my delivery", "track my order", "where is my delivery?", "how far is the driver from my order"])('"%s" -> track_delivery', (utterance) => {
    expect(call(utterance)).toMatchObject({ tool: TOOLS.trackDelivery, ruleId: "track-delivery" });
  });

  it.each(["is anything waiting for my review", "any pending changes?", "what changed", "is anything held"])('"%s" -> chaperone/pending_changes', (utterance) => {
    expect(call(utterance)).toMatchObject({ tool: TOOLS.pendingChanges, ruleId: "pending-changes" });
  });

  it("is deterministic: the same words give the same call every time", () => {
    const first = JSON.stringify(interpret("add batteries to my list"));
    for (let i = 0; i < 20; i++) expect(JSON.stringify(interpret("add batteries to my list"))).toBe(first);
  });

  it("every example phrase it shows the resident actually works, and names a tool the gateway lists", () => {
    const known = new Set<string>(Object.values(TOOLS));
    for (const { phrase } of EXAMPLE_PHRASES) {
      const step = interpret(phrase);
      expect(step.kind).toBe("call");
      if (step.kind === "call") expect(known.has(step.tool)).toBe(true);
    }
  });
});

describe("words that are not a request", () => {
  it("greets, and calls nothing", () => {
    expect(interpret("hello")).toMatchObject({ kind: "reply", ruleId: "greeting" });
  });

  it("help lists the example phrases", () => {
    const step = interpret("what can you do?");
    expect(step).toMatchObject({ kind: "reply", ruleId: "help" });
    if (step.kind === "reply") for (const { phrase } of EXAMPLE_PHRASES) expect(step.text).toContain(phrase);
  });

  it("unmatched input gets a helpful reply that lists what does work and says why", () => {
    const step = interpret("sing me a song about pasta");
    expect(step.kind).toBe("reply");
    if (step.kind === "reply") {
      expect(step.ruleId).toBe("unmatched");
      expect(step.text).toContain("rule-based stand-in");
      for (const { phrase } of EXAMPLE_PHRASES) expect(step.text).toContain(phrase);
    }
  });

  it("empty input is unmatched, not a call", () => {
    expect(interpret("   ").kind).toBe("reply");
  });

  it('"add" with nothing after it asks what to add instead of calling add_item with junk', () => {
    expect(interpret("add it to my list")).toMatchObject({ kind: "reply", ruleId: "add-item" });
    expect(interpret("add").kind).toBe("reply");
  });

  it("an out-of-range quantity is part of the item's name, not a quantity add_item would reject", () => {
    expect(call("add 500 stickers").args).toEqual({ item: "500 stickers" });
  });
});

describe("normalise", () => {
  it("drops filler and end punctuation only", () => {
    expect(normalise("  Hey, could you please Add   Batteries to my list!!  ")).toBe("add batteries to my list");
    expect(normalise("add batteries for me please")).toBe("add batteries");
  });
});
