import { describe, expect, it } from "vitest";
import { estimateServerCapability } from "../src/capabilityEstimate.js";

describe("estimateServerCapability", () => {
  it("classifies a pure read/search description as read", () => {
    expect(estimateServerCapability("PubMed", "Search biomedical literature across 36 million citations.")).toBe(
      "read",
    );
  });

  it("classifies a state-mutating description with no money or messaging as write", () => {
    expect(estimateServerCapability("Shopping List", "Add, update, and remove items from your list.")).toBe("write");
  });

  it("classifies a description that moves money as transact", () => {
    expect(estimateServerCapability("Grocery Reorder", "Reorder your last purchase and check out with one call.")).toBe(
      "transact",
    );
  });

  it("classifies a description that messages a third party as communicate", () => {
    expect(estimateServerCapability("Gmail", "Read, search, and send Gmail messages.")).toBe("communicate");
  });

  it("applies the taxonomy's transact > communicate > write > read priority order", () => {
    expect(
      estimateServerCapability("Grocery", "Add items to your list, then send a text confirmation and place the order."),
    ).toBe("transact");
    expect(estimateServerCapability("Grocery", "Add items to your list, then send a text confirmation.")).toBe(
      "communicate",
    );
  });
});
