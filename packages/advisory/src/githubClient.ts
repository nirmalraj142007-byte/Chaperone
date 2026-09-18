import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { childLogger } from "@chaperone/logger";
import { loadAdvisoryEnv } from "./env.js";

const log = childLogger({ component: "advisory-github-client" });

/** GitHub REST's authenticated ceiling for a personal access token or `GITHUB_TOKEN` on public metadata. */
export const GITHUB_HOURLY_LIMIT = 5_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface TokenBucketOptions {
  capacity: number;
  refillIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A continuous-refill token bucket: `capacity` tokens, fully replenished
 * every `refillIntervalMs`. `acquire()` waits out any deficit rather than
 * rejecting, so a burst of calls self-paces to the 5000/hr ceiling instead
 * of needing a caller-side queue.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillRatePerMs = options.capacity / options.refillIntervalMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = options.capacity;
    this.lastRefillAt = this.now();
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) {
      return;
    }
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefillAt = now;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const deficitMs = (1 - this.tokens) / this.refillRatePerMs;
    await this.sleep(deficitMs);
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

/** One process-wide bucket — every `checkChangelog` call across every quarantine shares the same 5000/hr ceiling, since they all hit the same GitHub account. */
export const githubTokenBucket = new TokenBucket({ capacity: GITHUB_HOURLY_LIMIT, refillIntervalMs: ONE_HOUR_MS });

export interface GithubFetchResult {
  status: number;
  json: unknown;
  fromCache: boolean;
}

function cacheKeyFor(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

async function readCache(cachePath: string): Promise<{ status: number; json: unknown } | undefined> {
  try {
    const raw = await readFile(cachePath, "utf8");
    return JSON.parse(raw) as { status: number; json: unknown };
  } catch {
    return undefined;
  }
}

async function writeCache(cachePath: string, result: { status: number; json: unknown }): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(result), "utf8");
}

/**
 * Fetches one GitHub REST URL under the changelog cross-check's shared
 * policy: an on-disk cache keyed by URL (so a repeated run never re-spends
 * quota), a 5000/hr token bucket, and a 10s timeout. Only a 200 response is
 * cached — a 403 or 5xx is left uncached so a later run can retry it
 * instead of freezing a transient failure into "no evidence found" forever.
 * Never throws on a non-2xx status; the caller (changelog.ts) is the one
 * that decides a 403 means "degrade to none".
 */
export async function fetchGithub(
  url: string,
  githubToken: string | undefined,
  bucket: TokenBucket = githubTokenBucket,
): Promise<GithubFetchResult> {
  const env = loadAdvisoryEnv();
  const cachePath = path.join(env.githubCacheDir, `${cacheKeyFor(url)}.json`);

  const cached = await readCache(cachePath);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  await bucket.acquire();

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    log.warn({ url, error }, "GitHub fetch failed (network/timeout)");
    return { status: 0, json: null, fromCache: false };
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  const result = { status: res.status, json };
  if (res.status === 200) {
    await writeCache(cachePath, result);
  }
  return { ...result, fromCache: false };
}
