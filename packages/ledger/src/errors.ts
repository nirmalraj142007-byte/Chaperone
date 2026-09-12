import { ConfigError, LedgerWriteError } from "@chaperone/errors";

/**
 * Backoff delay after each of the 3 total attempts, indexed by attempt
 * number (0, 1, 2). 3 attempts total, not 3 retries after an initial call —
 * the delay after the 3rd attempt still elapses before `withDynamoErrors`
 * gives up, so the caller's overall wait time matches "100/400/1600ms"
 * exactly rather than silently dropping the last figure.
 */
const RETRY_BACKOFF_MS = [100, 400, 1600] as const;
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;
const THROTTLING_ERROR_NAMES = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
]);

function errorName(e: unknown): string | undefined {
  return e instanceof Error ? e.name : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a single DynamoDB SDK call. `ResourceNotFoundException` (the table
 * doesn't exist yet) becomes a `ConfigError` pointing the operator at
 * `pnpm ddb:migrate`. Throttling is retried up to three times with
 * 100/400/1600ms backoff before surfacing as a `LedgerWriteError` — never
 * silently dropped, so every caller fails closed rather than proceeding as
 * if the write or read had succeeded.
 */
export async function withDynamoErrors<T>(op: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (e) {
      const name = errorName(e);
      if (name === "ResourceNotFoundException") {
        throw new ConfigError(
          'DynamoDB table not found. Run "pnpm ddb:migrate" to create the Chaperone tables.',
          { cause: e },
        );
      }
      if (!name || !THROTTLING_ERROR_NAMES.has(name)) {
        throw e;
      }
      lastError = e;
      const delay = RETRY_BACKOFF_MS[attempt];
      if (delay !== undefined) {
        await sleep(delay);
      }
    }
  }
  throw new LedgerWriteError("DynamoDB write failed after 3 attempts due to throttling", {
    cause: lastError,
  });
}
