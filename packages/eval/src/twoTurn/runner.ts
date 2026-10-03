import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ConfigError, UpstreamTimeoutError } from "@chaperone/errors";
import { withRetry, type ConversationMessage, type ConversationToolCall, type ModelProvider } from "@chaperone/advisory";
import type { AttackCorpusItem, BenignControlItem } from "../types.js";
import {
  ITEM_RUBRIC_BY_ID,
  judgeTwoTurnAttackRun,
  judgeTwoTurnControlRun,
  type RunTranscript,
  type TwoTurnJudgement,
} from "./rubric.js";
import { CONTROL_REQUESTS, CONTROL_RESULTS, SYSTEM_PROMPT, userTurn } from "./scenario.js";

/** 3 runs per item, as in the single-turn run. */
export const TWO_TURN_RUNS_PER_ITEM = 3;
export const BASELINE2_TWO_TURN_RAW_FILE = "data/baseline2-raw.json";

/** The visible-answer cap per call; the provider adds reasoning headroom on top. */
const MAX_RESPONSE_TOKENS = 500;
const PER_CALL_TIMEOUT_MS = 45_000;
const RETRY_DELAYS_MS = [500, 2_000] as const;

export interface TwoTurnRawEntry {
  itemId: string;
  kind: "attack" | "control";
  runIndex: number;
  turn: 1 | 2;
  /** sha256 of the exact request (conversation + tools). A stored entry whose request no longer matches is rejected, so a changed scenario can never be silently scored with old responses. */
  requestSha: string;
  text: string;
  toolCalls: readonly ConversationToolCall[];
  modelId: string;
  capturedAt: string;
}

export interface TwoTurnRawFile {
  schemaVersion: 1;
  description: string;
  design: "two-turn";
  provider: string;
  modelId: string;
  temperature: number;
  entries: TwoTurnRawEntry[];
}

export function loadTwoTurnRaw(path: string): TwoTurnRawFile | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as TwoTurnRawFile) : undefined;
}

/** Write-then-rename so a crash cannot leave a truncated file that the next run resumes from. */
export function saveTwoTurnRaw(path: string, file: TwoTurnRawFile): void {
  const temp = `${path}.tmp`;
  const body = `${JSON.stringify(file, null, 2)}\n`;
  writeFileSync(temp, body, "utf8");
  // OneDrive (this repo lives in a synced folder) can briefly hold the target open and fail the
  // rename with EPERM. Retry, and if it never lets go, write the target directly: a stored
  // response must never be lost to a sync lock.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EBUSY") {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
  writeFileSync(path, body, "utf8");
}

export interface RunSpec {
  itemId: string;
  kind: "attack" | "control";
  runIndex: number;
  /** The resident's request. */
  request: string;
  tool: { name: string; description: string };
  cannedResult: string;
}

export function specForAttack(item: AttackCorpusItem, runIndex: number): RunSpec {
  const rubric = ITEM_RUBRIC_BY_ID.get(item.id);
  if (!rubric) {
    throw new ConfigError(`no two-turn rubric for attack item ${item.id}`, { itemId: item.id });
  }
  return {
    itemId: item.id,
    kind: "attack",
    runIndex,
    request: item.userRequest,
    tool: { name: item.toolName, description: item.attackVersion },
    cannedResult: rubric.cannedResult,
  };
}

export function specForControl(item: BenignControlItem, runIndex: number): RunSpec {
  const request = CONTROL_REQUESTS[item.id];
  const cannedResult = CONTROL_RESULTS[item.id];
  if (request === undefined || cannedResult === undefined) {
    throw new ConfigError(`no two-turn request/result for control ${item.id}`, { itemId: item.id });
  }
  return {
    itemId: item.id,
    kind: "control",
    runIndex,
    request,
    tool: { name: item.toolName, description: item.description },
    cannedResult,
  };
}

function requestSha(conversation: readonly ConversationMessage[], tool: RunSpec["tool"]): string {
  return createHash("sha256").update(JSON.stringify({ conversation, tool, maxTokens: MAX_RESPONSE_TOKENS }), "utf8").digest("hex");
}

export interface RunnerContext {
  /** Absent in replay mode: a missing stored response is then an error, never a silent model call. */
  provider?: ModelProvider;
  file: TwoTurnRawFile;
  onNewEntry?: (file: TwoTurnRawFile) => void;
  now?: () => Date;
  /** Counters, read by the script for the call report. */
  stats: { liveCalls: number; cacheHits: number };
}

async function turn(ctx: RunnerContext, spec: RunSpec, turnNumber: 1 | 2, conversation: readonly ConversationMessage[]) {
  const sha = requestSha(conversation, spec.tool);
  const stored = ctx.file.entries.find(
    (e) => e.itemId === spec.itemId && e.kind === spec.kind && e.runIndex === spec.runIndex && e.turn === turnNumber,
  );
  if (stored) {
    if (stored.requestSha !== sha) {
      throw new ConfigError(
        `stored turn ${turnNumber} of ${spec.itemId} run ${spec.runIndex} was produced by a different request than the current scenario would send; move the raw file aside to start a new capture`,
        { itemId: spec.itemId, runIndex: spec.runIndex, turn: turnNumber },
      );
    }
    ctx.stats.cacheHits++;
    return stored;
  }
  if (!ctx.provider) {
    throw new ConfigError(
      `two-turn replay: no stored turn ${turnNumber} for ${spec.itemId} run ${spec.runIndex}; re-run with --capture to call the model`,
      { itemId: spec.itemId, runIndex: spec.runIndex, turn: turnNumber },
    );
  }
  const provider = ctx.provider;
  const result = await withRetry(
    (remainingMs) =>
      provider.invoke({
        prompt: conversation.map((m) => ("content" in m ? m.content : "")).join("\n"),
        conversation,
        maxTokens: MAX_RESPONSE_TOKENS,
        timeoutMs: Math.min(PER_CALL_TIMEOUT_MS, remainingMs),
        tools: [spec.tool],
      }),
    {
      delaysMs: RETRY_DELAYS_MS,
      deadline: Date.now() + PER_CALL_TIMEOUT_MS * (RETRY_DELAYS_MS.length + 1),
      isRetryable: (e) => e instanceof UpstreamTimeoutError,
    },
  );
  if (!result.ok) {
    throw result.error;
  }
  ctx.stats.liveCalls++;
  const entry: TwoTurnRawEntry = {
    itemId: spec.itemId,
    kind: spec.kind,
    runIndex: spec.runIndex,
    turn: turnNumber,
    requestSha: sha,
    text: result.value.text,
    toolCalls: result.value.toolCalls ?? [],
    modelId: result.value.modelId,
    capturedAt: (ctx.now ?? (() => new Date()))().toISOString(),
  };
  ctx.file.entries.push(entry);
  ctx.onNewEntry?.(ctx.file);
  return entry;
}

/**
 * One run: turn 1, and if the model called the tool, a canned result for each
 * call and turn 2. Turn 2's own tool calls are recorded and scored but not
 * executed, so a run is at most two model calls.
 *
 * `text` in a stored entry is the provider's rendering, which includes
 * `[tool call] ...` lines. For scoring, the transcript uses prose only and the
 * structured calls, so the rendering never counts as the model "saying" it.
 */
export async function runTwoTurn(ctx: RunnerContext, spec: RunSpec): Promise<RunTranscript> {
  const base: ConversationMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userTurn(spec.request) },
  ];
  const first = await turn(ctx, spec, 1, base);
  const firstTurn = { text: proseOf(first.text, first.toolCalls.length > 0), toolCalls: first.toolCalls };

  if (first.toolCalls.length === 0) {
    return { turns: [firstTurn], toolResultsDelivered: false };
  }

  const second = await turn(ctx, spec, 2, [
    ...base,
    { role: "assistant", content: firstTurn.text, toolCalls: first.toolCalls },
    ...first.toolCalls.map((c): ConversationMessage => ({ role: "tool", toolCallId: c.id, content: spec.cannedResult })),
  ]);
  return {
    turns: [firstTurn, { text: proseOf(second.text, second.toolCalls.length > 0), toolCalls: second.toolCalls }],
    toolResultsDelivered: true,
  };
}

/** Strips the provider's `[tool call] ...` rendering lines when the structured calls are carried separately. The malformed-call recovery text is kept: it is the only trace of that call. */
function proseOf(text: string, hasStructuredCalls: boolean): string {
  if (!hasStructuredCalls) {
    return text;
  }
  return text
    .split("\n")
    .filter((line) => !line.startsWith("[tool call] "))
    .join("\n")
    .trim();
}

export interface TwoTurnRunResult {
  itemId: string;
  kind: "attack" | "control";
  runIndex: number;
  transcript: RunTranscript;
  judgement: TwoTurnJudgement;
}

export async function runTwoTurnCorpus(
  ctx: RunnerContext,
  attacks: readonly AttackCorpusItem[],
  controls: readonly BenignControlItem[],
  runsPerItem: number = TWO_TURN_RUNS_PER_ITEM,
): Promise<TwoTurnRunResult[]> {
  const results: TwoTurnRunResult[] = [];
  for (const item of attacks) {
    const rubric = ITEM_RUBRIC_BY_ID.get(item.id)!;
    for (let runIndex = 0; runIndex < runsPerItem; runIndex++) {
      const transcript = await runTwoTurn(ctx, specForAttack(item, runIndex));
      results.push({ itemId: item.id, kind: "attack", runIndex, transcript, judgement: judgeTwoTurnAttackRun(rubric, transcript) });
    }
  }
  for (const item of controls) {
    for (let runIndex = 0; runIndex < runsPerItem; runIndex++) {
      const transcript = await runTwoTurn(ctx, specForControl(item, runIndex));
      results.push({ itemId: item.id, kind: "control", runIndex, transcript, judgement: judgeTwoTurnControlRun(transcript) });
    }
  }
  return results;
}
