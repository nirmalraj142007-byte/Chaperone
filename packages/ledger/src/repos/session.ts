import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDdbDocClient } from "../client.js";
import { tableName } from "../tables.js";
import { withDynamoErrors } from "../errors.js";

export interface Session {
  sessionId: string;
  upstreamSessions: Record<string, string>;
  protocolVersion: string;
  clientInfo: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
  /** Unix seconds. DynamoDB TTL is enabled on this attribute. */
  ttl: number;
}

export async function putSession(session: Session): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(new PutCommand({ TableName: tableName("session"), Item: session })),
  );
}

export async function getSession(sessionId: string): Promise<Session | undefined> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new GetCommand({ TableName: tableName("session"), Key: { sessionId } }),
    ),
  );
  return result.Item as Session | undefined;
}

export async function touchSession(sessionId: string, lastSeenAt: string, ttl: number): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new UpdateCommand({
        TableName: tableName("session"),
        Key: { sessionId },
        UpdateExpression: "SET lastSeenAt = :lastSeenAt, #ttl = :ttl",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":lastSeenAt": lastSeenAt, ":ttl": ttl },
      }),
    ),
  );
}

/**
 * Session rows are mutable operational state, not the hash-chained ledger —
 * unlike `ledger-event`, deleting one here is not a non-negotiable
 * violation. Used by `DELETE /mcp` termination so a subsequent request
 * against the same session ID reliably 404s.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(new DeleteCommand({ TableName: tableName("session"), Key: { sessionId } })),
  );
}
