import { describe, expect, it } from "vitest";
import { TEXT_CARD_DECISION_LINE, approvalFromCardHtml, classify, isTextCard } from "../src/outcome";
import type { Block } from "../src/gateway";

const REFUSAL = "any frozen words";
const TEXT_CARD = `Tool changed: add_item\n\n${TEXT_CARD_DECISION_LINE}`;
const text = (t: string): Block => ({ type: "text", text: t });
const card = (uri = "ui://chaperone/consent/Q1"): Block => ({ type: "resource", uri, mimeType: "text/html;profile=mcp-app", text: "<html></html>" });

describe("classify", () => {
  it("a result that is not an error ran", () => {
    expect(classify({ isError: false, blocks: [text("Added 1 × batteries"), text("more")] })).toEqual({ kind: "ok", text: "Added 1 × batteries\nmore" });
  });

  it("the frozen refusal with an interactive card and a text card is held, with both, and the refusal verbatim", () => {
    const result = classify({ isError: true, blocks: [text(REFUSAL), text(TEXT_CARD), card()] });
    expect(result).toEqual({ kind: "held", refusal: REFUSAL, card: { html: "<html></html>", resourceUri: "ui://chaperone/consent/Q1", text: TEXT_CARD } });
  });

  it("the refusal with only the text card (MCP Apps switched off) is held, with no html", () => {
    const result = classify({ isError: true, blocks: [text(REFUSAL), text(TEXT_CARD)] });
    expect(result).toMatchObject({ kind: "held", refusal: REFUSAL, card: { html: undefined, text: TEXT_CARD } });
  });

  it("an error with no card is just an error, its words untouched (unpinned, upstream unavailable, a bad argument)", () => {
    expect(classify({ isError: true, blocks: [text("The service is unavailable.")] })).toEqual({ kind: "error", text: "The service is unavailable." });
  });

  it("a resource block that is not one of this gateway's consent cards does not make a result held", () => {
    expect(classify({ isError: true, blocks: [text("boom"), card("ui://someone-else/panel")] }).kind).toBe("error");
  });

  it("a successful result that happens to carry a card is still just ok: only an error can be a refusal", () => {
    expect(classify({ isError: false, blocks: [text("fine"), card()] }).kind).toBe("ok");
  });
});

describe("isTextCard", () => {
  it("recognises an undecided text card by its decision line", () => {
    expect(isTextCard(TEXT_CARD)).toBe(true);
  });

  it("is false for text that is not a card", () => {
    expect(isTextCard("Added 1 × batteries")).toBe(false);
  });
});

describe("approvalFromCardHtml", () => {
  it("reads the first item's quarantine id and token from the HTML card's data attributes", () => {
    const html = '<div class="pending-content" id="a" data-quarantine-id="Q1" data-approval-token="T1"></div><div data-quarantine-id="Q2" data-approval-token="T2"></div>';
    expect(approvalFromCardHtml(html)).toEqual({ quarantineId: "Q1", approvalToken: "T1" });
  });

  it("is undefined for HTML with no undecided item", () => {
    expect(approvalFromCardHtml("<html><p>Kept blocked</p></html>")).toBeUndefined();
  });
});
