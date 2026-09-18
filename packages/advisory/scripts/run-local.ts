import { loadConfig } from "@chaperone/config";
import type { ModelProvider } from "../src/provider.js";
import { MockModelProvider } from "../src/providers/mock.js";
import { BedrockModelProvider } from "../src/providers/bedrock.js";
import { runLocalAdvisoryPipeline } from "../src/localRunner.js";

/**
 * `pnpm advisory:run-local` — the in-process stand-in for the AWS-01 Step
 * Functions pipeline, run against a real (local) DynamoDB. Defaults to
 * `ADVISORY_PROVIDER=mock`: CLAUDE.md's "no working model provider yet...
 * stop short of the one real invocation" means this script must not reach
 * Bedrock by default. `ADVISORY_PROVIDER=bedrock` constructs the real
 * provider for whoever picks this up once Bedrock access clears, but
 * nothing in this phase sets that env var.
 */
function resolveProvider(): { provider: ModelProvider; kind: string } {
  const kind = (process.env.ADVISORY_PROVIDER ?? "mock").toLowerCase();

  if (kind === "mock") {
    return { provider: new MockModelProvider(), kind };
  }

  if (kind === "bedrock") {
    const { bedrockModelId, awsRegion } = loadConfig();
    if (!bedrockModelId) {
      throw new Error("ADVISORY_PROVIDER=bedrock requires BEDROCK_MODEL_ID to be set.");
    }
    return { provider: new BedrockModelProvider({ modelId: bedrockModelId, region: awsRegion }), kind };
  }

  throw new Error(
    `Unknown ADVISORY_PROVIDER "${kind}". Expected "mock" or "bedrock" ` +
      `(direct Anthropic API backing is not implemented yet — see docs/AWS-BUILDER.md).`,
  );
}

async function main(): Promise<void> {
  const { householdId } = loadConfig();
  const { provider, kind } = resolveProvider();

  console.log(`advisory:run-local — provider=${kind} household=${householdId}`);
  const result = await runLocalAdvisoryPipeline(householdId, provider);
  console.log(JSON.stringify(result, null, 2));

  if (result.errored > 0) {
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error("advisory:run-local: failed —", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
