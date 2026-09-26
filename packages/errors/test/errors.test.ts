import { describe, expect, it } from "vitest";
import {
  AdvisoryUnavailableError,
  AnalysisError,
  ApprovalTokenExpiredError,
  BootFailureError,
  ChaperoneError,
  ConfigError,
  InvalidApprovalTokenError,
  LedgerWriteError,
  PolicyViolationError,
  ProtocolError,
  QuarantineAlreadyResolvedError,
  QuarantineNotFoundError,
  SessionNotFoundError,
  UpstreamError,
  UpstreamTimeoutError,
  isRetryable,
} from "../src/index.js";

describe("@chaperone/errors taxonomy", () => {
  it("marks exactly the retryable subclasses as retryable", () => {
    expect(isRetryable(new UpstreamError("x"))).toBe(true);
    expect(isRetryable(new UpstreamTimeoutError("x"))).toBe(true);
    expect(isRetryable(new AdvisoryUnavailableError("x"))).toBe(true);

    expect(isRetryable(new ConfigError("x"))).toBe(false);
    expect(isRetryable(new LedgerWriteError("x"))).toBe(false);
    expect(isRetryable(new PolicyViolationError("x"))).toBe(false);
    expect(isRetryable(new BootFailureError("x"))).toBe(false);
    expect(isRetryable(new SessionNotFoundError("x"))).toBe(false);
    expect(isRetryable(new ProtocolError("x"))).toBe(false);
    expect(isRetryable(new QuarantineNotFoundError("x"))).toBe(false);
    expect(isRetryable(new QuarantineAlreadyResolvedError("x"))).toBe(false);
    expect(isRetryable(new ApprovalTokenExpiredError("x"))).toBe(false);
    expect(isRetryable(new InvalidApprovalTokenError("x"))).toBe(false);
    expect(isRetryable(new AnalysisError("x"))).toBe(false);
  });

  it("returns false for non-ChaperoneError values", () => {
    expect(isRetryable(new Error("plain"))).toBe(false);
    expect(isRetryable("not an error")).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });

  it("carries code, message, and context, and chains instanceof Error", () => {
    const err = new ConfigError("missing key", { key: "PORT" });
    expect(err).toBeInstanceOf(ChaperoneError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.message).toBe("missing key");
    expect(err.context).toEqual({ key: "PORT" });
    expect(err.name).toBe("ConfigError");
  });

  it("defaults context to an empty object when omitted", () => {
    const err = new BootFailureError("could not boot");
    expect(err.context).toEqual({});
  });
});
