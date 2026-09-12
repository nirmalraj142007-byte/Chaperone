import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDdbDocClient } from "../client.js";
import { tableName } from "../tables.js";
import { withDynamoErrors } from "../errors.js";

export interface DriftRecord {
  serverId: string;
  toolName: string;
  fromHash: string;
  toHash: string;
  changeClass: string;
  capabilityClass: string;
  labeledBy: string;
  labeledAt: string;
  taxonomyCommitSha: string;
  changelogSignal: string;
  advisoryScore?: number;
}

function partitionKey(serverId: string): string {
  return `SERVER#${serverId}`;
}

function sortKey(toolName: string): string {
  return `TOOL#${toolName}`;
}

export async function putDriftRecord(record: DriftRecord): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new PutCommand({
        TableName: tableName("drift-record"),
        Item: {
          pk: partitionKey(record.serverId),
          sk: sortKey(record.toolName),
          ...record,
        },
      }),
    ),
  );
}

export async function getDriftRecord(
  serverId: string,
  toolName: string,
): Promise<DriftRecord | undefined> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new GetCommand({
        TableName: tableName("drift-record"),
        Key: { pk: partitionKey(serverId), sk: sortKey(toolName) },
      }),
    ),
  );
  return result.Item as DriftRecord | undefined;
}

export async function listDriftRecordsByChangeClass(
  changeClass: string,
  capabilityClass?: string,
): Promise<DriftRecord[]> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new QueryCommand({
        TableName: tableName("drift-record"),
        IndexName: "GSI1",
        KeyConditionExpression:
          capabilityClass !== undefined
            ? "changeClass = :changeClass AND capabilityClass = :capabilityClass"
            : "changeClass = :changeClass",
        ExpressionAttributeValues: {
          ":changeClass": changeClass,
          ...(capabilityClass !== undefined ? { ":capabilityClass": capabilityClass } : {}),
        },
      }),
    ),
  );
  return (result.Items ?? []) as DriftRecord[];
}
