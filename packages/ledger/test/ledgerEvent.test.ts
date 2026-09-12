import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { PutCommand, QueryCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LedgerWriteError, PolicyViolationError } from "@chaperone/errors";
import { resetConfigForTests } from "@chaperone/config";
import { resetDdbClientForTests } from "../src/client.js";
import { appendEvent, GENESIS_EVENT_HASH, verifyChain, type StoredLedgerEvent } from "../src/repos/ledgerEvent.js";

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

  it("chains a second event onto the first event's payloadHash", async () => {
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
    expect(second.prevEventHash).toBe(first.payloadHash);
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
    // simulate `aws dynamodb update-item` mutating the payload directly, without touching payloadHash
    target!.payload = { b: "tampered" };

    const result = await verifyChain("household-test");
    expect(result).toEqual({
      ok: false,
      index: 1,
      brokenSk: second.eventId,
      expected: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      actual: second.payloadHash,
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
    }
  });
});
