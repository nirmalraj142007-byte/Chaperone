// `pushed_at` is time-sensitive in a way the registry/smithery/awesome
// listing cache isn't (a repo's activity keeps changing after we look at
// it), so this check gets its own cache directory, isolated from the main
// crawl:assemble cache and easy to blow away on its own before a future
// re-run (e.g. ahead of crawl 2, 2026-10-20) without disturbing the frozen
// candidate list itself. Set before any other module reads crawler env.
process.env.CRAWLER_HTTP_CACHE_DIR ??= "packages/crawler/.cache/http-github-activity";
process.env.CRAWLER_RAW_ARCHIVE_DIR ??= "packages/crawler/.cache/raw-github-activity";

import fs from "node:fs";
import { loadCrawlerEnv } from "../src/env.js";
import { fetchRepoActivity, type RepoActivityStatus } from "../src/githubActivity.js";

interface CandidateRecord {
  serverId: string;
  displayName: string;
  sources: string[];
  repoOwner: string | null;
  repoName: string | null;
}

interface SourceTally {
  active: number;
  dormant: number;
  notFound: number;
  error: number;
}

function emptyTally(): SourceTally {
  return { active: 0, dormant: 0, notFound: 0, error: 0 };
}

function bump(tally: SourceTally, status: RepoActivityStatus): void {
  if (status === "active") tally.active++;
  else if (status === "dormant") tally.dormant++;
  else if (status === "not_found") tally.notFound++;
  else tally.error++;
}

const CONSECUTIVE_ERROR_ABORT_THRESHOLD = 5;

async function main(): Promise<void> {
  const env = loadCrawlerEnv();
  const data = JSON.parse(fs.readFileSync("corpus/candidates.json", "utf8")) as CandidateRecord[];
  const withRepo = data.filter(
    (d): d is CandidateRecord & { repoOwner: string; repoName: string } =>
      d.repoOwner !== null && d.repoName !== null,
  );

  console.log(`repo-identified candidates: ${withRepo.length}`);
  console.log(
    env.githubToken
      ? "GITHUB_TOKEN: configured (5000 req/hour budget)"
      : "GITHUB_TOKEN: not set (60 req/hour unauthenticated budget — this will likely stop early)",
  );
  console.log("");

  const overall = emptyTally();
  const bySource = new Map<string, SourceTally>();
  let consecutiveErrors = 0;
  let processed = 0;
  let abortedEarly = false;

  for (const c of withRepo) {
    const source = c.sources[0] ?? "unknown";
    if (!bySource.has(source)) {
      bySource.set(source, emptyTally());
    }

    const result = await fetchRepoActivity({ owner: c.repoOwner, name: c.repoName }, env.githubToken);
    processed++;
    bump(overall, result.status);
    bump(bySource.get(source)!, result.status);

    if (result.status === "error") {
      consecutiveErrors++;
      console.error(`  error: ${c.repoOwner}/${c.repoName}: ${result.detail}`);
      if (consecutiveErrors >= CONSECUTIVE_ERROR_ABORT_THRESHOLD) {
        console.error(
          `\n${CONSECUTIVE_ERROR_ABORT_THRESHOLD} consecutive errors — stopping early ` +
            "(likely rate-limited or an invalid token). Reporting partial results below.",
        );
        abortedEarly = true;
        break;
      }
    } else {
      consecutiveErrors = 0;
    }

    if (processed % 100 === 0) {
      console.log(`  ...${processed}/${withRepo.length}`);
    }
  }

  const resolvedTotal = overall.active + overall.dormant;
  console.log("");
  console.log(`processed: ${processed}/${withRepo.length}${abortedEarly ? " (aborted early)" : ""}`);
  console.log(`active (<=90 days):  ${overall.active}`);
  console.log(`dormant (>90 days):  ${overall.dormant}`);
  console.log(`not found (404):     ${overall.notFound}`);
  console.log(`error:               ${overall.error}`);
  if (resolvedTotal > 0) {
    console.log(`active rate among resolved: ${((overall.active / resolvedTotal) * 100).toFixed(1)}%`);
  }

  console.log("");
  console.log("by source:");
  for (const [source, tally] of bySource) {
    const resolved = tally.active + tally.dormant;
    const rate = resolved > 0 ? `${((tally.active / resolved) * 100).toFixed(1)}%` : "n/a";
    console.log(
      `  ${source.padEnd(10)} active=${String(tally.active).padStart(4)} dormant=${String(tally.dormant).padStart(4)} ` +
        `notFound=${String(tally.notFound).padStart(3)} error=${String(tally.error).padStart(3)}  active-rate=${rate}`,
    );
  }

  if (abortedEarly) {
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error("commit-recency: failed —", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
