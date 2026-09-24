/**
 * `pnpm --filter @chaperone/eval exec tsx scripts/run-baseline2.ts` — the
 * real baseline-2 run: the full attack corpus (30 items) plus all 10 benign
 * controls, 3 runs per item, against `BASELINE_MODEL_ID` via Bedrock's
 * Converse API (no model is chosen yet — see docs/LIMITATIONS.md, "The model
 * provider is not decided"). Requires `BASELINE_MODEL_ID` and `AWS_REGION` to be
 * set (see .env.example) and a Bedrock-reachable AWS credential in the
 * environment already — this script never constructs or prints one.
 *
 * Writes two files, and only these two:
 *   - data/baseline2-adjudication.json — every `ambiguous` verdict from
 *     either half of the run, with its full raw response text, for human
 *     review. This script never decides an ambiguous case itself; it only
 *     ever appends new entries with `humanDecision: null`. Existing
 *     entries (any prior human decisions) are preserved.
 *   - data/baselines.json — regenerated via buildBaselineReport with the
 *     real baseline2 numbers this run measured, replacing the
 *     null/"pending" placeholders. Overwrites the file `pnpm eval:report`
 *     also writes; this script is the one to run last.
 *
 * Total model calls this makes: (30 attack items + 10 control items) * 3
 * runs = 120 Converse calls to BASELINE_MODEL_ID, plus whatever
 * `withRetry` adds on a throttle/timeout (retried calls only, not a
 * multiplier on every call).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "@chaperone/config";
import { BedrockModelProvider } from "@chaperone/advisory";
import { runBaseline2Corpus, type Baseline2RawResponseListener } from "../src/baseline-model.js";
import { runBaseline2ControlCorpus } from "../src/baseline2Controls.js";
import { classifyBaseline2Response, classifyBaseline2ControlResponse } from "../src/baseline2Classify.js";
import { loadAttackCorpus } from "../src/corpus.js";
import { buildBaselineReport, summarizeBaseline2ForReport } from "../src/report.js";

const ADJUDICATION_PATH = path.join("data", "baseline2-adjudication.json");
const BASELINES_PATH = path.join("data", "baselines.json");

interface AdjudicationEntry {
  itemId: string;
  kind: "attack" | "control";
  runIndex: number;
  verdict: "ambiguous";
  rawResponseText: string;
  modelId: string;
  capturedAt: string;
  humanDecision: null;
}

interface AdjudicationFile {
  schemaVersion: number;
  description: string;
  adjudications: AdjudicationEntry[];
}

async function loadAdjudicationFile(): Promise<AdjudicationFile> {
  const raw = await readFile(ADJUDICATION_PATH, "utf8");
  return JSON.parse(raw) as AdjudicationFile;
}

async function main(): Promise<void> {
  const { awsRegion, baselineModelId } = loadConfig();
  if (!baselineModelId) {
    throw new Error("BASELINE_MODEL_ID must be set to run baseline 2 for real — see .env.example.");
  }

  const provider = new BedrockModelProvider({ modelId: baselineModelId, region: awsRegion });
  const corpus = loadAttackCorpus();
  const capturedAt = new Date().toISOString();

  const newAdjudications: AdjudicationEntry[] = [];
  const captureAmbiguous =
    (kind: "attack" | "control"): Baseline2RawResponseListener =>
    (info) => {
      if (info.verdict !== "ambiguous") {
        return;
      }
      newAdjudications.push({
        itemId: info.itemId,
        kind,
        runIndex: info.runIndex,
        verdict: "ambiguous",
        rawResponseText: info.text,
        modelId: baselineModelId,
        capturedAt,
        humanDecision: null,
      });
    };

  console.log(
    `run-baseline2 — model=${baselineModelId} region=${awsRegion} attacks=${corpus.attacks.length} controls=${corpus.controls.length}`,
  );

  const attackSummaries = await runBaseline2Corpus(
    provider,
    corpus.attacks,
    classifyBaseline2Response,
    undefined,
    captureAmbiguous("attack"),
  );
  console.log(`attack corpus scored: ${attackSummaries.length} items`);

  const controlSummaries = await runBaseline2ControlCorpus(
    provider,
    corpus.controls,
    classifyBaseline2ControlResponse,
    undefined,
    captureAmbiguous("control"),
  );
  console.log(`benign controls scored: ${controlSummaries.length} items`);

  const adjudicationFile = await loadAdjudicationFile();
  adjudicationFile.adjudications.push(...newAdjudications);
  await writeFile(ADJUDICATION_PATH, `${JSON.stringify(adjudicationFile, null, 2)}\n`, "utf8");
  console.log(`wrote ${ADJUDICATION_PATH} — ${newAdjudications.length} new ambiguous case(s) for human review`);

  const realBaseline2 = summarizeBaseline2ForReport(attackSummaries, controlSummaries, baselineModelId);
  const report = buildBaselineReport(corpus, () => new Date(), realBaseline2);
  await writeFile(BASELINES_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`wrote ${BASELINES_PATH}`);

  console.log(
    `baseline 2 (${baselineModelId}) refusal rate: ${(realBaseline2.detectionRate * 100).toFixed(1)}% ` +
      `(per-run: ${realBaseline2.perRunRefusalRate.map((r) => `${(r * 100).toFixed(1)}%`).join(", ")}), ` +
      `false-positive rate on benign controls: ${(realBaseline2.falsePositiveRate * 100).toFixed(1)}%, ` +
      `delta vs Chaperone's structural 100% catch rate: ${(report.delta! * 100).toFixed(1)} points`,
  );
  if (newAdjudications.length > 0) {
    console.log(
      `${newAdjudications.length} ambiguous case(s) await human review in ${ADJUDICATION_PATH} before these numbers should be treated as final.`,
    );
  }
}

main().catch((e: unknown) => {
  console.error("run-baseline2 failed —", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
