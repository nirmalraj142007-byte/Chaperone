import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

vi.mock("@chaperone/ledger", () => ({
  nextSseSeq: vi.fn(),
  putSseEvent: vi.fn(),
  listSseEventsSince: vi.fn(),
  sseEventTtl: vi.fn(() => 1_900_000_000),
}));

const { createSessionEventStore } = await import("../src/event-store.js");
const ledger = await import("@chaperone/ledger");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ledger.sseEventTtl).mockReturnValue(1_900_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const resultMessage: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } };

describe("createSessionEventStore", () => {
  it("storeEvent mints a monotonic per-stream seq via nextSseSeq and persists eventId as {streamId}:{seq}", async () => {
    vi.mocked(ledger.nextSseSeq).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    vi.mocked(ledger.putSseEvent).mockResolvedValue(undefined);

    const store = createSessionEventStore("session-1");
    const first = await store.storeEvent("stream-a", resultMessage);
    const second = await store.storeEvent("stream-a", resultMessage);

    expect(first).toBe("stream-a:1");
    expect(second).toBe("stream-a:2");
    expect(ledger.nextSseSeq).toHaveBeenNthCalledWith(1, "session-1", "stream-a");
    expect(ledger.putSseEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: "session-1", streamId: "stream-a", seq: 1, eventId: "stream-a:1" }),
    );
  });

  it("replayEventsAfter sends only events with seq strictly greater than the parsed Last-Event-ID, in order", async () => {
    vi.mocked(ledger.listSseEventsSince).mockResolvedValueOnce([
      {
        sessionId: "session-1",
        streamId: "stream-a",
        seq: 2,
        eventId: "stream-a:2",
        message: JSON.stringify(resultMessage),
        ts: "2026-09-14T00:00:00.000Z",
        ttl: 1_900_000_000,
      },
      {
        sessionId: "session-1",
        streamId: "stream-a",
        seq: 3,
        eventId: "stream-a:3",
        message: JSON.stringify(resultMessage),
        ts: "2026-09-14T00:00:01.000Z",
        ttl: 1_900_000_000,
      },
    ]);

    const store = createSessionEventStore("session-1");
    const sent: string[] = [];
    const streamId = await store.replayEventsAfter("stream-a:1", {
      send: async (eventId) => {
        sent.push(eventId);
      },
    });

    expect(streamId).toBe("stream-a");
    expect(sent).toEqual(["stream-a:2", "stream-a:3"]);
    expect(ledger.listSseEventsSince).toHaveBeenCalledWith("session-1", "stream-a", 1);
  });

  it("never replays a different stream than the one encoded in the Last-Event-ID", async () => {
    vi.mocked(ledger.listSseEventsSince).mockResolvedValueOnce([]);
    const store = createSessionEventStore("session-1");
    await store.replayEventsAfter("stream-b:5", { send: async () => {} });
    expect(ledger.listSseEventsSince).toHaveBeenCalledWith("session-1", "stream-b", 5);
  });

  it("a malformed Last-Event-ID does not throw — it logs and starts a fresh stream", async () => {
    const store = createSessionEventStore("session-1");
    const send = vi.fn(async () => {});

    await expect(store.replayEventsAfter("not-a-valid-event-id", { send })).resolves.toEqual(expect.any(String));
    expect(send).not.toHaveBeenCalled();
    expect(ledger.listSseEventsSince).not.toHaveBeenCalled();
  });

  it("an unparseable trailing sequence does not throw — it logs and starts a fresh stream", async () => {
    const store = createSessionEventStore("session-1");
    const streamId = await store.replayEventsAfter("stream-a:not-a-number", { send: async () => {} });
    expect(typeof streamId).toBe("string");
    expect(streamId.length).toBeGreaterThan(0);
  });

  it("a storage failure during replay does not throw into the transport — it starts a fresh stream", async () => {
    vi.mocked(ledger.listSseEventsSince).mockRejectedValueOnce(new Error("DynamoDB unreachable"));
    const store = createSessionEventStore("session-1");
    const streamId = await store.replayEventsAfter("stream-a:1", { send: async () => {} });
    expect(typeof streamId).toBe("string");
    expect(streamId.length).toBeGreaterThan(0);
  });
});
