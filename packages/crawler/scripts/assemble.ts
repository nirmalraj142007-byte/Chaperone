import { assembleCorpus } from "../src/assemble.js";
import { loadCrawlerEnv } from "../src/env.js";

function row(cols: string[], widths: number[]): string {
  return cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
}

async function main(): Promise<void> {
  const env = loadCrawlerEnv();
  const report = await assembleCorpus();

  const widths = [10, 9, 20, 18, 10];
  console.log("");
  console.log(row(["source", "fetched", "unique-contributed", "total-after-dedup", "status"], widths));
  for (const s of report.sources) {
    console.log(
      row(
        [
          s.sourceId,
          String(s.fetched),
          String(s.uniqueContributed),
          String(report.totalAfterDedup),
          s.degraded ? `degraded${s.degradedReason ? `: ${s.degradedReason}` : ""}` : "ok",
        ],
        widths,
      ),
    );
  }
  console.log("");
  console.log(`total before dedup: ${report.totalBeforeDedup}`);
  console.log(`total after dedup:  ${report.totalAfterDedup}`);
  console.log(`with repoUrl:       ${report.withRepoUrl}`);
  console.log(`started:            ${report.startedAt}`);
  console.log(`finished:           ${report.finishedAt}`);

  if (report.totalAfterDedup < env.minTotal) {
    console.error("");
    console.error(
      `crawl:assemble FAILED — deduplicated total ${report.totalAfterDedup} is below the required floor of ` +
        `${env.minTotal}. The blueprint requires attempting ~300 servers to land the N=100 floor captured in ` +
        "both crawls; discovering this shortfall after crawl 1 (2026-09-15) is too late to fix.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log(`crawl:assemble: OK — wrote corpus/candidates.json (${report.totalAfterDedup} servers).`);
}

main().catch((e: unknown) => {
  console.error("crawl:assemble: failed —", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
