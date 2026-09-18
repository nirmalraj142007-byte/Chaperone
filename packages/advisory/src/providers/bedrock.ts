import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { UpstreamError, UpstreamTimeoutError } from "@chaperone/errors";
import type { ModelInvocationRequest, ModelInvocationResult, ModelProvider } from "../provider.js";

export interface BedrockModelProviderOptions {
  modelId: string;
  region: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Maps whatever the SDK throws onto the closed error taxonomy. Our own
 * `AbortSignal.timeout` firing surfaces as a `DOMException` named
 * "TimeoutError" (the same check `packages/crawler/src/http.ts` already
 * uses); Bedrock's own server-side timeout is the separate
 * `ModelTimeoutException`. Everything else becomes `UpstreamError` with the
 * original exception name preserved in `context.providerErrorName` — that
 * field is how scoreDiff.ts's retry predicate tells a retryable throttling
 * failure (`ThrottlingException`, `ServiceUnavailableException`,
 * `ModelNotReadyException`) apart from a terminal one (`ValidationException`,
 * `AccessDeniedException`, ...) without this provider needing to know
 * anything about retry policy itself.
 */
function toChaperoneError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new UpstreamTimeoutError("Bedrock Converse call timed out", { providerErrorName: error.name });
  }
  const name = error instanceof Error ? error.name : undefined;
  if (name === "ModelTimeoutException") {
    return new UpstreamTimeoutError("Bedrock Converse call timed out", {
      cause: errorMessage(error),
      providerErrorName: name,
    });
  }
  return new UpstreamError("Bedrock Converse call failed", { cause: errorMessage(error), providerErrorName: name });
}

/**
 * Verified against the actually-installed `@aws-sdk/client-bedrock-runtime`
 * (see its `package.json` for the pinned version) by reading
 * `dist-types/commands/ConverseCommand.d.ts` and
 * `dist-types/BedrockRuntimeClient.d.ts` directly on 2026-09-18, per
 * CLAUDE.md's "verify rather than remember": `ConverseCommand`'s request is
 * `{ modelId, messages: [{ role, content: [{ text }] }], inferenceConfig:
 * { maxTokens, ... } }`; its response is `{ output: { message: { content:
 * [{ text }] } }, stopReason, usage, ... }`; `BedrockRuntimeClient` extends
 * `@smithy/core/client`'s `Client`, whose `send(command, options)` accepts
 * `{ abortSignal, requestTimeout }` from `@smithy/types`'s
 * `HttpHandlerOptions` — confirmed in
 * `@smithy/types/dist-types/http.d.ts`. The Converse API (rather than the
 * older per-model-family `InvokeModel` body format) is used specifically
 * because it is the one request/response shape that works across model
 * families, so this provider never hard-codes an Anthropic-specific
 * message envelope, matching CLAUDE.md's "either Bedrock or the Anthropic
 * API can back it with a config change" requirement.
 *
 * Not invoked by anything in this phase. CLAUDE.md: "no working model
 * provider yet... build everything that does not require a live call,
 * against a mocked provider, and stop short of the one real invocation."
 * Every test and every `pnpm advisory:run-local` run in this phase
 * constructs `MockModelProvider`, never this class. The one real
 * invocation that would confirm `BEDROCK_MODEL_ID` resolves in the
 * configured region — CLAUDE.md's separate "Bedrock model availability"
 * verification rule — is an explicit TODO; see docs/AWS-BUILDER.md.
 */
export class BedrockModelProvider implements ModelProvider {
  readonly modelId: string;
  private readonly client: BedrockRuntimeClient;

  constructor(options: BedrockModelProviderOptions) {
    this.modelId = options.modelId;
    this.client = new BedrockRuntimeClient({ region: options.region });
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const command = new ConverseCommand({
      modelId: this.modelId,
      messages: [{ role: "user", content: [{ text: request.prompt }] }],
      inferenceConfig: { maxTokens: request.maxTokens, temperature: 0 },
    });

    let response;
    try {
      response = await this.client.send(command, { abortSignal: AbortSignal.timeout(request.timeoutMs) });
    } catch (error) {
      throw toChaperoneError(error);
    }

    const block = response.output?.message?.content?.[0];
    const text = block && "text" in block ? block.text : undefined;
    if (text === undefined) {
      throw new UpstreamError("Bedrock Converse response had no text content block", {
        modelId: this.modelId,
        stopReason: response.stopReason,
      });
    }

    return { text, modelId: this.modelId };
  }
}
