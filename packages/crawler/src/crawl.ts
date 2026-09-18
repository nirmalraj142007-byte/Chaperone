import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { childLogger } from "@chaperone/logger";
import { getCorpusServer, putCorpusServer, putToolSnapshot } from "@chaperone/ledger";
import { canonicalizeTool, classifyCapability, hashTool } from "@chaperone/policy";
import { CANDIDATES_PATH, type CandidateRecord } from "./assemble.js";
import { type BootCandidate, type BootResult, type BootStatus, bootAndList, ensureCrawlInfrastructure } from "./boot.js";

const execFileAsync = promisify(execFile);
const log = childLogger({ component: "crawler-crawl" });

const CONCURRENCY = 6;
/** The documented 30s start-phase budget; boot.ts always adds its own fixed 90s install-phase budget on top of this. */
const START_TIMEOUT_MS = 30_000;
const AUTOMATABLE_METHODS = new Set(["npx", "uvx", "pip"]);

/**
 * "Low confidence" and "read" are the same set by construction of
 * classifyCapability (every unmatched-verb verdict defaults to
 * `{class: "read", confidence: "low"}`), so the full population is in the
 * thousands — nobody reviews 4,381 tools. A fixed-size, seeded random
 * sample is a number a human can actually work through and still supports
 * a real inter-rater agreement statistic later, which a review queue that
 * scales with corpus size never would.
 */
export const NEEDS_REVIEW_SAMPLE_SIZE = 150;

export interface RunCrawlOptions {
  limit?: number;
}

export interface CrawlReport {
  crawlId: string;
  startedAt: string;
  finishedAt: string;
  candidatesConsidered: number;
  noInstallPath: number;
  attempted: number;
  booted: number;
  refusedNoCreds: number;
  failedInstall: number;
  failedStart: number;
  failedTimeout: number;
  bootSuccessRate: number;
  capturedServers: number;
  /**
   * Exactly the serverIds counted in `capturedServers` (BOOTED with >=1
   * tool) — crawl 2's drift comparison is a diff against this exact set, so
   * it needs to be an explicit list rather than something reconstructed
   * from tool-snapshot rows months later. A candidate absent here can never
   * enter the drift comparison, however its install path evolves before
   * crawl 2 — which is also why a full run attempts every candidate in
   * corpus/candidates.json, not just the ones with a resolved install path
   * today: the corpus is frozen at crawl 1, but "attempted and got
   * NO_INSTALL_PATH" still counts as being in that frozen set.
   */
  bootedServerIds: string[];
  totalToolsCaptured: number;
  capabilityDistribution: Record<string, number>;
  lowConfidenceCount: number;
  /** Content-addressed hash of corpus/TAXONOMY.md's exact bytes at HEAD — a git blob SHA, not a commit SHA. See getTaxonomyBlobSha. */
  taxonomyBlobSha: string;
}

interface CapabilityRow {
  serverId: string;
  toolName: string;
  capabilityClass: string;
  confidence: string;
}

export interface NeedsReviewSample {
  seed: number;
  /** How to recompute `seed` from scratch, so it never has to be trusted blindly. */
  seedDerivation: string;
  sampleSize: number;
  /** The full low-confidence population this was sampled from — always >= sampleSize. */
  totalLowConfidence: number;
  items: CapabilityRow[];
}

interface Counts {
  noInstallPath: number;
  booted: number;
  refusedNoCreds: number;
  failedInstall: number;
  failedStart: number;
  failedTimeout: number;
}

function tally(counts: Counts, status: BootStatus): void {
  switch (status) {
    case "NO_INSTALL_PATH":
      counts.noInstallPath++;
      return;
    case "BOOTED":
      counts.booted++;
      return;
    case "REFUSED_NO_CREDS":
      counts.refusedNoCreds++;
      return;
    case "FAILED_INSTALL":
      counts.failedInstall++;
      return;
    case "FAILED_START":
      counts.failedStart++;
      return;
    case "FAILED_TIMEOUT":
      counts.failedTimeout++;
  }
}

/**
 * Known-install-path candidates first, everything else after — stable
 * within each group. Exists so `--limit=N` on a small N still exercises
 * real container boots instead of mostly instant `NO_INSTALL_PATH` rows
 * (84% of the pre-Phase-5 corpus had no install path at all; see
 * friction-log.md and the Phase 5 plan for how that changed).
 */
export function sortForCrawl(records: CandidateRecord[]): CandidateRecord[] {
  const attemptable = records.filter((r) => r.installMethod !== null && AUTOMATABLE_METHODS.has(r.installMethod));
  const rest = records.filter((r) => !(r.installMethod !== null && AUTOMATABLE_METHODS.has(r.installMethod)));
  return [...attemptable, ...rest];
}

/** FNV-1a, 32-bit. Turns an arbitrary string (a crawlId) into a deterministic uint32 seed — same string in, same seed out, every time, on every machine. */
export function seedFromString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — a small, fast, seeded PRNG. Deterministic: the same seed always produces the same sequence of [0, 1) values, on every machine and every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded, reproducible sample of `size` items from `items`, without
 * replacement, order-preserved-then-shuffled (a partial Fisher-Yates driven
 * by `mulberry32(seed)`). The same `items` array and the same `seed` always
 * produce the exact same sample in the exact same order — that's the whole
 * point: a reviewer, or a future agreement-statistic script, can regenerate
 * it from the recorded seed rather than trusting a committed file blindly.
 */
export function seededSample<T>(items: readonly T[], size: number, seed: number): T[] {
  const pool = [...items];
  const rand = mulberry32(seed);
  const take = Math.min(size, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, take);
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

function rawArchivePath(crawlId: string, serverId: string): string {
  return path.join("data", "raw", crawlId, `${serverId}.json`);
}

async function readArchived(archivePath: string): Promise<BootResult | undefined> {
  try {
    const raw = await readFile(archivePath, "utf8");
    return JSON.parse(raw) as BootResult;
  } catch {
    return undefined;
  }
}

/**
 * `git rev-parse HEAD:<path>` resolves to the blob object for that path in
 * the HEAD tree — a hash of the file's exact bytes, not of any commit. That
 * is deliberately stronger evidence than a commit SHA (immune to an
 * unrelated commit that happens to also touch this file), but the name
 * must say so plainly: a field called "commit SHA" that is actually a blob
 * hash reads as a mistake to anyone who checks it against `git log`.
 */
async function getTaxonomyBlobSha(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD:corpus/TAXONOMY.md"]);
    return stdout.trim();
  } catch (e) {
    log.warn({ error: e instanceof Error ? e.message : String(e) }, "could not resolve corpus/TAXONOMY.md blob SHA");
    return "unknown";
  }
}

/**
 * Replaces exactly the one reserved "_(pending...)_" line for this crawl —
 * the rest of CRAWL_DATES.md is frozen prose from before crawl 1 and must
 * never be touched by anything but this targeted substitution.
 */
async function updateCrawlDatesFile(crawlId: string, startedAt: string, finishedAt: string, taxonomyBlobSha: string): Promise<void> {
  const match = /^crawl-(\d+)$/.exec(crawlId);
  if (!match) {
    log.warn({ crawlId }, "crawlId doesn't match 'crawl-N'; leaving CRAWL_DATES.md untouched");
    return;
  }
  const crawlNumber = match[1];
  const filePath = "CRAWL_DATES.md";
  const content = await readFile(filePath, "utf8");
  const pattern = new RegExp(`^- Crawl ${crawlNumber} executed at:.*$`, "m");
  if (!pattern.test(content)) {
    log.warn({ crawlId }, "CRAWL_DATES.md has no matching 'Crawl N executed at' line to update");
    return;
  }
  const replacement = `- Crawl ${crawlNumber} executed at: ${startedAt} (finished ${finishedAt}; corpus/TAXONOMY.md blob ${taxonomyBlobSha})`;
  await writeFile(filePath, content.replace(pattern, replacement), "utf8");
}

/**
 * Runs (or resumes) one crawl against `corpus/candidates.json`. Every
 * candidate's outcome — including `NO_INSTALL_PATH` and every failure mode —
 * is archived to `data/raw/{crawlId}/{serverId}.json` as the last step of
 * handling it; a candidate whose archive file already exists is skipped
 * without re-attempting the boot, which is the entire resumability
 * mechanism (crawl-scoped by construction, self-healing for DynamoDB state
 * even if a prior run died between writing the archive and writing to the
 * ledger — see the shared post-processing block below, which always runs
 * regardless of whether this candidate was just booted or read from disk).
 */
export async function runCrawl(crawlId: string, opts: RunCrawlOptions = {}): Promise<CrawlReport> {
  const startedAt = new Date().toISOString();
  await ensureCrawlInfrastructure();

  const raw = await readFile(CANDIDATES_PATH, "utf8");
  const allRecords = JSON.parse(raw) as CandidateRecord[];
  const ordered = sortForCrawl(allRecords);
  const targets = opts.limit !== undefined ? ordered.slice(0, opts.limit) : ordered;

  await mkdir(path.join("data", "raw", crawlId), { recursive: true });

  const counts: Counts = { noInstallPath: 0, booted: 0, refusedNoCreds: 0, failedInstall: 0, failedStart: 0, failedTimeout: 0 };
  let totalToolsCaptured = 0;
  let capturedServers = 0;
  const bootedServerIds: string[] = [];
  const capabilityDistribution: Record<string, number> = {};
  const capabilitiesOut: CapabilityRow[] = [];
  const needsReview: CapabilityRow[] = [];

  await mapWithConcurrency(targets, CONCURRENCY, async (record) => {
    const archivePath = rawArchivePath(crawlId, record.serverId);
    let result = await readArchived(archivePath);
    const resumed = result !== undefined;

    if (!result) {
      const candidate: BootCandidate = {
        serverId: record.serverId,
        repoOwner: record.repoOwner,
        repoName: record.repoName,
        installMethod: record.installMethod,
        installSpec: record.installSpec,
      };
      result = await bootAndList(candidate, { timeoutMs: START_TIMEOUT_MS, network: "allowlist" });
      await writeFile(archivePath, JSON.stringify(result, null, 2), "utf8");
    } else {
      log.info({ serverId: record.serverId }, "already recorded for this crawl — skipping boot attempt");
    }

    tally(counts, result.status);

    // Always runs, resumed or not — see the docstring above on why that matters for resume safety.
    //
    // Verified 2026-09-19 (see docs/AWS-BUILDER.md): this block is the ONLY
    // place in runCrawl that reads or writes the corpus-server table, and it
    // is best-effort — `if (existing)` means it silently no-ops, for every
    // candidate, whenever that table is empty (as it currently is: a
    // `docker compose down -v` during Phase 10 dropped the local volume, and
    // nothing since has refilled it — crawl runs only ever *update* an
    // existing corpus-server row here, never create one). This no-op does
    // NOT affect anything crawl 2's report depends on: `tally()` above
    // already recorded this candidate's boot status into the in-memory
    // `counts` used for `report.bootSuccessRate`/`booted`/etc.;
    // `bootedServerIds` and `putToolSnapshot` below read only `record` (from
    // corpus/candidates.json) and `result` (from this boot or its
    // data/raw/{crawlId}/{serverId}.json archive) — never `existing`. If the
    // corpus-server table is still empty on 2026-10-20, crawl 2 remains
    // fully valid; do NOT "fix" it by re-running `crawl:assemble` — that is
    // the one thing the corpus freeze forbids (CLAUDE.md: "The corpus was
    // frozen at crawl 1. Never re-assemble it.").
    const existing = await getCorpusServer(record.serverId);
    if (existing) {
      await putCorpusServer({
        ...existing,
        bootStatus: result.status,
        ...(result.stderrTail ? { bootFailureDetail: result.stderrTail.slice(0, 500) } : {}),
      });
    }

    if (result.status === "BOOTED" && result.tools.length > 0) {
      capturedServers++;
      bootedServerIds.push(record.serverId);
      for (const tool of result.tools) {
        totalToolsCaptured++;
        const verdict = classifyCapability(tool);
        capabilityDistribution[verdict.class] = (capabilityDistribution[verdict.class] ?? 0) + 1;
        await putToolSnapshot({
          serverId: record.serverId,
          crawlId,
          toolName: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
          canonicalJson: canonicalizeTool(tool),
          sha256: hashTool(tool),
          capabilityClass: verdict.class,
          capabilityConfidence: verdict.confidence,
          capabilityAssignedBy: "rules-v1",
          capturedAt: new Date().toISOString(),
          rawPayloadPath: archivePath,
        });
        const row: CapabilityRow = { serverId: record.serverId, toolName: tool.name, capabilityClass: verdict.class, confidence: verdict.confidence };
        capabilitiesOut.push(row);
        if (verdict.confidence === "low") {
          needsReview.push(row);
        }
      }
    }

    if (!resumed) {
      log.debug({ serverId: record.serverId, status: result.status, durationMs: result.durationMs }, "boot attempt complete");
    }
  });

  const finishedAt = new Date().toISOString();
  const taxonomyBlobSha = await getTaxonomyBlobSha();
  const attempted = targets.length - counts.noInstallPath;

  const report: CrawlReport = {
    crawlId,
    startedAt,
    finishedAt,
    candidatesConsidered: targets.length,
    noInstallPath: counts.noInstallPath,
    attempted,
    booted: counts.booted,
    refusedNoCreds: counts.refusedNoCreds,
    failedInstall: counts.failedInstall,
    failedStart: counts.failedStart,
    failedTimeout: counts.failedTimeout,
    bootSuccessRate: attempted > 0 ? (counts.booted / attempted) * 100 : 0,
    capturedServers,
    // Sorted for a deterministic, diffable report — mapWithConcurrency's
    // worker-pool scheduling makes the completion order nondeterministic
    // across runs, and that order carries no meaning here anyway.
    bootedServerIds: bootedServerIds.sort(),
    totalToolsCaptured,
    capabilityDistribution,
    lowConfidenceCount: needsReview.length,
    taxonomyBlobSha,
  };

  const reviewSeed = seedFromString(crawlId);
  const reviewSample: NeedsReviewSample = {
    seed: reviewSeed,
    seedDerivation: `seedFromString(${JSON.stringify(crawlId)})`,
    sampleSize: Math.min(NEEDS_REVIEW_SAMPLE_SIZE, needsReview.length),
    totalLowConfidence: needsReview.length,
    items: seededSample(needsReview, NEEDS_REVIEW_SAMPLE_SIZE, reviewSeed),
  };

  await writeFile(path.join("data", `${crawlId}-report.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join("data", `${crawlId}-needs-review.json`), `${JSON.stringify(reviewSample, null, 2)}\n`, "utf8");
  await writeFile(path.join("data", `${crawlId}-capabilities.json`), `${JSON.stringify(capabilitiesOut, null, 2)}\n`, "utf8");
  await updateCrawlDatesFile(crawlId, startedAt, finishedAt, taxonomyBlobSha);

  return report;
}
