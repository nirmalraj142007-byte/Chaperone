import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { canonicalizeJson, hashCanonicalJson } from "@chaperone/policy";
import { LedgerWriteError, PolicyViolationError } from "@chaperone/errors";
import { getDdbDocClient } from "../client.js";
import { tableName } from "../tables.js";
import { withDynamoErrors } from "../errors.js";

export type LedgerEventType =
  | "PIN_CREATED"
  | "MISMATCH_DETECTED"
  | "TOOL_QUARANTINED"
  | "CONSENT_SHOWN"
  | "APPROVED"
  | "REFUSED"
  | "REPIN";

export interface StoredLedgerEvent {
  pk: string;
  sk: string;
  type: LedgerEventType;
  actor: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  prevEventHash: string;
  ts: string;
}

/** The chain's first event points at this rather than at a real prior hash. */
export const GENESIS_EVENT_HASH = "0".repeat(64);

function partitionKey(householdId: string): string {
  return `HOUSEHOLD#${householdId}`;
}

function hashPayload(payload: Record<string, unknown>): string {
  const canonical = canonicalizeJson(payload);
  // canonicalize() only returns undefined for a top-level undefined/function
  // input; a Record<string, unknown> payload is always a plain object.
  if (canonical === undefined) {
    throw new PolicyViolationError("Ledger event payload could not be canonicalized");
  }
  return hashCanonicalJson(canonical);
}

async function getTailEvent(householdId: string): Promise<StoredLedgerEvent | undefined> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new QueryCommand({
        TableName: tableName("ledger-event"),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": partitionKey(householdId) },
        ScanIndexForward: false,
        Limit: 1,
      }),
    ),
  );
  return result.Items?.[0] as StoredLedgerEvent | undefined;
}

async function queryAllEventsAscending(householdId: string): Promise<StoredLedgerEvent[]> {
  const items: StoredLedgerEvent[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await withDynamoErrors(() =>
      getDdbDocClient().send(
        new QueryCommand({
          TableName: tableName("ledger-event"),
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": partitionKey(householdId) },
          ScanIndexForward: true,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      ),
    );
    items.push(...((result.Items ?? []) as StoredLedgerEvent[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
  return items;
}

/**
 * Appends one event to a household's hash-chained ledger. Reads the current
 * tail, chains onto its payloadHash (or the genesis hash if the partition is
 * empty), and writes with `attribute_not_exists(sk)` so a concurrent append
 * can never silently overwrite another. A lost race is retried exactly once
 * against a freshly-read tail and a fresh ULID; a second collision, or any
 * other write failure, surfaces as `LedgerWriteError` — callers must treat
 * that as fail-closed, never as a reason to allow the tool it was guarding.
 */
export async function appendEvent(i: {
  householdId: string;
  type: LedgerEventType;
  actor: string;
  payload: Record<string, unknown>;
}): Promise<{ eventId: string; payloadHash: string; prevEventHash: string }> {
  if (i.actor === "model") {
    throw new PolicyViolationError(
      'Ledger event actor must never be the string "model" — an advisory model is never the actor of record for a ledger event.',
      { type: i.type },
    );
  }

  const payloadHash = hashPayload(i.payload);

  for (let attempt = 0; attempt < 2; attempt++) {
    let tail: StoredLedgerEvent | undefined;
    try {
      tail = await getTailEvent(i.householdId);
    } catch (e) {
      throw new LedgerWriteError("Failed to read ledger tail before append", {
        cause: e,
        type: i.type,
      });
    }
    const prevEventHash = tail?.payloadHash ?? GENESIS_EVENT_HASH;
    const eventId = ulid();

    try {
      await withDynamoErrors(() =>
        getDdbDocClient().send(
          new PutCommand({
            TableName: tableName("ledger-event"),
            Item: {
              pk: partitionKey(i.householdId),
              sk: eventId,
              type: i.type,
              actor: i.actor,
              payload: i.payload,
              payloadHash,
              prevEventHash,
              ts: new Date().toISOString(),
            } satisfies StoredLedgerEvent,
            ConditionExpression: "attribute_not_exists(sk)",
          }),
        ),
      );
      return { eventId, payloadHash, prevEventHash };
    } catch (e) {
      const isRace = e instanceof Error && e.name === "ConditionalCheckFailedException";
      if (isRace && attempt === 0) {
        continue;
      }
      throw new LedgerWriteError("Failed to append ledger event", { cause: e, type: i.type });
    }
  }
  /* c8 ignore next -- the loop above always returns or throws within its two iterations. */
  throw new LedgerWriteError("Failed to append ledger event after retry", { type: i.type });
}

export type VerifyChainResult =
  | { ok: true; count: number }
  | { ok: false; index: number; brokenSk: string; expected: string; actual: string };

/**
 * Walks a household's entire ledger partition forward, recomputing each
 * event's payloadHash from its stored payload and checking that it matches
 * both the stored payloadHash (self-integrity) and the next event's
 * prevEventHash (chain linkage). Returns the first break found, if any.
 */
export async function verifyChain(householdId: string): Promise<VerifyChainResult> {
  const events = await queryAllEventsAscending(householdId);

  let expectedPrev = GENESIS_EVENT_HASH;
  for (const [index, event] of events.entries()) {
    const recomputedPayloadHash = hashPayload(event.payload);
    if (recomputedPayloadHash !== event.payloadHash) {
      return {
        ok: false,
        index,
        brokenSk: event.sk,
        expected: recomputedPayloadHash,
        actual: event.payloadHash,
      };
    }
    if (event.prevEventHash !== expectedPrev) {
      return {
        ok: false,
        index,
        brokenSk: event.sk,
        expected: expectedPrev,
        actual: event.prevEventHash,
      };
    }
    expectedPrev = event.payloadHash;
  }

  return { ok: true, count: events.length };
}
