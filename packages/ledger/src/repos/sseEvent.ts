import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
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

function partitionKey(sessionId: string, streamId: string): string {
  return `SESSION#${sessionId}#STREAM#${streamId}`;
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
