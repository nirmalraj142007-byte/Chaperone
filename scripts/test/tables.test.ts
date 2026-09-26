import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { resetConfigForTests } from "@chaperone/config";
import { TABLE_LOGICAL_NAMES, ensureTables, tableName, type TableLogicalName } from "@chaperone/ledger";
import {
  CRAWL_OWNED_TABLES,
  DEMO_OWNED_TABLES,
  dropDemoTables,
  planDemoDrop,
  unclassifiedTables,
} from "../demo/tables.js";

/**
 * A DynamoDB that is only a map of table name to rows. It understands exactly
 * the four commands the reset path sends (Describe, Delete, Create,
 * UpdateTimeToLive) and throws on anything else, so a test fails loudly if the
 * reset ever starts issuing a command this file has not accounted for.
 */
class FakeDynamoDb {
  readonly tables = new Map<string, string[]>();
  readonly deleted: string[] = [];

  send(command: unknown): Promise<unknown> {
    if (command instanceof DescribeTableCommand) {
      const name = command.input.TableName ?? "";
      if (!this.tables.has(name)) {
        return Promise.reject(new ResourceNotFoundException({ message: `no such table: ${name}`, $metadata: {} }));
      }
      return Promise.resolve({});
    }
    if (command instanceof DeleteTableCommand) {
      const name = command.input.TableName ?? "";
      this.deleted.push(name);
      this.tables.delete(name);
      return Promise.resolve({});
    }
    if (command instanceof CreateTableCommand) {
      this.tables.set(command.input.TableName ?? "", []);
      return Promise.resolve({});
    }
    if (command instanceof UpdateTimeToLiveCommand) {
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`FakeDynamoDb: unexpected command ${(command as object).constructor.name}`));
  }

  asClient(): DynamoDBClient {
    return this as unknown as DynamoDBClient;
  }
}

let previous: Record<string, string | undefined>;

beforeEach(() => {
  previous = { CHAPERONE_UPSTREAMS: process.env["CHAPERONE_UPSTREAMS"], DDB_TABLE_PREFIX: process.env["DDB_TABLE_PREFIX"] };
  process.env["CHAPERONE_UPSTREAMS"] = JSON.stringify([{ id: "grocery", url: "http://localhost:4001/mcp", label: "Grocery" }]);
  delete process.env["DDB_TABLE_PREFIX"];
  resetConfigForTests();
});

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigForTests();
});

/** Every table exists, each holding one row that stands in for real data. */
function seededDatabase(): FakeDynamoDb {
  const db = new FakeDynamoDb();
  for (const logical of TABLE_LOGICAL_NAMES) {
    db.tables.set(tableName(logical), [`${logical}-row-1`]);
  }
  return db;
}

describe("demo:reset table ownership", () => {
  it("classifies every table exactly once: demo-owned or crawl-owned, never both, never neither", () => {
    expect(unclassifiedTables()).toEqual([]);
    const demo = new Set<string>(DEMO_OWNED_TABLES);
    for (const name of CRAWL_OWNED_TABLES) {
      expect(demo.has(name)).toBe(false);
    }
    expect([...DEMO_OWNED_TABLES, ...CRAWL_OWNED_TABLES].sort()).toEqual([...TABLE_LOGICAL_NAMES].sort());
  });

  it("names the six tables the demo owns and the three the crawler owns", () => {
    expect([...DEMO_OWNED_TABLES].sort()).toEqual(["advisory", "ledger-event", "pin", "quarantine", "session", "sse-event"]);
    expect([...CRAWL_OWNED_TABLES].sort()).toEqual(["corpus-server", "drift-record", "tool-snapshot"]);
  });
});

describe("planDemoDrop and dropDemoTables", () => {
  it("drops the demo tables and leaves tool-snapshot, corpus-server and drift-record, with their rows, untouched", async () => {
    const db = seededDatabase();
    const crawlRowsBefore = CRAWL_OWNED_TABLES.map((t) => [tableName(t), [...(db.tables.get(tableName(t)) ?? [])]] as const);

    const plan = await planDemoDrop(db.asClient());
    await dropDemoTables(db.asClient(), plan, () => {});
    // What resetDemo does next: recreate whatever is missing.
    await ensureTables(db.asClient());

    expect([...db.deleted].sort()).toEqual(DEMO_OWNED_TABLES.map((t) => tableName(t)).sort());
    for (const crawl of CRAWL_OWNED_TABLES) {
      expect(db.deleted).not.toContain(tableName(crawl));
    }
    for (const [name, rows] of crawlRowsBefore) {
      expect(db.tables.get(name), `${name} must still exist`).toEqual(rows);
      expect(rows.length).toBeGreaterThan(0);
    }
    for (const demo of DEMO_OWNED_TABLES) {
      expect(db.tables.get(tableName(demo)), `${demo} is recreated empty`).toEqual([]);
    }
  });

  it("does not create a crawl table's replacement over an existing one: ensureTables skips it", async () => {
    const db = seededDatabase();
    const plan = await planDemoDrop(db.asClient());
    await dropDemoTables(db.asClient(), plan, () => {});
    const { created, skipped } = await ensureTables(db.asClient());
    expect(created.sort()).toEqual(DEMO_OWNED_TABLES.map((t) => tableName(t)).sort());
    expect(skipped.sort()).toEqual(CRAWL_OWNED_TABLES.map((t) => tableName(t)).sort());
  });

  it("issues no DeleteTable for a crawl table even when the crawl tables are all that exist", async () => {
    const db = new FakeDynamoDb();
    for (const t of CRAWL_OWNED_TABLES) db.tables.set(tableName(t), ["crawl-row"]);

    const plan = await planDemoDrop(db.asClient());
    expect(plan.willDrop).toEqual([]);
    expect(plan.absent).toHaveLength(DEMO_OWNED_TABLES.length);
    expect(await dropDemoTables(db.asClient(), plan, () => {})).toBe(0);
    expect(db.deleted).toEqual([]);
    expect(db.tables.size).toBe(CRAWL_OWNED_TABLES.length);
  });

  it("prints what it will drop, and what it preserves, before it drops anything", async () => {
    const db = seededDatabase();
    const events: string[] = [];
    const client = {
      send: (command: unknown): Promise<unknown> => {
        if (command instanceof DeleteTableCommand) events.push(`DELETE ${command.input.TableName}`);
        return db.send(command);
      },
    } as unknown as DynamoDBClient;

    const plan = await planDemoDrop(client);
    await dropDemoTables(client, plan, (line) => events.push(`LOG ${line}`));

    const firstDelete = events.findIndex((e) => e.startsWith("DELETE "));
    const logsBefore = events.slice(0, firstDelete).join("\n");
    for (const demo of DEMO_OWNED_TABLES) {
      expect(logsBefore).toContain(tableName(demo));
    }
    expect(logsBefore).toMatch(/preserved, crawl-owned/);
    for (const crawl of CRAWL_OWNED_TABLES) {
      expect(logsBefore).toContain(tableName(crawl));
    }
    expect(events.filter((e) => e.startsWith("DELETE "))).toHaveLength(DEMO_OWNED_TABLES.length);
  });

  it("refuses to plan when a table is in neither list, rather than guessing which side owns it", async () => {
    // Simulated by passing a client for a config in which the classification is incomplete.
    const original = TABLE_LOGICAL_NAMES as unknown as TableLogicalName[];
    const extra = "new-table" as TableLogicalName;
    original.push(extra);
    try {
      await expect(planDemoDrop(seededDatabase().asClient())).rejects.toThrow(/neither DEMO_OWNED_TABLES nor CRAWL_OWNED_TABLES/);
    } finally {
      original.pop();
    }
  });
});
