import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { resetConfigForTests } from "@chaperone/config";
import { resetDdbClientForTests } from "../src/client.js";
import { listSseEventsSince, nextSseSeq, putSseEvent } from "../src/repos/sseEvent.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

let previousUpstreams: string | undefined;

beforeEach(() => {
  previousUpstreams = process.env["CHAPERONE_UPSTREAMS"];
  process.env["CHAPERONE_UPSTREAMS"] = JSON.stringify([
    { id: "grocery", url: "http://localhost:4001/mcp", label: "Grocery" },
  ]);
  resetConfigForTests();
  resetDdbClientForTests();
  ddbMock.reset();
});

afterEach(() => {
  ddbMock.reset();
  if (previousUpstreams === undefined) {
    delete process.env["CHAPERONE_UPSTREAMS"];
  } else {
    process.env["CHAPERONE_UPSTREAMS"] = previousUpstreams;
  }
  resetConfigForTests();
  resetDdbClientForTests();
});

describe("nextSseSeq", () => {
  it("issues a single atomic UpdateItem ADD, never a read followed by a write", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { nextSeq: 1 } });

    const seq = await nextSseSeq("session-1", "stream-1");

    expect(seq).toBe(1);
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toMatchObject({
      TableName: "chaperone-sse-event",
      Key: { pk: "SESSION#session-1#STREAM#stream-1#COUNTER", seq: 0 },
      UpdateExpression: "ADD nextSeq :incr SET #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: { "#ttl": "ttl" },
    });
  });

  it("uses a counter partition disjoint from the stream's own event partition", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { nextSeq: 1 } });
    await nextSseSeq("session-1", "stream-1");
    const key = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.Key as { pk: string };
    expect(key.pk).not.toBe("SESSION#session-1#STREAM#stream-1");
  });

  it("returns the incremented value DynamoDB reports on each call, reflecting real concurrent increments", async () => {
    ddbMock.on(UpdateCommand).resolvesOnce({ Attributes: { nextSeq: 1 } }).resolvesOnce({ Attributes: { nextSeq: 2 } });

    await expect(nextSseSeq("session-1", "stream-1")).resolves.toBe(1);
    await expect(nextSseSeq("session-1", "stream-1")).resolves.toBe(2);
  });

  it("throws LedgerWriteError rather than returning undefined if DynamoDB omits the updated attribute", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: undefined });
    await expect(nextSseSeq("session-1", "stream-1")).rejects.toThrow(
      /did not return an updated sse-event sequence number/,
    );
  });
});

describe("putSseEvent / listSseEventsSince", () => {
  it("replays only events with seq strictly greater than sinceSeq, ascending", async () => {
    const stored: Array<Record<string, unknown>> = [];
    ddbMock.on(PutCommand).callsFake((input: { Item: Record<string, unknown> }) => {
      stored.push(input.Item);
      return {};
    });
    ddbMock.on(QueryCommand).callsFake((input: { ExpressionAttributeValues: Record<string, unknown> }) => {
      const pk = input.ExpressionAttributeValues[":pk"];
      const sinceSeq = input.ExpressionAttributeValues[":sinceSeq"] as number;
      const items = stored
        .filter((item) => item["pk"] === pk && (item["seq"] as number) > sinceSeq)
        .sort((a, b) => (a["seq"] as number) - (b["seq"] as number));
      return { Items: items };
    });

    for (let seq = 1; seq <= 3; seq++) {
      await putSseEvent({
        sessionId: "session-1",
        streamId: "stream-1",
        seq,
        eventId: `stream-1:${seq}`,
        message: JSON.stringify({ n: seq }),
        ts: "2026-09-14T00:00:00.000Z",
        ttl: 1_800_000_000,
      });
    }

    const replayed = await listSseEventsSince("session-1", "stream-1", 1);
    expect(replayed.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("never returns events from a different stream in the same session", async () => {
    const stored: Array<Record<string, unknown>> = [];
    ddbMock.on(PutCommand).callsFake((input: { Item: Record<string, unknown> }) => {
      stored.push(input.Item);
      return {};
    });
    ddbMock.on(QueryCommand).callsFake((input: { ExpressionAttributeValues: Record<string, unknown> }) => {
      const pk = input.ExpressionAttributeValues[":pk"];
      const sinceSeq = input.ExpressionAttributeValues[":sinceSeq"] as number;
      const items = stored.filter((item) => item["pk"] === pk && (item["seq"] as number) > sinceSeq);
      return { Items: items };
    });

    await putSseEvent({
      sessionId: "session-1",
      streamId: "stream-a",
      seq: 1,
      eventId: "stream-a:1",
      message: JSON.stringify({ from: "a" }),
      ts: "2026-09-14T00:00:00.000Z",
      ttl: 1_800_000_000,
    });
    await putSseEvent({
      sessionId: "session-1",
      streamId: "stream-b",
      seq: 1,
      eventId: "stream-b:1",
      message: JSON.stringify({ from: "b" }),
      ts: "2026-09-14T00:00:00.000Z",
      ttl: 1_800_000_000,
    });

    const replayed = await listSseEventsSince("session-1", "stream-a", 0);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.eventId).toBe("stream-a:1");
  });
});
