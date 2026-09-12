import { writeFileSync } from "node:fs";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getDdbDocClient } from "../src/client.js";
import { withDynamoErrors } from "../src/errors.js";
import { TABLE_SCHEMAS } from "../src/schema.js";
import { tableName } from "../src/tables.js";

async function scanAll(name: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await withDynamoErrors(() =>
      getDdbDocClient().send(
        new ScanCommand({ TableName: name, ExclusiveStartKey: exclusiveStartKey }),
      ),
    );
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
  return items;
}

/** DynamoDB String/Number sets round-trip through @aws-sdk/lib-dynamodb as native JS Sets, which JSON.stringify otherwise serializes as "{}". */
function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Set ? [...value] : value;
}

async function dump(): Promise<void> {
  const outPath = process.argv[2] ?? "ddb-dump.json";
  const snapshot: Record<string, Record<string, unknown>[]> = {};

  for (const schema of TABLE_SCHEMAS) {
    const name = tableName(schema.logicalName);
    const items = await scanAll(name);
    snapshot[schema.logicalName] = items;
    console.log(`dumped ${schema.logicalName}: ${items.length} item(s)`);
  }

  writeFileSync(outPath, JSON.stringify(snapshot, jsonReplacer, 2), "utf8");
  console.log(`dump: wrote ${outPath}`);
}

dump().catch((e: unknown) => {
  console.error("dump: failed —", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
