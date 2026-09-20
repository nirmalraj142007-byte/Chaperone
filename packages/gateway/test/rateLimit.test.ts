import { describe, expect, it, vi } from "vitest";
import { apiRateLimitMiddleware, mcpRateLimitMiddleware, TokenBucketLimiter } from "../src/rateLimit.js";

function fakeRes() {
  const headers: Record<string, string> = {};
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const setHeader = vi.fn((name: string, value: string) => {
    headers[name] = value;
  });
  return { status, json, setHeader, headers } as unknown as Parameters<
    ReturnType<typeof mcpRateLimitMiddleware>
  >[1] & { headers: Record<string, string>; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe("TokenBucketLimiter", () => {
  it("allows up to capacity requests in a burst, then rejects", () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1 });
    const now = 1_000_000;
    expect(limiter.consume("k", now)).toEqual({ allowed: true });
    expect(limiter.consume("k", now)).toEqual({ allowed: true });
    expect(limiter.consume("k", now)).toEqual({ allowed: true });
    const fourth = limiter.consume("k", now);
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) {
      expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("refills continuously over time, not on a fixed window boundary", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });
    const t0 = 1_000_000;
    expect(limiter.consume("k", t0)).toEqual({ allowed: true });
    expect(limiter.consume("k", t0 + 100)).toEqual(expect.objectContaining({ allowed: false }));
    // Half a token back after 500ms at 1/sec — still not enough for a full token.
    expect(limiter.consume("k", t0 + 500)).toEqual(expect.objectContaining({ allowed: false }));
    // A full second later, exactly one token is available again.
    expect(limiter.consume("k", t0 + 1000)).toEqual({ allowed: true });
  });

  it("tracks separate keys independently", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });
    const now = 2_000_000;
    expect(limiter.consume("a", now)).toEqual({ allowed: true });
    expect(limiter.consume("b", now)).toEqual({ allowed: true });
    expect(limiter.consume("a", now).allowed).toBe(false);
  });
});

describe("mcpRateLimitMiddleware", () => {
  it("keys by mcp-session-id when present", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001 });
    const middleware = mcpRateLimitMiddleware(limiter);
    const req1 = { header: () => "session-a", ip: "10.0.0.1" } as unknown as Parameters<typeof middleware>[0];
    const req2 = { header: () => "session-b", ip: "10.0.0.1" } as unknown as Parameters<typeof middleware>[0];
    const next1 = vi.fn();
    const next2 = vi.fn();
    middleware(req1, fakeRes(), next1);
    middleware(req2, fakeRes(), next2);
    // Different sessions from the same IP are independent budgets.
    expect(next1).toHaveBeenCalledOnce();
    expect(next2).toHaveBeenCalledOnce();
  });

  it("falls back to IP when there is no session yet (initialize), and returns 429 with Retry-After once exhausted", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001 });
    const middleware = mcpRateLimitMiddleware(limiter);
    const req = { header: () => undefined, ip: "10.0.0.5" } as unknown as Parameters<typeof middleware>[0];

    const next1 = vi.fn();
    middleware(req, fakeRes(), next1);
    expect(next1).toHaveBeenCalledOnce();

    const res2 = fakeRes();
    const next2 = vi.fn();
    middleware(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.status).toHaveBeenCalledWith(429);
    expect(res2.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ jsonrpc: "2.0" }));
  });
});

describe("apiRateLimitMiddleware", () => {
  it("keys by IP and rejects once exhausted", () => {
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 0.001 });
    const middleware = apiRateLimitMiddleware(limiter);
    const req = { ip: "10.0.0.9" } as unknown as Parameters<typeof middleware>[0];

    middleware(req, fakeRes(), vi.fn());
    middleware(req, fakeRes(), vi.fn());
    const res3 = fakeRes();
    const next3 = vi.fn();
    middleware(req, res3, next3);
    expect(next3).not.toHaveBeenCalled();
    expect(res3.status).toHaveBeenCalledWith(429);
  });

  it("different IPs get independent budgets", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001 });
    const middleware = apiRateLimitMiddleware(limiter);
    const reqA = { ip: "10.0.0.1" } as unknown as Parameters<typeof middleware>[0];
    const reqB = { ip: "10.0.0.2" } as unknown as Parameters<typeof middleware>[0];
    const nextA = vi.fn();
    const nextB = vi.fn();
    middleware(reqA, fakeRes(), nextA);
    middleware(reqB, fakeRes(), nextB);
    expect(nextA).toHaveBeenCalledOnce();
    expect(nextB).toHaveBeenCalledOnce();
  });
});
