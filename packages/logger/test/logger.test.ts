import { describe, expect, it } from "vitest";
import { childLogger, logger, redactSensitive, requestLogger } from "../src/index.js";

describe("@chaperone/logger", () => {
  it("redacts keys matching token|secret|key|authorization, recursively and in arrays", () => {
    const redacted = redactSensitive({
      apiKey: "abc123",
      Authorization: "Bearer xyz",
      nested: { clientSecret: "shh", accessToken: "jwt", safe: "value" },
      list: [{ apiKey: "nope" }, { safe: "yes" }],
    });

    expect(redacted).toEqual({
      apiKey: "[redacted]",
      Authorization: "[redacted]",
      nested: { clientSecret: "[redacted]", accessToken: "[redacted]", safe: "value" },
      list: [{ apiKey: "[redacted]" }, { safe: "yes" }],
    });
  });

  it("leaves non-sensitive values untouched", () => {
    expect(redactSensitive({ note: "ok", count: 3 })).toEqual({ note: "ok", count: 3 });
    expect(redactSensitive("plain string")).toBe("plain string");
    expect(redactSensitive(42)).toBe(42);
  });

  it("creates a child logger bound with (redacted) fields", () => {
    const child = childLogger({ component: "gateway", apiKey: "should-not-leak" });
    expect(typeof child.info).toBe("function");
    expect(typeof child.error).toBe("function");
  });

  it("creates a request-scoped logger from sessionId and requestId", () => {
    const requestScoped = requestLogger("session-1", "req-1");
    expect(typeof requestScoped.info).toBe("function");
  });

  it("exports the root logger", () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
  });
});
