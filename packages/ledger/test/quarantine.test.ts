import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { resetConfigForTests } from "@chaperone/config";
import { QuarantineAlreadyResolvedError } from "@chaperone/errors";
import { resetDdbClientForTests } from "../src/client.js";
import {
  createQuarantine,
  getQuarantine,
  listQuarantineByStatus,
  resolveQuarantine,
  setQuarantineAdvisoryScore,
  type Quarantine,
} from "../src/repos/quarantine.js";

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

const sampleQuarantine: Quarantine = {
  householdId: "household-demo",
  quarantineId: "01JQUARANTINE00000000000",
  upstreamId: "grocery",
  toolName: "add_item",
  fromHash: "sha256:before",
  toHash: "sha256:after",
  fromCanonicalJson: '{"name":"add_item","description":"before","inputSchema":{}}',
  toCanonicalJson: '{"name":"add_item","description":"after","inputSchema":{}}',
  diffSpans: [],
  approvalTokenHash: "deadbeef",
  status: "pending",
  capabilityClass: "write",
  detectedAt: "2026-09-13T00:00:00.000Z",
};

describe("quarantine repo", () => {
  it("createQuarantine writes both canonical JSONs alongside the row, unscored", async () => {
    ddbMock.on(PutCommand).resolves({});
    await createQuarantine(sampleQuarantine);

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: "chaperone-quarantine",
      Item: {
        pk: "HOUSEHOLD#household-demo",
        sk: "QUAR#01JQUARANTINE00000000000",
        ...sampleQuarantine,
        advisoryScoreSort: "000000",
      },
    });
  });

  it("round-trips a quarantine through createQuarantine and getQuarantine", async () => {
    let stored: Record<string, unknown> | undefined;
    ddbMock.on(PutCommand).callsFake((input: { Item: Record<string, unknown> }) => {
      stored = input.Item;
      return {};
    });
    ddbMock.on(GetCommand).callsFake(() => ({ Item: stored }));

    await createQuarantine(sampleQuarantine);
    // getQuarantine returns the raw stored item, `pk`/`sk` included — it
    // doesn't strip its own key attributes back off, same as pin.ts.
    await expect(getQuarantine("household-demo", sampleQuarantine.quarantineId)).resolves.toEqual({
      ...sampleQuarantine,
      pk: "HOUSEHOLD#household-demo",
      sk: `QUAR#${sampleQuarantine.quarantineId}`,
      advisoryScoreSort: "000000",
    });
  });

  it("listQuarantineByStatus queries GSI1 by status, most recent first", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [sampleQuarantine] });
    await expect(listQuarantineByStatus("pending")).resolves.toEqual([sampleQuarantine]);

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[0]?.args[0].input).toMatchObject({
      TableName: "chaperone-quarantine",
      IndexName: "GSI1",
      // "status" is a DynamoDB reserved keyword — must be aliased.
      KeyConditionExpression: "#status = :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": "pending" },
      ScanIndexForward: false,
    });
  });

  it("resolveQuarantine sets status and resolvedAt via a conditional update guarding against a non-pending row", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await resolveQuarantine("household-demo", sampleQuarantine.quarantineId, "approved", "2026-09-13T01:00:00.000Z");

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls[0]?.args[0].input).toMatchObject({
      TableName: "chaperone-quarantine",
      Key: { pk: "HOUSEHOLD#household-demo", sk: "QUAR#01JQUARANTINE00000000000" },
      ConditionExpression: "attribute_exists(pk) AND #status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "approved",
        ":resolvedAt": "2026-09-13T01:00:00.000Z",
        ":pending": "pending",
      },
    });
  });

  it("resolveQuarantine throws QuarantineAlreadyResolvedError, not a raw AWS error, when the conditional write loses the race", async () => {
    const conditionalFailure = Object.assign(new Error("The conditional request failed"), {
      name: "ConditionalCheckFailedException",
    });
    ddbMock.on(UpdateCommand).rejects(conditionalFailure);

    await expect(
      resolveQuarantine("household-demo", sampleQuarantine.quarantineId, "approved", "2026-09-13T01:00:00.000Z"),
    ).rejects.toBeInstanceOf(QuarantineAlreadyResolvedError);
  });

  it("setQuarantineAdvisoryScore zero-pads into the sortable GSI range attribute", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await setQuarantineAdvisoryScore("household-demo", sampleQuarantine.quarantineId, 87.5);

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls[0]?.args[0].input).toMatchObject({
      ExpressionAttributeValues: { ":sort": "08750" },
    });
  });
});
