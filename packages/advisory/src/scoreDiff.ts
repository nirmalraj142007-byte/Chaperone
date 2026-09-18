import { UpstreamError, UpstreamTimeoutError } from "@chaperone/errors";
import { childLogger } from "@chaperone/logger";
import type { ModelProvider } from "./provider.js";
import { buildAdvisoryPrompt, type DiffSummaryInput } from "./prompt.js";
import { exceedsPromptBudget, MAX_RESPONSE_TOKENS } from "./tokenBudget.js";
import { parseAdvisoryResponse } from "./parse.js";
import { withRetry } from "./retry.js";

const log = childLogger({ component: "advisory-score-diff" });

/** Whole-operation budget: both the provider retries below AND the single retry-once-on-parse-failure share this one deadline, not a fresh budget each. */
const WALL_CLOCK_BUDGET_MS = 20_000;
const RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;
/** Per-attempt ceiling so one slow call can't alone consume the whole wall-clock budget; each attempt actually gets `min(this, remaining budget)`. */
const PER_CALL_TIMEOUT_MS = 8_000;
/** The first response plus one retry — CLAUDE.md's "retry-once-on-parse-failure", not an open-ended loop. */
const MAX_PARSE_ATTEMPTS = 2;

/** Bedrock/AWS exception names ScoreDiff treats as transient — matches CLAUDE.md's "retries ... on throttling and timeouts". Anything else in an `UpstreamError` is terminal (bad prompt, no access, no such model) and is never retried. */
const THROTTLING_ERROR_NAMES = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "ModelNotReadyException",
  "TooManyRequestsException",
]);

function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof UpstreamTimeoutError) {
    return true;
  }
  if (error instanceof UpstreamError) {
    const name = error.context["providerErrorName"];
    return typeof name === "string" && THROTTLING_ERROR_NAMES.has(name);
  }
  return false;
}

export type ScoreDiffResult =
  | { status: "scored"; score: number; summary: string; modelId: string; promptSha: string }
  | { status: "unavailable"; reason: string };

/**
 * Turns one quarantined tool-description change into an advisory score, or
 * gives up cleanly. CLAUDE.md: "scoreDiff NEVER throws — returns
 * unavailable, caller renders the card without it." Every awaited call in
 * here either already can't throw (withRetry catches internally) or is
 * wrapped in the outer try/catch, so a bug here degrades the advisory, it
 * never blocks or corrupts the refusal path this decorates.
 */
export async function scoreDiff(input: DiffSummaryInput, provider: ModelProvider): Promise<ScoreDiffResult> {
  try {
    const { prompt, promptSha } = buildAdvisoryPrompt(input);

    if (exceedsPromptBudget(prompt)) {
      log.warn({ toolName: input.toolName, promptSha }, "advisory prompt exceeds token budget; skipping");
      return { status: "unavailable", reason: "prompt-too-large" };
    }

    const deadline = Date.now() + WALL_CLOCK_BUDGET_MS;

    for (let parseAttempt = 0; parseAttempt < MAX_PARSE_ATTEMPTS; parseAttempt++) {
      const retryResult = await withRetry(
        (remainingMs) =>
          provider.invoke({
            prompt,
            maxTokens: MAX_RESPONSE_TOKENS,
            timeoutMs: Math.min(PER_CALL_TIMEOUT_MS, remainingMs),
          }),
        { delaysMs: RETRY_DELAYS_MS, deadline, isRetryable: isRetryableProviderError },
      );

      if (!retryResult.ok) {
        log.warn(
          { toolName: input.toolName, promptSha, attempts: retryResult.attempts, reason: retryResult.reason },
          "advisory provider call did not complete; advisory unavailable",
        );
        return { status: "unavailable", reason: `provider-${retryResult.reason}` };
      }

      const parsed = parseAdvisoryResponse(retryResult.value.text);
      if (parsed.ok) {
        return {
          status: "scored",
          score: parsed.value.score,
          summary: parsed.value.summary,
          modelId: retryResult.value.modelId,
          promptSha,
        };
      }

      log.warn(
        { toolName: input.toolName, promptSha, parseAttempt, reason: parsed.reason },
        parseAttempt + 1 < MAX_PARSE_ATTEMPTS
          ? "advisory response failed to parse; retrying once"
          : "advisory response failed to parse a second time; giving up",
      );
    }

    return { status: "unavailable", reason: "unparseable-response" };
  } catch (error) {
    log.error({ error, toolName: input.toolName }, "scoreDiff failed unexpectedly; advisory unavailable");
    return { status: "unavailable", reason: "unexpected-error" };
  }
}
