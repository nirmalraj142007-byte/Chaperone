import { runCrawl } from "../src/crawl.js";

const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const GO_NO_GO_FLOOR = 120;

function parseArgs(argv: string[]): { crawlId: string; limit?: number } {
  let crawlId: string | undefined;
  let limit: number | undefined;

  for (const arg of argv) {
    const crawlIdMatch = /^--crawl-id=(.+)$/.exec(arg);
    if (crawlIdMatch) {
      crawlId = crawlIdMatch[1];
      continue;
    }
    const limitMatch = /^--limit=(\d+)$/.exec(arg);
    if (limitMatch) {
      limit = Number(limitMatch[1]);
    }
  }

  if (!crawlId) {
    throw new Error(
      "usage: pnpm crawl:run --crawl-id=<id> [--limit=N]\n" +
        "  ids: crawl-1, crawl-2 (refused before 2026-10-20), crawl-interim-1 (the 2026-10-02 interim crawl),\n" +
        "       or a scratch id such as crawl-dryrun-1, which writes nothing to CRAWL_DATES.md",
    );
  }
  return { crawlId, ...(limit !== undefined ? { limit } : {}) };
}

async function main(): Promise<void> {
  const { crawlId, limit } = parseArgs(process.argv.slice(2));

  console.log(`crawl:run — crawlId=${crawlId}${limit !== undefined ? ` limit=${limit}` : ""}`);
  const report = await runCrawl(crawlId, limit !== undefined ? { limit } : {});

  const row = (label: string, value: string): string => `  ${label}${value}`;

  console.log("");
  console.log("boot status distribution:");
  console.log(row("considered:     ", String(report.candidatesConsidered)));
  console.log(row("no-install-path:", String(report.noInstallPath)));
  console.log(row("attempted:      ", String(report.attempted)));
  console.log(row("booted:         ", String(report.booted)));
  console.log(row("refused-no-creds:", String(report.refusedNoCreds)));
  console.log(row("failed-install: ", String(report.failedInstall)));
  console.log(row("failed-start:   ", String(report.failedStart)));
  console.log(row("timed-out:      ", String(report.failedTimeout)));

  console.log("");
  // report.bootSuccessRate is booted/attempted — a SUCCESS rate. The
  // headline this project reports is the failure framing ("did not
  // start"), so the printed percentage must be 100 minus that, not the
  // success-rate number itself relabelled with failure language.
  const didNotStartRate = 100 - report.bootSuccessRate;
  console.log(
    `${didNotStartRate.toFixed(1)}% of public MCP servers with a discoverable install command did not ` +
      `start from their own documented setup instructions.`,
  );
  console.log(`(${report.booted} booted of ${report.attempted} attempted; ${report.noInstallPath} had no discoverable install path at all.)`);

  console.log("");
  console.log(`total tools captured: ${report.totalToolsCaptured}`);
  console.log(`servers with >=1 tool captured: ${report.capturedServers}`);
  console.log("capability distribution:");
  for (const [cls, count] of Object.entries(report.capabilityDistribution).sort()) {
    console.log(`  ${cls}: ${count}`);
  }
  console.log(`low-confidence capability verdicts (needs human review): ${report.lowConfidenceCount}`);

  console.log("");
  console.log(`started:  ${report.startedAt}`);
  console.log(`finished: ${report.finishedAt}`);
  console.log(`corpus/TAXONOMY.md blob sha: ${report.taxonomyBlobSha}`);

  console.log("");
  if (report.capturedServers < GO_NO_GO_FLOOR) {
    console.log(
      `${RED}${BOLD}GO/NO-GO: ${report.capturedServers} servers-with->=1-tool-captured is below the floor of ` +
        `${GO_NO_GO_FLOOR}. The corpus must be widened TODAY — it cannot be extended after crawl 1 runs.${RESET}`,
    );
    process.exitCode = 2;
    return;
  }
  console.log(`GO: ${report.capturedServers} servers-with->=1-tool-captured clears the floor of ${GO_NO_GO_FLOOR}.`);
}

main().catch((e: unknown) => {
  console.error("crawl:run: failed —", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
