import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "@chaperone/errors";
import { loadCrawlerEnv, resetCrawlerEnvForTests } from "../src/env.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    const nextValue = vars[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(previous)) {
      const restoreValue = previous[key];
      if (restoreValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = restoreValue;
      }
    }
  }
}

describe("crawler loadCrawlerEnv", () => {
  afterEach(() => {
    resetCrawlerEnvForTests();
  });

  it("applies defaults with no crawler env vars set", () => {
    withEnv(
      {
        CRAWLER_REGISTRY_LIMIT: undefined,
        CRAWLER_SMITHERY_LIMIT: undefined,
        CRAWLER_AWESOME_LIMIT: undefined,
        CRAWLER_MIN_TOTAL: undefined,
        CRAWLER_BLOCKED_HOSTS: undefined,
      },
      () => {
        const env = loadCrawlerEnv();
        expect(env.registryLimit).toBe(400);
        expect(env.smitheryLimit).toBe(400);
        expect(env.awesomeLimit).toBe(350);
        expect(env.minTotal).toBe(300);
        expect(env.blockedHosts).toEqual([]);
        expect(env.pulsemcpApiKey).toBeUndefined();
      },
    );
  });

  it("parses a comma-separated CRAWLER_BLOCKED_HOSTS into a trimmed array", () => {
    withEnv({ CRAWLER_BLOCKED_HOSTS: "registry.smithery.ai, glama.ai ,, " }, () => {
      const env = loadCrawlerEnv();
      expect(env.blockedHosts).toEqual(["registry.smithery.ai", "glama.ai"]);
    });
  });

  it("memoises the loaded env as a singleton until reset", () => {
    const first = loadCrawlerEnv();
    const second = loadCrawlerEnv();
    expect(first).toBe(second);
  });

  it("throws ConfigError when a numeric limit is not a positive integer", () => {
    withEnv({ CRAWLER_REGISTRY_LIMIT: "not-a-number" }, () => {
      expect(() => loadCrawlerEnv()).toThrow(ConfigError);
    });
  });

  it("throws ConfigError when CRAWLER_CONTACT_URL is not a URL", () => {
    withEnv({ CRAWLER_CONTACT_URL: "not-a-url" }, () => {
      expect(() => loadCrawlerEnv()).toThrow(ConfigError);
    });
  });
});
