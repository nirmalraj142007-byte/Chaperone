import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { resetConfigForTests } from "@chaperone/config";
import { resetDdbClientForTests } from "../src/client.js";
import { getPin, listPinsForHousehold, putPin, type Pin } from "../src/repos/pin.js";

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

const samplePin: Pin = {
  householdId: "household-demo",
  upstreamId: "grocery",
  toolName: "add_item",
  approvedHash: "sha256:abc",
  approvedCanonicalJson: '{"name":"add_item"}',
  approvedAt: "2026-09-13T00:00:00.000Z",
  approvedBy: "resident:household-demo",
  consentEventId: "01J000000000000000000000",
  capabilityClass: "write",
};

describe("pin repo", () => {
  it("putPin writes under a household-partitioned, upstream+tool-sorted key", async () => {
    ddbMock.on(PutCommand).resolves({});
    await putPin(samplePin);

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: "chaperone-pin",
      Item: {
        pk: "HOUSEHOLD#household-demo",
        sk: "UPSTREAM#grocery#TOOL#add_item",
        ...samplePin,
      },
    });
  });

  it("getPin returns undefined for a tool that was never pinned", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await expect(getPin("household-demo", "grocery", "add_item")).resolves.toBeUndefined();
  });

  it("round-trips a pin through putPin and getPin", async () => {
    let stored: Record<string, unknown> | undefined;
    ddbMock.on(PutCommand).callsFake((input: { Item: Record<string, unknown> }) => {
      stored = input.Item;
      return {};
    });
    ddbMock.on(GetCommand).callsFake(() => ({ Item: stored }));

    await putPin(samplePin);
    // getPin returns the raw stored item, `pk`/`sk` included — it doesn't
    // strip its own key attributes back off, same as every other repo here.
    await expect(getPin("household-demo", "grocery", "add_item")).resolves.toEqual({
      ...samplePin,
      pk: "HOUSEHOLD#household-demo",
      sk: "UPSTREAM#grocery#TOOL#add_item",
    });
  });

  it("listPinsForHousehold queries only that household's partition", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [samplePin] });
    await expect(listPinsForHousehold("household-demo")).resolves.toEqual([samplePin]);

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[0]?.args[0].input).toMatchObject({
      TableName: "chaperone-pin",
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "HOUSEHOLD#household-demo" },
    });
  });
});
