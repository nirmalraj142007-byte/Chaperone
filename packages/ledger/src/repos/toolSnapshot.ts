import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDdbDocClient } from "../client.js";
import { tableName } from "../tables.js";
import { withDynamoErrors } from "../errors.js";

export interface ToolSnapshot {
  serverId: string;
  crawlId: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  canonicalJson: string;
  sha256: string;
  capabilityClass: string;
  capabilityConfidence: string;
  capabilityAssignedBy: string;
  capturedAt: string;
  rawPayloadPath: string;
}

function partitionKey(serverId: string): string {
  return `SERVER#${serverId}`;
}

function sortKey(crawlId: string, toolName: string): string {
  return `CRAWL#${crawlId}#TOOL#${toolName}`;
}

/** GSI1 sort key: capabilityClass, then serverId, so the review queue can page one capability class at a time. */
function capSort(capabilityClass: string, serverId: string): string {
  return `${capabilityClass}#${serverId}`;
}

export async function putToolSnapshot(snapshot: ToolSnapshot): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new PutCommand({
        TableName: tableName("tool-snapshot"),
        Item: {
          pk: partitionKey(snapshot.serverId),
          sk: sortKey(snapshot.crawlId, snapshot.toolName),
          ...snapshot,
          capSort: capSort(snapshot.capabilityClass, snapshot.serverId),
        },
      }),
    ),
  );
}

export async function getToolSnapshot(
  serverId: string,
  crawlId: string,
  toolName: string,
): Promise<ToolSnapshot | undefined> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new GetCommand({
        TableName: tableName("tool-snapshot"),
        Key: { pk: partitionKey(serverId), sk: sortKey(crawlId, toolName) },
      }),
    ),
  );
  return result.Item as ToolSnapshot | undefined;
}

export async function listToolSnapshotsForServer(
  serverId: string,
  crawlId?: string,
): Promise<ToolSnapshot[]> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new QueryCommand({
        TableName: tableName("tool-snapshot"),
        KeyConditionExpression:
          crawlId !== undefined ? "pk = :pk AND begins_with(sk, :skPrefix)" : "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": partitionKey(serverId),
          ...(crawlId !== undefined ? { ":skPrefix": `CRAWL#${crawlId}#TOOL#` } : {}),
        },
      }),
    ),
  );
  return (result.Items ?? []) as ToolSnapshot[];
}

export async function listToolSnapshotsByCrawlAndCapability(
  crawlId: string,
  capabilityClass: string,
): Promise<ToolSnapshot[]> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new QueryCommand({
        TableName: tableName("tool-snapshot"),
        IndexName: "GSI1",
        KeyConditionExpression: "crawlId = :crawlId AND begins_with(capSort, :capPrefix)",
        ExpressionAttributeValues: {
          ":crawlId": crawlId,
          ":capPrefix": `${capabilityClass}#`,
        },
      }),
    ),
  );
  return (result.Items ?? []) as ToolSnapshot[];
}
