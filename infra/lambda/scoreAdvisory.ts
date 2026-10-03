/**
 * AWS-01's model-calling Lambda. Bedrock access for this account was declined
 * (docs/LIMITATIONS.md), so it calls openai/gpt-oss-120b on Groq, an
 * open-weight model served by Groq, through `GroqModelProvider`.
 * Triggered per `chaperone-quarantine` stream INSERT via the EventBridge Pipe
 * in `../lib/advisory-pipeline-stack.ts`, with `{householdId, quarantineId}`
 * as its event: deliberately not the stream record's NewImage, so it always
 * scores against the freshest read of the quarantine row.
 *
 * The Groq key is read from AWS Secrets Manager at runtime, by ARN from
 * `GROQ_SECRET_ARN`, and cached for the life of the execution environment. It
 * is never in the template, the bundle or the environment.
 *
 * This function's IAM role may read that one secret and read
 * `chaperone-quarantine`: nothing else. It never writes to `chaperone-advisory`,
 * `chaperone-ledger-event`, or `chaperone-pin`; that split (score here, write
 * in `writeAdvisory.ts` under a different role) is what keeps the model-calling
 * code path with zero DynamoDB write capability. See
 * `packages/ledger/test/iam-advisory.test.ts`.
 */
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DEFAULT_GROQ_MODEL_ID, GroqModelProvider, scoreDiff, type ScoreDiffResult } from "@chaperone/advisory";
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

let cachedKey: string | undefined;

/**
 * The secret may be the bare key or a JSON object with a `GROQ_API_KEY` field
 * (what the console's "key/value" secret type stores). Never logged.
 */
async function groqApiKey(): Promise<string> {
  if (cachedKey !== undefined) {
    return cachedKey;
  }
  const client = new SecretsManagerClient({});
  const result = await client.send(new GetSecretValueCommand({ SecretId: requireEnv("GROQ_SECRET_ARN") }));
  const raw = result.SecretString?.trim();
  if (!raw) {
    throw new Error("the Groq secret has no SecretString");
  }
  let key = raw;
  if (raw.startsWith("{")) {
    key = (JSON.parse(raw) as { GROQ_API_KEY?: string }).GROQ_API_KEY ?? "";
  }
  if (!key) {
    throw new Error("the Groq secret has no GROQ_API_KEY");
  }
  cachedKey = key;
  return key;
}

export async function handler(event: ScoreAdvisoryEvent): Promise<ScoreAdvisoryOutput> {
  const modelId = process.env["ADVISORY_MODEL_ID"] ?? DEFAULT_GROQ_MODEL_ID;

  const quarantine = await getQuarantine(event.householdId, event.quarantineId);
  if (quarantine === undefined || quarantine.status !== "pending") {
    log.warn({ quarantineId: event.quarantineId }, "quarantine missing or no longer pending; advisory unavailable");
    return { status: "unavailable", reason: "quarantine-not-pending", quarantineId: event.quarantineId };
  }

  const before = parseCanonicalTool(quarantine.fromCanonicalJson);
  const after = parseCanonicalTool(quarantine.toCanonicalJson);

  // Short rate-limit budget: past it the call fails fast as a RateLimitError, which
  // scoreDiff retries inside its 20s budget, rather than a Lambda sleeping to its timeout.
  const provider = new GroqModelProvider({ modelId, apiKey: await groqApiKey(), maxRateLimitWaitMs: 8_000 });
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
