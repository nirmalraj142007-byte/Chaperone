import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "@chaperone/errors";
import { loadConfig, resetConfigForTests } from "../src/index.js";

const VALID_UPSTREAMS = JSON.stringify([
  { id: "grocery", url: "http://localhost:4001/mcp", label: "Grocery" },
]);

/**
 * Every variable loadConfig reads. withEnv clears all of them before applying
 * the ones a test names, so a test asserts what an *unset* variable defaults
 * to no matter what the shell running the suite exported. It failed exactly
 * that way in CI's stack job (which exports DDB_ENDPOINT for pnpm test:all)
 * and on a laptop with a real .env: defaults were being read off the ambient
 * environment, not off the code.
 */
const CONFIG_KEYS = [
  "AWS_REGION",
  "DDB_ENDPOINT",
  "DDB_TABLE_PREFIX",
  "HOUSEHOLD_ID",
  "CHAPERONE_UPSTREAMS",
  "ADVISORY_MODEL_ID",
  "BASELINE_MODEL_ID",
  "GITHUB_TOKEN",
  "LOG_LEVEL",
  "PORT",
  "GATEWAY_ORIGIN_ALLOWLIST",
  "BIND_ALL",
  "MCP_APP_ENABLED",
  "CHAPERONE_VERSION",
  "CHAPERONE_COMMIT",
  "CHAPERONE_ENV",
];

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const vars: Record<string, string | undefined> = { ...Object.fromEntries(CONFIG_KEYS.map((k) => [k, undefined])), ...overrides };
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

  it("defaults originAllowlist to localhost-any-port and bindAll to false", () => {
    withEnv({ CHAPERONE_UPSTREAMS: VALID_UPSTREAMS }, () => {
      const config = loadConfig();
      expect(config.originAllowlist).toEqual(["http://localhost:*"]);
      expect(config.bindAll).toBe(false);
    });
  });

  it("splits a comma-separated GATEWAY_ORIGIN_ALLOWLIST and trims whitespace", () => {
    withEnv(
      {
        CHAPERONE_UPSTREAMS: VALID_UPSTREAMS,
        GATEWAY_ORIGIN_ALLOWLIST: "http://localhost:*, https://app.example.com ,https://deployed.example.com",
      },
      () => {
        const config = loadConfig();
        expect(config.originAllowlist).toEqual([
          "http://localhost:*",
          "https://app.example.com",
          "https://deployed.example.com",
        ]);
      },
    );
  });

  it("parses BIND_ALL=true", () => {
    withEnv({ CHAPERONE_UPSTREAMS: VALID_UPSTREAMS, BIND_ALL: "true" }, () => {
      expect(loadConfig().bindAll).toBe(true);
    });
  });

  it("throws ConfigError when BIND_ALL is neither true nor false", () => {
    withEnv({ CHAPERONE_UPSTREAMS: VALID_UPSTREAMS, BIND_ALL: "yes" }, () => {
      expect(() => loadConfig()).toThrow(ConfigError);
    });
  });

  it("leaves advisoryModelId and baselineModelId undefined when unset", () => {
    withEnv({ CHAPERONE_UPSTREAMS: VALID_UPSTREAMS, ADVISORY_MODEL_ID: undefined, BASELINE_MODEL_ID: undefined }, () => {
      const config = loadConfig();
      expect(config.advisoryModelId).toBeUndefined();
      expect(config.baselineModelId).toBeUndefined();
    });
  });

  it("reads ADVISORY_MODEL_ID and BASELINE_MODEL_ID independently", () => {
    withEnv(
      {
        CHAPERONE_UPSTREAMS: VALID_UPSTREAMS,
        ADVISORY_MODEL_ID: "us.amazon.nova-lite-v1:0",
        BASELINE_MODEL_ID: "us.amazon.nova-pro-v1:0",
      },
      () => {
        const config = loadConfig();
        expect(config.advisoryModelId).toBe("us.amazon.nova-lite-v1:0");
        expect(config.baselineModelId).toBe("us.amazon.nova-pro-v1:0");
      },
    );
  });
});
