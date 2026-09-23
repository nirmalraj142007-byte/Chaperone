/**
 * AWS-01's Bedrock-calling Lambda — the real deployment target
 * `infra/iam-advisory.json`'s `chaperone-bedrock-advisory-role` was audited
 * for (`packages/ledger/test/iam-advisory.test.ts`). Triggered per
 * `chaperone-quarantine` stream INSERT via the EventBridge Pipe defined in
 * `../lib/advisory-pipeline-stack.ts`, with `{householdId, quarantineId}` as
 * its event — deliberately not the stream record's NewImage directly, so
 * this always scores against the freshest read of the quarantine row rather
 * than trusting whatever the stream happened to capture.
 *
 * This function's own IAM role may call Bedrock and read `chaperone-quarantine`
 * — nothing else. It never writes to `chaperone-advisory`, `chaperone-ledger-event`,
 * or `chaperone-pin`; that split (score here, write in `writeAdvisory.ts`,
 * under a completely different, non-Bedrock role) is what keeps the
 * model-calling code path with zero DynamoDB write capability at all — see
 * `packages/ledger/test/iam-advisory.test.ts`'s "the Bedrock role's action
 * list contains no DynamoDB write verb at all".
 */
import { BedrockModelProvider, scoreDiff, type ScoreDiffResult } from "@chaperone/advisory";
import { getQuarantine } from "@chaperone/ledger";
import { childLogger } from "@chaperone/logger";

const log = childLogger({ component: "advisory-pipeline-score" });

interface ScoreAdvisoryEvent {
  householdId: string;
  quarantineId: string;
}

export type ScoreAdvisoryOutput = (ScoreDiffResult & { quarantineId: string });

interface ParsedTool {
  name?: string;
  description?: string;
}

function parseCanonicalTool(json: string): ParsedTool {
  try {
    const parsed = JSON.parse(json) as ParsedTool;
    return {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    };
  } catch {
    return {};
  }
}

function changedFieldsFor(before: ParsedTool, after: ParsedTool): string[] {
  const fields: string[] = [];
  if (before.name !== after.name) {
    fields.push("name");
  }
  if ((before.description ?? "") !== (after.description ?? "")) {
    fields.push("description");
  }
  return fields;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set in the ScoreAdvisory Lambda's environment`);
  }
  return value;
}

export async function handler(event: ScoreAdvisoryEvent): Promise<ScoreAdvisoryOutput> {
  const modelId = requireEnv("ADVISORY_MODEL_ID");
  // Lambda injects AWS_REGION automatically; @chaperone/config's own
  // AWS_REGION default ("us-east-1") is for local/dev use only and is never
  // relied on here.
  const region = requireEnv("AWS_REGION");

  const quarantine = await getQuarantine(event.householdId, event.quarantineId);
  if (quarantine === undefined || quarantine.status !== "pending") {
    log.warn({ quarantineId: event.quarantineId }, "quarantine missing or no longer pending; advisory unavailable");
    return { status: "unavailable", reason: "quarantine-not-pending", quarantineId: event.quarantineId };
  }

  const before = parseCanonicalTool(quarantine.fromCanonicalJson);
  const after = parseCanonicalTool(quarantine.toCanonicalJson);

  const provider = new BedrockModelProvider({ modelId, region });
  const result = await scoreDiff(
    {
      toolName: quarantine.toolName,
      upstreamLabel: quarantine.upstreamId,
      capabilityClass: quarantine.capabilityClass,
      changedFields: changedFieldsFor(before, after),
      beforeDescription: before.description ?? "",
      afterDescription: after.description ?? "",
    },
    provider,
  );

  return { ...result, quarantineId: event.quarantineId };
}
