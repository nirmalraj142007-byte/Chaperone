import { describe, expect, it } from "vitest";
import {
  CAPABILITY_RULES,
  CAPABILITY_RULES_BY_VERSION,
  CLASSIFIER_VERSION,
  classifyCapability,
  findCapabilityClassifierArtifacts,
} from "../src/capability.js";
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

describe("classifier versioning", () => {
  it("defaults CLASSIFIER_VERSION to v2", () => {
    expect(CLASSIFIER_VERSION).toBe("v2");
  });

  it("defaults classifyCapability to CLASSIFIER_VERSION when no version is given", () => {
    const withDefault = classifyCapability(tool("add_item", "Adds an item to your shopping list."));
    const withExplicitV2 = classifyCapability(tool("add_item", "Adds an item to your shopping list."), "v2");
    expect(withDefault).toEqual(withExplicitV2);
  });

  it("exports a rule table for every ClassifierVersion", () => {
    expect(Object.keys(CAPABILITY_RULES_BY_VERSION).sort()).toEqual(["v1", "v2"]);
  });

  it("CAPABILITY_RULES is the table for the current CLASSIFIER_VERSION", () => {
    expect(CAPABILITY_RULES).toBe(CAPABILITY_RULES_BY_VERSION[CLASSIFIER_VERSION]);
  });
});

describe("classifyCapability: v2 fixes the add_item under-classification (found 2026-09-20)", () => {
  // This is TAXONOMY.md's own Axis 2 `write` example, verbatim:
  // "add_to_list(item)". v1 had no verb matching "add", so this defaulted
  // to read/low — the exact bug this classifier version exists to fix.
  it("classifies add_item as write, high confidence under v2", () => {
    const verdict = classifyCapability(tool("add_item", "Adds an item to your shopping list."), "v2");
    expect(verdict.class).toBe("write");
    expect(verdict.confidence).toBe("high");
    expect(verdict.matchedRules).toContain("write");
  });

  it("still classifies add_item as read, low confidence under v1 — v1 is frozen, never patched in place", () => {
    const verdict = classifyCapability(tool("add_item", "Adds an item to your shopping list."), "v1");
    expect(verdict.class).toBe("read");
    expect(verdict.confidence).toBe("low");
  });

  it.each([
    ["insert_row", "Inserts a row into the table."],
    ["append_note", "Appends a note to the record."],
    ["clear_cart", "Clears every item from your cart."],
  ])("classifies %s as write, high confidence under v2", (name, description) => {
    const verdict = classifyCapability(tool(name, description), "v2");
    expect(verdict.class).toBe("write");
    expect(verdict.confidence).toBe("high");
  });

  it.each([
    ["insert_row", "Inserts a row into the table."],
    ["append_note", "Appends a note to the record."],
    ["clear_cart", "Clears every item from your cart."],
  ])("still classifies %s as read, low confidence under v1", (name, description) => {
    const verdict = classifyCapability(tool(name, description), "v1");
    expect(verdict.class).toBe("read");
    expect(verdict.confidence).toBe("low");
  });

  it("save matches only the bare form and third-person-singular under v2 (suffixes restricted to s)", () => {
    expect(classifyCapability(tool("save_link", "Save a new link to your library."), "v2").class).toBe("write");
    expect(classifyCapability(tool("t", "Saves the PDF to disk and returns the path."), "v2").class).toBe("write");
  });

  it("edit matches only ed/ing forms under v2 (suffixes restricted, bare form still matches)", () => {
    expect(classifyCapability(tool("edit_image", "Edit an existing image using a text prompt."), "v2").class).toBe(
      "write",
    );
    expect(classifyCapability(tool("t", "Edited the layer's opacity."), "v2").class).toBe("write");
  });

  it("remove matches only the bare form and third-person-singular under v2 (suffixes restricted to s)", () => {
    expect(classifyCapability(tool("remove_service", "Remove a service and all dependencies."), "v2").class).toBe(
      "write",
    );
    expect(classifyCapability(tool("t", "Calling again removes it from favourites."), "v2").class).toBe("write");
  });
});

describe("classifyCapability: v2 false-positive regressions found in crawl-1 evidence review", () => {
  it("does not fire write on 'edits' used as a plural noun", () => {
    const verdict = classifyCapability(
      tool("t", "Every following material row freezes, and edits to the original stop reaching it."),
      "v2",
    );
    expect(verdict.class).toBe("read");
    expect(verdict.confidence).toBe("low");
  });

  it("does not fire write on 'saved' used as an adjective describing pre-existing data", () => {
    const verdict = classifyCapability(tool("list_library", "Browse your saved icons."), "v2");
    expect(verdict.class).toBe("read");
    expect(verdict.confidence).toBe("low");
  });

  it("does not fire write on 'removed'/'removing' describing a fact other than this tool's own action", () => {
    expect(
      classifyCapability(
        tool("device_recall_search", "FDA medical-device recalls: devices removed from the market."),
        "v2",
      ).class,
    ).toBe("read");
    expect(
      classifyCapability(tool("read_page", "Extract the main readable content, removing navigation and ads."), "v2")
        .class,
    ).toBe("read");
  });

  it("does not add a write rule for 'modify' — deliberately excluded from v2", () => {
    const verdict = classifyCapability(tool("t", "Does not modify any pixel data."), "v2");
    expect(verdict.class).toBe("read");
    expect(verdict.confidence).toBe("low");
    expect(verdict.matchedRules).toEqual([]);
  });
});

describe("findCapabilityClassifierArtifacts", () => {
  it("returns empty when no crawl-2 sha256 matches a crawl-1 sha256", () => {
    const artifacts = findCapabilityClassifierArtifacts(
      [{ sha256: "aaa", capabilityClass: "read" }],
      [{ sha256: "bbb", capabilityClass: "write" }],
    );
    expect(artifacts).toEqual([]);
  });

  it("returns empty when matching sha256 rows agree on capability class", () => {
    const artifacts = findCapabilityClassifierArtifacts(
      [{ sha256: "aaa", capabilityClass: "read" }],
      [{ sha256: "aaa", capabilityClass: "read" }],
    );
    expect(artifacts).toEqual([]);
  });

  it("flags a matching sha256 whose capability class disagrees across crawls as a classifier artifact", () => {
    const artifacts = findCapabilityClassifierArtifacts(
      [{ sha256: "aaa", capabilityClass: "read" }],
      [{ sha256: "aaa", capabilityClass: "write" }],
    );
    expect(artifacts).toEqual([{ sha256: "aaa", crawl1Class: "read", crawl2Class: "write" }]);
  });
});
