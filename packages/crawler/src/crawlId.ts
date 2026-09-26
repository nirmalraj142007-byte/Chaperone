/**
 * Which crawl IDs may run, and which line of CRAWL_DATES.md each one may write.
 *
 * `updateCrawlDatesFile` used to fill the reserved line for any ID shaped
 * `crawl-N`, so running the 2026-10-02 interim crawl as `crawl-2` would have
 * consumed crawl 2's line, and one shaped anything else was silently skipped
 * (audit item M17, 2026-09-26). The interim crawl now runs as
 * `crawl-interim-1` and has its own reserved line in the appended interim
 * section. Nothing here does I/O; crawl.ts reads and writes the files.
 */
import { ConfigError } from "@chaperone/errors";

/**
 * Crawl 2 is pre-registered for 2026-10-20 (CRAWL_DATES.md). The ID `crawl-2`
 * is refused before this instant so an early or mistyped run can never write
 * into crawl 2's data. UTC midnight, the start of that calendar date.
 */
export const CRAWL_2_NOT_BEFORE = "2026-10-20T00:00:00.000Z";

/** The interim crawl's ID, as announced in CRAWL_DATES.md's appendix. */
export const INTERIM_CRAWL_ID = "crawl-interim-1";

/** The text the crawler replaces, and the only text it replaces. */
const PENDING_MARK = "_(pending";

/** The appendix heading in CRAWL_DATES.md; interim lines are searched for only after it. */
export const INTERIM_APPENDIX_HEADING = "## Appendix: interim crawl";

export type CrawlIdKind =
  | { kind: "numbered"; n: number }
  | { kind: "interim"; n: number }
  /** Any other well-formed ID (a dry run, a throwaway). It writes to no line of CRAWL_DATES.md. */
  | { kind: "scratch" };

export function parseCrawlId(crawlId: string): CrawlIdKind {
  // The ID becomes a directory and file names under data/, so keep it to a safe alphabet.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(crawlId)) {
    throw new ConfigError(`crawl ID "${crawlId}" is not allowed: use lowercase letters, digits and hyphens, at most 64 characters`, { crawlId });
  }
  const numbered = /^crawl-(\d+)$/.exec(crawlId);
  if (numbered) {
    return { kind: "numbered", n: Number(numbered[1]) };
  }
  const interim = /^crawl-interim-(\d+)$/.exec(crawlId);
  if (interim) {
    return { kind: "interim", n: Number(interim[1]) };
  }
  return { kind: "scratch" };
}

export interface RunnableCheck {
  now: Date;
  /** Whether `data/{crawlId}-report.json` already exists, i.e. this crawl already finished once. */
  reportExists: boolean;
}

/**
 * Throws ConfigError for an ID that must not run right now. Called before the
 * crawler touches Docker, DynamoDB or any file.
 *
 * A `crawl-N` or `crawl-interim-N` whose report already exists is refused as
 * well: a crawl that died part way has no report yet (it is written last) and
 * resumes normally, but a finished one being run again would overwrite its
 * report and its CRAWL_DATES.md timestamp. That is how crawl 1's frozen
 * evidence would be lost.
 */
export function assertCrawlIdRunnable(crawlId: string, check: RunnableCheck): CrawlIdKind {
  const parsed = parseCrawlId(crawlId);
  if (parsed.kind === "numbered" && parsed.n === 2 && check.now.getTime() < Date.parse(CRAWL_2_NOT_BEFORE)) {
    throw new ConfigError(
      `refusing crawl ID "crawl-2" before ${CRAWL_2_NOT_BEFORE.slice(0, 10)} (UTC; now is ${check.now.toISOString()}). ` +
        `Crawl 2's line in CRAWL_DATES.md is reserved for the pre-registered run. The interim crawl's ID is "${INTERIM_CRAWL_ID}"; ` +
        "use a scratch ID such as crawl-dryrun-1 for a dry run.",
      { crawlId, notBefore: CRAWL_2_NOT_BEFORE },
    );
  }
  if (parsed.kind !== "scratch" && check.reportExists) {
    throw new ConfigError(
      `refusing crawl ID "${crawlId}": data/${crawlId}-report.json already exists, so this crawl has finished. ` +
        "Running it again would overwrite its report and its CRAWL_DATES.md timestamp.",
      { crawlId },
    );
  }
  return parsed;
}

export interface CrawlDatesUpdate {
  content: string;
  outcome: "updated" | "untouched";
  /** Why nothing was written, when outcome is "untouched". */
  reason?: string;
}

const untouched = (content: string, reason: string): CrawlDatesUpdate => ({ content, outcome: "untouched", reason });

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Fills exactly one reserved, still-pending line of CRAWL_DATES.md and
 * returns the new content; every other byte is preserved.
 *
 *  - `crawl-N`         -> the `- Crawl N executed at:` line, above the appendix
 *  - `crawl-interim-N` -> the `- Interim crawl N (...) executed at:` line, inside the appendix
 *  - anything else     -> nothing
 *
 * A line that is already filled is never overwritten, so a second run cannot
 * replace a recorded timestamp.
 */
export function applyCrawlDatesUpdate(
  content: string,
  crawlId: string,
  startedAt: string,
  finishedAt: string,
  taxonomyBlobSha: string,
): CrawlDatesUpdate {
  const parsed = parseCrawlId(crawlId);
  if (parsed.kind === "scratch") {
    return untouched(content, "scratch crawl ID: CRAWL_DATES.md has no line for it");
  }

  const appendixAt = content.indexOf(`\n${INTERIM_APPENDIX_HEADING}`);
  const head = appendixAt === -1 ? content : content.slice(0, appendixAt);
  const tail = appendixAt === -1 ? "" : content.slice(appendixAt);
  const stamp = `${startedAt} (finished ${finishedAt}; corpus/TAXONOMY.md blob ${taxonomyBlobSha})`;

  if (parsed.kind === "numbered") {
    const pattern = new RegExp(`^- Crawl ${parsed.n} executed at:(.*)$`, "m");
    const found = pattern.exec(head);
    if (!found) {
      return untouched(content, `CRAWL_DATES.md has no "Crawl ${parsed.n} executed at" line`);
    }
    if (!(found[1] ?? "").includes(PENDING_MARK)) {
      return untouched(content, `the "Crawl ${parsed.n} executed at" line is already filled`);
    }
    return { content: head.replace(pattern, `- Crawl ${parsed.n} executed at: ${stamp}`) + tail, outcome: "updated" };
  }

  const pattern = new RegExp(`^- Interim crawl ${parsed.n} \\(\`${escapeRegExp(crawlId)}\`\\) executed at:(.*)$`, "m");
  const found = pattern.exec(tail);
  if (!found) {
    return untouched(content, `CRAWL_DATES.md's interim section has no line for "${crawlId}"`);
  }
  if (!(found[1] ?? "").includes(PENDING_MARK)) {
    return untouched(content, `the interim line for "${crawlId}" is already filled`);
  }
  return {
    content: head + tail.replace(pattern, `- Interim crawl ${parsed.n} (\`${crawlId}\`) executed at: ${stamp}`),
    outcome: "updated",
  };
}
