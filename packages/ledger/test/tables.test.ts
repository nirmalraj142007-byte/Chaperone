import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigForTests } from "@chaperone/config";
import { tableName } from "../src/tables.js";
import { TABLE_SCHEMAS } from "../src/schema.js";

describe("tableName", () => {
  const previous: Record<string, string | undefined> = {};

  beforeEach(() => {
    previous["CHAPERONE_UPSTREAMS"] = process.env["CHAPERONE_UPSTREAMS"];
    previous["DDB_TABLE_PREFIX"] = process.env["DDB_TABLE_PREFIX"];
    process.env["CHAPERONE_UPSTREAMS"] = JSON.stringify([
      { id: "grocery", url: "http://localhost:4001/mcp", label: "Grocery" },
    ]);
    resetConfigForTests();
  });

  afterEach(() => {
    for (const key of Object.keys(previous)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetConfigForTests();
  });

  it("prefixes with the default table prefix when DDB_TABLE_PREFIX is unset", () => {
    delete process.env["DDB_TABLE_PREFIX"];
    resetConfigForTests();
    expect(tableName("ledger-event")).toBe("chaperone-ledger-event");
  });

  it("respects an overridden DDB_TABLE_PREFIX", () => {
    process.env["DDB_TABLE_PREFIX"] = "chaperone-test";
    resetConfigForTests();
    expect(tableName("quarantine")).toBe("chaperone-test-quarantine");
  });
});

describe("TABLE_SCHEMAS", () => {
  it("declares exactly the 9 tables the migration spec requires", () => {
    const names = TABLE_SCHEMAS.map((s) => s.logicalName).sort();
    expect(names).toEqual(
      [
        "advisory",
        "corpus-server",
        "drift-record",
        "ledger-event",
        "pin",
        "quarantine",
        "session",
        "sse-event",
        "tool-snapshot",
      ].sort(),
    );
  });

  it("every GSI key attribute also appears in that table's own key schema or is a distinct attribute", () => {
    for (const schema of TABLE_SCHEMAS) {
      if (schema.gsi) {
        expect(schema.gsi.keys).toHaveLength(2);
        expect(schema.gsi.keys[0]?.keyType).toBe("HASH");
        expect(schema.gsi.keys[1]?.keyType).toBe("RANGE");
      }
    }
  });
});
