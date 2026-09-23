import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { resetConfigForTests } from "@chaperone/config";
import { resetDdbClientForTests } from "../src/client.js";
import {
  FIXTURE_MODEL_ID_PREFIX,
  getAdvisory,
  getFixtureAdvisory,
  isFixtureAdvisory,
  putAdvisory,
  putFixtureAdvisory,
  type Advisory,
} from "../src/repos/advisory.js";

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

const fixtureRow: Advisory = {
  quarantineId: "fixture:grocery-add-item-calendar-clause",
  score: 72,
  summary: "A hand-written line.",
  modelId: `${FIXTURE_MODEL_ID_PREFIX}hand-written-not-model-output`,
  generatedAt: "2026-09-23T00:00:00.000Z",
  promptSha: "fixture",
};

describe("fixture advisories", () => {
  it("isFixtureAdvisory keys on the modelId prefix and nothing else", () => {
    expect(isFixtureAdvisory(fixtureRow)).toBe(true);
    expect(isFixtureAdvisory({ modelId: "us.amazon.nova-lite-v1:0" })).toBe(false);
  });

  it("putFixtureAdvisory stores under a FIXTURE#<hash> key, never a quarantine key", async () => {
    ddbMock.on(PutCommand).resolves({});
    await putFixtureAdvisory("sha256:abc", fixtureRow);
    const [call] = ddbMock.commandCalls(PutCommand);
    expect(call?.args[0].input.TableName).toBe("chaperone-advisory");
    expect(call?.args[0].input.Item?.["pk"]).toBe("FIXTURE#sha256:abc");
    expect(call?.args[0].input.Item?.["modelId"]).toBe(fixtureRow.modelId);
  });

  it("putFixtureAdvisory refuses a row that is not labelled as a fixture", async () => {
    await expect(putFixtureAdvisory("sha256:abc", { ...fixtureRow, modelId: "us.amazon.nova-lite-v1:0" })).rejects.toThrow(
      /does not start with "fixture:"/,
    );
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("getFixtureAdvisory reads by hash, and returns undefined when there is no such row", async () => {
    ddbMock.on(GetCommand).resolvesOnce({ Item: { pk: "FIXTURE#sha256:abc", ...fixtureRow } }).resolvesOnce({});
    expect((await getFixtureAdvisory("sha256:abc"))?.summary).toBe("A hand-written line.");
    expect(await getFixtureAdvisory("sha256:other")).toBeUndefined();
    const keys = ddbMock.commandCalls(GetCommand).map((c) => c.args[0].input.Key?.["pk"]);
    expect(keys).toEqual(["FIXTURE#sha256:abc", "FIXTURE#sha256:other"]);
  });

  it("a fixture is invisible to the ordinary by-quarantine read", async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await getAdvisory("fixture:grocery-add-item-calendar-clause")).toBeUndefined();
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.Key?.["pk"]).toBe("QUAR#fixture:grocery-add-item-calendar-clause");
  });

  it("putAdvisory (the real path) is unchanged: keyed by quarantine id", async () => {
    ddbMock.on(PutCommand).resolves({});
    await putAdvisory({ ...fixtureRow, quarantineId: "q1", modelId: "us.amazon.nova-lite-v1:0" });
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item?.["pk"]).toBe("QUAR#q1");
  });
});
