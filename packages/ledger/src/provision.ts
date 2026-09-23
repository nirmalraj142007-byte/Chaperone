/**
 * Table provisioning, shared by `pnpm ddb:migrate` and `pnpm demo:reset`.
 *
 * Create-only on purpose. Nothing exported from this package drops a table
 * or deletes an item: the ledger is append-only (CLAUDE.md non-negotiable
 * 6), and the one place a table is ever dropped — scripts/demo-reset.ts —
 * does it itself, against DynamoDB Local only, rather than borrowing a
 * capability from a package the gateway also imports.
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type KeySchemaElement,
} from "@aws-sdk/client-dynamodb";
import { loadConfig } from "@chaperone/config";
import { TABLE_SCHEMAS, type KeyAttribute, type TableSchema } from "./schema.js";
import { tableName } from "./tables.js";

function toKeySchema(keys: readonly KeyAttribute[]): KeySchemaElement[] {
  return keys.map((key) => ({ AttributeName: key.name, KeyType: key.keyType }));
}

function attributeDefinitions(schema: TableSchema): AttributeDefinition[] {
  const byName = new Map<string, AttributeDefinition>();
  for (const key of [...schema.keys, ...(schema.gsi?.keys ?? [])]) {
    byName.set(key.name, { AttributeName: key.name, AttributeType: key.type });
  }
  return [...byName.values()];
}

/**
 * The low-level (non-document) client provisioning needs. Same timeout
 * discipline as client.ts: without an explicit requestTimeout, a stuck
 * DynamoDB Local (its storage layer failing behind an otherwise-open
 * connection) hangs the caller forever with no output instead of failing
 * loudly.
 */
export function createAdminClient(): DynamoDBClient {
  const config = loadConfig();
  return new DynamoDBClient({
    region: config.awsRegion,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 5000, throwOnRequestTimeout: true },
    ...(config.ddbEndpoint !== undefined
      ? {
          endpoint: config.ddbEndpoint,
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : {}),
  });
}

export async function tableExists(client: DynamoDBClient, name: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (e) {
    if (e instanceof ResourceNotFoundException) {
      return false;
    }
    throw e;
  }
}

export interface EnsureTablesResult {
  created: string[];
  skipped: string[];
}

/** Creates every table in TABLE_SCHEMAS that does not exist yet. Idempotent. */
export async function ensureTables(
  client: DynamoDBClient,
  onProgress: (line: string) => void = () => {},
): Promise<EnsureTablesResult> {
  const result: EnsureTablesResult = { created: [], skipped: [] };

  for (const schema of TABLE_SCHEMAS) {
    const name = tableName(schema.logicalName);

    if (await tableExists(client, name)) {
      result.skipped.push(name);
      onProgress(`skip  ${name} (already exists)`);
      continue;
    }

    const globalSecondaryIndexes: GlobalSecondaryIndex[] | undefined = schema.gsi
      ? [
          {
            IndexName: schema.gsi.indexName,
            KeySchema: toKeySchema(schema.gsi.keys),
            Projection: { ProjectionType: "ALL" },
          },
        ]
      : undefined;

    await client.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: attributeDefinitions(schema),
        KeySchema: toKeySchema(schema.keys),
        ...(globalSecondaryIndexes !== undefined
          ? { GlobalSecondaryIndexes: globalSecondaryIndexes }
          : {}),
      }),
    );
    result.created.push(name);
    onProgress(`create ${name}`);

    if (schema.ttlAttribute !== undefined) {
      await client.send(
        new UpdateTimeToLiveCommand({
          TableName: name,
          TimeToLiveSpecification: { AttributeName: schema.ttlAttribute, Enabled: true },
        }),
      );
      onProgress(`  ttl on ${schema.ttlAttribute}`);
    }
  }

  return result;
}
