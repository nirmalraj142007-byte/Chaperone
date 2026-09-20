/**
 * Derives data/boot-rate.json from an existing crawl report.
 *
 * The derivation itself lives in `@chaperone/bench`'s `deriveBootRate` —
 * not here — because two files publish this finding: this one, next to the
 * crawl evidence, and `benchmarks/boot-rate.json`, written by `pnpm bench`
 * next to the other reproducible number. Two independent implementations
 * of one published percentage is the same failure mode as the crawler and
 * the gateway hashing tools differently, so there is one function and this
 * script is a thin writer over it.
 *
 * Never hand-edit data/boot-rate.json; regenerate it from the crawl report
 * this way instead, so it can never drift from the report it came from.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveBootRate } from "@chaperone/bench";
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

  const bootRate = deriveBootRate(report, reportPath.split(path.sep).join("/"));

  await writeFile(path.join("data", "boot-rate.json"), `${JSON.stringify(bootRate, null, 2)}\n`, "utf8");
  console.log(`wrote data/boot-rate.json from ${reportPath}`);
  console.log(bootRate.findingSentence);
}

main().catch((e: unknown) => {
  console.error("boot-rate: failed —", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
