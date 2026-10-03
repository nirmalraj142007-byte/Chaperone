import { UpstreamError, UpstreamTimeoutError } from "@chaperone/errors";
import type { ModelInvocationRequest, ModelInvocationResult, ModelProvider } from "../provider.js";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export interface GroqModelProviderOptions {
  modelId: string;
  /** Read by the caller from the environment or Secrets Manager. Never logged, never put in an error context. */
  apiKey: string;
  baseUrl?: string;
  /**
   * gpt-oss models spend completion tokens on hidden reasoning before the
   * visible answer, and `max_tokens` covers both. This is added on top of the
   * request's `maxTokens` so the visible answer is not starved. Default 512.
   */
  reasoningTokenHeadroom?: number;
  /** "low" keeps reasoning short, which on a free tier is mostly a tokens-per-minute question. Default "low". */
  reasoningEffort?: "low" | "medium" | "high";
  temperature?: number;
  /**
   * The longest this provider will wait out rate limits for one `invoke`.
   * Waiting is not counted against `timeoutMs`, which bounds each HTTP
   * attempt. The eval harness wants a long wait (a run must never fail on a
   * rate limit); a Lambda with a 25s budget wants a short one. Past it the
   * call throws `UpstreamError` with `providerErrorName: "RateLimitError"`.
   * Default 5 minutes.
   */
  maxRateLimitWaitMs?: number;
  /** How many times a 5xx is retried inside the provider. Default 3. */
  maxServerErrorRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_REASONING_HEADROOM = 512;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;
const DEFAULT_SERVER_ERROR_RETRIES = 3;
/** Added to every wait so a request does not land on the exact instant the bucket refills. */
const WAIT_MARGIN_MS = 250;
const CHARS_PER_TOKEN = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Groq reports resets as a duration string: "2.865s", "1m26.4s", "120ms",
 * "1h2m3s". Returns undefined for anything else so the caller falls back to
 * a fixed wait instead of guessing.
 */
export function parseGroqDuration(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const text = raw.trim();
  if (text === "") {
    return undefined;
  }
  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    const unit = match[2];
    total += unit === "ms" ? value : unit === "s" ? value * 1000 : unit === "m" ? value * 60_000 : value * 3_600_000;
    consumed += match[0].length;
  }
  return consumed === text.length ? total : undefined;
}

/** `Retry-After` is whole seconds per the HTTP spec; Groq sends that form. */
function parseRetryAfterMs(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

interface ChatCompletionBody {
  choices?: {
    message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string;
  }[];
  error?: { message?: string; type?: string; code?: string; failed_generation?: string };
}

/**
 * What a model that called a tool "said". `[tool call] name(args)` lines come
 * after any prose, so downstream code can tell talking about a tool from using it.
 */
function renderMessage(message: NonNullable<NonNullable<ChatCompletionBody["choices"]>[number]["message"]>): string {
  const prose = typeof message.content === "string" ? message.content.trim() : "";
  const calls = (message.tool_calls ?? []).map((c) => `[tool call] ${c.function?.name ?? "?"}(${c.function?.arguments ?? ""})`);
  return [prose, ...calls].filter((part) => part !== "").join("\n");
}

/**
 * OpenAI-compatible chat completions against Groq, over plain `fetch`.
 * The official `groq-sdk` was weighed and not used: this needs one POST, the
 * 429/`Retry-After` handling has to be ours either way (the SDK's own retry
 * does not know about a tokens-per-minute budget), and a dependency is one
 * more thing a judge has to trust. Request and response shapes were checked
 * against Groq's live API on 2026-10-03: `POST /openai/v1/chat/completions`
 * answers `{choices:[{message:{content, reasoning}, finish_reason}], usage}`
 * and sends `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` headers on
 * every response.
 *
 * Rate limits: the free tier for openai/gpt-oss-120b was observed at 8,000
 * tokens per minute and 1,000 requests per day. Before each request the
 * provider checks the `remaining-tokens` header from the previous response
 * against an estimate of this request and waits out `reset-tokens` if it
 * would not fit. A 429 that happens anyway waits for `Retry-After` and tries
 * again. A rate limit is never a failure of the run, only of a call that
 * outlasts `maxRateLimitWaitMs`.
 */
export class GroqModelProvider implements ModelProvider {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly headroom: number;
  private readonly reasoningEffort: "low" | "medium" | "high";
  private readonly temperature: number;
  private readonly maxWaitMs: number;
  private readonly maxServerErrorRetries: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private remainingTokens: number | undefined;
  private tokensResetAt = 0;
  private remainingRequests: number | undefined;
  private requestsResetAt = 0;

  /** Calls that reached Groq, counting every HTTP attempt including 429s. Read by the eval scripts to report the real call count. */
  httpAttempts = 0;
  /** 429 responses received. */
  rateLimited = 0;
  /** Seconds-worth of waiting this provider did to stay inside the rate limit, in milliseconds. */
  waitedMs = 0;

  constructor(options: GroqModelProviderOptions) {
    this.modelId = options.modelId;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? GROQ_BASE_URL;
    this.headroom = options.reasoningTokenHeadroom ?? DEFAULT_REASONING_HEADROOM;
    this.reasoningEffort = options.reasoningEffort ?? "low";
    this.temperature = options.temperature ?? 0;
    this.maxWaitMs = options.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS;
    this.maxServerErrorRetries = options.maxServerErrorRetries ?? DEFAULT_SERVER_ERROR_RETRIES;
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const maxTokens = request.maxTokens + this.headroom;
    const estimatedTokens = Math.ceil(request.prompt.length / CHARS_PER_TOKEN) + maxTokens;
    const tools =
      request.tools && request.tools.length > 0
        ? request.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: { type: "object", additionalProperties: true } },
          }))
        : undefined;
    const body = JSON.stringify({
      model: this.modelId,
      messages: [{ role: "user", content: request.prompt }],
      max_tokens: maxTokens,
      temperature: this.temperature,
      reasoning_effort: this.reasoningEffort,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
    });

    let waitedThisCall = 0;
    let serverErrors = 0;

    for (;;) {
      waitedThisCall += await this.waitForBudget(estimatedTokens, this.maxWaitMs - waitedThisCall);

      this.httpAttempts++;
      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (error) {
        if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new UpstreamTimeoutError("Groq chat completion timed out", { providerErrorName: "TimeoutError" });
        }
        throw new UpstreamError("Groq chat completion request failed", {
          providerErrorName: "NetworkError",
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      this.recordRateLimitHeaders(response.headers);

      if (response.status === 429) {
        this.rateLimited++;
        const waitMs =
          (parseRetryAfterMs(response.headers.get("retry-after")) ??
            parseGroqDuration(response.headers.get("x-ratelimit-reset-tokens")) ??
            parseGroqDuration(response.headers.get("x-ratelimit-reset-requests")) ??
            5_000) + WAIT_MARGIN_MS;
        if (waitedThisCall + waitMs > this.maxWaitMs) {
          throw new UpstreamError("Groq rate limit outlasted the wait budget", {
            providerErrorName: "RateLimitError",
            waitedMs: waitedThisCall,
          });
        }
        await this.sleep(waitMs);
        this.waitedMs += waitMs;
        waitedThisCall += waitMs;
        // The bucket this 429 reports is empty; do not trust the pre-429 headers.
        this.remainingTokens = undefined;
        this.remainingRequests = undefined;
        continue;
      }

      if (response.status >= 500) {
        if (serverErrors < this.maxServerErrorRetries) {
          serverErrors++;
          await this.sleep(1_000 * 2 ** (serverErrors - 1));
          continue;
        }
        throw new UpstreamError("Groq returned a server error", {
          providerErrorName: "ServiceUnavailable",
          status: response.status,
        });
      }

      let parsed: ChatCompletionBody;
      try {
        parsed = (await response.json()) as ChatCompletionBody;
      } catch {
        throw new UpstreamError("Groq response was not JSON", { providerErrorName: "BadResponse", status: response.status });
      }

      if (!response.ok) {
        // gpt-oss sometimes emits a tool call Groq's parser rejects. That is still the
        // model deciding to act, so hand back what it tried rather than failing the run.
        if (parsed.error?.code === "tool_use_failed" && typeof parsed.error.failed_generation === "string") {
          return { text: `[tool call, rejected by Groq as malformed] ${parsed.error.failed_generation}`, modelId: this.modelId };
        }
        // The error message is Groq's own and carries no request content or key.
        throw new UpstreamError("Groq rejected the request", {
          providerErrorName: parsed.error?.code ?? parsed.error?.type ?? `Http${response.status}`,
          status: response.status,
          detail: parsed.error?.message,
        });
      }

      const choice = parsed.choices?.[0];
      const text = choice?.message ? renderMessage(choice.message) : "";
      if (text === "") {
        throw new UpstreamError("Groq response had no text content", {
          providerErrorName: "EmptyContent",
          modelId: this.modelId,
          finishReason: choice?.finish_reason,
        });
      }
      return { text, modelId: this.modelId };
    }
  }

  private recordRateLimitHeaders(headers: Headers): void {
    const now = this.now();
    const tokens = headers.get("x-ratelimit-remaining-tokens");
    const requests = headers.get("x-ratelimit-remaining-requests");
    if (tokens !== null && Number.isFinite(Number(tokens))) {
      this.remainingTokens = Number(tokens);
      this.tokensResetAt = now + (parseGroqDuration(headers.get("x-ratelimit-reset-tokens")) ?? 60_000);
    }
    if (requests !== null && Number.isFinite(Number(requests))) {
      this.remainingRequests = Number(requests);
      this.requestsResetAt = now + (parseGroqDuration(headers.get("x-ratelimit-reset-requests")) ?? 60_000);
    }
  }

  /** Sleeps until the tokens bucket (and, if exhausted, the requests bucket) can take this request. Returns how long it slept. */
  private async waitForBudget(estimatedTokens: number, budgetMs: number): Promise<number> {
    const now = this.now();
    let waitMs = 0;
    if (this.remainingTokens !== undefined && this.remainingTokens < estimatedTokens && this.tokensResetAt > now) {
      waitMs = Math.max(waitMs, this.tokensResetAt - now + WAIT_MARGIN_MS);
    }
    if (this.remainingRequests !== undefined && this.remainingRequests < 1 && this.requestsResetAt > now) {
      waitMs = Math.max(waitMs, this.requestsResetAt - now + WAIT_MARGIN_MS);
    }
    if (waitMs === 0) {
      return 0;
    }
    if (waitMs > budgetMs) {
      throw new UpstreamError("Groq rate limit outlasted the wait budget", { providerErrorName: "RateLimitError", waitMs });
    }
    await this.sleep(waitMs);
    this.waitedMs += waitMs;
    // The headers that told us to wait are now stale; the next response refreshes them.
    this.remainingTokens = undefined;
    this.remainingRequests = undefined;
    return waitMs;
  }
}
