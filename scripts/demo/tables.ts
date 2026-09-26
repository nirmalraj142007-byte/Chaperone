/**
 * Which DynamoDB tables `pnpm demo:reset` owns, and which it must never touch.
 *
 * The reset used to drop every table in TABLE_SCHEMAS. That included
 * `tool-snapshot` and `corpus-server`, which the crawler writes to during a
 * crawl, so a `demo:reset` run near the 2026-10-02 interim crawl or the
 * 2026-10-20 crawl 2 would have destroyed that crawl's rows (found in the
 * 2026-09-26 audit). The split below is total and disjoint: a test asserts
 * every logical table name is in exactly one list, so a table added later has
 * to be classified before the reset will run against it.
 */
import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { TABLE_LOGICAL_NAMES, tableExists, tableName, type TableLogicalName } from "@chaperone/ledger";

/** Tables the demo stages and the reset may drop and recreate. */
export const DEMO_OWNED_TABLES = [
  "pin",
  "quarantine",
  "ledger-event",
  "session",
  "sse-event",
  "advisory",
] as const satisfies readonly TableLogicalName[];

/** Tables the crawler and the drift analysis own. `demo:reset` never drops, deletes from, or recreates these. */
export const CRAWL_OWNED_TABLES = [
  "tool-snapshot",
  "corpus-server",
  "drift-record",
] as const satisfies readonly TableLogicalName[];

const OWNED = new Set<string>([...DEMO_OWNED_TABLES, ...CRAWL_OWNED_TABLES]);

/** Logical names that appear in neither list. Empty unless a table was added without being classified. */
export function unclassifiedTables(): TableLogicalName[] {
  return TABLE_LOGICAL_NAMES.filter((name) => !OWNED.has(name));
}

export interface DropPlan {
  /** Physical names of demo-owned tables that exist right now and will be dropped. */
  willDrop: string[];
  /** Physical names of demo-owned tables that do not exist yet, so there is nothing to drop. */
  absent: string[];
  /** Physical names of crawl-owned tables. Never touched, whether or not they exist. */
  preserved: string[];
}

/** Read-only: inspects which demo tables exist. Drops nothing. */
export async function planDemoDrop(client: DynamoDBClient): Promise<DropPlan> {
  const missing = unclassifiedTables();
  if (missing.length > 0) {
    throw new Error(
      `refusing to reset: table(s) ${missing.join(", ")} are in TABLE_LOGICAL_NAMES but in neither DEMO_OWNED_TABLES nor ` +
        "CRAWL_OWNED_TABLES (scripts/demo/tables.ts). Classify them first; the reset will not guess which side owns a table.",
    );
  }
  const plan: DropPlan = { willDrop: [], absent: [], preserved: CRAWL_OWNED_TABLES.map((name) => tableName(name)) };
  for (const logical of DEMO_OWNED_TABLES) {
    const name = tableName(logical);
    if (await tableExists(client, name)) {
      plan.willDrop.push(name);
    } else {
      plan.absent.push(name);
    }
  }
  return plan;
}

/**
 * Prints the plan, then drops exactly `plan.willDrop`. Only ever called after
 * assertLocalDynamoDb(); this function does not re-check the endpoint.
 */
export async function dropDemoTables(
  client: DynamoDBClient,
  plan: DropPlan,
  log: (line: string) => void,
): Promise<number> {
  log(`tables: will drop ${plan.willDrop.length} demo-owned table(s): ${plan.willDrop.join(", ") || "(none exist)"}`);
  if (plan.absent.length > 0) {
    log(`tables: not present, nothing to drop: ${plan.absent.join(", ")}`);
  }
  log(`tables: preserved, crawl-owned, never dropped by demo:reset: ${plan.preserved.join(", ")}`);
  for (const name of plan.willDrop) {
    await client.send(new DeleteTableCommand({ TableName: name }));
  }
  return plan.willDrop.length;
}
