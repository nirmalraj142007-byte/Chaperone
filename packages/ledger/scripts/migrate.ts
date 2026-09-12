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
import { TABLE_SCHEMAS, type KeyAttribute } from "../src/schema.js";
import { tableName } from "../src/tables.js";

function toKeySchema(keys: readonly KeyAttribute[]): KeySchemaElement[] {
  return keys.map((key) => ({ AttributeName: key.name, KeyType: key.keyType }));
}

function attributeDefinitions(schema: (typeof TABLE_SCHEMAS)[number]): AttributeDefinition[] {
  const byName = new Map<string, AttributeDefinition>();
  for (const key of [...schema.keys, ...(schema.gsi?.keys ?? [])]) {
    byName.set(key.name, { AttributeName: key.name, AttributeType: key.type });
  }
  return [...byName.values()];
}

async function tableExists(client: DynamoDBClient, name: string): Promise<boolean> {
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

async function migrate(): Promise<void> {
  const config = loadConfig();
  const client = new DynamoDBClient({
    region: config.awsRegion,
    // See packages/ledger/src/client.ts — without an explicit requestTimeout,
    // a stuck DynamoDB Local (e.g. its storage layer failing behind an
    // otherwise-open connection) hangs this script forever with no output
    // instead of failing loudly.
    requestHandler: { connectionTimeout: 3000, requestTimeout: 5000, throwOnRequestTimeout: true },
    ...(config.ddbEndpoint !== undefined
      ? {
          endpoint: config.ddbEndpoint,
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : {}),
  });

  for (const schema of TABLE_SCHEMAS) {
    const name = tableName(schema.logicalName);

    if (await tableExists(client, name)) {
      console.log(`skip  ${name} (already exists)`);
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
    console.log(`create ${name}`);

    if (schema.ttlAttribute !== undefined) {
      await client.send(
        new UpdateTimeToLiveCommand({
          TableName: name,
          TimeToLiveSpecification: { AttributeName: schema.ttlAttribute, Enabled: true },
        }),
      );
      console.log(`  ttl on ${schema.ttlAttribute}`);
    }
  }
}

migrate()
  .then(() => {
    console.log("migrate: done");
  })
  .catch((e: unknown) => {
    console.error("migrate: failed —", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
