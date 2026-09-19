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
  /**
   * sha256 over the canonical form of this event's full identity — `type`,
   * `actor`, `ts`, `payload`, and `prevEventHash` (see `hashEvent`). Folding
   * in `prevEventHash` commits each event to its position in the chain, so
   * a deleted, reordered, or spliced-in event breaks the next link even
   * when payloads repeat.
   */
  eventHash: string;
  prevEventHash: string;
  ts: string;
}

/** The chain's first event points at this rather than at a real prior hash. */
export const GENESIS_EVENT_HASH = "0".repeat(64);

function partitionKey(householdId: string): string {
  return `HOUSEHOLD#${householdId}`;
}

/**
 * Domain tag inside the hashed form: a hash computed under any other
 * field set (including Phase 3's payload-only rule) can never collide with
 * one computed here.
 */
const EVENT_HASH_SCHEMA = "chaperone/ledger-event@2";

type HashedFields = Pick<StoredLedgerEvent, "type" | "actor" | "ts" | "payload" | "prevEventHash">;

/**
 * The stored hash, over the event's full identity rather than its payload
 * alone. Phase 3's rule hashed only `payload`, which let an attacker with
 * raw table access edit `type` or `actor`, or delete an event whose
 * payload matched its neighbour's, without verifyChain noticing (found in
 * Phase 14; see spec/ledger-tamper.test.ts). `sk` is not hashed: position
 * is already committed through `prevEventHash`, and `ts` carries the time.
 */
export function hashEvent(fields: HashedFields): string {
  const canonical = canonicalizeJson({
    schema: EVENT_HASH_SCHEMA,
    type: fields.type,
    actor: fields.actor,
    ts: fields.ts,
    payload: fields.payload,
    prevEventHash: fields.prevEventHash,
  });
  // canonicalize() only returns undefined for a top-level undefined/function
  // input; this is always a plain object.
  if (canonical === undefined) {
    throw new PolicyViolationError("Ledger event could not be canonicalized");
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
 * tail, chains onto its eventHash (or the genesis hash if the partition is
 * empty), hashes the new event's full identity including that link, and writes with `attribute_not_exists(sk)` so a concurrent append
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
}): Promise<{ eventId: string; eventHash: string; prevEventHash: string }> {
  if (i.actor === "model") {
    throw new PolicyViolationError(
      'Ledger event actor must never be the string "model" — an advisory model is never the actor of record for a ledger event.',
      { type: i.type },
    );
  }

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
    const prevEventHash = tail?.eventHash ?? GENESIS_EVENT_HASH;
    const eventId = ulid();
    // Per attempt: a retry chains onto a freshly-read tail, so both the link and the time change.
    const ts = new Date().toISOString();
    const eventHash = hashEvent({ type: i.type, actor: i.actor, ts, payload: i.payload, prevEventHash });

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
              eventHash,
              prevEventHash,
              ts,
            } satisfies StoredLedgerEvent,
            ConditionExpression: "attribute_not_exists(sk)",
          }),
        ),
      );
      return { eventId, eventHash, prevEventHash };
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

/**
 * Read-only: every event in a household's ledger, oldest first — the same
 * forward walk verifyChain() does, exposed so the gateway's `/api/ledger`
 * can show the console exactly the rows the verifier checked. There is
 * deliberately no update or delete counterpart anywhere in this module.
 */
export async function listEvents(householdId: string): Promise<StoredLedgerEvent[]> {
  return queryAllEventsAscending(householdId);
}

export type VerifyChainResult =
  | { ok: true; count: number }
  | {
      ok: false;
      index: number;
      brokenSk: string;
      /**
       * `hash`: the event's stored fields no longer hash to its stored
       * eventHash (a field was edited). `link`: its prevEventHash doesn't
       * match the eventHash of the event before it (an event was deleted,
       * reordered, or spliced in). `unhashed`: the event carries no eventHash
       * at all — written under Phase 3's payload-only rule, so it cannot be
       * checked and is not vouched for.
       */
      reason: "hash" | "link" | "unhashed";
      expected: string;
      actual: string;
    };

/**
 * Walks a household's entire ledger partition forward. For each event,
 * recomputes eventHash from its stored type/actor/ts/payload/prevEventHash
 * and compares it to the stored eventHash (self-integrity), then checks its
 * prevEventHash against the previous event's eventHash (chain linkage).
 * Returns the first break found, if any. An event with no eventHash at all
 * — written under Phase 3's payload-only rule — fails as `unhashed`: a
 * chain this function cannot fully check is not reported as verified.
 */
export async function verifyChain(householdId: string): Promise<VerifyChainResult> {
  const events = await queryAllEventsAscending(householdId);

  let expectedPrev = GENESIS_EVENT_HASH;
  for (const [index, event] of events.entries()) {
    const recomputed = hashEvent(event);
    if (typeof event.eventHash !== "string") {
      return { ok: false, index, brokenSk: event.sk, reason: "unhashed", expected: recomputed, actual: "(missing)" };
    }
    if (recomputed !== event.eventHash) {
      return { ok: false, index, brokenSk: event.sk, reason: "hash", expected: recomputed, actual: event.eventHash };
    }
    if (event.prevEventHash !== expectedPrev) {
      return {
        ok: false,
        index,
        brokenSk: event.sk,
        reason: "link",
        expected: expectedPrev,
        actual: event.prevEventHash,
      };
    }
    expectedPrev = event.eventHash;
  }

  return { ok: true, count: events.length };
}
