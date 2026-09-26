import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError } from "@chaperone/errors";
import {
  CRAWL_2_NOT_BEFORE,
  INTERIM_CRAWL_ID,
  applyCrawlDatesUpdate,
  assertCrawlIdRunnable,
  parseCrawlId,
} from "../src/crawlId.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Normalised to LF so the line-by-line comparisons below hold on a CRLF checkout.
const realDates = readFileSync(path.join(repoRoot, "CRAWL_DATES.md"), "utf8").replace(/\r\n/g, "\n");

const STARTED = "2026-10-02T06:00:00.000Z";
const FINISHED = "2026-10-02T06:40:00.000Z";
const BLOB = "0c896539006dbb6f8dfacc1f02ebbf179c50eec2";

const at = (iso: string): Date => new Date(iso);
const check = (iso: string, reportExists = false): { now: Date; reportExists: boolean } => ({ now: at(iso), reportExists });

function changedLines(before: string, after: string): Array<{ before: string; after: string }> {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b).toHaveLength(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [{ before: line, after: b[i] ?? "" }]));
}

describe("parseCrawlId", () => {
  it("tells numbered, interim and scratch IDs apart", () => {
    expect(parseCrawlId("crawl-1")).toEqual({ kind: "numbered", n: 1 });
    expect(parseCrawlId("crawl-2")).toEqual({ kind: "numbered", n: 2 });
    expect(parseCrawlId(INTERIM_CRAWL_ID)).toEqual({ kind: "interim", n: 1 });
    expect(parseCrawlId("crawl-dryrun-1")).toEqual({ kind: "scratch" });
  });

  it("rejects an ID that could escape data/ or is not a plain lowercase slug", () => {
    for (const bad of ["../crawl-1", "crawl 2", "Crawl-2", "", "-x", "crawl_2", "a".repeat(65)]) {
      expect(() => parseCrawlId(bad), bad).toThrow(ConfigError);
    }
  });
});

describe("assertCrawlIdRunnable", () => {
  it("refuses crawl-2 before 2026-10-20, the day of the interim crawl included", () => {
    expect(() => assertCrawlIdRunnable("crawl-2", check("2026-10-02T06:00:00.000Z"))).toThrow(ConfigError);
    expect(() => assertCrawlIdRunnable("crawl-2", check("2026-10-19T23:59:59.999Z"))).toThrow(/refusing crawl ID "crawl-2" before 2026-10-20/);
  });

  it("allows crawl-2 from the start of 2026-10-20 UTC", () => {
    expect(CRAWL_2_NOT_BEFORE).toBe("2026-10-20T00:00:00.000Z");
    expect(assertCrawlIdRunnable("crawl-2", check("2026-10-20T00:00:00.000Z"))).toEqual({ kind: "numbered", n: 2 });
    expect(assertCrawlIdRunnable("crawl-2", check("2026-10-21T12:00:00.000Z"))).toEqual({ kind: "numbered", n: 2 });
  });

  it("does not gate the interim ID or a scratch ID by date", () => {
    expect(assertCrawlIdRunnable(INTERIM_CRAWL_ID, check("2026-09-26T00:00:00.000Z"))).toEqual({ kind: "interim", n: 1 });
    expect(assertCrawlIdRunnable("crawl-dryrun-1", check("2026-09-26T00:00:00.000Z"))).toEqual({ kind: "scratch" });
  });

  it("refuses to re-run a numbered or interim crawl that already has a report, but not a scratch one", () => {
    expect(() => assertCrawlIdRunnable("crawl-1", check("2026-10-25T00:00:00.000Z", true))).toThrow(/already exists/);
    expect(() => assertCrawlIdRunnable(INTERIM_CRAWL_ID, check("2026-10-03T00:00:00.000Z", true))).toThrow(/already exists/);
    expect(assertCrawlIdRunnable("crawl-dryrun-1", check("2026-10-03T00:00:00.000Z", true))).toEqual({ kind: "scratch" });
  });

  it("lets a crawl that died part way resume: no report yet means it may run", () => {
    expect(assertCrawlIdRunnable(INTERIM_CRAWL_ID, check("2026-10-02T08:00:00.000Z", false))).toEqual({ kind: "interim", n: 1 });
  });
});

describe("applyCrawlDatesUpdate against the committed CRAWL_DATES.md", () => {
  it("has an unfilled interim line and a filled crawl 1 line to start from", () => {
    expect(realDates).toMatch(/^- Interim crawl 1 \(`crawl-interim-1`\) executed at: _\(pending/m);
    expect(realDates).toMatch(/^- Crawl 1 executed at: 2026-09-15T06:19:42\.282Z/m);
    expect(realDates).toMatch(/^- Crawl 2 executed at: _\(pending/m);
  });

  it("writes the interim ID to the interim line only, leaving the crawl 1 and crawl 2 lines byte-identical", () => {
    const result = applyCrawlDatesUpdate(realDates, INTERIM_CRAWL_ID, STARTED, FINISHED, BLOB);
    expect(result.outcome).toBe("updated");

    const changes = changedLines(realDates, result.content);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.before).toMatch(/^- Interim crawl 1 \(`crawl-interim-1`\) executed at: _\(pending/);
    expect(changes[0]?.after).toBe(
      `- Interim crawl 1 (\`crawl-interim-1\`) executed at: ${STARTED} (finished ${FINISHED}; corpus/TAXONOMY.md blob ${BLOB})`,
    );

    // The frozen lines, asserted directly as well as by the diff above.
    for (const frozen of [/^- Crawl 1 executed at:.*$/m, /^- Crawl 2 executed at:.*$/m]) {
      expect(result.content.match(frozen)?.[0]).toBe(realDates.match(frozen)?.[0]);
    }
  });

  it("does not overwrite the interim line once it is filled", () => {
    const first = applyCrawlDatesUpdate(realDates, INTERIM_CRAWL_ID, STARTED, FINISHED, BLOB);
    const second = applyCrawlDatesUpdate(first.content, INTERIM_CRAWL_ID, "2026-10-03T00:00:00.000Z", "2026-10-03T01:00:00.000Z", BLOB);
    expect(second.outcome).toBe("untouched");
    expect(second.content).toBe(first.content);
  });

  it("does not overwrite crawl 1's recorded timestamp, even if it were run again", () => {
    const result = applyCrawlDatesUpdate(realDates, "crawl-1", STARTED, FINISHED, BLOB);
    expect(result.outcome).toBe("untouched");
    expect(result.reason).toMatch(/already filled/);
    expect(result.content).toBe(realDates);
  });

  it("fills crawl 2's own pending line for crawl-2, and only that line", () => {
    const result = applyCrawlDatesUpdate(realDates, "crawl-2", "2026-10-20T06:00:00.000Z", "2026-10-20T06:40:00.000Z", BLOB);
    expect(result.outcome).toBe("updated");
    const changes = changedLines(realDates, result.content);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.before).toMatch(/^- Crawl 2 executed at: _\(pending/);
  });

  it("writes nothing for a scratch ID", () => {
    const result = applyCrawlDatesUpdate(realDates, "crawl-dryrun-1", STARTED, FINISHED, BLOB);
    expect(result.outcome).toBe("untouched");
    expect(result.content).toBe(realDates);
  });

  it("never lets an interim ID reach a line above the appendix, even if a stray one were planted there", () => {
    const planted = realDates.replace(/^- Crawl 2 executed at:.*$/m, (line) => `${line}\n- Interim crawl 1 (\`crawl-interim-1\`) executed at: _(pending)_`);
    const result = applyCrawlDatesUpdate(planted, INTERIM_CRAWL_ID, STARTED, FINISHED, BLOB);
    expect(result.outcome).toBe("updated");
    const [head] = result.content.split("\n## Appendix: interim crawl");
    const [plantedHead] = planted.split("\n## Appendix: interim crawl");
    expect(head).toBe(plantedHead);
  });

  it("leaves the file alone when the interim section is missing", () => {
    const [head] = realDates.split("\n## Appendix: interim crawl");
    const result = applyCrawlDatesUpdate(head ?? "", INTERIM_CRAWL_ID, STARTED, FINISHED, BLOB);
    expect(result.outcome).toBe("untouched");
  });
});
