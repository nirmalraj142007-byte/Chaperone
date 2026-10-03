/**
 * The narrow surface scoreDiff.ts and everything upstream of it depend on.
 * A single prompt string in, a single text string out — no message-array
 * shape, no provider-specific request/response envelope — so a Bedrock
 * Converse call, a direct Anthropic Messages call, or a mock can all
 * implement it without leaking their own wire format into scoreDiff.ts.
 * Swapping the backing provider is a config change (which implementation
 * gets constructed), never a rewrite of the scoring logic.
 */
export interface ConversationToolCall {
  id: string;
  name: string;
  /** The raw JSON string the model produced for the arguments. */
  arguments: string;
}

/**
 * A multi-turn conversation, for providers that support it (Groq). The first
 * two-turn baseline-2 call is `[system, user]`; the second appends the model's
 * own tool call and the harness's canned `tool` result.
 */
export type ConversationMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: readonly ConversationToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ModelInvocationRequest {
  prompt: string;
  /** When present, a provider that supports it sends this instead of `prompt` as a single user message. `prompt` stays required as the human-readable summary and the budget estimate. */
  conversation?: readonly ConversationMessage[];
  maxTokens: number;
  /** Milliseconds this single call may take before the provider must abort and throw `UpstreamTimeoutError`. */
  timeoutMs: number;
  /**
   * Tools the model may call, name and description only (the baseline-2 corpus
   * has no parameter schemas). A provider that supports tool calling declares
   * them with a permissive object schema and renders any call the model makes
   * into `text` as `[tool call] name(arguments)`, so a model that acts on a
   * tool is distinguishable from one that only talks about it. Providers that
   * don't support tools ignore this.
   */
  tools?: readonly { name: string; description: string }[];
}

export interface ModelInvocationResult {
  text: string;
  modelId: string;
  /** Tool calls the model made, with ids, for a provider that supports tools. `text` also carries them rendered as `[tool call] name(args)`. */
  toolCalls?: readonly ConversationToolCall[];
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
