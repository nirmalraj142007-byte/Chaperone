/**
 * `pnpm eval:report` — regenerates data/baselines.json from the committed
 * corpus and baseline 1. Also the only writer of data/baselines.json other
 * than `pnpm eval:baseline2` (packages/eval/scripts/run-baseline2.ts) —
 * never hand-edit the file directly, the same way
 * packages/crawler/scripts/boot-rate.ts is the only writer of
 * data/boot-rate.json. If a real baseline-2 result is already on disk (a
 * `baseline2FrontierModelUnaided` with no `pending` field — i.e. a prior
 * `pnpm eval:baseline2` run), this script preserves it rather than
 * clobbering it back to "pending": it only ever regenerates baseline 1 and
 * the corpus stats, since baseline 2 needs a real, billed model call this
 * script never makes.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAttackCorpus } from "../src/corpus.js";
import { buildBaselineReport, type RealBaseline2 } from "../src/report.js";

async function loadExistingRealBaseline2(outPath: string): Promise<RealBaseline2 | undefined> {
  try {
    const raw = await readFile(outPath, "utf8");
    const existing = JSON.parse(raw) as { baseline2FrontierModelUnaided?: unknown };
    const section = existing.baseline2FrontierModelUnaided;
    if (section && typeof section === "object" && !("pending" in section)) {
      return section as RealBaseline2;
    }
  } catch {
    // No existing file, or it doesn't parse — proceed with the pending placeholder, same as always.
  }
  return undefined;
}

async function main(): Promise<void> {
  const corpus = loadAttackCorpus();
  const outPath = path.join("data", "baselines.json");
  const existingRealBaseline2 = await loadExistingRealBaseline2(outPath);
  const report = buildBaselineReport(corpus, undefined, existingRealBaseline2);

  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`wrote ${outPath}`);
  console.log(
    `corpus: ${report.corpus.attackItems} attack items across ${report.corpus.injectionPatterns.length} patterns, ` +
      `${report.corpus.benignControls} standalone benign controls`,
  );
  console.log(
    `baseline 1 (regex blocklist): detection ${(report.baseline1RegexBlocklist.detectionRate * 100).toFixed(1)}%, ` +
      `false positives ${(report.baseline1RegexBlocklist.falsePositiveRate * 100).toFixed(1)}%`,
  );
  const baseline2 = report.baseline2FrontierModelUnaided;
  console.log(
    `baseline 2 (frontier model, unaided): ${"pending" in baseline2 ? baseline2.pending : `real result from ${baseline2.model} — run pnpm eval:baseline2 to refresh`}`,
  );
  console.log(report.disclosure);
}

main().catch((e: unknown) => {
  console.error("eval:report failed —", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
