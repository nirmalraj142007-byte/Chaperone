/**
 * Drops every row in the `sse-event` table. A local benchmark fixture, not
 * a product capability.
 *
 * Why this has to exist. `sse-event` holds resumable-SSE replay state and
 * carries a TTL, so in production DynamoDB evicts it and the table stays
 * small. DynamoDB Local does not implement TTL at all: the rows accumulate
 * forever, and because its backend is SQLite, write latency climbs as the
 * table grows. Measured on this repo — a `pnpm bench` run writes several
 * thousand rows, and successive runs on the same volume got monotonically
 * slower (added p50 64ms, then 174ms, at the same commit with no code
 * change between them). That is not a property of the gateway; it is a
 * property of a dev container, and a benchmark whose result depends on how
 * many times it has been run before is not a measurement.
 *
 * So `pnpm bench` resets this table first, and a run therefore starts from
 * a defined state. Against real DynamoDB the same reset is unnecessary —
 * TTL evicts, and write latency does not depend on table size.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It never touches `ledger-event`. That table is the append-only,
 *     hash-chained evidence chain, `pnpm verify-ledger` walks it, and
 *     nothing in this repo may delete from it (CLAUDE.md's sixth
 *     non-negotiable). Only `sse-event` is named below.
 *   - It refuses to run without `DDB_ENDPOINT`. That variable is what
 *     points the SDK at DynamoDB Local; without it the client would talk
 *     to real AWS, and a benchmark fixture must not be one fat-fingered
 *     environment away from deleting a deployed household's replay state.
 */
import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { loadConfig } from "@chaperone/config";
import { getDdbDocClient } from "../src/client.js";
import { tableName } from "../src/tables.js";

/** DynamoDB's hard cap on BatchWriteItem. */
const BATCH_LIMIT = 25;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function main(): Promise<void> {
  const { ddbEndpoint } = loadConfig();
  if (ddbEndpoint === undefined) {
    throw new Error(
      "refusing to run without DDB_ENDPOINT set. This deletes every sse-event row and is only ever " +
        "meant for DynamoDB Local, where TTL does not evict. Against real DynamoDB, TTL handles this.",
    );
  }

  const table = tableName("sse-event");
  const client = getDdbDocClient();

  let deleted = 0;
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await client.send(
      new ScanCommand({
        TableName: table,
        // Only the key attributes — a delete needs nothing else, and the
        // stored SSE messages can be large.
        ProjectionExpression: "pk, seq",
        ...(startKey !== undefined ? { ExclusiveStartKey: startKey } : {}),
      }),
    );

    const items = page.Items ?? [];
    for (const batch of chunk(items, BATCH_LIMIT)) {
      await client.send(
        new BatchWriteCommand({
          RequestItems: {
            [table]: batch.map((item) => ({ DeleteRequest: { Key: { pk: item["pk"], seq: item["seq"] } } })),
          },
        }),
      );
      deleted += batch.length;
    }

    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);

  console.log(`reset-sse: deleted ${deleted} rows from ${table} (ledger-event untouched)`);
}

main().catch((e: unknown) => {
  console.error("reset-sse: failed —", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
