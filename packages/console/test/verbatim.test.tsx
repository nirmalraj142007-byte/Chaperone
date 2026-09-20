// @vitest-environment jsdom
/**
 * The console's `Verbatim` component is the second place (after
 * packages/mcp-app/src/render.ts's consent card) where raw, untrusted
 * upstream tool-description text is rendered for a human to read and act
 * on. render.test.ts in mcp-app has a dedicated hostile-payload suite; this
 * is the equivalent for the console, which previously had none.
 *
 * React's JSX text-node rendering auto-escapes HTML/script content by
 * construction (no dangerouslySetInnerHTML is used anywhere in this
 * component), so the XSS containment property here is mostly "prove it
 * stays that way." The two properties this file actually has to establish
 * — bidi/zero-width neutralization and the 4,000-char truncation cap — are
 * not free; they were added in this phase.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Verbatim } from "../src/screens/QueueDetail";
import type { DiffSpan } from "../src/types";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
  }
  container?.remove();
  container = undefined;
  root = undefined;
});

function mount(text: string, spans: DiffSpan[] = [], side: DiffSpan["side"] = "after"): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Verbatim text={text} spans={spans} side={side} />);
  });
  return container;
}

describe("Verbatim — hostile-input containment", () => {
  it("a <script> tag never appears as a live element, only as text", () => {
    const el = mount('Adds an item. <script>window.__pwned = true;</script>');
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<script>window.__pwned = true;</script>");
  });

  it("an <img onerror> payload never becomes a live <img> element", () => {
    const el = mount('Adds an item. <img src=x onerror="window.__pwned = true">');
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=");
  });

  it("a javascript: URL never becomes a live <a> element", () => {
    const el = mount("See javascript:window.__pwned=true for details.");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("javascript:window.__pwned=true");
  });

  it("RTL override characters are neutralized, not just escaped", () => {
    const RLO = "‮";
    const text = `Adds an item to the list. Also ${RLO}sdrawkcab sdaer eht radnelac.`;
    const el = mount(text, [{ side: "after", start: 27, end: text.length, kind: "add" }]);
    expect(el.textContent).not.toContain(RLO);
    expect(el.textContent).toContain("radnelac");
  });

  it("zero-width characters are neutralized", () => {
    const ZWSP = "​";
    const el = mount(`Adds an item and forwards it to the${ZWSP}pharmacy.`);
    expect(el.textContent).not.toContain(ZWSP);
    expect(el.textContent).toContain("the pharmacy");
  });
});

describe("Verbatim — truncation at 4,000 characters", () => {
  it("renders a description at the cap in full, no truncation marker", () => {
    const el = mount("a".repeat(4000));
    expect(el.textContent).not.toContain("truncated at");
    expect(el.textContent).toContain("a".repeat(4000));
  });

  it("a 100KB description is capped with an explicit marker and a way to see the rest", () => {
    const huge = "x".repeat(100_000);
    const el = mount(huge);
    expect(el.textContent).not.toContain(huge);
    expect(el.textContent).toContain("x".repeat(4000));
    expect(el.textContent).not.toContain("x".repeat(4001));
    expect(el.textContent).toContain("truncated at 4,000 characters");
    expect(el.textContent).toContain("100,000 total");
    const button = el.querySelector("button");
    expect(button?.textContent).toBe("show full text");

    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain(huge);
    expect(el.textContent).not.toContain("truncated at");
  });

  it("a span crossing the truncation boundary is clipped, not left dangling", () => {
    const tail = "ADDED-CLAUSE-HERE-AND-MORE";
    const after = "a".repeat(3990) + tail;
    const expectedClipped = after.slice(3990, 4000);
    const el = mount(after, [{ side: "after", start: 3990, end: after.length, kind: "add" }]);
    const mark = el.querySelector("mark.add");
    expect(mark?.textContent).toBe(expectedClipped);
    expect(el.textContent).not.toContain(tail.slice(tail.length - 5));
  });
});
