import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LedgerWriteError } from "@chaperone/errors";
import { getDdbDocClient } from "../client.js";
import { tableName } from "../tables.js";
import { withDynamoErrors } from "../errors.js";

export interface SseEvent {
  sessionId: string;
  streamId: string;
  seq: number;
  eventId: string;
  message: string;
  ts: string;
  /** Unix seconds. DynamoDB TTL is enabled on this attribute. */
  ttl: number;
}

const SSE_EVENT_TTL_SECONDS = 24 * 60 * 60;

/** Unix seconds, 24h from now — the TTL every `sse-event` item (including the counter item) is written with. */
export function sseEventTtl(): number {
  return Math.floor(Date.now() / 1000) + SSE_EVENT_TTL_SECONDS;
}

function partitionKey(sessionId: string, streamId: string): string {
  return `SESSION#${sessionId}#STREAM#${streamId}`;
}

/**
 * A dedicated partition per stream, disjoint from `partitionKey`'s events
 * (`seq` fixed at 0, below every real event's `seq >= 1`) so the counter
 * item can never be returned by `listSseEventsSince`'s `seq > sinceSeq`
 * query and never collides with a real event's range key.
 */
function counterPartitionKey(sessionId: string, streamId: string): string {
  return `SESSION#${sessionId}#STREAM#${streamId}#COUNTER`;
}

/**
 * Atomically allocates the next sequence number for `streamId` within
 * `sessionId` via a single `UpdateItem ADD` — never a read followed by a
 * write, which under concurrent callers could hand out the same seq twice.
 * The counter item is created on first use (`if_not_exists` seeds both
 * `nextSeq` and `ttl`) and every subsequent call increments it in place.
 */
export async function nextSseSeq(sessionId: string, streamId: string): Promise<number> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new UpdateCommand({
        TableName: tableName("sse-event"),
        Key: { pk: counterPartitionKey(sessionId, streamId), seq: 0 },
        // "ttl" is a DynamoDB reserved keyword — #ttl aliases it, the same
        // pattern packages/ledger/src/repos/session.ts's touchSession uses.
        UpdateExpression: "ADD nextSeq :incr SET #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":incr": 1, ":ttl": sseEventTtl() },
        ReturnValues: "UPDATED_NEW",
      }),
    ),
  );
  const nextSeq = result.Attributes?.["nextSeq"];
  if (typeof nextSeq !== "number") {
    throw new LedgerWriteError("DynamoDB did not return an updated sse-event sequence number", {
      sessionId,
      streamId,
    });
  }
  return nextSeq;
}

export async function putSseEvent(event: SseEvent): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new PutCommand({
        TableName: tableName("sse-event"),
        Item: {
          pk: partitionKey(event.sessionId, event.streamId),
          seq: event.seq,
          eventId: event.eventId,
          message: event.message,
          ts: event.ts,
          ttl: event.ttl,
        },
      }),
    ),
  );
}

/** Events with seq strictly greater than `sinceSeq`, ascending — the replay set for a resumed stream's `Last-Event-ID`. */
export async function listSseEventsSince(
  sessionId: string,
  streamId: string,
  sinceSeq: number,
): Promise<SseEvent[]> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new QueryCommand({
        TableName: tableName("sse-event"),
        KeyConditionExpression: "pk = :pk AND seq > :sinceSeq",
        ExpressionAttributeValues: {
          ":pk": partitionKey(sessionId, streamId),
          ":sinceSeq": sinceSeq,
        },
        ScanIndexForward: true,
      }),
    ),
  );
  return (result.Items ?? []).map((item) => ({
    sessionId,
    streamId,
    seq: item["seq"] as number,
    eventId: item["eventId"] as string,
    message: item["message"] as string,
    ts: item["ts"] as string,
    ttl: item["ttl"] as number,
  }));
}
