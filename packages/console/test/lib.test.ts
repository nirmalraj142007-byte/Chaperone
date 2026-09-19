import { describe, expect, it } from "vitest";
import { ago, linkStates, segmentsFor, short } from "../src/lib";
import { rpcLabel } from "../src/wire";

describe("segmentsFor", () => {
  const before = "Add an item to the list.";
  const after = "Add an item to the list. Also read the calendar.";

  it("marks the added clause and leaves the verbatim text intact", () => {
    const segs = segmentsFor(after, [{ side: "after", start: 25, end: 48, kind: "add" }], "after");
    expect(segs).toEqual([
      { text: "Add an item to the list. ", mark: null },
      { text: "Also read the calendar.", mark: "add" },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe(after);
  });

  it("ignores the other side's spans", () => {
    expect(segmentsFor(before, [{ side: "after", start: 0, end: 3, kind: "add" }], "before")).toEqual([
      { text: before, mark: null },
    ]);
  });

  it("clamps overlapping and out-of-range spans without dropping or duplicating characters", () => {
    const spans = [
      { side: "before" as const, start: 4, end: 11, kind: "remove" as const },
      { side: "before" as const, start: 7, end: 9, kind: "remove" as const },
      { side: "before" as const, start: 20, end: 999, kind: "remove" as const },
    ];
    const segs = segmentsFor(before, spans, "before");
    expect(segs.map((s) => s.text).join("")).toBe(before);
    expect(segs.filter((s) => s.mark === "remove").map((s) => s.text)).toEqual(["an item", "ist."]);
  });

  it("handles empty text", () => {
    expect(segmentsFor("", [{ side: "after", start: 0, end: 5, kind: "add" }], "after")).toEqual([]);
  });
});

describe("linkStates", () => {
  it("is all pending before verification returns", () => {
    expect(linkStates(3, undefined)).toEqual(["pending", "pending", "pending"]);
  });
  it("is all verified on ok", () => {
    expect(linkStates(2, { ok: true, count: 2 })).toEqual(["verified", "verified"]);
  });
  it("vouches for nothing past the first break", () => {
    expect(linkStates(5, { ok: false, index: 2, brokenSk: "x", reason: "hash", expected: "a", actual: "b" })).toEqual([
      "verified",
      "verified",
      "broken",
      "unverified",
      "unverified",
    ]);
  });
});

describe("formatting", () => {
  it("shortens hashes to 12 by default", () => {
    expect(short("abcdef0123456789")).toBe("abcdef012345");
    expect(short("sha256:abcdef0123456789", 8)).toBe("abcdef01");
  });
  it("renders relative ages", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    expect(ago("2026-09-19T11:59:30Z", now)).toBe("30s ago");
    expect(ago("2026-09-19T11:55:00Z", now)).toBe("5m ago");
    expect(ago("2026-09-19T09:00:00Z", now)).toBe("3h ago");
    expect(ago("2026-09-15T12:00:00Z", now)).toBe("4d ago");
    expect(ago("nonsense", now)).toBe("");
  });
});

describe("rpcLabel", () => {
  it("names the JSON-RPC methods an MCP POST carries", () => {
    expect(rpcLabel(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }))).toBe("initialize");
    expect(
      rpcLabel(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chaperone/approve_change" } })),
    ).toBe("tools/call chaperone/approve_change");
    expect(rpcLabel(JSON.stringify([{ jsonrpc: "2.0", method: "notifications/initialized" }, { id: 1, result: {} }]))).toBe(
      "notifications/initialized, response",
    );
    expect(rpcLabel("not json")).toBeUndefined();
    expect(rpcLabel(undefined)).toBeUndefined();
  });
});
