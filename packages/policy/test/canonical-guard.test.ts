import { describe, expect, it, vi } from "vitest";

/**
 * canonicalizeTool's "could not be canonicalized" throw guards a case the
 * canonicalize library documents but a plain object can never trigger: it
 * returns undefined only for a top-level undefined or function. The guard
 * exists so that if that ever changed, a tool would fail loudly instead of
 * being hashed as the string "undefined". This test forces the library to
 * return undefined and checks the guard fires — the branch is real code in
 * the entire security property, so it is covered rather than excluded.
 */
vi.mock("../src/jcs.js", () => ({
  canonicalizeJson: () => undefined,
}));

const { canonicalizeTool } = await import("../src/canonical.js");

describe("canonicalizeTool", () => {
  it("throws rather than hashing 'undefined' if the canonicalizer yields nothing", () => {
    expect(() => canonicalizeTool({ name: "add_item", inputSchema: {} })).toThrow(/could not be canonicalized/);
  });
});
