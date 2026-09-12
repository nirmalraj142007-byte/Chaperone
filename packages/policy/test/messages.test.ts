import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REFUSAL_MESSAGES,
  REFUSAL_TOOL_CHANGED,
  REFUSAL_TOOL_UNPINNED,
  REFUSAL_UPSTREAM_UNAVAILABLE,
} from "../src/messages.js";

const sourcePath = fileURLToPath(new URL("../src/messages.ts", import.meta.url));
const source = readFileSync(sourcePath, "utf8");

describe("frozen refusal messages", () => {
  it("are plain, non-empty string literals", () => {
    for (const value of [REFUSAL_TOOL_CHANGED, REFUSAL_TOOL_UNPINNED, REFUSAL_UPSTREAM_UNAVAILABLE]) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("contain no leftover interpolation syntax", () => {
    for (const value of [REFUSAL_TOOL_CHANGED, REFUSAL_TOOL_UNPINNED, REFUSAL_UPSTREAM_UNAVAILABLE]) {
      expect(value).not.toContain("${");
    }
  });

  it("are declared as plain literals in source — no template interpolation and no + concatenation", () => {
    const declarationBlock = source.slice(0, source.indexOf("REFUSAL_MESSAGES"));
    expect(declarationBlock).not.toContain("${");
    expect(declarationBlock).not.toMatch(/REFUSAL_\w+\s*=[\s\S]*?\+/);
  });

  it("REFUSAL_MESSAGES is frozen", () => {
    expect(Object.isFrozen(REFUSAL_MESSAGES)).toBe(true);
    expect(() => {
      (REFUSAL_MESSAGES as unknown as Record<string, string>)["TOOL_CHANGED"] = "tampered";
    }).toThrow();
    expect(REFUSAL_MESSAGES.TOOL_CHANGED).toBe(REFUSAL_TOOL_CHANGED);
  });

  it("distinguishes 'this tool changed' from 'the server is unavailable'", () => {
    expect(REFUSAL_UPSTREAM_UNAVAILABLE).not.toBe(REFUSAL_TOOL_CHANGED);
    expect(REFUSAL_UPSTREAM_UNAVAILABLE).not.toBe(REFUSAL_TOOL_UNPINNED);
    expect(REFUSAL_TOOL_CHANGED.toLowerCase()).toMatch(/chang/);
    expect(REFUSAL_UPSTREAM_UNAVAILABLE.toLowerCase()).not.toMatch(/\bchanged\b/);
    expect(REFUSAL_UPSTREAM_UNAVAILABLE.toLowerCase()).toMatch(/reach|server|connection/);
  });
});
