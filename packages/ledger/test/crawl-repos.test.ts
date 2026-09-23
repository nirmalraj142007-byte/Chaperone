import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { resetConfigForTests } from "@chaperone/config";
import { resetDdbClientForTests } from "../src/client.js";
import {
  getCorpusServer,
  listCorpusServersByBootStatus,
  putCorpusServer,
  type CorpusServer,
} from "../src/repos/corpusServer.js";
import {
  getDriftRecord,
  listDriftRecordsByChangeClass,
  putDriftRecord,
  type DriftRecord,
} from "../src/repos/driftRecord.js";
import {
  getToolSnapshot,
  listToolSnapshotsByCrawlAndCapability,
  listToolSnapshotsForServer,
  putToolSnapshot,
  type ToolSnapshot,
} from "../src/repos/toolSnapshot.js";

// The three repos the crawler and the drift analysis write through. Each is a
// thin key-shaping layer over DynamoDB; what these tests pin down is the key
// shape and the query expressions, because those are what would silently
// break a read of already-written evidence.
const ddbMock = mockClient(DynamoDBDocumentClient);

let previousUpstreams: string | undefined;

beforeEach(() => {
  previousUpstreams = process.env["CHAPERONE_UPSTREAMS"];
  process.env["CHAPERONE_UPSTREAMS"] = JSON.stringify([{ id: "grocery", url: "http://localhost:4001/mcp", label: "Grocery" }]);
  resetConfigForTests();
  resetDdbClientForTests();
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
  resetDdbClientForTests();
});

const server: CorpusServer = {
  serverId: "acme__weather",
  displayName: "Acme Weather",
  sources: new Set(["registry"]),
  repoUrl: "https://github.com/acme/weather",
  repoOwner: "acme",
  repoName: "weather",
  installMethod: "npx",
  requiresCredentials: false,
  bootStatus: "booted",
  firstSeenAt: "2026-09-15T06:00:00.000Z",
};

describe("corpus-server repo", () => {
  it("putCorpusServer writes the server as the item, keyed by serverId", async () => {
    ddbMock.on(PutCommand).resolves({});
    await putCorpusServer(server);
    const [call] = ddbMock.commandCalls(PutCommand);
    expect(call?.args[0].input.TableName).toBe("chaperone-corpus-server");
    expect(call?.args[0].input.Item?.["serverId"]).toBe("acme__weather");
  });

  it("getCorpusServer returns the item, or undefined when there is none", async () => {
    ddbMock.on(GetCommand).resolvesOnce({ Item: server }).resolvesOnce({});
    expect((await getCorpusServer("acme__weather"))?.displayName).toBe("Acme Weather");
    expect(await getCorpusServer("missing")).toBeUndefined();
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({ serverId: "acme__weather" });
  });

  it("listCorpusServersByBootStatus queries the GSI by status, and returns [] when nothing matches", async () => {
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [server] }).resolvesOnce({});
    expect(await listCorpusServersByBootStatus("booted")).toHaveLength(1);
    expect(await listCorpusServersByBootStatus("failed")).toEqual([]);
    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.IndexName).toBe("GSI1");
    expect(input?.ExpressionAttributeValues).toEqual({ ":bootStatus": "booted" });
  });
});

const record: DriftRecord = {
  serverId: "acme__weather",
  toolName: "get_forecast",
  fromHash: "sha256:a",
  toHash: "sha256:b",
  changeClass: "semantic-intent",
  capabilityClass: "read",
  labeledBy: "author",
  labeledAt: "2026-10-21T00:00:00.000Z",
  taxonomyCommitSha: "0c896539006dbb6f8dfacc1f02ebbf179c50eec2",
  changelogSignal: "none",
};

describe("drift-record repo", () => {
  it("putDriftRecord keys by SERVER#<id> / TOOL#<name>", async () => {
    ddbMock.on(PutCommand).resolves({});
    await putDriftRecord(record);
    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(item?.["pk"]).toBe("SERVER#acme__weather");
    expect(item?.["sk"]).toBe("TOOL#get_forecast");
    expect(item?.["changeClass"]).toBe("semantic-intent");
  });

  it("getDriftRecord reads the same key it wrote, and returns undefined for a miss", async () => {
    ddbMock.on(GetCommand).resolvesOnce({ Item: record }).resolvesOnce({});
    expect((await getDriftRecord("acme__weather", "get_forecast"))?.toHash).toBe("sha256:b");
    expect(await getDriftRecord("acme__weather", "nope")).toBeUndefined();
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({ pk: "SERVER#acme__weather", sk: "TOOL#get_forecast" });
  });

  it("listDriftRecordsByChangeClass filters by class alone, or by class and capability", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [record] });
    await listDriftRecordsByChangeClass("semantic-intent");
    await listDriftRecordsByChangeClass("semantic-intent", "read");
    const [alone, both] = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(alone?.KeyConditionExpression).toBe("changeClass = :changeClass");
    expect(alone?.ExpressionAttributeValues).toEqual({ ":changeClass": "semantic-intent" });
    expect(both?.KeyConditionExpression).toBe("changeClass = :changeClass AND capabilityClass = :capabilityClass");
    expect(both?.ExpressionAttributeValues).toEqual({ ":changeClass": "semantic-intent", ":capabilityClass": "read" });
  });

  it("listDriftRecordsByChangeClass returns [] when the query has no items", async () => {
    ddbMock.on(QueryCommand).resolves({});
    expect(await listDriftRecordsByChangeClass("cosmetic")).toEqual([]);
  });
});

const snapshot: ToolSnapshot = {
  serverId: "acme__weather",
  crawlId: "crawl-1",
  toolName: "get_forecast",
  description: "Returns the forecast.",
  inputSchema: { type: "object" },
  canonicalJson: "{}",
  sha256: "sha256:a",
  capabilityClass: "read",
  capabilityConfidence: "low",
  capabilityAssignedBy: "v2",
  capturedAt: "2026-09-15T06:19:42.282Z",
  rawPayloadPath: "data/raw/crawl-1/acme.json",
};

describe("tool-snapshot repo", () => {
  it("putToolSnapshot keys by server and crawl+tool, and adds the capability-first sort key for the GSI", async () => {
    ddbMock.on(PutCommand).resolves({});
    await putToolSnapshot(snapshot);
    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(item?.["pk"]).toBe("SERVER#acme__weather");
    expect(item?.["sk"]).toBe("CRAWL#crawl-1#TOOL#get_forecast");
    expect(item?.["capSort"]).toBe("read#acme__weather");
  });

  it("getToolSnapshot reads by the same key, and returns undefined for a miss", async () => {
    ddbMock.on(GetCommand).resolvesOnce({ Item: snapshot }).resolvesOnce({});
    expect((await getToolSnapshot("acme__weather", "crawl-1", "get_forecast"))?.sha256).toBe("sha256:a");
    expect(await getToolSnapshot("acme__weather", "crawl-2", "get_forecast")).toBeUndefined();
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({
      pk: "SERVER#acme__weather",
      sk: "CRAWL#crawl-1#TOOL#get_forecast",
    });
  });

  it("listToolSnapshotsForServer pages one crawl by sort-key prefix, or every crawl without one", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [snapshot] });
    await listToolSnapshotsForServer("acme__weather");
    await listToolSnapshotsForServer("acme__weather", "crawl-1");
    const [all, one] = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(all?.KeyConditionExpression).toBe("pk = :pk");
    expect(all?.ExpressionAttributeValues).toEqual({ ":pk": "SERVER#acme__weather" });
    expect(one?.KeyConditionExpression).toBe("pk = :pk AND begins_with(sk, :skPrefix)");
    expect(one?.ExpressionAttributeValues).toEqual({ ":pk": "SERVER#acme__weather", ":skPrefix": "CRAWL#crawl-1#TOOL#" });
  });

  it("listToolSnapshotsByCrawlAndCapability queries the GSI by crawl and capability prefix", async () => {
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [snapshot] }).resolvesOnce({});
    expect(await listToolSnapshotsByCrawlAndCapability("crawl-1", "read")).toHaveLength(1);
    expect(await listToolSnapshotsByCrawlAndCapability("crawl-1", "transact")).toEqual([]);
    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.IndexName).toBe("GSI1");
    expect(input?.ExpressionAttributeValues).toEqual({ ":crawlId": "crawl-1", ":capPrefix": "read#" });
  });

  it("listToolSnapshotsForServer returns [] when the query has no items", async () => {
    ddbMock.on(QueryCommand).resolves({});
    expect(await listToolSnapshotsForServer("nobody")).toEqual([]);
  });
});
