/**
 * A hand-rolled token-bucket limiter rather than a new dependency — the
 * gateway is a single process, single household (CLAUDE.md: multi-tenancy
 * and horizontal scaling are out of scope), so an in-memory bucket per key
 * is the whole problem, not a simplification of a harder one. Each key
 * (a session id for /mcp, an IP for /api/*) gets its own bucket that
 * refills continuously rather than resetting on a fixed window, so a
 * client that's been quiet isn't penalized for a window boundary it never
 * crossed.
 */
import type { NextFunction, Request, Response } from "express";

export interface RateLimiterOptions {
  /** Maximum tokens a bucket can hold — the size of an allowed burst. */
  capacity: number;
  /** Tokens added back per second. */
  refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export type ConsumeResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly opts: RateLimiterOptions) {}

  consume(key: string, now: number = Date.now()): ConsumeResult {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.opts.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
    bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + elapsedSeconds * this.opts.refillPerSecond);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    const deficit = 1 - bucket.tokens;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(deficit / this.opts.refillPerSecond)) };
  }

  /** Test/process-lifetime hygiene only — never called from request-handling code. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Default budgets. Not derived from measured production load (there isn't
 * any yet) — chosen against two real, measured reference points instead:
 * packages/console/src/api.ts polls /api/* on a 15s interval (a handful of
 * parallel requests per poll, well under 1 req/sec sustained), and the full
 * spec/resumption.test.ts + spec/long-stream.test.ts stack suite (a
 * 10-iteration kill-and-resume loop, several requests per session, plus a
 * ~180s held-open stream) runs clean against MCP_RATE_LIMIT with room to
 * spare. /mcp keeps a larger budget since one session legitimately makes
 * several requests in a row (tools/list, then several tools/calls);
 * /api/* is deliberately tighter — real usage is a slow poll, so a burst
 * far above that is either a bug or automated abuse, and a plain
 * sequential curl loop against localhost runs at roughly 8 req/sec, which
 * is the floor this needed to be tuned below to actually demonstrate a 429
 * rather than always winning the race against its own refill.
 */
export const MCP_RATE_LIMIT: RateLimiterOptions = { capacity: 60, refillPerSecond: 10 };
export const API_RATE_LIMIT: RateLimiterOptions = { capacity: 20, refillPerSecond: 2 };

function sendTooManyRequests(res: Response, retryAfterSeconds: number): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Too many requests" },
    id: null,
  });
}

/** Keyed by mcp-session-id when present; an initialize request (no session yet) falls back to the client IP. */
export function mcpRateLimitMiddleware(limiter: TokenBucketLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.header("mcp-session-id") ?? `ip:${req.ip ?? "unknown"}`;
    const result = limiter.consume(key);
    if (!result.allowed) {
      sendTooManyRequests(res, result.retryAfterSeconds);
      return;
    }
    next();
  };
}

/** Keyed by client IP — /api/* has no session concept, it's the console reading on behalf of whoever's on that address. */
export function apiRateLimitMiddleware(limiter: TokenBucketLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = limiter.consume(`ip:${req.ip ?? "unknown"}`);
    if (!result.allowed) {
      sendTooManyRequests(res, result.retryAfterSeconds);
      return;
    }
    next();
  };
}
