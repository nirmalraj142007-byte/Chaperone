import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { UpstreamError, UpstreamTimeoutError } from "@chaperone/errors";
import { childLogger } from "@chaperone/logger";
import { loadCrawlerEnv } from "./env.js";
import type { SourceId } from "./types.js";

const log = childLogger({ component: "crawler-http" });

const TIMEOUT_MS = 10_000;
const RATE_LIMIT_MS = 500; // 2 requests/second ceiling, per host
const MAX_ATTEMPTS = 4; // 1 initial attempt + 3 retries
const BACKOFF_BASE_MS = 500;
const RETRYABLE_STATUS = new Set<number>([429]);

/** A raw-archive bucket name: one of the five sources, or "readme" for the shared credential-scan README fetches. */
export type ArchiveBucket = SourceId | "readme";

export interface FetchOptions {
  sourceId?: ArchiveBucket;
  headers?: Record<string, string>;
}

export interface FetchResult {
  status: number;
  body: string;
  url: string;
  fromCache: boolean;
}

function userAgent(): string {
  const { contactUrl } = loadCrawlerEnv();
  return `ChaperoneCrawler/0.1 (Alexa+ hackathon corpus crawl; +${contactUrl})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-host send-time slots, chained so concurrent callers serialize onto the
// same host and each waits out the full RATE_LIMIT_MS gap from the previous
// one's send time — a simple token-less rate limiter that needs no timers.
const hostSlots = new Map<string, Promise<number>>();

async function throttle(host: string): Promise<void> {
  const prior = hostSlots.get(host) ?? Promise.resolve(0);
  const mySlot = prior.then(async (lastSentAt) => {
    const wait = lastSentAt + RATE_LIMIT_MS - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    return Date.now();
  });
  hostSlots.set(host, mySlot);
  await mySlot;
}

function isHostBlocked(host: string): boolean {
  return loadCrawlerEnv().blockedHosts.includes(host);
}

function cacheKeyFor(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

async function readCache(cachePath: string): Promise<FetchResult | undefined> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as { status: number; body: string; url: string };
    return { ...parsed, fromCache: true };
  } catch {
    return undefined;
  }
}

async function writeCache(cachePath: string, result: FetchResult): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify({ status: result.status, body: result.body, url: result.url }),
    "utf8",
  );
}

async function archiveRaw(sourceId: ArchiveBucket, url: string, status: number, body: string): Promise<void> {
  const env = loadCrawlerEnv();
  const dir = path.join(env.rawArchiveDir, sourceId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${cacheKeyFor(url)}.json`);
  await writeFile(file, JSON.stringify({ url, status, fetchedAt: new Date().toISOString(), body }), "utf8");
}

function backoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, asDate - Date.now());
    }
  }
  const base = BACKOFF_BASE_MS * 2 ** attempt;
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

/**
 * Fetches a URL under the crawler's shared network policy: 10s timeout,
 * three retries on 429/5xx (and on network/timeout failures) with
 * exponential backoff honouring Retry-After, a 2 req/s ceiling per host, a
 * descriptive User-Agent, and an on-disk response cache so re-running the
 * crawl doesn't re-hammer anyone. Every response is archived raw (when
 * `sourceId` is given) before the caller parses it. Non-2xx/429/5xx statuses
 * (e.g. 401) are returned to the caller rather than thrown, since several
 * sources treat "unauthorized" as a signal to degrade gracefully rather than
 * an error.
 */
export async function fetchWithPolicy(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const env = loadCrawlerEnv();
  const host = new URL(url).host;
  const cachePath = path.join(env.httpCacheDir, `${cacheKeyFor(url)}.json`);

  const cached = await readCache(cachePath);
  if (cached) {
    log.debug({ url, host }, "http cache hit");
    return cached;
  }

  if (isHostBlocked(host)) {
    throw new UpstreamError(`host is blocked via CRAWLER_BLOCKED_HOSTS: ${host}`, { url, host });
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await throttle(host);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": userAgent(), ...options.headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.text();

      if (options.sourceId) {
        await archiveRaw(options.sourceId, url, res.status, body);
      }

      if (RETRYABLE_STATUS.has(res.status) || res.status >= 500) {
        lastError = new UpstreamError(`HTTP ${res.status} from ${host}`, { url, status: res.status });
        if (attempt < MAX_ATTEMPTS - 1) {
          const delay = backoffDelayMs(attempt, res.headers.get("retry-after"));
          log.warn({ url, host, status: res.status, attempt, delay }, "retrying after transient HTTP error");
          await sleep(delay);
          continue;
        }
        throw lastError;
      }

      const result: FetchResult = { status: res.status, body, url, fromCache: false };
      await writeCache(cachePath, result);
      return result;
    } catch (e) {
      if (e instanceof UpstreamError) {
        throw e;
      }
      const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
      lastError = isTimeout
        ? new UpstreamTimeoutError(`timeout fetching ${url}`, { url })
        : new UpstreamError(`network error fetching ${url}`, {
            url,
            cause: e instanceof Error ? e.message : String(e),
          });

      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = backoffDelayMs(attempt, null);
        log.warn({ url, host, attempt, delay, reason: isTimeout ? "timeout" : "network" }, "retrying after error");
        await sleep(delay);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

export function resetHttpStateForTests(): void {
  hostSlots.clear();
}
