/**
 * Derives data/boot-rate.json from an existing crawl report — the shape
 * Phase 16's bench package will read this project's single most
 * externally-verifiable ecosystem finding from. Never hand-edit
 * data/boot-rate.json; regenerate it from the crawl report this way
 * instead, so it can never drift from the report it's derived from.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CrawlReport } from "../src/crawl.js";

function parseArgs(argv: string[]): { crawlId: string } {
  let crawlId: string | undefined;
  for (const arg of argv) {
    const match = /^--crawl-id=(.+)$/.exec(arg);
    if (match) {
      crawlId = match[1];
    }
  }
  if (!crawlId) {
    throw new Error("usage: pnpm crawl:boot-rate --crawl-id=crawl-1");
  }
  return { crawlId };
}

async function main(): Promise<void> {
  const { crawlId } = parseArgs(process.argv.slice(2));
  const reportPath = path.join("data", `${crawlId}-report.json`);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as CrawlReport;

  // report.bootSuccessRate is booted/attempted — a SUCCESS rate. This
  // project's headline is the failure framing ("did not start"), so the
  // reported percentage is 100 minus that, never the success-rate number
  // relabelled with failure language (see friction-log.md for the entry
  // recording exactly this bug, caught before it shipped further).
  const didNotStartRate = 100 - report.bootSuccessRate;
  const findingSentence =
    `${didNotStartRate.toFixed(1)}% of public MCP servers with a discoverable install command did not start ` +
    `from their own documented setup instructions (${report.booted} booted of ${report.attempted} attempted; ` +
    `${report.noInstallPath} had no discoverable install path at all).`;

  const bootRate = {
    source: reportPath.split(path.sep).join("/"),
    crawlId,
    candidatesConsidered: report.candidatesConsidered,
    noInstallPath: report.noInstallPath,
    attempted: report.attempted,
    booted: report.booted,
    refusedNoCreds: report.refusedNoCreds,
    failedInstall: report.failedInstall,
    failedStart: report.failedStart,
    failedTimeout: report.failedTimeout,
    bootSuccessRate: report.bootSuccessRate,
    didNotStartRate,
    findingSentence,
  };

  await writeFile(path.join("data", "boot-rate.json"), `${JSON.stringify(bootRate, null, 2)}\n`, "utf8");
  console.log(`wrote data/boot-rate.json from ${reportPath}`);
  console.log(findingSentence);
}

main().catch((e: unknown) => {
  console.error("boot-rate: failed —", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
