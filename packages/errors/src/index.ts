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
  | "PROTOCOL_ERROR"
  | "QUARANTINE_NOT_FOUND_ERROR"
  | "QUARANTINE_ALREADY_RESOLVED_ERROR"
  | "APPROVAL_TOKEN_EXPIRED_ERROR"
  | "INVALID_APPROVAL_TOKEN_ERROR"
  | "BENCH_ERROR";

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

/** `chaperone/approve_change` was given a `quarantineId` this household has no record of. */
export class QuarantineNotFoundError extends ChaperoneError {
  readonly code = "QUARANTINE_NOT_FOUND_ERROR" as const;
  readonly retryable = false;
}

/** The quarantine was already approved or refused; a token cannot be redeemed twice. */
export class QuarantineAlreadyResolvedError extends ChaperoneError {
  readonly code = "QUARANTINE_ALREADY_RESOLVED_ERROR" as const;
  readonly retryable = false;
}

/** More than 24 hours have passed since the change was detected. */
export class ApprovalTokenExpiredError extends ChaperoneError {
  readonly code = "APPROVAL_TOKEN_EXPIRED_ERROR" as const;
  readonly retryable = false;
}

/** The provided token's hash does not match the quarantine's stored `approvalTokenHash`. */
export class InvalidApprovalTokenError extends ChaperoneError {
  readonly code = "INVALID_APPROVAL_TOKEN_ERROR" as const;
  readonly retryable = false;
}

/**
 * A benchmark run produced something that cannot honestly be reported: an
 * empty sample, a measured call that came back a refusal rather than a
 * real result, an upstream that never answered. Never retryable — a bench
 * harness that silently retried past a bad measurement would be reporting
 * the runs that happened to work, which is the one thing a reproducible
 * number cannot be.
 */
export class BenchError extends ChaperoneError {
  readonly code = "BENCH_ERROR" as const;
  readonly retryable = false;
}

export function isRetryable(e: unknown): boolean {
  return e instanceof ChaperoneError && e.retryable;
}
