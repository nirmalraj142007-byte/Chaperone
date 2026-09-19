import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { PutCommand, QueryCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LedgerWriteError, PolicyViolationError } from "@chaperone/errors";
import { resetConfigForTests } from "@chaperone/config";
import { resetDdbClientForTests } from "../src/client.js";
import { appendEvent, GENESIS_EVENT_HASH, hashEvent, verifyChain, type StoredLedgerEvent } from "../src/repos/ledgerEvent.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

/** In-memory stand-in for the ledger-event table, keyed by pk, ordered by insertion (== sk order, since ULIDs are lexicographically time-ordered). */
let store: StoredLedgerEvent[];

function conditionalCheckFailed(): Error {
  return Object.assign(new Error("conflict"), { name: "ConditionalCheckFailedException" });
}

let previousUpstreams: string | undefined;
let previousHouseholdId: string | undefined;

beforeEach(() => {
  previousUpstreams = process.env["CHAPERONE_UPSTREAMS"];
  previousHouseholdId = process.env["HOUSEHOLD_ID"];
  process.env["CHAPERONE_UPSTREAMS"] = JSON.stringify([
    { id: "grocery", url: "http://localhost:4001/mcp", label: "Grocery" },
  ]);
  process.env["HOUSEHOLD_ID"] = "household-test";
  resetConfigForTests();
  resetDdbClientForTests();
  ddbMock.reset();
  store = [];

  ddbMock.on(QueryCommand).callsFake((input: { ScanIndexForward?: boolean }) => {
    if (input.ScanIndexForward === false) {
      const tail = store[store.length - 1];
      return { Items: tail ? [tail] : [] };
    }
    return { Items: [...store] };
  });

  ddbMock.on(PutCommand).callsFake((input: { Item: StoredLedgerEvent }) => {
    if (store.some((e) => e.sk === input.Item.sk)) {
      throw conditionalCheckFailed();
    }
    store.push(input.Item);
    return {};
  });
});

afterEach(() => {
  ddbMock.reset();
  if (previousUpstreams === undefined) {
    delete process.env["CHAPERONE_UPSTREAMS"];
  } else {
    process.env["CHAPERONE_UPSTREAMS"] = previousUpstreams;
  }
  if (previousHouseholdId === undefined) {
    delete process.env["HOUSEHOLD_ID"];
  } else {
    process.env["HOUSEHOLD_ID"] = previousHouseholdId;
  }
  resetConfigForTests();
  resetDdbClientForTests();
});

describe("appendEvent", () => {
  it("chains the first event in a household's partition onto the genesis hash", async () => {
    const { prevEventHash } = await appendEvent({
      householdId: "household-test",
      type: "PIN_CREATED",
      actor: "resident:demo",
      payload: { toolName: "list_shopping_list" },
    });
    expect(prevEventHash).toBe(GENESIS_EVENT_HASH);
    expect(store).toHaveLength(1);
  });

  it("chains a second event onto the first event's eventHash", async () => {
    const first = await appendEvent({
      householdId: "household-test",
      type: "CONSENT_SHOWN",
      actor: "resident:demo",
      payload: { toolName: "list_shopping_list" },
    });
    const second = await appendEvent({
      householdId: "household-test",
      type: "APPROVED",
      actor: "resident:demo",
      payload: { toolName: "list_shopping_list" },
    });
    expect(second.prevEventHash).toBe(first.eventHash);
    expect(store).toHaveLength(2);
  });

  it("rejects actor 'model' with PolicyViolationError before making any DynamoDB call", async () => {
    await expect(
      appendEvent({
        householdId: "household-test",
        type: "APPROVED",
        actor: "model",
        payload: {},
      }),
    ).rejects.toBeInstanceOf(PolicyViolationError);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it("retries once with a fresh ULID when it loses a race on attribute_not_exists(sk)", async () => {
    let putCalls = 0;
    ddbMock.on(PutCommand).callsFake((input: { Item: StoredLedgerEvent }) => {
      putCalls++;
      if (putCalls === 1) {
        throw conditionalCheckFailed();
      }
      store.push(input.Item);
      return {};
    });

    const result = await appendEvent({
      householdId: "household-test",
      type: "PIN_CREATED",
      actor: "resident:demo",
      payload: { toolName: "x" },
    });

    expect(putCalls).toBe(2);
    expect(store).toHaveLength(1);
    expect(store[0]?.sk).toBe(result.eventId);
  });

  it("fails closed with LedgerWriteError when the race is lost twice in a row", async () => {
    ddbMock.on(PutCommand).callsFake(() => {
      throw conditionalCheckFailed();
    });

    await expect(
      appendEvent({
        householdId: "household-test",
        type: "PIN_CREATED",
        actor: "resident:demo",
        payload: { toolName: "x" },
      }),
    ).rejects.toBeInstanceOf(LedgerWriteError);
    expect(store).toHaveLength(0);
  });
});

describe("verifyChain", () => {
  it("reports ok:true for an untouched chain of appended events", async () => {
    await appendEvent({
      householdId: "household-test",
      type: "CONSENT_SHOWN",
      actor: "resident:demo",
      payload: { a: 1 },
    });
    await appendEvent({
      householdId: "household-test",
      type: "APPROVED",
      actor: "resident:demo",
      payload: { b: 2 },
    });
    await appendEvent({
      householdId: "household-test",
      type: "PIN_CREATED",
      actor: "resident:demo",
      payload: { c: 3 },
    });

    await expect(verifyChain("household-test")).resolves.toEqual({ ok: true, count: 3 });
  });

  it("reports ok:true with count 0 for a household with no events", async () => {
    await expect(verifyChain("household-test")).resolves.toEqual({ ok: true, count: 0 });
  });

  it("detects a tampered payload as a break at that event's own index", async () => {
    await appendEvent({
      householdId: "household-test",
      type: "CONSENT_SHOWN",
      actor: "resident:demo",
      payload: { a: 1 },
    });
    const second = await appendEvent({
      householdId: "household-test",
      type: "APPROVED",
      actor: "resident:demo",
      payload: { b: 2 },
    });
    await appendEvent({
      householdId: "household-test",
      type: "PIN_CREATED",
      actor: "resident:demo",
      payload: { c: 3 },
    });

    const target = store.find((e) => e.sk === second.eventId);
    expect(target).toBeDefined();
    // simulate `aws dynamodb update-item` mutating the payload directly, without touching eventHash
    target!.payload = { b: "tampered" };

    const result = await verifyChain("household-test");
    expect(result).toEqual({
      ok: false,
      index: 1,
      brokenSk: second.eventId,
      reason: "hash",
      expected: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      actual: second.eventHash,
    });
  });

  it("detects a broken prevEventHash chain link", async () => {
    await appendEvent({
      householdId: "household-test",
      type: "CONSENT_SHOWN",
      actor: "resident:demo",
      payload: { a: 1 },
    });
    const second = await appendEvent({
      householdId: "household-test",
      type: "APPROVED",
      actor: "resident:demo",
      payload: { b: 2 },
    });

    const target = store.find((e) => e.sk === second.eventId);
    target!.prevEventHash = "sha256:" + "f".repeat(64);

    const result = await verifyChain("household-test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.index).toBe(1);
      expect(result.brokenSk).toBe(second.eventId);
      // prevEventHash is itself hashed, so editing it is caught as a self-integrity break first.
      expect(result.reason).toBe("hash");
    }
  });

  // The three vectors found in Phase 14. spec/ledger-tamper.test.ts runs the
  // same three against real DynamoDB Local; these are the fast in-memory guard.
  describe("full-identity hash (Phase 14 regressions)", () => {
    const colliding = { upstreamId: "grocery", toolName: "add_item", quarantineId: "Q1" };

    async function fourEventChain() {
      const ids: string[] = [];
      for (const [type, actor, payload] of [
        ["PIN_CREATED", "resident:demo", { hash: "sha256:aa" }],
        ["TOOL_QUARANTINED", "system:gateway", colliding],
        ["CONSENT_SHOWN", "system:gateway", colliding],
        ["APPROVED", "resident:demo", { ...colliding, decision: "approve" }],
      ] as const) {
        const { eventId } = await appendEvent({ householdId: "household-test", type, actor, payload: { ...payload } });
        ids.push(eventId);
      }
      return ids;
    }

    it("detects an edited type as a hash break at that index", async () => {
      const ids = await fourEventChain();
      store[3]!.type = "REFUSED";
      await expect(verifyChain("household-test")).resolves.toMatchObject({ ok: false, index: 3, brokenSk: ids[3], reason: "hash" });
    });

    it("detects an edited actor as a hash break at that index", async () => {
      const ids = await fourEventChain();
      store[1]!.actor = "resident:someone-else";
      await expect(verifyChain("household-test")).resolves.toMatchObject({ ok: false, index: 1, brokenSk: ids[1], reason: "hash" });
    });

    it("detects an edited ts as a hash break at that index", async () => {
      const ids = await fourEventChain();
      store[2]!.ts = "2020-01-01T00:00:00.000Z";
      await expect(verifyChain("household-test")).resolves.toMatchObject({ ok: false, index: 2, brokenSk: ids[2], reason: "hash" });
    });

    it("gives payload-identical neighbours distinct hashes, because each commits to its predecessor", async () => {
      await fourEventChain();
      expect(store[1]!.payload).toEqual(store[2]!.payload);
      expect(store[1]!.eventHash).not.toBe(store[2]!.eventHash);
    });

    it("detects deleting an event whose payload collides with its neighbour's, as a link break at the successor", async () => {
      const ids = await fourEventChain();
      store.splice(2, 1);
      await expect(verifyChain("household-test")).resolves.toMatchObject({ ok: false, index: 2, brokenSk: ids[3], reason: "link" });
    });

    it("detects two events swapped in place as a link break", async () => {
      await fourEventChain();
      [store[1], store[2]] = [store[2]!, store[1]!];
      await expect(verifyChain("household-test")).resolves.toMatchObject({ ok: false, index: 1, reason: "link" });
    });

    it("fails an event written under the old payload-only rule rather than skipping it", async () => {
      store.push({
        pk: "HOUSEHOLD#household-test",
        sk: "01LEGACY",
        type: "PIN_CREATED",
        actor: "resident:demo",
        payload: { a: 1 },
        prevEventHash: GENESIS_EVENT_HASH,
        ts: "2026-09-12T00:00:00.000Z",
        payloadHash: "sha256:" + "a".repeat(64),
      } as unknown as StoredLedgerEvent);
      await expect(verifyChain("household-test")).resolves.toMatchObject({ ok: false, index: 0, reason: "unhashed", actual: "(missing)" });
    });

    it("hashEvent is stable under payload key order and changes with every hashed field", () => {
      const base = { type: "APPROVED" as const, actor: "resident:demo", ts: "2026-09-19T00:00:00.000Z", payload: { a: 1, b: 2 }, prevEventHash: GENESIS_EVENT_HASH };
      const h = hashEvent(base);
      expect(hashEvent({ ...base, payload: { b: 2, a: 1 } })).toBe(h);
      for (const variant of [
        { ...base, type: "REFUSED" as const },
        { ...base, actor: "resident:other" },
        { ...base, ts: "2026-09-19T00:00:00.001Z" },
        { ...base, payload: { a: 1, b: 3 } },
        { ...base, prevEventHash: "sha256:" + "f".repeat(64) },
      ]) {
        expect(hashEvent(variant)).not.toBe(h);
      }
    });
  });
});
