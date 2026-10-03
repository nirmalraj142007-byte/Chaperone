import { loadConfig } from "@chaperone/config";
import {
  createModelProvider,
  GroqModelProvider,
  MockModelProvider,
  resolveModelId,
  runLocalAdvisoryPipeline,
  type ModelProvider,
} from "../src/index.js";

/**
 * `pnpm advisory:run-local` — the in-process stand-in for the AWS-01 Step
 * Functions pipeline, run against a real (local) DynamoDB. The provider is
 * `MODEL_PROVIDER` (groq by default, bedrock as a config-only switch back);
 * `ADVISORY_PROVIDER=mock` is kept for runs that must not touch the network.
 * The model is `ADVISORY_MODEL_ID`, defaulting to openai/gpt-oss-120b on Groq.
 */
function resolveProvider(): { provider: ModelProvider; kind: string } {
  if ((process.env.ADVISORY_PROVIDER ?? "").toLowerCase() === "mock") {
    return { provider: new MockModelProvider(), kind: "mock" };
  }
  const { modelProvider, advisoryModelId, groqApiKey, awsRegion } = loadConfig();
  const modelId = resolveModelId(modelProvider, advisoryModelId, "ADVISORY_MODEL_ID");
  return {
    provider: createModelProvider({ kind: modelProvider, modelId, groqApiKey, awsRegion }),
    kind: `${modelProvider} (${modelId})`,
  };
}

async function main(): Promise<void> {
  const { householdId } = loadConfig();
  const { provider, kind } = resolveProvider();

  console.log(`advisory:run-local — provider=${kind} household=${householdId}`);
  const result = await runLocalAdvisoryPipeline(householdId, provider);
  console.log(JSON.stringify(result, null, 2));
  if (provider instanceof GroqModelProvider) {
    console.log(`groq http attempts: ${provider.httpAttempts} (rate-limited: ${provider.rateLimited})`);
  }

  if (result.errored > 0) {
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error("advisory:run-local: failed —", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
