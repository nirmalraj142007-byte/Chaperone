import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "@chaperone/errors";
import { MockModelProvider } from "@chaperone/advisory";
import {
  CachedModelProvider,
  loadRawFile,
  promptSha,
  saveRawFile,
  type Baseline2RawFile,
} from "../src/baseline2Cache.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function emptyFile(): Baseline2RawFile {
  return { schemaVersion: 1, description: "t", provider: "mock", modelId: "mock-model", temperature: 1, entries: [] };
}

const index = new Map([
  [promptSha("prompt A"), { itemId: "item-a", kind: "attack" as const }],
  [promptSha("prompt B"), { itemId: "control-b", kind: "control" as const }],
]);

const req = (prompt: string) => ({ prompt, maxTokens: 10, timeoutMs: 1000 });

describe("CachedModelProvider", () => {
  it("calls the inner provider for a new prompt and records itemId, kind and run index", async () => {
    const file = emptyFile();
    const inner = new MockModelProvider({ modelId: "mock-model", respond: (_r, i) => ({ text: `reply ${i}`, modelId: "mock-model" }) });
    const saved: number[] = [];
    const provider = new CachedModelProvider({ inner, file, promptIndex: index, onNewEntry: (f) => saved.push(f.entries.length) });

    await provider.invoke(req("prompt A"));
    await provider.invoke(req("prompt A"));
    await provider.invoke(req("prompt B"));

    expect(provider.liveCalls).toBe(3);
    expect(saved).toEqual([1, 2, 3]);
    expect(file.entries.map((e) => [e.itemId, e.kind, e.runIndex, e.text])).toEqual([
      ["item-a", "attack", 0, "reply 0"],
      ["item-a", "attack", 1, "reply 1"],
      ["control-b", "control", 0, "reply 2"],
    ]);
  });

  it("replays stored responses in order with no inner provider and zero model calls", async () => {
    const file = emptyFile();
    const inner = new MockModelProvider({ respond: (_r, i) => ({ text: `reply ${i}`, modelId: "mock-model" }) });
    const first = new CachedModelProvider({ inner, file, promptIndex: index });
    await first.invoke(req("prompt A"));
    await first.invoke(req("prompt A"));

    const replay = new CachedModelProvider({ file, promptIndex: index });
    expect((await replay.invoke(req("prompt A"))).text).toBe("reply 0");
    expect((await replay.invoke(req("prompt A"))).text).toBe("reply 1");
    expect(replay.liveCalls).toBe(0);
    expect(replay.cacheHits).toBe(2);
  });

  it("refuses to make a model call in replay mode when a response is missing", async () => {
    const replay = new CachedModelProvider({ file: emptyFile(), promptIndex: index });
    await expect(replay.invoke(req("prompt A"))).rejects.toBeInstanceOf(ConfigError);
  });

  it("resumes: serves what is stored, then calls the model only for the rest", async () => {
    const file = emptyFile();
    const seed = new CachedModelProvider({
      inner: new MockModelProvider({ respond: () => ({ text: "stored", modelId: "mock-model" }) }),
      file,
      promptIndex: index,
    });
    await seed.invoke(req("prompt A"));

    const inner = new MockModelProvider({ respond: () => ({ text: "fresh", modelId: "mock-model" }) });
    const resumed = new CachedModelProvider({ inner, file, promptIndex: index });
    expect((await resumed.invoke(req("prompt A"))).text).toBe("stored");
    expect((await resumed.invoke(req("prompt A"))).text).toBe("fresh");
    expect(resumed.liveCalls).toBe(1);
  });

  it("never sends a prompt that belongs to no corpus item", async () => {
    const inner = new MockModelProvider();
    const provider = new CachedModelProvider({ inner, file: emptyFile(), promptIndex: index });
    await expect(provider.invoke(req("something else"))).rejects.toBeInstanceOf(ConfigError);
    expect(provider.liveCalls).toBe(0);
  });
});

describe("raw file persistence", () => {
  it("round-trips through save/load and returns undefined when absent", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "b2-"));
    dirs.push(dir);
    const file = path.join(dir, "raw.json");
    expect(loadRawFile(file)).toBeUndefined();
    const data = emptyFile();
    saveRawFile(file, data);
    expect(loadRawFile(file)).toEqual(data);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });
});
