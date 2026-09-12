/**
 * The closed error taxonomy for Chaperone. Every thrown error in this codebase
 * is one of the subclasses below. Adding a new failure mode means adding a
 * class here first — nothing else may invent one.
 */

export type ErrorCode =
  | "CONFIG_ERROR"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_TIMEOUT_ERROR"
  | "LEDGER_WRITE_ERROR"
  | "POLICY_VIOLATION_ERROR"
  | "ADVISORY_UNAVAILABLE_ERROR"
  | "BOOT_FAILURE_ERROR"
  | "SESSION_NOT_FOUND_ERROR"
  | "PROTOCOL_ERROR";

export abstract class ChaperoneError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly retryable: boolean;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
  }
}

export class ConfigError extends ChaperoneError {
  readonly code = "CONFIG_ERROR" as const;
  readonly retryable = false;
}

export class UpstreamError extends ChaperoneError {
  readonly code = "UPSTREAM_ERROR" as const;
  readonly retryable = true;
}

export class UpstreamTimeoutError extends ChaperoneError {
  readonly code = "UPSTREAM_TIMEOUT_ERROR" as const;
  readonly retryable = true;
}

/** Callers must treat a ledger write failure as fail-closed, never as a reason to allow. */
export class LedgerWriteError extends ChaperoneError {
  readonly code = "LEDGER_WRITE_ERROR" as const;
  readonly retryable = false;
}

export class PolicyViolationError extends ChaperoneError {
  readonly code = "POLICY_VIOLATION_ERROR" as const;
  readonly retryable = false;
}

/** Advisory-only failure (e.g. Bedrock scoring). Never surfaced to a resident. */
export class AdvisoryUnavailableError extends ChaperoneError {
  readonly code = "ADVISORY_UNAVAILABLE_ERROR" as const;
  readonly retryable = true;
}

export class BootFailureError extends ChaperoneError {
  readonly code = "BOOT_FAILURE_ERROR" as const;
  readonly retryable = false;
}

export class SessionNotFoundError extends ChaperoneError {
  readonly code = "SESSION_NOT_FOUND_ERROR" as const;
  readonly retryable = false;
}

export class ProtocolError extends ChaperoneError {
  readonly code = "PROTOCOL_ERROR" as const;
  readonly retryable = false;
}

export function isRetryable(e: unknown): boolean {
  return e instanceof ChaperoneError && e.retryable;
}
