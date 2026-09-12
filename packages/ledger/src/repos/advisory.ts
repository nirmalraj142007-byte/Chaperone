import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDdbDocClient } from "../client.js";
import { tableName } from "../tables.js";
import { withDynamoErrors } from "../errors.js";

export interface Advisory {
  quarantineId: string;
  score: number;
  summary: string;
  modelId: string;
  generatedAt: string;
  promptSha: string;
}

function partitionKey(quarantineId: string): string {
  return `QUAR#${quarantineId}`;
}

export async function putAdvisory(advisory: Advisory): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new PutCommand({
        TableName: tableName("advisory"),
        Item: { pk: partitionKey(advisory.quarantineId), ...advisory },
      }),
    ),
  );
}

export async function getAdvisory(quarantineId: string): Promise<Advisory | undefined> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new GetCommand({
        TableName: tableName("advisory"),
        Key: { pk: partitionKey(quarantineId) },
      }),
    ),
  );
  return result.Item as Advisory | undefined;
}
