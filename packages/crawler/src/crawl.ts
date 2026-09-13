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
  totalToolsCaptured: number;
  capabilityDistribution: Record<string, number>;
  lowConfidenceCount: number;
  taxonomyCommitSha: string;
}

interface CapabilityRow {
  serverId: string;
  toolName: string;
  capabilityClass: string;
  confidence: string;
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

async function getTaxonomyCommitSha(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD:corpus/TAXONOMY.md"]);
    return stdout.trim();
  } catch (e) {
    log.warn({ error: e instanceof Error ? e.message : String(e) }, "could not resolve corpus/TAXONOMY.md commit SHA");
    return "unknown";
  }
}

/**
 * Replaces exactly the one reserved "_(pending...)_" line for this crawl —
 * the rest of CRAWL_DATES.md is frozen prose from before crawl 1 and must
 * never be touched by anything but this targeted substitution.
 */
async function updateCrawlDatesFile(crawlId: string, startedAt: string, finishedAt: string, taxonomySha: string): Promise<void> {
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
  const replacement = `- Crawl ${crawlNumber} executed at: ${startedAt} (finished ${finishedAt}; corpus/TAXONOMY.md at commit ${taxonomySha})`;
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
  const taxonomyCommitSha = await getTaxonomyCommitSha();
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
    totalToolsCaptured,
    capabilityDistribution,
    lowConfidenceCount: needsReview.length,
    taxonomyCommitSha,
  };

  await writeFile(path.join("data", `${crawlId}-report.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join("data", `${crawlId}-needs-review.json`), `${JSON.stringify(needsReview, null, 2)}\n`, "utf8");
  await writeFile(path.join("data", `${crawlId}-capabilities.json`), `${JSON.stringify(capabilitiesOut, null, 2)}\n`, "utf8");
  await updateCrawlDatesFile(crawlId, startedAt, finishedAt, taxonomyCommitSha);

  return report;
}
