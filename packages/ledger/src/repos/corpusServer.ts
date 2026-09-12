import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDdbDocClient } from "../client.js";
import { tableName } from "../tables.js";
import { withDynamoErrors } from "../errors.js";

export interface CorpusServer {
  serverId: string;
  displayName: string;
  /** A native JS Set marshals to DynamoDB's String Set (SS) type via @aws-sdk/lib-dynamodb. */
  sources: Set<string>;
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  installMethod: string;
  requiresCredentials: boolean;
  bootStatus: string;
  bootFailureDetail?: string;
  firstSeenAt: string;
}

export async function putCorpusServer(server: CorpusServer): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new PutCommand({ TableName: tableName("corpus-server"), Item: server }),
    ),
  );
}

export async function getCorpusServer(serverId: string): Promise<CorpusServer | undefined> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new GetCommand({ TableName: tableName("corpus-server"), Key: { serverId } }),
    ),
  );
  return result.Item as CorpusServer | undefined;
}

export async function listCorpusServersByBootStatus(bootStatus: string): Promise<CorpusServer[]> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new QueryCommand({
        TableName: tableName("corpus-server"),
        IndexName: "GSI1",
        KeyConditionExpression: "bootStatus = :bootStatus",
        ExpressionAttributeValues: { ":bootStatus": bootStatus },
      }),
    ),
  );
  return (result.Items ?? []) as CorpusServer[];
}
