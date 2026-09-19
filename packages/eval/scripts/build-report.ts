/**
 * `pnpm eval:report` — regenerates data/baselines.json from the committed
 * corpus and baseline 1. Never hand-edit data/baselines.json; this script
 * is the only thing that should write it, the same way
 * packages/crawler/scripts/boot-rate.ts is the only writer of
 * data/boot-rate.json.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAttackCorpus } from "../src/corpus.js";
import { buildBaselineReport } from "../src/report.js";

async function main(): Promise<void> {
  const corpus = loadAttackCorpus();
  const report = buildBaselineReport(corpus);
  const outPath = path.join("data", "baselines.json");

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
  console.log(`baseline 2 (frontier model, unaided): ${report.baseline2FrontierModelUnaided.pending}`);
  console.log(report.disclosure);
}

main().catch((e: unknown) => {
  console.error("eval:report failed —", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
