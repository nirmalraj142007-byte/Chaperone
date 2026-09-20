/**
 * The request ID has to reach log lines written by modules that were never
 * handed the request — the gate, the upstream pool, the event store. That
 * is the whole point of the AsyncLocalStorage context, and it is easy to
 * assert loosely ("the middleware sets a header") and still ship a logger
 * that drops the ID the moment an `await` crosses a module boundary. These
 * tests capture real pino output and check the ID is on it.
 */
import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { currentRequestContext, runWithRequestContext } from "../src/context.js";
import { redactSensitive } from "../src/index.js";

/** A pino instance wired the same way as the real one, writing to a buffer. */
function capturingLogger(): { logger: pino.Logger; lines: () => Array<Record<string, unknown>> } {
  const captured: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured.push(String(chunk));
      callback();
    },
  });

  const logger = pino(
    {
      level: "debug",
      mixin(_mergeObject, _level, loggerInstance: pino.Logger) {
        const context = currentRequestContext();
        if (context === undefined) {
          return {};
        }
        const bindings = loggerInstance.bindings();
        return {
          ...(bindings["requestId"] === undefined ? { requestId: context.requestId } : {}),
          ...(bindings["sessionId"] === undefined ? { sessionId: context.sessionId } : {}),
        };
      },
      formatters: { log: (object) => redactSensitive(object) as Record<string, unknown> },
    },
    stream,
  );

  return {
    logger,
    lines: () =>
      captured
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const CONTEXT = { requestId: "01JBENCH0000000000000000AA", sessionId: "session-42" };

describe("runWithRequestContext", () => {
  it("makes the context visible to code inside it", () => {
    runWithRequestContext(CONTEXT, () => {
      expect(currentRequestContext()).toEqual(CONTEXT);
    });
  });

  it("is undefined outside a request — startup, shutdown, a script", () => {
    expect(currentRequestContext()).toBeUndefined();
  });

  it("survives awaits, so a line logged after an upstream call still carries the ID", async () => {
    await runWithRequestContext(CONTEXT, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await Promise.resolve();
      expect(currentRequestContext()?.requestId).toBe(CONTEXT.requestId);
    });
  });

  it("keeps concurrent requests apart", async () => {
    const seen: string[] = [];
    const one = runWithRequestContext({ requestId: "one", sessionId: "s1" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(currentRequestContext()?.requestId ?? "lost");
    });
    const two = runWithRequestContext({ requestId: "two", sessionId: "s2" }, async () => {
      seen.push(currentRequestContext()?.requestId ?? "lost");
    });
    await Promise.all([one, two]);
    expect(seen.sort()).toEqual(["one", "two"]);
  });
});

describe("the pino mixin", () => {
  it("puts the request ID on a line from a child logger that was never told about it", () => {
    // This is the gate's situation: `childLogger({component: "gateway-gate"})`
    // is built at module load, long before any request exists.
    const { logger, lines } = capturingLogger();
    const componentLogger = logger.child({ component: "gateway-gate" });

    runWithRequestContext(CONTEXT, () => {
      componentLogger.debug({ decision: "allow" }, "allow: current definition hashes to the pinned hash");
    });

    const [line] = lines();
    expect(line).toMatchObject({
      component: "gateway-gate",
      requestId: CONTEXT.requestId,
      sessionId: CONTEXT.sessionId,
      decision: "allow",
    });
  });

  it("does not override an explicitly bound request ID", () => {
    // `requestLogger()` binds the IDs directly. The ambient context only
    // ever fills a gap; it must not rewrite what a caller stated.
    const { logger, lines } = capturingLogger();
    const bound = logger.child({ requestId: "explicit", sessionId: "explicit-session" });

    runWithRequestContext(CONTEXT, () => {
      bound.info("request handled");
    });

    expect(lines()[0]).toMatchObject({ requestId: "explicit", sessionId: "explicit-session" });
  });

  it("adds nothing outside a request", () => {
    const { logger, lines } = capturingLogger();
    logger.info("gateway listening");
    const [line] = lines();
    expect(line).not.toHaveProperty("requestId");
    expect(line).not.toHaveProperty("sessionId");
  });

  it("still redacts secrets on a line the context contributed to", () => {
    // The mixin runs before the formatter; adding it must not open a hole
    // in the redaction that every log line goes through.
    const { logger, lines } = capturingLogger();
    runWithRequestContext(CONTEXT, () => {
      logger.info({ approvalToken: "super-secret" }, "minted");
    });
    const [line] = lines();
    expect(line["approvalToken"]).toBe("[redacted]");
    expect(line["requestId"]).toBe(CONTEXT.requestId);
  });

  it("redacts approvalToken, GITHUB_TOKEN, and AWS credentials together in one real pino line, none surviving in the serialized output", () => {
    const { logger, lines } = capturingLogger();
    const secret = {
      approvalToken: "approval-secret-value",
      GITHUB_TOKEN: "ghp_realLookingSecretValue123456",
      AWS_ACCESS_KEY_ID: "AKIAABCDEFGHIJKLMNOP",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
      AWS_SESSION_TOKEN: "session-token-secret-value",
      upstreamId: "grocery", // control: not sensitive, must survive
    };
    logger.info(secret, "config loaded");
    const raw = JSON.stringify(lines()[0]);
    const [line] = lines();

    for (const key of [
      "approvalToken",
      "GITHUB_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ] as const) {
      expect(line[key]).toBe("[redacted]");
    }
    // None of the actual secret values leak anywhere in the serialized line.
    for (const value of Object.values(secret).slice(0, 5)) {
      expect(raw).not.toContain(value);
    }
    expect(line["upstreamId"]).toBe("grocery");
  });
});
