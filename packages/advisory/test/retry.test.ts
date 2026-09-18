import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/retry.js";

/** A controllable clock + no-op sleep that advances the clock by the requested amount, so tests run instantly while still exercising real budget arithmetic. */
function fakeClock(startMs = 0) {
  let current = startMs;
  const now = () => current;
  const sleep = vi.fn(async (ms: number) => {
    current += ms;
  });
  return { now, sleep, advance: (ms: number) => (current += ms) };
}

describe("withRetry", () => {
  it("returns the value on the first successful attempt without sleeping", async () => {
    const { now, sleep } = fakeClock();
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { delaysMs: [250, 1000, 4000], deadline: 20_000, isRetryable: () => true, now, sleep });
    expect(result).toEqual({ ok: true, value: "ok", attempts: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable failure and succeeds on the next attempt", async () => {
    const { now, sleep } = fakeClock();
    const fn = vi.fn().mockRejectedValueOnce(new Error("throttled")).mockResolvedValueOnce("ok");
    const result = await withRetry(fn, {
      delaysMs: [250, 1000, 4000],
      deadline: 20_000,
      isRetryable: () => true,
      now,
      sleep,
      jitterRatio: 0,
    });
    expect(result).toEqual({ ok: true, value: "ok", attempts: 2 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("stops immediately on a non-retryable error, without sleeping", async () => {
    const { now, sleep } = fakeClock();
    const error = new Error("bad request");
    const fn = vi.fn().mockRejectedValue(error);
    const result = await withRetry(fn, { delaysMs: [250, 1000, 4000], deadline: 20_000, isRetryable: () => false, now, sleep });
    expect(result).toEqual({ ok: false, error, attempts: 1, reason: "non-retryable" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after exhausting the full 1-initial+3-retry schedule", async () => {
    const { now, sleep } = fakeClock();
    const error = new Error("still throttled");
    const fn = vi.fn().mockRejectedValue(error);
    const result = await withRetry(fn, {
      delaysMs: [250, 1000, 4000],
      deadline: 1_000_000,
      isRetryable: () => true,
      now,
      sleep,
      jitterRatio: 0,
    });
    expect(result).toEqual({ ok: false, error, attempts: 4, reason: "exhausted" });
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([250, 1000, 4000]);
  });

  it("stops before the deadline instead of sleeping past it", async () => {
    const { now, sleep } = fakeClock();
    const error = new Error("throttled");
    const fn = vi.fn().mockRejectedValue(error);
    // Deadline only leaves room for the initial attempt + one 250ms retry delay.
    const result = await withRetry(fn, {
      delaysMs: [250, 1000, 4000],
      deadline: 200,
      isRetryable: () => true,
      now,
      sleep,
      jitterRatio: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("budget-exceeded");
    }
    expect(sleep).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes the remaining budget into each attempt", async () => {
    const { now, sleep } = fakeClock();
    const seen: number[] = [];
    const fn = vi.fn(async (remainingMs: number) => {
      seen.push(remainingMs);
      throw new Error("throttled");
    });
    await withRetry(fn, { delaysMs: [250, 1000], deadline: 20_000, isRetryable: () => true, now, sleep, jitterRatio: 0 });
    expect(seen[0]).toBe(20_000);
    expect(seen[1]).toBe(20_000 - 250);
    expect(seen[2]).toBe(20_000 - 250 - 1000);
  });

  it("applies jitter within the expected range", async () => {
    const { now, sleep } = fakeClock();
    const fn = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("ok");
    await withRetry(fn, { delaysMs: [1000], deadline: 20_000, isRetryable: () => true, now, sleep, jitterRatio: 0.25 });
    const [delay] = sleep.mock.calls[0]!;
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1250);
  });
});
