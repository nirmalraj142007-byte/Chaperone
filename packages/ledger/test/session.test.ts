import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { resetConfigForTests } from "@chaperone/config";
import { resetDdbClientForTests } from "../src/client.js";
import { deleteSession, getSession, putSession, touchSession, type Session } from "../src/repos/session.js";

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

const sampleSession: Session = {
  sessionId: "01J000000000000000000000",
  upstreamSessions: {},
  protocolVersion: "2025-11-25",
  clientInfo: { name: "curl", version: "0" },
  createdAt: "2026-09-13T00:00:00.000Z",
  lastSeenAt: "2026-09-13T00:00:00.000Z",
  ttl: 1_800_000_000,
};

describe("session repo", () => {
  it("round-trips a session through putSession and getSession", async () => {
    let stored: Session | undefined;
    ddbMock.on(PutCommand).callsFake((input: { Item: Session }) => {
      stored = input.Item;
      return {};
    });
    ddbMock.on(GetCommand).callsFake(() => ({ Item: stored }));

    await putSession(sampleSession);
    await expect(getSession(sampleSession.sessionId)).resolves.toEqual(sampleSession);
  });

  it("getSession returns undefined for a session that was never stored", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(getSession("unknown")).resolves.toBeUndefined();
  });

  it("touchSession updates lastSeenAt and ttl in place", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await expect(
      touchSession(sampleSession.sessionId, "2026-09-13T01:00:00.000Z", 1_800_003_600),
    ).resolves.toBeUndefined();
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toMatchObject({
      Key: { sessionId: sampleSession.sessionId },
      ExpressionAttributeValues: { ":lastSeenAt": "2026-09-13T01:00:00.000Z", ":ttl": 1_800_003_600 },
    });
  });

  it("deleteSession removes the row so a subsequent getSession finds nothing", async () => {
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await deleteSession(sampleSession.sessionId);
    const calls = ddbMock.commandCalls(DeleteCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: "chaperone-session",
      Key: { sessionId: sampleSession.sessionId },
    });
    await expect(getSession(sampleSession.sessionId)).resolves.toBeUndefined();
  });
});
