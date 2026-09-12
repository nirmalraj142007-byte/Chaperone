import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpstreamError } from "@chaperone/errors";
import { fetchWithPolicy, resetHttpStateForTests } from "../src/http.js";
import { resetCrawlerEnvForTests } from "../src/env.js";

/**
 * These tests spin up a real HTTP server on loopback rather than mocking
 * fetch — CLAUDE.md's "never mock external APIs" rule is about the
 * crawler's actual network calls in production, and a real socket
 * round-trip on 127.0.0.1 exercises fetchWithPolicy's retry/backoff/cache
 * logic honestly without depending on (or hammering) a real third party.
 */
function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = `packages/crawler/.cache/test-${randomUUID()}`;
  process.env.CRAWLER_HTTP_CACHE_DIR = `${cacheDir}/http`;
  process.env.CRAWLER_RAW_ARCHIVE_DIR = `${cacheDir}/raw`;
  resetCrawlerEnvForTests();
  resetHttpStateForTests();
});

afterEach(async () => {
  delete process.env.CRAWLER_HTTP_CACHE_DIR;
  delete process.env.CRAWLER_RAW_ARCHIVE_DIR;
  delete process.env.CRAWLER_BLOCKED_HOSTS;
  resetCrawlerEnvForTests();
  await rm(cacheDir, { recursive: true, force: true });
});

describe("fetchWithPolicy", () => {
  it("returns the body and status on a plain 200", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    try {
      const result = await fetchWithPolicy(`${server.url}/servers`);
      expect(result.status).toBe(200);
      expect(result.body).toBe('{"ok":true}');
      expect(result.fromCache).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("serves a second request for the same URL from the on-disk cache without hitting the server again", async () => {
    let requestCount = 0;
    const server = await startServer((_req, res) => {
      requestCount++;
      res.writeHead(200);
      res.end("hello");
    });
    try {
      const first = await fetchWithPolicy(`${server.url}/once`);
      const second = await fetchWithPolicy(`${server.url}/once`);
      expect(first.fromCache).toBe(false);
      expect(second.fromCache).toBe(true);
      expect(second.body).toBe("hello");
      expect(requestCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("retries a 429 honouring Retry-After (in seconds) and then succeeds", async () => {
    let attempts = 0;
    const server = await startServer((_req, res) => {
      attempts++;
      if (attempts < 2) {
        res.writeHead(429, { "retry-after": "0" });
        res.end("slow down");
        return;
      }
      res.writeHead(200);
      res.end("ok now");
    });
    try {
      const result = await fetchWithPolicy(`${server.url}/rate-limited`);
      expect(result.status).toBe(200);
      expect(result.body).toBe("ok now");
      expect(attempts).toBe(2);
    } finally {
      await server.close();
    }
  });

  it(
    "retries a 500 up to 3 times then throws UpstreamError",
    async () => {
      let attempts = 0;
      const server = await startServer((_req, res) => {
        attempts++;
        res.writeHead(500);
        res.end("boom");
      });
      try {
        await expect(fetchWithPolicy(`${server.url}/always-broken`)).rejects.toBeInstanceOf(UpstreamError);
        expect(attempts).toBe(4); // 1 initial attempt + 3 retries
      } finally {
        await server.close();
      }
    },
    10_000,
  );

  it("does not retry and returns a 401 as-is (callers decide how to degrade)", async () => {
    let attempts = 0;
    const server = await startServer((_req, res) => {
      attempts++;
      res.writeHead(401);
      res.end("nope");
    });
    try {
      const result = await fetchWithPolicy(`${server.url}/needs-key`);
      expect(result.status).toBe(401);
      expect(attempts).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("refuses to fetch a host listed in CRAWLER_BLOCKED_HOSTS", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("should not be reached");
    });
    try {
      const host = new URL(server.url).host;
      process.env.CRAWLER_BLOCKED_HOSTS = host;
      resetCrawlerEnvForTests();
      await expect(fetchWithPolicy(`${server.url}/anything`)).rejects.toBeInstanceOf(UpstreamError);
    } finally {
      await server.close();
    }
  });

  it("spaces two requests to the same host by roughly the 2 req/s ceiling", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("x");
    });
    try {
      const start = Date.now();
      await fetchWithPolicy(`${server.url}/a`);
      await fetchWithPolicy(`${server.url}/b`);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(450); // ~500ms floor, small margin for scheduler jitter
    } finally {
      await server.close();
    }
  });
});
