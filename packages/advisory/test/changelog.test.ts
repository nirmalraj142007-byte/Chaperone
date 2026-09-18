import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkChangelog } from "../src/changelog.js";
import { resetAdvisoryEnvForTests } from "../src/env.js";

const SINCE = "2026-09-01T00:00:00.000Z";

interface RouteMap {
  commits?: unknown;
  commitsStatus?: number;
  releases?: unknown;
  releasesStatus?: number;
  tags?: unknown;
  tagsStatus?: number;
}

/** A real loopback server standing in for api.github.com, matching packages/crawler's real-server test convention. */
function startGithubServer(routes: RouteMap): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.endsWith("/commits")) {
        res.writeHead(routes.commitsStatus ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(routes.commits ?? []));
      } else if (url.pathname.endsWith("/releases")) {
        res.writeHead(routes.releasesStatus ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(routes.releases ?? []));
      } else if (url.pathname.endsWith("/tags")) {
        res.writeHead(routes.tagsStatus ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(routes.tags ?? []));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
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

describe("checkChangelog", () => {
  it("returns 'release' when a release was published after the pin date", async () => {
    const server = await startGithubServer({
      commits: [{ sha: "abc123", html_url: "https://github.com/o/r/commit/abc123" }],
      releases: [{ published_at: "2026-09-10T00:00:00.000Z", html_url: "https://github.com/o/r/releases/tag/v2" }],
      tags: [],
    });
    try {
      const result = await checkChangelog("o", "r", SINCE, undefined, server.url);
      expect(result).toEqual({ evidence: "release", evidenceUrl: "https://github.com/o/r/releases/tag/v2" });
    } finally {
      await server.close();
    }
  });

  it("returns 'tag' when a tag (but no qualifying release) points at a since-commit", async () => {
    const server = await startGithubServer({
      commits: [{ sha: "abc123", html_url: "https://github.com/o/r/commit/abc123" }],
      releases: [],
      tags: [{ name: "v2.0.1", commit: { sha: "abc123" } }],
    });
    try {
      const result = await checkChangelog("o", "r", SINCE, undefined, server.url);
      expect(result).toEqual({ evidence: "tag", evidenceUrl: "https://github.com/o/r/releases/tag/v2.0.1" });
    } finally {
      await server.close();
    }
  });

  it("ignores a release published before the pin date and falls through to tag/commit", async () => {
    const server = await startGithubServer({
      commits: [{ sha: "abc123", html_url: "https://github.com/o/r/commit/abc123" }],
      releases: [{ published_at: "2026-01-01T00:00:00.000Z", html_url: "https://github.com/o/r/releases/tag/old" }],
      tags: [],
    });
    try {
      const result = await checkChangelog("o", "r", SINCE, undefined, server.url);
      expect(result.evidence).toBe("commit-message");
    } finally {
      await server.close();
    }
  });

  it("returns 'commit-message' when there's a commit since the pin date but no release or tag", async () => {
    const server = await startGithubServer({
      commits: [{ sha: "def456", html_url: "https://github.com/o/r/commit/def456" }],
      releases: [],
      tags: [],
    });
    try {
      const result = await checkChangelog("o", "r", SINCE, undefined, server.url);
      expect(result).toEqual({ evidence: "commit-message", evidenceUrl: "https://github.com/o/r/commit/def456" });
    } finally {
      await server.close();
    }
  });

  it("returns 'none' when there are no commits since the pin date at all", async () => {
    const server = await startGithubServer({ commits: [] });
    try {
      const result = await checkChangelog("o", "r", SINCE, undefined, server.url);
      expect(result).toEqual({ evidence: "none" });
    } finally {
      await server.close();
    }
  });

  it("degrades to 'none' on a 403 from the commits endpoint", async () => {
    const server = await startGithubServer({ commitsStatus: 403, commits: { message: "rate limited" } });
    try {
      const result = await checkChangelog("o", "r", SINCE, undefined, server.url);
      expect(result).toEqual({ evidence: "none" });
    } finally {
      await server.close();
    }
  });

  it("never throws, even against an unreachable host", async () => {
    const result = await checkChangelog("o", "r", SINCE, undefined, "http://127.0.0.1:1");
    expect(result).toEqual({ evidence: "none" });
  });
});
