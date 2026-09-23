import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { resetConfigForTests } from "@chaperone/config";
import { ensureTables, tableExists } from "../src/provision.js";
import { TABLE_SCHEMAS } from "../src/schema.js";

const ddbMock = mockClient(DynamoDBClient);

let previousUpstreams: string | undefined;

beforeEach(() => {
  previousUpstreams = process.env["CHAPERONE_UPSTREAMS"];
  process.env["CHAPERONE_UPSTREAMS"] = JSON.stringify([{ id: "grocery", url: "http://localhost:4001/mcp", label: "Grocery" }]);
  resetConfigForTests();
  ddbMock.reset();
});

afterEach(() => {
  ddbMock.reset();
  if (previousUpstreams === undefined) {
    delete process.env["CHAPERONE_UPSTREAMS"];
  } else {
    process.env["CHAPERONE_UPSTREAMS"] = previousUpstreams;
  }
  resetConfigForTests();
});

const notFound = (): ResourceNotFoundException => new ResourceNotFoundException({ message: "no such table", $metadata: {} });

describe("ensureTables", () => {
  it("creates every table in TABLE_SCHEMAS when none exist, and turns TTL on where the schema asks", async () => {
    ddbMock.on(DescribeTableCommand).rejects(notFound());
    ddbMock.on(CreateTableCommand).resolves({});
    ddbMock.on(UpdateTimeToLiveCommand).resolves({});

    const lines: string[] = [];
    const result = await ensureTables(new DynamoDBClient({}), (line) => lines.push(line));

    expect(result.created).toHaveLength(TABLE_SCHEMAS.length);
    expect(result.skipped).toHaveLength(0);
    expect(ddbMock.commandCalls(CreateTableCommand)).toHaveLength(TABLE_SCHEMAS.length);
    const ttlTables = TABLE_SCHEMAS.filter((s) => s.ttlAttribute !== undefined).length;
    expect(ttlTables).toBeGreaterThan(0);
    expect(ddbMock.commandCalls(UpdateTimeToLiveCommand)).toHaveLength(ttlTables);
    expect(lines.filter((l) => l.startsWith("create "))).toHaveLength(TABLE_SCHEMAS.length);
  });

  it("is idempotent: existing tables are skipped, not recreated", async () => {
    ddbMock.on(DescribeTableCommand).resolves({});
    const result = await ensureTables(new DynamoDBClient({}));
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(TABLE_SCHEMAS.length);
    expect(ddbMock.commandCalls(CreateTableCommand)).toHaveLength(0);
  });

  it("tableExists rethrows anything that is not a missing table", async () => {
    ddbMock.on(DescribeTableCommand).rejects(new Error("connection refused"));
    await expect(tableExists(new DynamoDBClient({}), "chaperone-pin")).rejects.toThrow("connection refused");
  });
});
