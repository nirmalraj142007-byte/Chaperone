/**
 * The narrow surface scoreDiff.ts and everything upstream of it depend on.
 * A single prompt string in, a single text string out — no message-array
 * shape, no provider-specific request/response envelope — so a Bedrock
 * Converse call, a direct Anthropic Messages call, or a mock can all
 * implement it without leaking their own wire format into scoreDiff.ts.
 * Swapping the backing provider is a config change (which implementation
 * gets constructed), never a rewrite of the scoring logic.
 */
export interface ModelInvocationRequest {
  prompt: string;
  maxTokens: number;
  /** Milliseconds this single call may take before the provider must abort and throw `UpstreamTimeoutError`. */
  timeoutMs: number;
}

export interface ModelInvocationResult {
  text: string;
  modelId: string;
}

export interface ModelProvider {
  readonly modelId: string;
  /**
   * Throws `UpstreamTimeoutError` for a call that didn't complete within
   * `timeoutMs`, or `UpstreamError` for any other provider-side failure
   * (throttling, validation, access, service unavailability) — never a bare
   * `Error`. `UpstreamError`'s `context.providerErrorName`, when present,
   * is how scoreDiff.ts tells a retryable throttling failure apart from a
   * terminal one (see its `isRetryableProviderError`).
   */
  invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult>;
}
