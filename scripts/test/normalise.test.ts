import { describe, expect, it } from "vitest";
import { normaliseDump, normalisedText } from "../demo/normalise.js";

const ULID_A = "01K8X3M9Q2W7E5R1T4Y6A8B0CD";
const ULID_B = "01K8X3M9Q2W7E5R1T4Y6V8H0JK";

describe("normaliseDump", () => {
  it("replaces ULIDs, in keys and inside other strings, and counts them", () => {
    const { dump, stats } = normaliseDump({
      pin: [{ pk: "HOUSEHOLD#h", sk: "UPSTREAM#g#TOOL#t", consentEventId: ULID_A, note: `see ${ULID_B}` }],
    });
    expect(dump["pin"]?.[0]).toEqual({ pk: "HOUSEHOLD#h", sk: "UPSTREAM#g#TOOL#t", consentEventId: "<ulid>", note: "see <ulid>" });
    expect(stats.ulids).toBe(2);
  });

  it("masks wall-clock timestamps but never the staged 12 January instants", () => {
    const { dump, stats } = normaliseDump({
      "ledger-event": [
        { pk: "p", sk: "1", ts: "2026-01-12T10:30:00.000Z" },
        { pk: "p", sk: "2", ts: "2026-01-12T10:30:03.000Z" },
        { pk: "p", sk: "3", ts: "2026-09-23T14:05:11.123Z" },
      ],
    });
    expect(dump["ledger-event"]?.map((r) => r["ts"])).toEqual([
      "2026-01-12T10:30:00.000Z",
      "2026-01-12T10:30:03.000Z",
      "<timestamp>",
    ]);
    expect(stats.timestamps).toBe(1);
  });

  it("keeps any extra instant the caller says is fixed by design", () => {
    const { stats } = normaliseDump(
      { advisory: [{ pk: "x", generatedAt: "2026-09-23T00:00:00.000Z" }] },
      { keepTimestamps: ["2026-09-23T00:00:00.000Z"] },
    );
    expect(stats.timestamps).toBe(0);
  });

  it("a staged instant that drifted is a difference, not something to mask", () => {
    const a = normalisedText({ pin: [{ pk: "p", sk: "a", approvedAt: "2026-01-12T10:30:00.000Z" }] }).text;
    const b = normalisedText({ pin: [{ pk: "p", sk: "a", approvedAt: "2026-01-13T10:30:00.000Z" }] }).text;
    expect(a).not.toBe(b);
  });

  it("does not mask a hash: a differing eventHash is a real difference", () => {
    const a = normalisedText({ "ledger-event": [{ pk: "p", sk: "1", eventHash: "aaaa" }] }).text;
    const b = normalisedText({ "ledger-event": [{ pk: "p", sk: "1", eventHash: "bbbb" }] }).text;
    expect(a).not.toBe(b);
  });

  it("does not care about scan order or key order", () => {
    const a = normalisedText({
      pin: [
        { pk: "p", sk: "a", x: 1 },
        { pk: "p", sk: "b", y: 2 },
      ],
    }).text;
    const b = normalisedText({
      pin: [
        { sk: "b", pk: "p", y: 2 },
        { sk: "a", x: 1, pk: "p" },
      ],
    }).text;
    expect(a).toBe(b);
  });

  it("two dumps that differ only in ULIDs and wall-clock times normalise to the same text", () => {
    const one = { "ledger-event": [{ pk: "p", sk: ULID_A, ts: "2026-09-23T14:00:00.000Z" }] };
    const two = { "ledger-event": [{ pk: "p", sk: ULID_B, ts: "2026-09-23T14:09:59.999Z" }] };
    expect(normalisedText(one).text).toBe(normalisedText(two).text);
  });
});
