/**
 * `pnpm eval:baseline2` — baseline 2: the full attack corpus (30 items) plus
 * all 10 benign controls, 3 runs per item, against `BASELINE_MODEL_ID` (default
 * openai/gpt-oss-120b, served by Groq; `MODEL_PROVIDER=bedrock` switches back).
 *
 * Two modes, because a model call is the expensive part and classification is
 * not:
 *   --capture   call the model for every prompt that has no stored response
 *               yet, writing each response to data/baseline2-single-turn-raw.json the
 *               moment it arrives. Also resumes a run that died part-way.
 *   (default)   replay data/baseline2-single-turn-raw.json. Zero model calls. Reclassifies
 *               and rebuilds the report, so the classifier can be revisited
 *               against the real responses and anyone can re-derive the number.
 *
 * Writes:
 *   - data/baseline2-single-turn-raw.json — the model's responses, verbatim.
 *   - data/baseline2-single-turn-adjudication.json — every `ambiguous` verdict with its raw
 *     text, for a human. This script never decides one. A decision already
 *     recorded in that file survives a re-run; an undecided entry is rebuilt
 *     from the current classifier, so a better classifier shrinks the list
 *     rather than leaving stale entries behind.
 *   - data/baseline2-single-turn-report.json — the measured single-turn numbers, marked superseded.
 *
 * Total model calls with --capture: (30 attacks + 10 controls) * 3 runs = 120,
 * plus any Groq retries after a 429 (counted and printed as "http attempts").
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "@chaperone/config";
import { createModelProvider, GroqModelProvider, resolveModelId, type ModelProvider } from "@chaperone/advisory";
import { buildBaseline2Prompt, runBaseline2Corpus, type Baseline2RawResponseListener } from "../src/baseline-model.js";
import { buildBaseline2ControlPrompt, runBaseline2ControlCorpus } from "../src/baseline2Controls.js";
import { classifyBaseline2ControlResponse, judgeBaseline2Response } from "../src/baseline2Classify.js";
import {
  BASELINE2_SINGLE_TURN_RAW_FILE,
  CachedModelProvider,
  loadRawFile,
  promptSha,
  saveRawFile,
  type Baseline2RawFile,
} from "../src/baseline2Cache.js";
import { loadAttackCorpus } from "../src/corpus.js";
import { buildBaselineReport, summarizeBaseline2ForReport } from "../src/report.js";

const ADJUDICATION_PATH = path.join("data", "baseline2-single-turn-adjudication.json");
/** The single-turn section of the report, written on its own; the combined data/baselines.json is built by the two-turn script. */
const SECTION_PATH = path.join("data", "baseline2-single-turn-report.json");

/**
 * Sampling temperature for the baseline. Baseline 2 asks what an unaided model
 * does, and a deployed assistant samples. Groq's default for this model is 1;
 * at 0 the three runs per item would be near-copies and "spread across runs"
 * would measure nothing. Overridable with BASELINE_TEMPERATURE.
 */
const DEFAULT_BASELINE_TEMPERATURE = 1;

interface AdjudicationEntry {
  itemId: string;
  kind: "attack" | "control";
  runIndex: number;
  verdict: "ambiguous";
  rawResponseText: string;
  modelId: string;
  capturedAt: string;
  /** Why the classifier could not place it, so the reviewer knows what to look at. */
  classifierNote?: string;
  humanDecision: unknown;
}

interface AdjudicationFile {
  schemaVersion: number;
  description: string;
  adjudications: AdjudicationEntry[];
}

async function loadAdjudicationFile(): Promise<AdjudicationFile> {
  return JSON.parse(await readFile(ADJUDICATION_PATH, "utf8")) as AdjudicationFile;
}

function adjudicationKey(e: { itemId: string; kind: string; runIndex: number }): string {
  return `${e.kind}:${e.itemId}:${e.runIndex}`;
}

async function main(): Promise<void> {
  const capture = process.argv.includes("--capture");
  const config = loadConfig();
  const modelId = resolveModelId(config.modelProvider, config.baselineModelId, "BASELINE_MODEL_ID");
  const temperature = Number(process.env["BASELINE_TEMPERATURE"] ?? DEFAULT_BASELINE_TEMPERATURE);

  const corpus = loadAttackCorpus();
  const promptIndex = new Map<string, { itemId: string; kind: "attack" | "control" }>();
  for (const item of corpus.attacks) {
    promptIndex.set(promptSha(buildBaseline2Prompt(item)), { itemId: item.id, kind: "attack" });
  }
  for (const item of corpus.controls) {
    promptIndex.set(promptSha(buildBaseline2ControlPrompt(item)), { itemId: item.id, kind: "control" });
  }

  const existing = loadRawFile(BASELINE2_SINGLE_TURN_RAW_FILE);
  if (existing && existing.modelId !== modelId) {
    throw new Error(
      `${BASELINE2_SINGLE_TURN_RAW_FILE} holds responses from ${existing.modelId}, not ${modelId}. Move it aside to start a new capture.`,
    );
  }
  if (!existing && !capture) {
    throw new Error(`${BASELINE2_SINGLE_TURN_RAW_FILE} does not exist yet. Run with --capture to call the model.`);
  }
  const file: Baseline2RawFile = existing ?? {
    schemaVersion: 1,
    description:
      "Verbatim model responses for baseline 2 (data/baselines.json), one per (item, run). Re-classifiable with `pnpm eval:baseline2:single-turn` with no model calls.",
    provider: config.modelProvider,
    modelId,
    temperature,
    entries: [],
  };

  let inner: ModelProvider | undefined;
  if (capture) {
    inner = createModelProvider({
      kind: config.modelProvider,
      modelId,
      groqApiKey: config.groqApiKey,
      awsRegion: config.awsRegion,
      groq: { temperature },
    });
  }
  const provider = new CachedModelProvider({
    ...(inner ? { inner } : {}),
    file,
    promptIndex,
    onNewEntry: (f) => {
      saveRawFile(BASELINE2_SINGLE_TURN_RAW_FILE, f);
      process.stdout.write(`\r${f.entries.length}/${(corpus.attacks.length + corpus.controls.length) * 3} responses stored`);
    },
  });

  const capturedAt = new Date().toISOString();
  const found: AdjudicationEntry[] = [];
  const attackById = new Map(corpus.attacks.map((a) => [a.id, a] as const));
  const captureAmbiguous =
    (kind: "attack" | "control"): Baseline2RawResponseListener =>
    (info) => {
      if (info.verdict !== "ambiguous") {
        return;
      }
      const stored = file.entries.find((e) => e.itemId === info.itemId && e.kind === kind && e.runIndex === info.runIndex);
      found.push({
        itemId: info.itemId,
        kind,
        runIndex: info.runIndex,
        verdict: "ambiguous",
        rawResponseText: info.text,
        modelId,
        capturedAt: stored?.capturedAt ?? capturedAt,
        classifierNote:
          kind === "attack"
            ? judgeBaseline2Response(attackById.get(info.itemId)!, info.text).note
            : "empty response from a benign control",
        humanDecision: null,
      });
    };

  console.log(
    `run-baseline2 — mode=${capture ? "capture" : "replay"} provider=${config.modelProvider} model=${modelId} temperature=${file.temperature} ` +
      `attacks=${corpus.attacks.length} controls=${corpus.controls.length}`,
  );

  const attackSummaries = await runBaseline2Corpus(
    provider,
    corpus.attacks,
    (item, text) => judgeBaseline2Response(item, text).verdict,
    undefined,
    captureAmbiguous("attack"),
  );
  const controlSummaries = await runBaseline2ControlCorpus(
    provider,
    corpus.controls,
    classifyBaseline2ControlResponse,
    undefined,
    captureAmbiguous("control"),
  );
  console.log(`\nattack items scored: ${attackSummaries.length}; control items scored: ${controlSummaries.length}`);
  console.log(`model calls this run: ${provider.liveCalls} live, ${provider.cacheHits} replayed from ${BASELINE2_SINGLE_TURN_RAW_FILE}`);
  if (inner instanceof GroqModelProvider) {
    console.log(
      `groq http attempts: ${inner.httpAttempts} (429 responses: ${inner.rateLimited}, time spent waiting out limits: ${(inner.waitedMs / 1000).toFixed(0)}s)`,
    );
  }

  const adjudicationFile = await loadAdjudicationFile();
  const decided = new Map(
    adjudicationFile.adjudications.filter((a) => a.humanDecision !== null).map((a) => [adjudicationKey(a), a] as const),
  );
  adjudicationFile.adjudications = found.map((entry) => decided.get(adjudicationKey(entry)) ?? entry);
  await writeFile(ADJUDICATION_PATH, `${JSON.stringify(adjudicationFile, null, 2)}\n`, "utf8");
  console.log(`wrote ${ADJUDICATION_PATH} — ${found.length} ambiguous run(s) for human review`);

  const realBaseline2 = summarizeBaseline2ForReport(attackSummaries, controlSummaries, modelId, {
    provider: config.modelProvider,
    temperature: file.temperature,
  });
  const report = buildBaselineReport(corpus, () => new Date(), realBaseline2);
  await writeFile(SECTION_PATH, `${JSON.stringify({ superseded: true, ...realBaseline2 }, null, 2)}\n`, "utf8");
  console.log(`wrote ${SECTION_PATH}`);

  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  console.log(
    `baseline 2 (${modelId}, ${config.modelProvider}): refused ${pct(realBaseline2.detectionRate)} of attack runs ` +
      `(per-run: ${realBaseline2.perRunRefusalRate.map(pct).join(", ")}); of ${realBaseline2.attackRuns} attack runs: ` +
      `${realBaseline2.followedRuns} followed, ${realBaseline2.ambiguousRuns} ambiguous (awaiting adjudication), ` +
      `${realBaseline2.notExercisedRuns} not exercised; ` +
      `refused ${pct(realBaseline2.falsePositiveRate)} of benign-control runs, delta ${(report.delta! * 100).toFixed(1)} points`,
  );
}

main().catch((e: unknown) => {
  console.error("\nrun-baseline2 failed —", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
