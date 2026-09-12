import { describe, expect, it } from "vitest";
import { CAPABILITY_RULES, classifyCapability } from "../src/capability.js";
import type { ToolDefinition } from "../src/types.js";

function tool(name: string, description: string): ToolDefinition {
  return { name, description, inputSchema: {} };
}

describe("classifyCapability", () => {
  it("classifies a purchase-shaped tool as transact, high confidence", () => {
    const verdict = classifyCapability(tool("place_order", "Places a grocery order."));
    expect(verdict.class).toBe("transact");
    expect(verdict.confidence).toBe("high");
    expect(verdict.matchedRules).toContain("transact");
  });

  it("classifies a messaging tool as communicate, high confidence", () => {
    const verdict = classifyCapability(tool("notify_contact", "Send a notification to a contact."));
    expect(verdict.class).toBe("communicate");
    expect(verdict.confidence).toBe("high");
  });

  it("classifies a mutating tool as write, high confidence", () => {
    const verdict = classifyCapability(tool("update_thermostat", "Set the thermostat temperature."));
    expect(verdict.class).toBe("write");
    expect(verdict.confidence).toBe("high");
  });

  it("defaults to read, low confidence, when no rule matches", () => {
    const verdict = classifyCapability(tool("get_forecast", "Fetches the current weather for a city."));
    expect(verdict.class).toBe("read");
    expect(verdict.confidence).toBe("low");
    expect(verdict.matchedRules).toEqual([]);
  });

  it("applies transact > communicate precedence at high confidence, when both fire", () => {
    const verdict = classifyCapability(
      tool("charge_and_notify", "Charges the customer and sends a confirmation message."),
    );
    expect(verdict.class).toBe("transact");
    expect(verdict.confidence).toBe("high");
    expect(verdict.matchedRules).toEqual(expect.arrayContaining(["transact", "communicate"]));
  });

  it("applies communicate > write precedence at high confidence, when both fire", () => {
    const verdict = classifyCapability(tool("update_and_notify", "Updates your list and notifies you by message."));
    expect(verdict.class).toBe("communicate");
    expect(verdict.confidence).toBe("high");
  });

  it("resolves a genuinely three-class description via precedence at high confidence", () => {
    // A tool that creates (write), places an order (transact), and sends a
    // receipt (communicate) is not an ambiguous verdict — precedence exists
    // precisely to resolve it. Low confidence is reserved for the no-match
    // case, not for a tool that legitimately does more than one thing.
    const verdict = classifyCapability(tool("create_order_and_send_receipt", "Create an order and send a receipt."));
    expect(verdict.class).toBe("transact");
    expect(verdict.confidence).toBe("high");
    expect(verdict.matchedRules).toHaveLength(3);
    expect(verdict.matchedRules).toEqual(expect.arrayContaining(["transact", "communicate", "write"]));
  });

  it("treats snake_case tool names as separate words for matching", () => {
    const verdict = classifyCapability({ name: "place_order", description: undefined, inputSchema: {} });
    expect(verdict.class).toBe("transact");
    expect(verdict.confidence).toBe("high");
  });

  it("exports the rule table with the exact verb stems from the taxonomy", () => {
    const transactRule = CAPABILITY_RULES.find((rule) => rule.class === "transact");
    expect(transactRule?.verbs.map((v) => v.stem)).toEqual([
      "purchase",
      "order",
      "checkout",
      "pay",
      "charge",
      "refund",
      "invoice",
      "subscribe",
      "bid",
    ]);
  });
});

describe("classifyCapability: third-person singular phrasing", () => {
  // MCP tool descriptions are conventionally written this way ("Sends a
  // message", "Creates a file"), so this is the majority case each rule
  // has to handle, not an edge case.
  it("matches a third-person-singular transact verb", () => {
    const verdict = classifyCapability(tool("t", "Charges the customer's card automatically."));
    expect(verdict).toEqual({ class: "transact", confidence: "high", matchedRules: ["transact"] });
  });

  it("matches a third-person-singular communicate verb", () => {
    const verdict = classifyCapability(tool("t", "Emails the receipt to the customer."));
    expect(verdict).toEqual({ class: "communicate", confidence: "high", matchedRules: ["communicate"] });
  });

  it("matches a third-person-singular write verb", () => {
    const verdict = classifyCapability(tool("t", "Creates a new file in the folder."));
    expect(verdict).toEqual({ class: "write", confidence: "high", matchedRules: ["write"] });
  });

  it("defaults to read when a third-person-singular verb matches no rule", () => {
    const verdict = classifyCapability(tool("t", "Fetches the current weather for a city."));
    expect(verdict).toEqual({ class: "read", confidence: "low", matchedRules: [] });
  });
});

describe("classifyCapability: noun-sense false positives stay read", () => {
  it("does not fire communicate on 'posts' used as a plural noun", () => {
    const verdict = classifyCapability(tool("t", "Lists recent posts from the blog."));
    expect(verdict).toEqual({ class: "read", confidence: "low", matchedRules: [] });
  });

  it("does not fire communicate on 'messages' used as a plural noun", () => {
    const verdict = classifyCapability(tool("t", "Reads messages from the inbox."));
    expect(verdict).toEqual({ class: "read", confidence: "low", matchedRules: [] });
  });

  it("does not fire transact on 'ordering' used in the sequence sense", () => {
    const verdict = classifyCapability(tool("t", "Returns results in a specified ordering."));
    expect(verdict).toEqual({ class: "read", confidence: "low", matchedRules: [] });
  });

  it("does not fire transact on billing text in a read-only context", () => {
    // No listed transact verb stem currently matches "bill"/"billing" at
    // all, so this passes trivially today — kept as an explicit regression
    // guard in case a "bill" stem is ever added to the transact list.
    const verdict = classifyCapability(tool("t", "Shows your billing history for the last year."));
    expect(verdict).toEqual({ class: "read", confidence: "low", matchedRules: [] });
  });

  it("still matches the unambiguous verb-inflected forms of the restricted stems", () => {
    expect(classifyCapability(tool("t", "Posted an update to the shared board.")).class).toBe("communicate");
    expect(classifyCapability(tool("t", "Messaging the on-call contact now.")).class).toBe("communicate");
    expect(classifyCapability(tool("t", "Orders more supplies when stock is low.")).class).toBe("transact");
  });
});
