export interface RetryOptions {
  /** Delay before each successive retry — `[250, 1000, 4000]` means up to 1 initial attempt + 3 retries. */
  delaysMs: readonly number[];
  jitterRatio?: number;
  /** An absolute `Date.now()`-style deadline, not a duration — so several `withRetry` calls in the same operation (scoreDiff's two parse attempts) can share one real budget instead of each getting a fresh one. */
  deadline: number;
  isRetryable: (error: unknown) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: unknown; attempts: number; reason: "exhausted" | "budget-exceeded" | "non-retryable" };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(baseMs: number, ratio: number): number {
  return baseMs + Math.random() * baseMs * ratio;
}

/**
 * Runs `fn` with exponential-ish backoff (the caller supplies the exact
 * schedule) and a shared wall-clock deadline. `fn` receives the
 * milliseconds remaining until that deadline so it can size its own
 * per-attempt timeout (e.g. a provider call's AbortSignal) instead of
 * risking a single slow attempt burning the whole budget. Retries only on
 * errors `isRetryable` accepts — anything else stops immediately rather
 * than spending the budget on a failure that will never succeed.
 */
export async function withRetry<T>(
  fn: (remainingMs: number) => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const maxAttempts = options.delaysMs.length + 1;

  let attempts = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = options.deadline - now();
    if (remaining <= 0) {
      return { ok: false, error: lastError, attempts, reason: "budget-exceeded" };
    }

    attempts++;
    try {
      const value = await fn(remaining);
      return { ok: true, value, attempts };
    } catch (error) {
      lastError = error;
      if (!options.isRetryable(error)) {
        return { ok: false, error, attempts, reason: "non-retryable" };
      }

      const nextDelay = options.delaysMs[attempt];
      if (nextDelay === undefined) {
        return { ok: false, error, attempts, reason: "exhausted" };
      }

      const delay = jitteredDelay(nextDelay, jitterRatio);
      if (options.deadline - now() <= delay) {
        return { ok: false, error, attempts, reason: "budget-exceeded" };
      }
      await sleep(delay);
    }
  }

  /* c8 ignore next -- every branch of the loop above returns; kept for exhaustiveness. */
  return { ok: false, error: lastError, attempts, reason: "exhausted" };
}
