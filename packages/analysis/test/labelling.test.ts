/**
 * The labelling tool's logic, driven by scripted input: rendering, the
 * change-label loop (resume, skip, bad input, end of input) and the M14
 * prevalence sample and loop.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LabelsFile,
  type LabelsTodoFile,
  type PrevalenceFile,
  type TodoItem,
  PREVALENCE_SAMPLE_SIZE,
  allocateProportional,
  defaultCapabilitiesPath,
  describeSchemaChange,
  drawPrevalenceSample,
  emptyLabelsFile,
  highlightSpans,
  loadSnapshot,
  makeStyle,
  mergeTodo,
  parseLabelsFile,
  parseLabelsTodoFile,
  parsePrevalenceFile,
  renderTodoItem,
  runChangeLabelSession,
  runPrevalenceSession,
  seedFromString,
  seededSample,
  sideBySide,
  summarizePrevalence,
  wrapText,
} from "../src/index.js";
import { REAL_DATA_DIR } from "./fixtures/drift-fixture.js";

const BLOB = "0c896539006dbb6f8dfacc1f02ebbf179c50eec2";

function item(n: number, overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    key: `fixture-server|tool_${n}|sha256:a${n}|sha256:b${n}`,
    serverId: "fixture-server",
    toolName: `tool_${n}`,
    comparisons: ["crawl-1 -> crawl-2"],
    beforeSha256: `sha256:a${n}`,
    afterSha256: `sha256:b${n}`,
    proposed: "semantic-intent",
    reason: "description words changed",
    descriptionChange: "words",
    schemaChange: "none",
    capabilityBefore: "write",
    capabilityAfter: "communicate",
    before: { description: "Sends a text summary to yourself.", inputSchema: { type: "object" } },
    after: { description: "Sends a text summary to yourself and to your emergency contact.", inputSchema: { type: "object" } },
    ...overrides,
  };
}

const todoOf = (items: TodoItem[]): LabelsTodoFile => ({ $comment: "fixture", generatedAt: "2026-10-21T00:00:00Z", taxonomyBlobSha: BLOB, items });

function scripted(answers: Array<string | null>) {
  const printed: string[] = [];
  const queue = [...answers];
  return { printed, io: { ask: async () => (queue.length === 0 ? null : queue.shift()!), print: (t: string) => printed.push(t) } };
}

async function session(todo: LabelsTodoFile, answers: Array<string | null>, labels: LabelsFile = emptyLabelsFile(), labeledBy = "Fixture Labeller") {
  const { printed, io } = scripted(answers);
  const saves: LabelsFile[] = [];
  const summary = await runChangeLabelSession({
    todo,
    labels,
    labeledBy,
    taxonomyBlobSha: BLOB,
    io,
    style: makeStyle(false),
    now: () => new Date("2026-10-21T02:00:00Z"),
    save: async (l) => {
      saves.push(l);
    },
  });
  return { summary, saves, printed, last: saves.at(-1) ?? labels };
}

describe("rendering", () => {
  it("marks changed words with [-..-] and {+..+} with colour off, and adds ANSI only when asked", () => {
    const text = renderTodoItem(item(1), 1, 3, makeStyle(false), false);
    expect(text).toContain("{+and to your emergency contact+}");
    expect(text).toContain("capability class moved: write -> communicate");
    expect(text).not.toContain("\u001b[");
    expect(renderTodoItem(item(1), 1, 3, makeStyle(true), true)).toContain("\u001b[32m{+");
    expect(renderTodoItem(item(1), 1, 3, makeStyle(true), true)).toContain("(skipped before)");
  });

  it("shows an unchanged description, and a schema change property by property", () => {
    const text = renderTodoItem(
      item(2, {
        descriptionChange: "none",
        schemaChange: "non-additive",
        capabilityAfter: "write",
        before: { description: "Same.", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
        after: { description: "Same.", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["b"] } },
      }),
      2,
      3,
      makeStyle(false),
      false,
    );
    expect(text).toContain("description: unchanged");
    expect(text).toContain('+ property "b" added (REQUIRED)');
    expect(text).toContain("capability class: write");
  });

  it("describeSchemaChange covers removal, changes, required flips and other keys", () => {
    const lines = describeSchemaChange(
      { type: "object", properties: { a: { type: "string" }, gone: {} }, required: ["a"], additionalProperties: true },
      { type: "object", properties: { a: { type: "number" }, c: {} }, required: [], additionalProperties: false },
    );
    expect(lines).toEqual([
      '+ property "c" added (optional)',
      '- property "gone" removed',
      '~ property "a" changed: {"type":"string"} -> {"type":"number"}',
      '~ "a" is no longer required',
      "~ schema \"additionalProperties\": true -> false",
    ]);
    expect(describeSchemaChange({ required: ["x"], properties: { x: {} } }, { required: ["x", "y"], properties: { x: {}, y: {} } })).toContain(
      '+ property "y" added (REQUIRED)',
    );
    expect(describeSchemaChange({ properties: { x: {} } }, { properties: { x: {} }, required: ["x"] })).toEqual(['! "x" is now required']);
    expect(describeSchemaChange(null, null)).toEqual(["(no property-level difference; key order or formatting only)"]);
  });

  it("highlightSpans, wrapText and sideBySide", () => {
    expect(highlightSpans("abc def", [{ side: "after", start: 4, end: 7, kind: "add" }], (s) => `<${s}>`)).toBe("abc <def>");
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrapText("", 9)).toEqual([]);
    const cols = sideBySide({ title: "L", text: "left text here" }, { title: "R", text: "right" }, 10).split("\n");
    expect(cols[0]).toBe("L          | R");
    expect(cols[2]).toBe("left text  | right");
    expect(cols[3]).toBe("here       |");
  });
});

describe("change-label session", () => {
  it("records each choice with labeledBy, labeledAt and the taxonomy blob, saving after every answer", async () => {
    const { summary, saves, last } = await session(todoOf([item(1), item(2), item(3)]), ["i", "c", "a"]);
    expect(summary).toEqual({ shown: 3, decided: 3, skipped: 0, remaining: 0, quit: false });
    expect(saves).toHaveLength(3);
    expect(last.labels.map((l) => l.label)).toEqual(["semantic-intent", "cosmetic", "schema-additive"]);
    expect(last.labels[0]).toMatchObject({ labeledBy: "Fixture Labeller", labeledAt: "2026-10-21T02:00:00.000Z", taxonomyBlobSha: BLOB, proposed: "semantic-intent" });
    expect(parseLabelsFile(JSON.parse(JSON.stringify(last)), "roundtrip").labels).toHaveLength(3);
  });

  it("re-asks on bad input, prints help, and treats end of input as quit", async () => {
    const { summary, printed, last } = await session(todoOf([item(1), item(2)]), ["x", "?", "I", null]);
    expect(printed.some((p) => p.includes('"x" is not one of'))).toBe(true);
    expect(printed.filter((p) => p.includes("c = cosmetic")).length).toBe(2);
    expect(summary).toMatchObject({ decided: 1, remaining: 1, quit: true });
    expect(last.labels).toHaveLength(1);
  });

  it("resumes where it stopped; a skipped item comes round again and can then be decided", async () => {
    const todo = todoOf([item(1), item(2), item(3)]);
    const first = await session(todo, ["i", "s", "q"]);
    expect(first.summary).toMatchObject({ decided: 1, skipped: 1, remaining: 2, quit: true });
    expect(first.last.labels.find((l) => l.toolName === "tool_2")!.label).toBe("skip");

    const second = await session(todo, ["c", "i"], first.last);
    expect(second.summary).toMatchObject({ shown: 2, decided: 2, remaining: 0 });
    expect(second.printed.some((p) => p.includes("[1/2] fixture-server  ::  tool_2") && p.includes("(skipped before)"))).toBe(true);
    expect(second.last.labels.find((l) => l.toolName === "tool_2")!.label).toBe("cosmetic");

    const third = await session(todo, [], second.last);
    expect(third.summary.shown).toBe(0);
    expect(third.printed[0]).toContain("Nothing to label");
  });

  it("refuses 'model' as the labeller, and a todo list made under another taxonomy", async () => {
    await expect(session(todoOf([item(1)]), ["i"], emptyLabelsFile(), "model")).rejects.toThrow(/must name the person/);
    await expect(session(todoOf([item(1)]), ["i"], emptyLabelsFile(), "  ")).rejects.toThrow(/must name the person/);
    await expect(session({ ...todoOf([item(1)]), taxonomyBlobSha: "other" }, ["i"])).rejects.toThrow(/was generated under/);
  });

  it("validates the labels and todo files it reads", () => {
    expect(() => parseLabelsFile({ labels: [{ key: "x" }] }, "bad")).toThrow(/not a valid labels file/);
    const record = { key: "a|b|c|d", serverId: "a", toolName: "b", beforeSha256: "c", afterSha256: "d", label: "cosmetic", proposed: "cosmetic", labeledBy: "P", labeledAt: "t", taxonomyBlobSha: BLOB };
    expect(() => parseLabelsFile({ labels: [{ ...record, key: "wrong" }] }, "bad")).toThrow(/does not match its own fields/);
    expect(() => parseLabelsFile({ labels: [record, record] }, "bad")).toThrow(/appears twice/);
    expect(() => parseLabelsFile({ labels: [{ ...record, labeledBy: "Model" }] }, "bad")).toThrow(/must name the person/);
    expect(() => parseLabelsTodoFile({ items: 1 }, "bad")).toThrow(/not a valid labels-todo file/);
    expect(parseLabelsTodoFile(JSON.parse(JSON.stringify(todoOf([item(1)]))), "ok").items).toHaveLength(1);
  });

  it("mergeTodo keeps one item per key and every comparison that needs it", () => {
    const merged = mergeTodo([
      { label: "a", classified: [], pending: [item(1)] },
      { label: "b", classified: [], pending: [item(1, { comparisons: ["crawl-1 -> crawl-interim-1"] }), item(1)] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.comparisons).toEqual(["crawl-1 -> crawl-2", "crawl-1 -> crawl-interim-1"]);
  });
});

describe("prevalence sample (M14)", () => {
  it("uses the crawler's seed construction: seedFromString('crawl-1') is the seed crawl 1 recorded", async () => {
    const needsReview = JSON.parse(await readFile(path.join(REAL_DATA_DIR, "crawl-1-needs-review.json"), "utf8")) as { seed: number };
    expect(seedFromString("crawl-1")).toBe(needsReview.seed);
  });

  it("allocates 150 proportionally with largest remainder, ties by TAXONOMY.md order", () => {
    expect(allocateProportional({ read: 4, write: 3, transact: 2, communicate: 1 }, 5)).toEqual({ transact: 1, communicate: 1, write: 1, read: 2 });
    const a = allocateProportional({ read: 3000, write: 1000, transact: 500, communicate: 500 }, 150);
    expect(a).toEqual({ read: 90, write: 30, transact: 15, communicate: 15 });
    expect(() => allocateProportional({ read: 1, write: 0, transact: 0, communicate: 0 }, 2)).toThrow(/cannot draw/);
  });

  it("seededSample is deterministic and without replacement", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(seededSample(items, 10, 7)).toEqual(seededSample(items, 10, 7));
    expect(new Set(seededSample(items, 50, 7)).size).toBe(50);
    expect(seededSample(items, 99, 7)).toHaveLength(50);
  });

  let sample: PrevalenceFile;
  it("draws 150 crawl-1 tools, stratified by v2 class, reproducibly", async () => {
    const crawl1 = await loadSnapshot({ dataDir: REAL_DATA_DIR, crawlId: "crawl-1", capabilitiesPath: defaultCapabilitiesPath(REAL_DATA_DIR, "crawl-1") });
    sample = drawPrevalenceSample(crawl1);
    const again = drawPrevalenceSample(crawl1);
    expect(again.items.map((i) => i.sha256)).toEqual(sample.items.map((i) => i.sha256));
    expect(sample.items).toHaveLength(PREVALENCE_SAMPLE_SIZE);
    expect(sample.frameSize).toBe(6058);
    for (const cls of ["read", "write", "transact", "communicate"] as const) {
      expect(sample.items.filter((i) => i.capabilityClass === cls)).toHaveLength(sample.allocation[cls]);
    }
    expect(new Set(sample.items.map((i) => `${i.serverId}|${i.toolName}`)).size).toBe(150);
    expect(sample.items.every((i) => i.answer === null)).toBe(true);
    expect(parsePrevalenceFile(JSON.parse(JSON.stringify(sample)), "roundtrip").seed).toBe(seedFromString("prevalence-crawl-1"));
    expect(() => drawPrevalenceSample({ ...crawl1, crawlId: "crawl-2" })).toThrow(/crawl 1's tools/);
    expect(() => parsePrevalenceFile({}, "bad")).toThrow(/not a valid prevalence file/);
  }, 60_000);

  it("the prevalence loop records yes/no, resumes, and states a share only when all are answered", async () => {
    const small: PrevalenceFile = { ...sample, items: sample.items.slice(0, 3) };
    const run = async (file: PrevalenceFile, answers: Array<string | null>) => {
      const { printed, io } = scripted(answers);
      let saved = file;
      const summary = await runPrevalenceSession({
        file,
        labeledBy: "Fixture Labeller",
        taxonomyBlobSha: BLOB,
        io,
        style: makeStyle(false),
        now: () => new Date("2026-10-01T00:00:00Z"),
        save: async (f) => {
          saved = f;
        },
      });
      return { summary, saved, printed };
    };
    const first = await run(small, ["y", "zz", "s", null]);
    expect(first.summary).toMatchObject({ decided: 1, skipped: 1, quit: true });
    expect(summarizePrevalence(first.saved)).toMatchObject({ answered: 1, yes: 1, sharePct: null });
    expect(first.printed.some((p) => p.includes("No share is stated"))).toBe(true);

    const second = await run(first.saved, ["?", "n", "n"]);
    expect(second.summary).toMatchObject({ decided: 2, remaining: 0 });
    expect(summarizePrevalence(second.saved)).toEqual({ answered: 3, yes: 1, no: 2, sampleSize: 3, sharePct: 33.3 });
    expect(second.saved.items[0]).toMatchObject({ labeledBy: "Fixture Labeller", taxonomyBlobSha: BLOB });

    const third = await run(second.saved, []);
    expect(third.printed[0]).toContain("Nothing to label");
    await expect(
      runPrevalenceSession({ file: small, labeledBy: "model", taxonomyBlobSha: BLOB, io: scripted([]).io, style: makeStyle(false), now: () => new Date(), save: async () => undefined }),
    ).rejects.toThrow(/must name the person/);
  });
});
