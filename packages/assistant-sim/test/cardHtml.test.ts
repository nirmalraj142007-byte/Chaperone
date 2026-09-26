import { describe, expect, it } from "vitest";
import { CARD_CSP, withCsp } from "../src/cardHtml";

describe("withCsp", () => {
  it("puts the policy first in <head>, before any script or style can run", () => {
    const html = withCsp("<!doctype html><html><head><title>x</title></head><body></body></html>");
    expect(html.indexOf("Content-Security-Policy")).toBeGreaterThan(html.indexOf("<head>"));
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<title>"));
  });

  it("allows nothing by default: no network, no frames, no objects, no forms", () => {
    expect(CARD_CSP).toContain("default-src 'none'");
    expect(CARD_CSP).not.toMatch(/connect-src|frame-src|form-action|https?:|\*/);
  });

  it("does not interpret dollar sequences in the card as replacement patterns", () => {
    const html = withCsp("<head></head><p>$& $1</p>");
    expect(html).toContain("<p>$& $1</p>");
  });

  it("still applies to a document with no <head>", () => {
    expect(withCsp("<p>hi</p>").startsWith("<meta http-equiv=")).toBe(true);
  });
});
