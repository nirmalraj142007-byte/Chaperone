import { describe, expect, it } from "vitest";
import { isWithinActivityWindow, NINETY_DAYS_MS } from "../src/githubActivity.js";

describe("isWithinActivityWindow", () => {
  const now = Date.parse("2026-09-13T00:00:00.000Z");

  it("is true for a push exactly at the 90-day boundary", () => {
    const pushedAt = new Date(now - NINETY_DAYS_MS).toISOString();
    expect(isWithinActivityWindow(pushedAt, now)).toBe(true);
  });

  it("is false for a push one millisecond past the 90-day boundary", () => {
    const pushedAt = new Date(now - NINETY_DAYS_MS - 1).toISOString();
    expect(isWithinActivityWindow(pushedAt, now)).toBe(false);
  });

  it("is true for a push yesterday and false for a push a year ago", () => {
    expect(isWithinActivityWindow("2026-09-12T00:00:00.000Z", now)).toBe(true);
    expect(isWithinActivityWindow("2025-09-12T00:00:00.000Z", now)).toBe(false);
  });
});
