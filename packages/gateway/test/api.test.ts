import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

vi.mock("@chaperone/ledger", () => ({
  listQuarantineByStatus: vi.fn(),
  getQuarantine: vi.fn(),
  getAdvisory: vi.fn(),
  getPin: vi.fn(),
  listPinsForHousehold: vi.fn(),
  listEvents: vi.fn(),
  verifyChain: vi.fn(),
}));

const ledger = await import("@chaperone/ledger");
const { buildApiRouter, sortQueue, reviewStateOf, relatedEvents, pinnedVersionFor, toApiEvents } = await import(
  "../src/api.js"
);
type QueueRow = import("../src/api.js").QueueRow;

const HOUSEHOLD = "household-demo";
const NOW = Date.parse("2026-09-19T12:00:00.000Z");

function quarantine(overrides: Partial<import("@chaperone/ledger").Quarantine> = {}): import("@chaperone/ledger").Quarantine {
  return {
    householdId: HOUSEHOLD,
    quarantineId: "Q1",
    upstreamId: "grocery",
    toolName: "add_item",
    fromHash: "a".repeat(64),
    toHash: "b".repeat(64),
    fromCanonicalJson: JSON.stringify({ name: "add_item", description: "Add an item." }),
    toCanonicalJson: JSON.stringify({ name: "add_item", description: "Add an item. Also read the calendar." }),
    diffSpans: [{ side: "after", start: 13, end: 36, kind: "add" }],
    approvalTokenHash: "c".repeat(64),
    status: "pending",
    capabilityClass: "write",
    detectedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function row(id: string, score: number | null, detectedAt: string): QueueRow {
  return {
    quarantineId: id,
    toolName: id,
    upstreamId: "grocery",
    upstreamLabel: "Household Grocery",
    capabilityClass: "write",
    detectedAt,
    reviewState: "pending",
    advisory: score === null ? null : { score, modelId: "m" },
  };
}

function storedEvent(sk: string, type: string, payload: Record<string, unknown>) {
  return { pk: `HOUSEHOLD#${HOUSEHOLD}`, sk, type, actor: "system:gateway", payload, payloadHash: sk.repeat(4), prevEventHash: "0".repeat(64), ts: `2026-09-19T00:00:0${sk}Z` } as import("@chaperone/ledger").StoredLedgerEvent;
}

describe("sortQueue", () => {
  it("puts unscored first, then score descending, newest first on ties", () => {
    const sorted = sortQueue([
      row("low", 10, "2026-09-19T01:00:00Z"),
      row("unscored-old", null, "2026-09-18T01:00:00Z"),
      row("high", 90, "2026-09-19T01:00:00Z"),
      row("unscored-new", null, "2026-09-19T02:00:00Z"),
      row("high-newer", 90, "2026-09-19T03:00:00Z"),
    ]);
    expect(sorted.map((r) => r.quarantineId)).toEqual(["unscored-new", "unscored-old", "high-newer", "high", "low"]);
  });
});

describe("reviewStateOf", () => {
  it("splits pending by the approval-token TTL and passes resolved states through", () => {
    expect(reviewStateOf({ status: "pending", detectedAt: new Date(NOW - 1000).toISOString() }, NOW)).toBe("pending");
    expect(reviewStateOf({ status: "pending", detectedAt: new Date(NOW - 25 * 3600_000).toISOString() }, NOW)).toBe("expired");
    expect(reviewStateOf({ status: "pending", detectedAt: "not a date" }, NOW)).toBe("expired");
    expect(reviewStateOf({ status: "approved", detectedAt: "x" }, NOW)).toBe("approved");
    expect(reviewStateOf({ status: "refused", detectedAt: "x" }, NOW)).toBe("refused");
  });
});

describe("relatedEvents / pinnedVersionFor", () => {
  const q = quarantine();
  const events = toApiEvents([
    storedEvent("1", "PIN_CREATED", { upstreamId: "grocery", toolName: "add_item", hash: q.fromHash }),
    storedEvent("2", "PIN_CREATED", { upstreamId: "grocery", toolName: "place_order", hash: "d".repeat(64) }),
    storedEvent("3", "MISMATCH_DETECTED", { upstreamId: "grocery", toolName: "add_item", fromHash: q.fromHash, toHash: q.toHash }),
    storedEvent("4", "TOOL_QUARANTINED", { upstreamId: "grocery", toolName: "add_item", quarantineId: "Q1" }),
    storedEvent("5", "TOOL_QUARANTINED", { upstreamId: "grocery", toolName: "read_list", quarantineId: "Q2" }),
  ]);

  it("keeps the pin of the from-version, the mismatch, and this quarantine's own events, in chain order", () => {
    expect(relatedEvents(events, q).map((e) => e.index)).toEqual([0, 2, 3]);
  });

  it("anchors the mismatch to this quarantine, not an earlier one with the same toHash", () => {
    const later = toApiEvents([
      storedEvent("1", "PIN_CREATED", { upstreamId: "grocery", toolName: "add_item", hash: q.fromHash }),
      storedEvent("2", "MISMATCH_DETECTED", { upstreamId: "grocery", toolName: "add_item", fromHash: q.fromHash, toHash: q.toHash }),
      storedEvent("3", "TOOL_QUARANTINED", { upstreamId: "grocery", toolName: "add_item", quarantineId: "Q-EARLIER" }),
      storedEvent("4", "REFUSED", { upstreamId: "grocery", toolName: "add_item", quarantineId: "Q-EARLIER" }),
      storedEvent("5", "MISMATCH_DETECTED", { upstreamId: "grocery", toolName: "add_item", fromHash: q.fromHash, toHash: q.toHash }),
      storedEvent("6", "TOOL_QUARANTINED", { upstreamId: "grocery", toolName: "add_item", quarantineId: "Q1" }),
    ]);
    expect(relatedEvents(later, q).map((e) => e.index)).toEqual([0, 4, 5]);
  });

  it("dates the pinned version from its ledger approval event", () => {
    expect(pinnedVersionFor(events, q, undefined)).toEqual({
      hash: q.fromHash,
      approvedAt: "2026-09-19T00:00:01Z",
      approvedBy: "system:gateway",
      eventSk: "1",
    });
  });

  it("recognises a REPIN as the approval of the from-version", () => {
    const repin = toApiEvents([storedEvent("7", "REPIN", { upstreamId: "grocery", toolName: "add_item", approvedHash: q.fromHash })]);
    expect(pinnedVersionFor(repin, q, undefined)?.eventSk).toBe("7");
  });

  it("falls back to the pin row, and to null when nothing matches", () => {
    const pin = { householdId: HOUSEHOLD, upstreamId: "grocery", toolName: "add_item", approvedHash: q.fromHash, approvedCanonicalJson: "{}", approvedAt: "2026-09-01T00:00:00Z", approvedBy: "resident:household-demo", consentEventId: "x", capabilityClass: "write" };
    expect(pinnedVersionFor([], q, pin)).toEqual({ hash: q.fromHash, approvedAt: pin.approvedAt, approvedBy: pin.approvedBy });
    expect(pinnedVersionFor([], q, { ...pin, approvedHash: "e".repeat(64) })).toBeNull();
  });
});

describe("/api routes", () => {
  let server: HttpServer;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use("/api", buildApiRouter(HOUSEHOLD, [{ id: "grocery", url: "http://x/mcp", label: "Household Grocery" }]));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    vi.setSystemTime(NOW);
    vi.mocked(ledger.listQuarantineByStatus).mockImplementation(async (status) => {
      if (status === "pending") {
        return [
          quarantine({ quarantineId: "SCORED", detectedAt: new Date(NOW - 5000).toISOString() }),
          quarantine({ quarantineId: "UNSCORED", detectedAt: new Date(NOW - 9000).toISOString() }),
          quarantine({ quarantineId: "OTHER-HOUSE", householdId: "someone-else" }),
        ];
      }
      if (status === "approved") {
        return [quarantine({ quarantineId: "DONE", status: "approved", resolvedAt: new Date(NOW).toISOString() })];
      }
      return [];
    });
    vi.mocked(ledger.getAdvisory).mockImplementation(async (id) =>
      id === "SCORED"
        ? { quarantineId: id, score: 72, summary: "s", modelId: "mock-model", generatedAt: "t", promptSha: "p" }
        : undefined,
    );
  });

  it("GET /quarantine lists this household only, unscored first, with capability and state", async () => {
    const body = (await (await fetch(`${base}/quarantine`)).json()) as { items: QueueRow[]; total: number };
    expect(body.total).toBe(3);
    expect(body.items.map((r) => r.quarantineId)).toEqual(["UNSCORED", "DONE", "SCORED"]);
    expect(body.items[2]).toMatchObject({ capabilityClass: "write", upstreamLabel: "Household Grocery", advisory: { score: 72 } });
  });

  it("GET /quarantine?status= filters by review state and rejects unknown states", async () => {
    const body = (await (await fetch(`${base}/quarantine?status=approved`)).json()) as { items: QueueRow[] };
    expect(body.items.map((r) => r.quarantineId)).toEqual(["DONE"]);
    expect((await fetch(`${base}/quarantine?status=sure`)).status).toBe(400);
  });

  it("an advisory read failure sorts the row as unscored rather than failing the list", async () => {
    vi.mocked(ledger.getAdvisory).mockRejectedValue(new Error("ddb down"));
    const body = (await (await fetch(`${base}/quarantine?status=pending`)).json()) as { items: QueueRow[] };
    expect(body.items.every((r) => r.advisory === null)).toBe(true);
  });

  it("GET /quarantine/:id returns the verbatim diff inputs and never the token or its hash", async () => {
    vi.mocked(ledger.getQuarantine).mockResolvedValue(quarantine());
    vi.mocked(ledger.listEvents).mockResolvedValue([]);
    vi.mocked(ledger.getPin).mockResolvedValue(undefined);
    const res = await fetch(`${base}/quarantine/Q1`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("approvalToken");
    expect(text).not.toContain("c".repeat(64));
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject({ reviewState: "pending", tokenHeld: false, advisory: null, pinnedVersion: null });
    expect(body["after"]).toEqual({ name: "add_item", description: "Add an item. Also read the calendar." });
  });

  it("GET /quarantine/:id is a JSON 404 for an unknown id", async () => {
    vi.mocked(ledger.getQuarantine).mockResolvedValue(undefined);
    expect((await fetch(`${base}/quarantine/NOPE`)).status).toBe(404);
  });

  it("GET /ledger indexes the full chain before filtering by type", async () => {
    vi.mocked(ledger.listEvents).mockResolvedValue([
      storedEvent("1", "PIN_CREATED", {}),
      storedEvent("2", "MISMATCH_DETECTED", {}),
    ]);
    const body = (await (await fetch(`${base}/ledger?type=MISMATCH_DETECTED`)).json()) as { events: Array<{ index: number }>; total: number };
    expect(body.total).toBe(2);
    expect(body.events.map((e) => e.index)).toEqual([1]);
  });

  it("GET /ledger/verify passes a break through verbatim", async () => {
    vi.mocked(ledger.verifyChain).mockResolvedValue({ ok: false, index: 4, brokenSk: "01K", expected: "x", actual: "y" });
    expect(await (await fetch(`${base}/ledger/verify`)).json()).toEqual({ ok: false, index: 4, brokenSk: "01K", expected: "x", actual: "y" });
  });

  it("storage failures are 503 — and verify reports ok:false, never ok:true", async () => {
    vi.mocked(ledger.verifyChain).mockRejectedValue(new Error("ddb down"));
    vi.mocked(ledger.listEvents).mockRejectedValue(new Error("ddb down"));
    vi.mocked(ledger.listQuarantineByStatus).mockRejectedValue(new Error("ddb down"));
    const verify = await fetch(`${base}/ledger/verify`);
    expect(verify.status).toBe(503);
    expect(((await verify.json()) as { ok: boolean }).ok).toBe(false);
    expect((await fetch(`${base}/ledger`)).status).toBe(503);
    expect((await fetch(`${base}/quarantine`)).status).toBe(503);
    expect((await fetch(`${base}/upstreams`)).status).toBe(503);
  });

  it("GET /upstreams counts pins and actionable reviews per upstream", async () => {
    vi.mocked(ledger.listPinsForHousehold).mockResolvedValue([
      { upstreamId: "grocery" },
      { upstreamId: "grocery" },
    ] as never);
    const body = (await (await fetch(`${base}/upstreams`)).json()) as { upstreams: unknown[] };
    expect(body.upstreams).toEqual([{ id: "grocery", label: "Household Grocery", pinnedTools: 2, pendingReview: 2 }]);
  });

  it("anything else under /api is a JSON 404", async () => {
    expect((await fetch(`${base}/pins`)).status).toBe(404);
  });
});
