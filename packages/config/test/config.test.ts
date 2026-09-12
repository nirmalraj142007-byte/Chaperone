import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "@chaperone/errors";
import { loadConfig, resetConfigForTests } from "../src/index.js";

const VALID_UPSTREAMS = JSON.stringify([
  { id: "grocery", url: "http://localhost:4001/mcp", label: "Grocery" },
]);

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

describe("@chaperone/config loadConfig", () => {
  afterEach(() => {
    resetConfigForTests();
  });

  it("applies defaults and parses CHAPERONE_UPSTREAMS into typed objects", () => {
    withEnv({ CHAPERONE_UPSTREAMS: VALID_UPSTREAMS }, () => {
      const config = loadConfig();
      expect(config.awsRegion).toBe("us-east-1");
      expect(config.ddbTablePrefix).toBe("chaperone");
      expect(config.householdId).toBe("household-demo");
      expect(config.logLevel).toBe("info");
      expect(config.port).toBe(3000);
      expect(config.ddbEndpoint).toBeUndefined();
      expect(config.upstreams).toEqual([
        { id: "grocery", url: "http://localhost:4001/mcp", label: "Grocery" },
      ]);
    });
  });

  it("memoises the loaded config as a singleton until reset", () => {
    withEnv({ CHAPERONE_UPSTREAMS: VALID_UPSTREAMS }, () => {
      const first = loadConfig();
      const second = loadConfig();
      expect(first).toBe(second);
    });
  });

  it("throws ConfigError listing CHAPERONE_UPSTREAMS when it is absent", () => {
    withEnv({ CHAPERONE_UPSTREAMS: undefined }, () => {
      let caught: unknown;
      try {
        loadConfig();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const message = (caught as ConfigError).message;
      expect(message).toContain("CHAPERONE_UPSTREAMS");
      expect(message).toContain("JSON array of {id: string, url: string, label: string}");
    });
  });

  it("throws ConfigError when CHAPERONE_UPSTREAMS is not valid JSON", () => {
    withEnv({ CHAPERONE_UPSTREAMS: "not-json" }, () => {
      expect(() => loadConfig()).toThrow(ConfigError);
    });
  });

  it("throws ConfigError when CHAPERONE_UPSTREAMS entries don't match the shape", () => {
    withEnv({ CHAPERONE_UPSTREAMS: JSON.stringify([{ id: "x" }]) }, () => {
      expect(() => loadConfig()).toThrow(ConfigError);
    });
  });

  it("respects an overridden PORT and LOG_LEVEL", () => {
    withEnv({ CHAPERONE_UPSTREAMS: VALID_UPSTREAMS, PORT: "8080", LOG_LEVEL: "debug" }, () => {
      const config = loadConfig();
      expect(config.port).toBe(8080);
      expect(config.logLevel).toBe("debug");
    });
  });
});
