import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DiffSpan } from "@chaperone/policy";
import { getDdbDocClient } from "../client.js";
import { tableName } from "../tables.js";
import { withDynamoErrors } from "../errors.js";

export type QuarantineStatus = "pending" | "approved" | "refused";

export interface Quarantine {
  householdId: string;
  quarantineId: string;
  upstreamId: string;
  toolName: string;
  fromHash: string;
  toHash: string;
  diffSpans: DiffSpan[];
  approvalTokenHash: string;
  status: QuarantineStatus;
  capabilityClass: string;
  detectedAt: string;
  resolvedAt?: string;
}

/** Unscored items sort last in the status/advisoryScoreSort GSI until a score is attached. */
const UNSCORED_SORT = "000000";

function partitionKey(householdId: string): string {
  return `HOUSEHOLD#${householdId}`;
}

function sortKey(quarantineId: string): string {
  return `QUAR#${quarantineId}`;
}

/**
 * A 0-100 advisory score, zero-padded to sort correctly as a string
 * (2-decimal precision: 0.00-100.00 -> "00000"-"10000").
 */
function advisoryScoreSort(score: number): string {
  const clamped = Math.max(0, Math.min(100, score));
  return String(Math.round(clamped * 100)).padStart(5, "0");
}

export async function createQuarantine(quarantine: Quarantine): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new PutCommand({
        TableName: tableName("quarantine"),
        Item: {
          pk: partitionKey(quarantine.householdId),
          sk: sortKey(quarantine.quarantineId),
          ...quarantine,
          advisoryScoreSort: UNSCORED_SORT,
        },
      }),
    ),
  );
}

export async function getQuarantine(
  householdId: string,
  quarantineId: string,
): Promise<Quarantine | undefined> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new GetCommand({
        TableName: tableName("quarantine"),
        Key: { pk: partitionKey(householdId), sk: sortKey(quarantineId) },
      }),
    ),
  );
  return result.Item as Quarantine | undefined;
}

export async function listQuarantineByStatus(status: QuarantineStatus): Promise<Quarantine[]> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new QueryCommand({
        TableName: tableName("quarantine"),
        IndexName: "GSI1",
        KeyConditionExpression: "status = :status",
        ExpressionAttributeValues: { ":status": status },
        ScanIndexForward: false,
      }),
    ),
  );
  return (result.Items ?? []) as Quarantine[];
}

export async function setQuarantineAdvisoryScore(
  householdId: string,
  quarantineId: string,
  score: number,
): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new UpdateCommand({
        TableName: tableName("quarantine"),
        Key: { pk: partitionKey(householdId), sk: sortKey(quarantineId) },
        UpdateExpression: "SET advisoryScoreSort = :sort",
        ExpressionAttributeValues: { ":sort": advisoryScoreSort(score) },
      }),
    ),
  );
}

export async function resolveQuarantine(
  householdId: string,
  quarantineId: string,
  status: Extract<QuarantineStatus, "approved" | "refused">,
  resolvedAt: string,
): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new UpdateCommand({
        TableName: tableName("quarantine"),
        Key: { pk: partitionKey(householdId), sk: sortKey(quarantineId) },
        UpdateExpression: "SET #status = :status, resolvedAt = :resolvedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": status, ":resolvedAt": resolvedAt },
      }),
    ),
  );
}
