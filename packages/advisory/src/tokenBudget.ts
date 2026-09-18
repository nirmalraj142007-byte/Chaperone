/**
 * ~4 characters per token is the standard English-prose rule of thumb
 * absent a real tokenizer for the target model — good enough to bound a
 * *request* before spending a call on it, not a billing-accurate count.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/** A prompt estimated above this is rejected before any provider call — CLAUDE.md's token budget. */
export const MAX_PROMPT_TOKENS = 4000;

/** The response token cap passed to every provider invocation. */
export const MAX_RESPONSE_TOKENS = 300;

/** Each side of the before/after description is truncated to this many characters, with an explicit marker, before it ever reaches a prompt. */
export const DESCRIPTION_TRUNCATE_CHARS = 1500;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function exceedsPromptBudget(prompt: string): boolean {
  return estimateTokens(prompt) > MAX_PROMPT_TOKENS;
}
