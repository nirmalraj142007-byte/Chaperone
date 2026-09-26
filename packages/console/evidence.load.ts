/**
 * Build-time evidence loader. Runs in Node (from vite.config.ts and from
 * test/evidence.test.ts), never in the browser.
 *
 * Risk R5: /corpus and /bench must render with no network and no database.
 * The numbers on those two screens are committed files, read once at build
 * time and inlined into the bundle as `virtual:chaperone-evidence`. The
 * demo can therefore render them with the laptop in airplane mode, and a
 * judge can diff what is on screen against what is in git.
 *
 * Every file here is optional. `data/drift.json` is absent until the
 * analysis runs, `benchmarks/latency.json` until `pnpm bench` does. A
 * missing file becomes `null` and the screen renders its designed empty or
 * partial state — it is never an error and never a zero.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export type CapabilityClass = "read" | "write" | "transact" | "communicate";

/** data/crawl-1-report.json — the fields the console reads. The crawler writes more. */
export interface CrawlReport {
  crawlId: string;
  startedAt: string;
  finishedAt: string;
  candidatesConsidered: number;
  noInstallPath: number;
  attempted: number;
  booted: number;
  bootSuccessRate: number;
  capturedServers: number;
  totalToolsCaptured: number;
  capabilityDistribution: Record<string, number>;
  /**
   * Tools whose capability verdict the classifier was not confident about.
   * Equal to the `read` count by construction — every unmatched-verb verdict
   * defaults to `{class: "read", confidence: "low"}` (packages/crawler/src/crawl.ts).
   * The console prints that caveat rather than letting the `read` bar imply
   * a confidence the classifier never claimed.
   */
  lowConfidenceCount: number;
  taxonomyBlobSha: string;
}

/** data/boot-rate.json — `findingSentence` is displayed verbatim, never recomputed here. */
export interface BootRate {
  crawlId: string;
  candidatesConsidered: number;
  noInstallPath: number;
  attempted: number;
  booted: number;
  bootSuccessRate: number;
  didNotStartRate: number;
  findingSentence: string;
}

export interface DriftPrediction {
  source: string;
  registeredOn: string;
  metric: string;
  lowPct: number;
  highPct: number;
}

export interface DriftStratum {
  capabilityClass: CapabilityClass;
  servers: number;
  drifted: number;
  /** null when the run was below the n >= 100 floor: drift.json then carries counts only. */
  ratePct: number | null;
}

/** data/drift.json. `status` is the authority on which /corpus state renders — never the presence of the file. */
export interface Drift {
  status: "pending" | "complete";
  interval: number | null;
  n: number | null;
  crawl1StartedAt: string | null;
  crawl2StartedAt: string | null;
  /** Target dates, copied from CRAWL_DATES.md so the console reads JSON instead of parsing markdown. */
  crawl1ScheduledFor: string;
  crawl2ScheduledFor: string;
  taxonomyBlobSha: string | null;
  prediction: DriftPrediction;
  semanticIntent: { servers: number; drifted: number; ratePct: number | null } | null;
  /** false below the n >= 100 floor (corpus/DRIFT-JSON-APPENDIX-report-shape.md). Absent from the pending file. */
  headlineEligible?: boolean | null;
  byCapability: DriftStratum[] | null;
  countedSeparately: Record<string, number | null | string>;
}

/** benchmarks/latency.json — written by the bench harness, which has not been built yet. */
export interface Latency {
  recordedAt: string;
  commitSha: string;
  samples: number;
  addedP50Ms: number;
  addedP95Ms: number;
  addedP99Ms: number;
  budgetP95Ms: number;
}

export interface Evidence {
  crawl1: CrawlReport | null;
  crawl2: CrawlReport | null;
  bootRate: BootRate | null;
  drift: Drift | null;
  latency: Latency | null;
  /** Full HEAD sha at build time, for /bench's stale-data check. null outside a git checkout. */
  headSha: string | null;
  builtAt: string;
}

function readJson<T>(repoRoot: string, rel: string): T | null {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8")) as T;
  } catch {
    // ENOENT is the normal case for drift.json before the analysis and
    // latency.json before the bench harness. A malformed file lands here
    // too and is treated the same way: the screen shows its empty state
    // rather than half-rendering a value nobody can vouch for.
    return null;
  }
}

function headSha(repoRoot: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function loadEvidence(repoRoot: string): Evidence {
  return {
    crawl1: readJson<CrawlReport>(repoRoot, "data/crawl-1-report.json"),
    crawl2: readJson<CrawlReport>(repoRoot, "data/crawl-2-report.json"),
    bootRate: readJson<BootRate>(repoRoot, "data/boot-rate.json"),
    drift: readJson<Drift>(repoRoot, "data/drift.json"),
    latency: readJson<Latency>(repoRoot, "benchmarks/latency.json"),
    headSha: headSha(repoRoot),
    builtAt: new Date().toISOString(),
  };
}
