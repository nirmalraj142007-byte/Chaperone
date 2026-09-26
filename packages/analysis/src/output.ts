/**
 * Where analysis output may go. `data/drift.json` is the project's headline
 * file, so it is written by exactly one comparison, crawl-1 against crawl-2,
 * and never by a dry run, a rehearsal against the interim crawl, or a test
 * fixture (corpus/DRIFT-JSON-APPENDIX-report-shape.md, "Where the file may be written").
 */
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnalysisError } from "@chaperone/errors";
import { CRAWL_1_ID, CRAWL_2_ID, type DriftReport } from "./analyse.js";

export interface Comparison {
  earlier: string;
  later: string;
  dryRun: boolean;
}

export function isHeadlineComparison(c: Comparison): boolean {
  return !c.dryRun && c.earlier === CRAWL_1_ID && c.later === CRAWL_2_ID;
}

export function headlineDriftPath(repoRoot: string): string {
  return path.resolve(repoRoot, "data", "drift.json");
}

/** Throws unless `outPath` may receive this comparison's report. */
export function assertDriftOutputAllowed(outPath: string, repoRoot: string, comparison: Comparison): void {
  const target = path.resolve(outPath);
  if (target.toLowerCase() === headlineDriftPath(repoRoot).toLowerCase() && !isHeadlineComparison(comparison)) {
    throw new AnalysisError(
      `refusing to write ${comparison.earlier} vs ${comparison.later}${comparison.dryRun ? " (dry run)" : ""} to data/drift.json: ` +
        "that file holds only the crawl-1 vs crawl-2 headline",
      { outPath: target },
    );
  }
}

/** Write to a sibling temp file, then rename over the target, so an interrupted write never leaves half a file. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export async function writeDriftReport(outPath: string, repoRoot: string, comparison: Comparison, report: DriftReport): Promise<void> {
  assertDriftOutputAllowed(outPath, repoRoot, comparison);
  if (report.n !== report.capturedBothCrawls.count) {
    throw new AnalysisError(`n (${report.n}) does not equal capturedBothCrawls.count (${report.capturedBothCrawls.count})`, {});
  }
  await writeJsonAtomic(outPath, report);
}
