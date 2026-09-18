import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenBucket, fetchGithub } from "../src/githubClient.js";
import { resetAdvisoryEnvForTests } from "../src/env.js";

/**
 * A real loopback HTTP server rather than a mocked `fetch` — matching
 * packages/crawler/test/http.test.ts's convention for exercising an actual
 * network policy (cache, retries) honestly rather than asserting against a
 * hand-written fixture of what GitHub "would" return.
 */
function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = `packages/advisory/.cache/test-${randomUUID()}`;
  process.env["ADVISORY_GITHUB_CACHE_DIR"] = cacheDir;
  resetAdvisoryEnvForTests();
});

afterEach(async () => {
  delete process.env["ADVISORY_GITHUB_CACHE_DIR"];
  resetAdvisoryEnvForTests();
  await rm(cacheDir, { recursive: true, force: true });
});

describe("fetchGithub", () => {
  it("returns the parsed JSON body and status on a 200", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const result = await fetchGithub(`${server.url}/repos/foo/bar`, undefined);
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ ok: true });
      expect(result.fromCache).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("serves a repeated request for the same URL from the on-disk cache", async () => {
    let requestCount = 0;
    const server = await startServer((_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ count: requestCount }));
    });
    try {
      const first = await fetchGithub(`${server.url}/repos/foo/bar`, undefined);
      const second = await fetchGithub(`${server.url}/repos/foo/bar`, undefined);
      expect(first.fromCache).toBe(false);
      expect(second.fromCache).toBe(true);
      expect(second.json).toEqual({ count: 1 });
      expect(requestCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("does not cache a non-200 response, so a later call retries it", async () => {
    let requestCount = 0;
    const server = await startServer((_req, res) => {
      requestCount++;
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "rate limited" }));
    });
    try {
      const first = await fetchGithub(`${server.url}/repos/foo/bar`, undefined);
      const second = await fetchGithub(`${server.url}/repos/foo/bar`, undefined);
      expect(first.status).toBe(403);
      expect(second.status).toBe(403);
      expect(second.fromCache).toBe(false);
      expect(requestCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("sends an Authorization header only when a token is given", async () => {
    let sawAuth: string | undefined;
    const server = await startServer((req, res) => {
      sawAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    try {
      await fetchGithub(`${server.url}/repos/foo/bar`, "gh-token-123");
      expect(sawAuth).toBe("Bearer gh-token-123");
    } finally {
      await server.close();
    }
  });
});

describe("TokenBucket", () => {
  it("consumes a token immediately when the bucket is full, without sleeping", async () => {
    let slept = false;
    const bucket = new TokenBucket({ capacity: 5, refillIntervalMs: 1000, sleep: async () => (slept = true) });
    await bucket.acquire();
    expect(slept).toBe(false);
  });

  it("waits out the deficit when the bucket is empty, using injected clock/sleep", async () => {
    let now = 0;
    const waited: number[] = [];
    const bucket = new TokenBucket({
      capacity: 1,
      refillIntervalMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        waited.push(ms);
        now += ms;
      },
    });
    await bucket.acquire(); // consumes the single starting token
    await bucket.acquire(); // must wait for a refill
    expect(waited).toHaveLength(1);
    expect(waited[0]).toBeCloseTo(1000, 0);
  });
});
