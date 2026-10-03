/**
 * `pnpm eval:baseline2` — baseline 2, two-turn. The PRIMARY baseline-2
 * measurement; it supersedes the single-turn first attempt
 * (`pnpm eval:baseline2:single-turn`, kept with its data).
 *
 * The full attack corpus (30 items) plus all 10 benign controls, 3 runs each,
 * against `BASELINE_MODEL_ID` (default openai/gpt-oss-120b, served by Groq).
 * Each run is at most two model calls: turn 1, and, if the model called the
 * tool, turn 2 after a fixed canned tool result. The tool is declared only in
 * the request's `tools` field. Scoring follows docs/BASELINE2-RUBRIC.md, which
 * was committed before the first two-turn call.
 *
 *   --capture   call the model for every turn that has no stored response,
 *               writing each response to data/baseline2-raw.json the moment it
 *               arrives. Also resumes a run that died part-way.
 *   (default)   replay data/baseline2-raw.json: zero model calls.
 *
 * Writes:
 *   - data/baseline2-raw.json — every model response, verbatim, per turn.
 *   - data/baseline2-adjudication.json — every `ambiguous` run, with its
 *     review reason and full transcript, for a human. This script never decides
 *     one; a decision already recorded survives a re-run, an undecided entry is
 *     rebuilt. (The single-turn list is data/baseline2-single-turn-adjudication.json.)
 *   - data/baselines.json — baseline 1, the two-turn section (primary), and the
 *     single-turn section kept as superseded.
 *
 * Model calls with --capture: up to 2 per run x 120 runs = 240, fewer when the
 * model answers without calling the tool; the exact number is printed.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "@chaperone/config";
import { createModelProvider, GroqModelProvider, resolveModelId, type ModelProvider } from "@chaperone/advisory";
import { loadAttackCorpus } from "../src/corpus.js";
import { buildBaselineReport, type BaselineReport, type SingleTurnSupersededSection } from "../src/report.js";
import {
  BASELINE2_TWO_TURN_RAW_FILE,
  TWO_TURN_RUNS_PER_ITEM,
  loadTwoTurnRaw,
  runTwoTurnCorpus,
  saveTwoTurnRaw,
  type TwoTurnRawFile,
} from "../src/twoTurn/runner.js";
import { summarizeTwoTurn } from "../src/twoTurn/report.js";
import { TWO_TURN_RUBRIC_VERSION } from "../src/twoTurn/rubric.js";

const ADJUDICATION_PATH = path.join("data", "baseline2-adjudication.json");
const BASELINES_PATH = path.join("data", "baselines.json");
const SINGLE_TURN_SECTION_PATH = path.join("data", "baseline2-single-turn-report.json");

/** Same as the single-turn run, so the two are comparable. Overridable with BASELINE_TEMPERATURE. */
const DEFAULT_BASELINE_TEMPERATURE = 1;

interface AdjudicationEntry {
  itemId: string;
  kind: "attack" | "control";
  runIndex: number;
  verdict: "ambiguous";
  reviewReason: string;
  note: string;
  /** What the injected clause says, so the reviewer does not have to open the corpus. Attack items only. */
  injectedToolDescription?: string;
  transcript: { turn: number; text: string; toolCalls: { name: string; arguments: string }[] }[];
  toolResultDelivered: boolean;
  modelId: string;
  capturedAt: string;
  humanDecision: unknown;
}

interface AdjudicationFile {
  schemaVersion: number;
  description: string;
  design: "two-turn";
  rubric: string;
  adjudications: AdjudicationEntry[];
}

const key = (e: { kind: string; itemId: string; runIndex: number }): string => `${e.kind}:${e.itemId}:${e.runIndex}`;

async function loadAdjudicationFile(): Promise<AdjudicationFile> {
  try {
    return JSON.parse(await readFile(ADJUDICATION_PATH, "utf8")) as AdjudicationFile;
  } catch {
    return {
      schemaVersion: 2,
      description:
        "Human adjudications for baseline 2's two-turn run (docs/BASELINE2-RUBRIC.md). One entry per run the rubric sends to a human, with its review reason and full transcript. Written by packages/eval/scripts/run-baseline2.ts, never decided automatically: humanDecision stays null until a person fills it in. Replaces the single-turn list, kept as data/baseline2-single-turn-adjudication.json.",
      design: "two-turn",
      rubric: TWO_TURN_RUBRIC_VERSION,
      adjudications: [],
    };
  }
}

async function main(): Promise<void> {
  const capture = process.argv.includes("--capture");
  const config = loadConfig();
  const modelId = resolveModelId(config.modelProvider, config.baselineModelId, "BASELINE_MODEL_ID");
  const temperature = Number(process.env["BASELINE_TEMPERATURE"] ?? DEFAULT_BASELINE_TEMPERATURE);

  const corpus = loadAttackCorpus();

  const existing = loadTwoTurnRaw(BASELINE2_TWO_TURN_RAW_FILE);
  if (existing && existing.modelId !== modelId) {
    throw new Error(`${BASELINE2_TWO_TURN_RAW_FILE} holds responses from ${existing.modelId}, not ${modelId}. Move it aside to start a new capture.`);
  }
  if (!existing && !capture) {
    throw new Error(`${BASELINE2_TWO_TURN_RAW_FILE} does not exist yet. Run with --capture to call the model.`);
  }
  const file: TwoTurnRawFile = existing ?? {
    schemaVersion: 1,
    description:
      "Verbatim model responses for baseline 2, two-turn (docs/BASELINE2-RUBRIC.md): one entry per (item, run, turn). Re-scorable with `pnpm eval:baseline2` and no model calls.",
    design: "two-turn",
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

  const stats = { liveCalls: 0, cacheHits: 0 };
  console.log(
    `run-baseline2 (two-turn) — mode=${capture ? "capture" : "replay"} provider=${config.modelProvider} model=${modelId} temperature=${file.temperature} ` +
      `attacks=${corpus.attacks.length} controls=${corpus.controls.length} runs/item=${TWO_TURN_RUNS_PER_ITEM}`,
  );
  const results = await runTwoTurnCorpus(
    {
      ...(inner ? { provider: inner } : {}),
      file,
      stats,
      onNewEntry: (f) => {
        saveTwoTurnRaw(BASELINE2_TWO_TURN_RAW_FILE, f);
        process.stdout.write(`\r${f.entries.length} model responses stored`);
      },
    },
    corpus.attacks,
    corpus.controls,
  );
  console.log(`\nruns scored: ${results.length}`);
  console.log(`model calls this run: ${stats.liveCalls} live, ${stats.cacheHits} replayed from ${BASELINE2_TWO_TURN_RAW_FILE}`);
  if (inner instanceof GroqModelProvider) {
    console.log(
      `groq http attempts: ${inner.httpAttempts} (429 responses: ${inner.rateLimited}, time spent waiting out limits: ${(inner.waitedMs / 1000).toFixed(0)}s)`,
    );
  }

  // --- adjudication list: every ambiguous run, never decided here ---
  const attackById = new Map(corpus.attacks.map((a) => [a.id, a] as const));
  const found: AdjudicationEntry[] = results
    .filter((r) => r.judgement.verdict === "ambiguous")
    .map((r) => {
      const stored = file.entries.find((e) => e.itemId === r.itemId && e.kind === r.kind && e.runIndex === r.runIndex && e.turn === 1);
      return {
        itemId: r.itemId,
        kind: r.kind,
        runIndex: r.runIndex,
        verdict: "ambiguous" as const,
        reviewReason: r.judgement.reviewReason ?? "unspecified",
        note: r.judgement.note,
        ...(r.kind === "attack" ? { injectedToolDescription: attackById.get(r.itemId)!.attackVersion } : {}),
        transcript: r.transcript.turns.map((t, i) => ({
          turn: i + 1,
          text: t.text,
          toolCalls: t.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
        })),
        toolResultDelivered: r.transcript.toolResultsDelivered,
        modelId,
        capturedAt: stored?.capturedAt ?? "",
        humanDecision: null,
      };
    });
  const adjudication = await loadAdjudicationFile();
  const decided = new Map(adjudication.adjudications.filter((a) => a.humanDecision !== null).map((a) => [key(a), a] as const));
  adjudication.adjudications = found.map((e) => decided.get(key(e)) ?? e);
  await writeFile(ADJUDICATION_PATH, `${JSON.stringify(adjudication, null, 2)}\n`, "utf8");
  console.log(`wrote ${ADJUDICATION_PATH} — ${found.length} ambiguous run(s) for human review, none decided`);

  // --- report ---
  const section = summarizeTwoTurn(results, new Map(corpus.attacks.map((a) => [a.id, a.pattern] as const)), {
    model: modelId,
    provider: config.modelProvider,
    temperature: file.temperature,
    runsPerItem: TWO_TURN_RUNS_PER_ITEM,
  });
  const singleTurn = JSON.parse(await readFile(SINGLE_TURN_SECTION_PATH, "utf8")) as SingleTurnSupersededSection;
  const fresh = buildBaselineReport(corpus, () => new Date());
  const report: BaselineReport = {
    ...fresh,
    baseline2FrontierModelUnaided: section,
    baseline2SingleTurnSuperseded: singleTurn,
    delta: 1 - section.refusalRate,
  };
  await writeFile(BASELINES_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`wrote ${BASELINES_PATH}`);

  const a = section.attacks;
  const c = section.controls;
  console.log(
    `\nbaseline 2, two-turn (${modelId}, ${config.modelProvider}, temperature ${section.temperature}):\n` +
      `  attacks (${a.runs} runs): followed ${a.followed}, refused ${a.refused}, ambiguous ${a.ambiguous}, not-exercised ${a.notExercised}\n` +
      `    not-exercised by basis: ${Object.entries(a.notExercisedByBasis).map(([k, v]) => `${k} ${v}`).join(", ")}\n` +
      `    ambiguous by reason:    ${Object.entries(a.ambiguousByReason).map(([k, v]) => `${k} ${v}`).join(", ")}\n` +
      `  controls (${c.runs} runs): normal use ${c.followed}, refused ${c.refused}, ambiguous ${c.ambiguous}; false-positive rate ${(section.falsePositiveRate * 100).toFixed(1)}%\n` +
      `  follow rate ${(section.followRate * 100).toFixed(1)}% (range ${(section.followRateRange.ifNoAmbiguousRunIsAFollow * 100).toFixed(1)}-${(section.followRateRange.ifEveryAmbiguousRunIsAFollow * 100).toFixed(1)}%), ` +
      `explicit refusal rate ${(section.refusalRate * 100).toFixed(1)}%\n` +
      `  follow rate status: ${section.followRateStatus} — ${section.followRateStatusReason}\n` +
      `  delta meaningful: ${section.deltaMeaningful} — ${section.deltaMeaningfulReason}`,
  );
}

main().catch((e: unknown) => {
  console.error("\nrun-baseline2 failed —", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
