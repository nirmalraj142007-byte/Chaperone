import { describe, expect, it } from "vitest";
import { findPlaceholders } from "../demo/placeholders.js";

describe("findPlaceholders", () => {
  it("finds a marker and reports its 1-based line and the matched text", () => {
    const hits = findPlaceholders("intro\nDrift rate: {{PENDING: drift rate — 2026-10-20}}\nend");
    expect(hits).toEqual([
      {
        line: 2,
        text: "Drift rate: {{PENDING: drift rate — 2026-10-20}}",
        matched: "{{PENDING: drift rate — 2026-10-20}}",
      },
    ]);
  });

  it("finds two markers on one line as two hits", () => {
    const hits = findPlaceholders("{{PENDING: a — b}} and {{PENDING: c — d}}");
    expect(hits.map((h) => h.matched)).toEqual(["{{PENDING: a — b}}", "{{PENDING: c — d}}"]);
  });

  it("is case- and spacing-tolerant, so a hand-typed variant cannot slip through", () => {
    expect(findPlaceholders("{{ pending : x — y }}")).toHaveLength(1);
  });

  it("skips a line that carries the allow marker (documentation of the syntax)", () => {
    expect(findPlaceholders("`{{PENDING: ...}}` <!-- check-placeholders:allow -->")).toEqual([]);
  });

  it("returns nothing for prose with no marker, including a bare word 'pending'", () => {
    expect(findPlaceholders("Baseline 2 is pending.\nNo braces here.")).toEqual([]);
  });
});
