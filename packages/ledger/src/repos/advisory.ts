import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDdbDocClient } from "../client.js";
import { tableName } from "../tables.js";
import { withDynamoErrors } from "../errors.js";

export interface Advisory {
  quarantineId: string;
  score: number;
  summary: string;
  modelId: string;
  generatedAt: string;
  promptSha: string;
}

function partitionKey(quarantineId: string): string {
  return `QUAR#${quarantineId}`;
}

export async function putAdvisory(advisory: Advisory): Promise<void> {
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new PutCommand({
        TableName: tableName("advisory"),
        Item: { pk: partitionKey(advisory.quarantineId), ...advisory },
      }),
    ),
  );
}

export async function getAdvisory(quarantineId: string): Promise<Advisory | undefined> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new GetCommand({
        TableName: tableName("advisory"),
        Key: { pk: partitionKey(quarantineId) },
      }),
    ),
  );
  return result.Item as Advisory | undefined;
}

/**
 * Fixture advisories — the offline demo's stand-in for a model call.
 *
 * Real advisory output does not exist: no model provider is chosen (Bedrock
 * access for this account was declined; see docs/LIMITATIONS.md). The offline demo still needs
 * the consent card's advisory line to appear instantly, so
 * `pnpm demo:reset` writes hand-written rows from demo/advisory-fixtures.json.
 *
 * A quarantine's id is minted at the moment the gate first sees a mismatch,
 * so a fixture cannot be keyed by it in advance. It is keyed by the hash of
 * the definition it describes instead (`FIXTURE#<toHash>`), and only ever
 * consulted after a real, model-written row for the quarantine turned out
 * not to exist. A real advisory always wins.
 *
 * Every fixture row carries a `modelId` starting with FIXTURE_MODEL_ID_PREFIX,
 * and every surface that displays an advisory (the consent card renderers,
 * the console) keys its "this is a fixture, not model output" label on that
 * prefix. Nothing writes these rows except scripts/demo-reset.ts, which
 * refuses to run against anything but DynamoDB Local.
 */
export const FIXTURE_MODEL_ID_PREFIX = "fixture:";

export function isFixtureAdvisory(advisory: Pick<Advisory, "modelId">): boolean {
  return advisory.modelId.startsWith(FIXTURE_MODEL_ID_PREFIX);
}

function fixturePartitionKey(toHash: string): string {
  return `FIXTURE#${toHash}`;
}

export async function putFixtureAdvisory(toHash: string, advisory: Advisory): Promise<void> {
  if (!isFixtureAdvisory(advisory)) {
    throw new Error(`putFixtureAdvisory: modelId "${advisory.modelId}" does not start with "${FIXTURE_MODEL_ID_PREFIX}"`);
  }
  await withDynamoErrors(() =>
    getDdbDocClient().send(
      new PutCommand({
        TableName: tableName("advisory"),
        Item: { pk: fixturePartitionKey(toHash), ...advisory },
      }),
    ),
  );
}

/** The fixture row describing the definition with this hash, if `demo:reset` wrote one. Callers try the real row first; see gateway/src/advisoryLookup.ts. */
export async function getFixtureAdvisory(toHash: string): Promise<Advisory | undefined> {
  const result = await withDynamoErrors(() =>
    getDdbDocClient().send(
      new GetCommand({
        TableName: tableName("advisory"),
        Key: { pk: fixturePartitionKey(toHash) },
      }),
    ),
  );
  return result.Item as Advisory | undefined;
}
