import { ConfigError, LedgerWriteError } from "@chaperone/errors";

/**
 * Delay before each of the three retry attempts *after* the original call —
 * i.e. up to 4 total DynamoDB calls (1 original + 3 retries), the last
 * delay always used as a real inter-call wait rather than a discarded one
 * spent right before giving up.
 */
const RETRY_BACKOFF_MS = [100, 400, 1600] as const;
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
  for (let call = 0; call <= RETRY_BACKOFF_MS.length; call++) {
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
      const delay = RETRY_BACKOFF_MS[call];
      if (delay === undefined) {
        break; // all three retries exhausted
      }
      await sleep(delay);
    }
  }
  throw new LedgerWriteError("DynamoDB write failed after 3 retries due to throttling", {
    cause: lastError,
  });
}
