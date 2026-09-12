import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDdbDocClient } from "../client.js";
import { tableName } from "../tables.js";
import { withDynamoErrors } from "../errors.js";

export interface Pin {
  householdId: string;
  upstreamId: string;
  toolName: string;
  approvedHash: string;
  approvedCanonicalJson: string;
  approvedAt: string;
  approvedBy: string;
  consentEventId: string;
  capabilityClass: string;
}

function partitionKey(householdId: string): string {
  return `HOUSEHOLD#${householdId}`;
}

function sortKey(upstreamId: string, toolName: string): string {
  return `UPSTREAM#${upstreamId}#TOOL#${toolName}`;
}

export async function putPin(pin: Pin): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new PutCommand({
        TableName: tableName("pin"),
        Item: {
          pk: partitionKey(pin.householdId),
          sk: sortKey(pin.upstreamId, pin.toolName),
          ...pin,
        },
      }),
    ),
  );
}

export async function getPin(
  householdId: string,
  upstreamId: string,
  toolName: string,
): Promise<Pin | undefined> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new GetCommand({
        TableName: tableName("pin"),
        Key: { pk: partitionKey(householdId), sk: sortKey(upstreamId, toolName) },
      }),
    ),
  );
  return result.Item as Pin | undefined;
}

export async function listPinsForHousehold(householdId: string): Promise<Pin[]> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new QueryCommand({
        TableName: tableName("pin"),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": partitionKey(householdId) },
      }),
    ),
  );
  return (result.Items ?? []) as Pin[];
}
