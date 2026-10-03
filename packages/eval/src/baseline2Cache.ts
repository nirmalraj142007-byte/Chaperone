import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ConfigError } from "@chaperone/errors";
import type { ModelInvocationRequest, ModelInvocationResult, ModelProvider } from "@chaperone/advisory";

/**
 * Baseline 2 costs real model calls, so every raw response is written down the
 * moment it arrives and every later step (reclassifying, rebuilding
 * data/baselines.json, a judge re-scoring) reads the file instead of calling
 * the model again. The classifier is a function of these files and nothing
 * else, which is what lets it be revisited against real responses without a
 * second 120-call run, and lets anyone re-derive the published number.
 *
 * The file holds the model's own text verbatim. That is a change from the
 * scaffold, which kept only a hash outside the adjudication file; the reason
 * is reproducibility, not convenience, and the content is a model's reply to a
 * public, author-written corpus.
 */
export interface Baseline2RawEntry {
  itemId: string;
  kind: "attack" | "control";
  runIndex: number;
  promptSha: string;
  text: string;
  modelId: string;
  capturedAt: string;
}

export interface Baseline2RawFile {
  schemaVersion: 1;
  description: string;
  provider: string;
  modelId: string;
  temperature: number;
  entries: Baseline2RawEntry[];
}

export const BASELINE2_RAW_FILE = "data/baseline2-raw.json";

export function promptSha(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function loadRawFile(path: string): Baseline2RawFile | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as Baseline2RawFile;
}

/** Write-then-rename, so a crash mid-write cannot leave a truncated file that the next run would resume from. */
export function saveRawFile(path: string, file: Baseline2RawFile): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

export interface CachedProviderOptions {
  /** Absent in replay mode: a prompt with no stored response is then an error, never a silent model call. */
  inner?: ModelProvider;
  file: Baseline2RawFile;
  /** promptSha -> which item that prompt belongs to; how the file gets its itemId and kind columns. */
  promptIndex: ReadonlyMap<string, { itemId: string; kind: "attack" | "control" }>;
  /** Called after every new entry, so the caller can persist it immediately. */
  onNewEntry?: (file: Baseline2RawFile) => void;
  now?: () => Date;
}

/**
 * Serves each prompt's stored responses in order (the 3 runs of an item share
 * one prompt, so the n-th request for a prompt gets the n-th stored text) and
 * only calls the real provider once the stored ones run out. That one rule is
 * both replay (no inner provider) and crash-resume (inner provider, partly
 * filled file).
 */
export class CachedModelProvider implements ModelProvider {
  readonly modelId: string;
  private readonly served = new Map<string, number>();
  /** Real model calls this provider made (not cache hits). */
  liveCalls = 0;
  cacheHits = 0;

  constructor(private readonly options: CachedProviderOptions) {
    this.modelId = options.file.modelId;
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const sha = promptSha(request.prompt);
    const stored = this.options.file.entries.filter((e) => e.promptSha === sha);
    const nth = this.served.get(sha) ?? 0;
    this.served.set(sha, nth + 1);

    const hit = stored[nth];
    if (hit) {
      this.cacheHits++;
      return { text: hit.text, modelId: hit.modelId };
    }

    if (!this.options.inner) {
      throw new ConfigError("baseline 2 replay: no stored response for this prompt; re-run with --capture to call the model", {
        promptSha: sha,
        occurrence: nth,
      });
    }
    const owner = this.options.promptIndex.get(sha);
    if (!owner) {
      throw new ConfigError("baseline 2: a prompt that belongs to no corpus item was about to be sent", { promptSha: sha });
    }

    const result = await this.options.inner.invoke(request);
    this.liveCalls++;
    this.options.file.entries.push({
      itemId: owner.itemId,
      kind: owner.kind,
      runIndex: nth,
      promptSha: sha,
      text: result.text,
      modelId: result.modelId,
      capturedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
    this.options.onNewEntry?.(this.options.file);
    return result;
  }
}
