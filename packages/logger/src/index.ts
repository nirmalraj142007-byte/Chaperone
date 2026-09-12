import pino from "pino";
import type { Logger } from "pino";

const SENSITIVE_KEY_PATTERN = /token|secret|key|authorization/i;

/**
 * Recursively replaces any object key matching SENSITIVE_KEY_PATTERN with
 * "[redacted]". Exported for direct unit testing; also wired in as pino's
 * log-object formatter below so every structured log line goes through it.
 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redactSensitive(entryValue);
    }
    return result;
  }
  return value;
}

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    log(object) {
      return redactSensitive(object) as Record<string, unknown>;
    },
  },
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(redactSensitive(bindings) as Record<string, unknown>);
}

export function requestLogger(sessionId: string, requestId: string): Logger {
  return childLogger({ sessionId, requestId });
}
