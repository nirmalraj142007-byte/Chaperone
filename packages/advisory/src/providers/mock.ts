import type { ModelInvocationRequest, ModelInvocationResult, ModelProvider } from "../provider.js";

export interface MockModelProviderOptions {
  modelId?: string;
  /** Overrides the default canned response. Receives the 0-indexed call number so a test can vary behaviour across retries. */
  respond?: (request: ModelInvocationRequest, callIndex: number) => ModelInvocationResult | Promise<ModelInvocationResult>;
  /** Returning a value (typically an UpstreamError/UpstreamTimeoutError instance) throws it instead of responding for this call number. */
  throwOn?: (callIndex: number) => unknown;
}

/**
 * The only provider anything in this phase actually calls — CLAUDE.md: "no
 * working model provider yet... build everything against a mocked
 * provider, and stop short of the one real invocation." Every test and
 * every `pnpm advisory:run-local` run in this phase constructs this class,
 * never BedrockModelProvider.
 */
export class MockModelProvider implements ModelProvider {
  readonly modelId: string;
  private callIndex = 0;

  constructor(private readonly options: MockModelProviderOptions = {}) {
    this.modelId = options.modelId ?? "mock-advisory-v1";
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const index = this.callIndex++;

    if (this.options.throwOn) {
      const error = this.options.throwOn(index);
      if (error) {
        throw error;
      }
    }

    if (this.options.respond) {
      return this.options.respond(request, index);
    }

    return {
      text: JSON.stringify({
        score: 15,
        summary: "Mock advisory: wording changed but no elevated-risk capability detected.",
      }),
      modelId: this.modelId,
    };
  }
}
