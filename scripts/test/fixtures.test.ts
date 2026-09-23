import { describe, expect, it } from "vitest";
import { FIXTURES_PATH, loadFixtureFile, parseFixtureFile } from "../demo/fixtures.js";

describe("demo/advisory-fixtures.json", () => {
  it("parses, and says in the file itself that it is a fixture and not model output", () => {
    const file = loadFixtureFile(FIXTURES_PATH);
    expect(file.$fixture).toBe(true);
    expect(file.notice).toMatch(/FIXTURE, NOT MODEL OUTPUT/);
    expect(file.modelId.startsWith("fixture:")).toBe(true);
    expect(file.rows.length).toBeGreaterThan(0);
  });

  it("carries a TODO that names its blocker and when it resolves", () => {
    expect(loadFixtureFile().todo).toMatch(/^TODO\(blocker: .+; resolves .+\)/);
  });

  it("holds every summary to the bound a real model's output must meet", () => {
    for (const row of loadFixtureFile().rows) {
      expect(row.summary.length).toBeGreaterThan(0);
      expect(row.summary.length).toBeLessThanOrEqual(480);
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
    }
  });

  const valid = (): Record<string, unknown> => JSON.parse(JSON.stringify(loadFixtureFile())) as Record<string, unknown>;

  it("rejects a file that is not marked as a fixture", () => {
    expect(() => parseFixtureFile(JSON.stringify({ ...valid(), $fixture: false }))).toThrow();
  });

  it("rejects a modelId that does not start with the fixture prefix", () => {
    expect(() => parseFixtureFile(JSON.stringify({ ...valid(), modelId: "us.amazon.nova-lite-v1:0" }))).toThrow();
  });

  it("rejects a TODO with no blocker or resolution date", () => {
    expect(() => parseFixtureFile(JSON.stringify({ ...valid(), todo: "TODO: fix later" }))).toThrow();
  });

  it("rejects a summary over 480 characters", () => {
    const file = valid() as { rows: Array<Record<string, unknown>> };
    file.rows[0] = { ...file.rows[0], summary: "x".repeat(481) };
    expect(() => parseFixtureFile(JSON.stringify(file))).toThrow();
  });
});
