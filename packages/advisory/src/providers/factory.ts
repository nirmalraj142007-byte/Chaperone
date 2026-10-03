import { ConfigError } from "@chaperone/errors";
import type { ModelProvider } from "../provider.js";
import { BedrockModelProvider } from "./bedrock.js";
import { GroqModelProvider, type GroqModelProviderOptions } from "./groq.js";

export const MODEL_PROVIDER_KINDS = ["groq", "bedrock"] as const;
export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number];

/**
 * Confirmed present on Groq's live `GET /openai/v1/models` on 2026-10-03
 * (context window 131072). An open-weight model served by Groq.
 */
export const DEFAULT_GROQ_MODEL_ID = "openai/gpt-oss-120b";

/** Groq has a default model id; Bedrock deliberately has none (an unconfirmed Bedrock id must never be guessed). */
export function resolveModelId(kind: ModelProviderKind, configured: string | undefined, envName: string): string {
  if (configured) {
    return configured;
  }
  if (kind === "groq") {
    return DEFAULT_GROQ_MODEL_ID;
  }
  throw new ConfigError(`MODEL_PROVIDER=bedrock requires ${envName} to be set.`, { key: envName });
}

export interface CreateModelProviderOptions {
  kind: ModelProviderKind;
  modelId: string;
  /** Required for `groq`. */
  groqApiKey?: string | undefined;
  /** Required for `bedrock`. */
  awsRegion?: string | undefined;
  /** Passed through to GroqModelProvider; ignored for bedrock. */
  groq?: Partial<Omit<GroqModelProviderOptions, "modelId" | "apiKey">>;
}

/**
 * The one place `MODEL_PROVIDER` turns into a class. Switching back to
 * Bedrock is `MODEL_PROVIDER=bedrock` and nothing else: BedrockModelProvider
 * is untouched by the Groq work.
 */
export function createModelProvider(options: CreateModelProviderOptions): ModelProvider {
  if (options.kind === "groq") {
    if (!options.groqApiKey) {
      throw new ConfigError("MODEL_PROVIDER=groq requires GROQ_API_KEY to be set.", { key: "GROQ_API_KEY" });
    }
    return new GroqModelProvider({ ...options.groq, modelId: options.modelId, apiKey: options.groqApiKey });
  }
  if (!options.awsRegion) {
    throw new ConfigError("MODEL_PROVIDER=bedrock requires an AWS region.", { key: "AWS_REGION" });
  }
  return new BedrockModelProvider({ modelId: options.modelId, region: options.awsRegion });
}
