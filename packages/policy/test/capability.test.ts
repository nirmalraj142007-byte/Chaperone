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

  it("exports the rule table with the exact verb families from the taxonomy", () => {
    const transactRule = CAPABILITY_RULES.find((rule) => rule.class === "transact");
    expect(transactRule?.verbs).toEqual([
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
