/**
 * Grouping of identical edits in the labelling session. Fixtures only: every
 * item here is invented, and none stands for a real crawl result.
 */
import { describe, expect, it } from "vitest";
import {
  type LabelsFile,
  type LabelsTodoFile,
  type TodoItem,
  editSignature,
  emptyLabelsFile,
  groupTodoItems,
  makeStyle,
  parseLabelsFile,
  runChangeLabelSession,
} from "../src/index.js";

const BLOB = "0c896539006dbb6f8dfacc1f02ebbf179c50eec2";
const SCHEMA = { type: "object", properties: { q: { type: "string" } } };

function item(serverId: string, toolName: string, before: string, after: string, overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    key: `${serverId}|${toolName}|sha256:a-${toolName}|sha256:b-${toolName}`,
    serverId,
    toolName,
    comparisons: ["crawl-1 -> crawl-interim-1"],
    beforeSha256: `sha256:a-${toolName}`,
    afterSha256: `sha256:b-${toolName}`,
    proposed: "semantic-intent",
    reason: "FIXTURE-REASON-MUST-NOT-BE-SHOWN",
    descriptionChange: "words",
    schemaChange: "none",
    capabilityBefore: "read",
    capabilityAfter: "read",
    before: { description: before, inputSchema: SCHEMA },
    after: { description: after, inputSchema: SCHEMA },
    ...overrides,
  };
}

// The same edit ("image" -> "image or video") in three tools on two servers, with different text around it.
const A = item("server-a", "make_picture", "Creates an image from a prompt.", "Creates an image or video from a prompt.");
const B = item("server-a", "check_picture", "Checks the status of an image task.", "Checks the status of an image or video task.");
const C = item("server-b", "list_pictures", "Lists every image you own.", "Lists every image or video you own.");
// A different edit, a one-off.
const D = item("server-b", "send_note", "Sends a note to you.", "Sends a note to you and your contacts.");

const withSchema = (base: TodoItem, name: string, afterSchema: unknown): TodoItem =>
  ({ ...base, toolName: name, key: `${base.serverId}|${name}|a|b`, schemaChange: "non-additive", after: { ...base.after, inputSchema: afterSchema } });

describe("editSignature and groupTodoItems", () => {
  it("puts the same word edit in one group across tools and servers, whatever surrounds it", () => {
    expect(editSignature(A)).toBe(editSignature(B));
    expect(editSignature(A)).toBe(editSignature(C));
    const groups = groupTodoItems([A, D, B, C]);
    expect(groups.map((g) => g.items.map((i) => i.toolName))).toEqual([["make_picture", "check_picture", "list_pictures"], ["send_note"]]);
  });

  it("keeps edits that add or remove different words in separate groups", () => {
    const other = item("server-a", "make_clip", "Creates an image from a prompt.", "Creates an image or audio from a prompt.");
    expect(editSignature(A)).not.toBe(editSignature(other));
    expect(groupTodoItems([A, other])).toHaveLength(2);
  });

  it("separates the same description edit when the input-schema change differs, and joins it when the schema change is the same", () => {
    const addRequired = { ...SCHEMA, properties: { q: { type: "string" }, n: { type: "number" } }, required: ["n"] };
    const addOther = { ...SCHEMA, properties: { q: { type: "string" }, m: { type: "number" } }, required: ["m"] };
    const x = withSchema(A, "x1", addRequired);
    const y = withSchema(A, "x2", addRequired);
    const z = withSchema(A, "x3", addOther);
    expect(editSignature(x)).toBe(editSignature(y));
    expect(editSignature(x)).not.toBe(editSignature(z));
    expect(editSignature(x)).not.toBe(editSignature(A));
    expect(groupTodoItems([x, y, z]).map((g) => g.items.length)).toEqual([2, 1]);
  });

  it("groups pure schema edits (no description change) by the schema change alone", () => {
    const addRequired = { ...SCHEMA, properties: { q: { type: "string" }, n: { type: "number" } }, required: ["n"] };
    const s1 = item("server-a", "s1", "Same.", "Same.", { descriptionChange: "none", schemaChange: "non-additive", after: { description: "Same.", inputSchema: addRequired } });
    const s2 = item("server-b", "s2", "Also same.", "Also same.", { descriptionChange: "none", schemaChange: "non-additive", after: { description: "Also same.", inputSchema: addRequired } });
    expect(groupTodoItems([s1, s2])).toHaveLength(1);
  });

  it("gives a stable id, preserves input order, and puts every item in exactly one group", () => {
    const items = [A, D, B, C];
    const first = groupTodoItems(items);
    const second = groupTodoItems([...items]);
    expect(first.map((g) => g.id)).toEqual(second.map((g) => g.id));
    expect(first[0]?.id).toMatch(/^[0-9a-f]{12}$/);
    expect(first.flatMap((g) => g.items).map((i) => i.key).sort()).toEqual(items.map((i) => i.key).sort());
    expect(groupTodoItems([])).toEqual([]);
  });
});

const todoOf = (items: TodoItem[]): LabelsTodoFile => ({ $comment: "fixture", generatedAt: "2026-10-06T00:00:00Z", taxonomyBlobSha: BLOB, items });

async function run(items: TodoItem[], answers: Array<string | null>, opts: { groupIdentical?: boolean; labels?: LabelsFile } = {}) {
  const printed: string[] = [];
  const prompts: string[] = [];
  const queue = [...answers];
  const saves: LabelsFile[] = [];
  const summary = await runChangeLabelSession({
    todo: todoOf(items),
    labels: opts.labels ?? emptyLabelsFile(),
    labeledBy: "Fixture Labeller",
    taxonomyBlobSha: BLOB,
    io: {
      ask: async (p) => {
        prompts.push(p);
        return queue.length === 0 ? null : queue.shift()!;
      },
      print: (t) => printed.push(t),
    },
    style: makeStyle(false),
    now: () => new Date("2026-10-06T02:00:00Z"),
    save: async (l) => {
      saves.push(l);
    },
    ...(opts.groupIdentical === undefined ? {} : { groupIdentical: opts.groupIdentical }),
  });
  return { summary, printed, prompts, saves, last: saves.at(-1) ?? emptyLabelsFile() };
}

describe("runChangeLabelSession with groupIdentical", () => {
  it("asks once per group and applies the answer to every member, recording the group and its size", async () => {
    const { summary, prompts, last } = await run([A, D, B, C], ["i", "c"], { groupIdentical: true });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("label for all 3 tools");
    expect(prompts[1]).not.toContain("for all");
    expect(summary).toMatchObject({ shown: 4, decided: 4, skipped: 0, remaining: 0, quit: false });

    const byTool = new Map(last.labels.map((l) => [l.toolName, l]));
    for (const name of ["make_picture", "check_picture", "list_pictures"]) {
      expect(byTool.get(name)?.label).toBe("semantic-intent");
      expect(byTool.get(name)?.appliedByGroup).toEqual({ groupId: groupTodoItems([A])[0]?.id, groupSize: 3 });
    }
    expect(byTool.get("send_note")?.label).toBe("cosmetic");
    expect(byTool.get("send_note")?.appliedByGroup).toBeUndefined();
    expect(byTool.get("make_picture")?.labeledBy).toBe("Fixture Labeller");
  });

  it("lists every tool in the group, says how many groups there are, and shows no proposed class or reason", async () => {
    const { printed } = await run([A, D, B, C], ["q"], { groupIdentical: true });
    const text = printed.join("\n");
    expect(text).toContain("4 of 4 items need a decision, in 2 groups of identical edits");
    expect(text).toContain("the same edit on 3 tools");
    for (const name of ["make_picture", "check_picture", "list_pictures"]) expect(text).toContain(name);
    expect(text).toContain("{+or video+}");
    expect(text).not.toMatch(/proposed/i);
    expect(text).not.toContain("FIXTURE-REASON-MUST-NOT-BE-SHOWN");
    expect(text).not.toMatch(/capability class/i);
  });

  it("saves after every group, and resumes with only the groups left", async () => {
    const first = await run([A, D, B, C], ["i", "q"], { groupIdentical: true });
    expect(first.saves).toHaveLength(1);
    expect(first.last.labels).toHaveLength(3);
    const second = await run([A, D, B, C], ["a"], { groupIdentical: true, labels: first.last });
    expect(second.printed.join("\n")).toContain("1 of 4 items need a decision, in 1 groups");
    expect(second.last.labels).toHaveLength(4);
  });

  it("a skipped group is recorded as skip with no group record, and comes round again", async () => {
    const skipped = await run([A, B, C], ["s"], { groupIdentical: true });
    expect(skipped.summary).toMatchObject({ decided: 0, skipped: 3, remaining: 3 });
    expect(skipped.last.labels.every((l) => l.label === "skip" && l.appliedByGroup === undefined)).toBe(true);
    const again = await run([A, B, C], ["c"], { groupIdentical: true, labels: skipped.last });
    expect(again.printed.join("\n")).toContain("(skipped before)");
    expect(again.last.labels.every((l) => l.label === "cosmetic" && l.appliedByGroup?.groupSize === 3)).toBe(true);
  });

  it("only groups the items that are still open: a member already labelled is not touched", async () => {
    const done = await run([B], ["a"], { groupIdentical: true });
    const rest = await run([A, B, C], ["i"], { groupIdentical: true, labels: done.last });
    const byTool = new Map(rest.last.labels.map((l) => [l.toolName, l]));
    expect(byTool.get("check_picture")?.label).toBe("schema-additive");
    expect(byTool.get("make_picture")?.appliedByGroup?.groupSize).toBe(2);
    expect(byTool.get("list_pictures")?.appliedByGroup?.groupSize).toBe(2);
  });

  it("without groupIdentical every item still gets its own prompt, and no group is recorded", async () => {
    const { prompts, last, printed } = await run([A, B, C], ["i", "i", "i"]);
    expect(prompts).toHaveLength(3);
    expect(last.labels.every((l) => l.appliedByGroup === undefined)).toBe(true);
    expect(printed.join("\n")).not.toContain("groups of identical edits");
  });
});

describe("labels file with appliedByGroup", () => {
  it("round-trips a group record and rejects a group of fewer than two", async () => {
    const { last } = await run([A, B], ["i"], { groupIdentical: true });
    expect(parseLabelsFile(JSON.parse(JSON.stringify(last)), "fixture").labels[0]?.appliedByGroup?.groupSize).toBe(2);
    const bad = JSON.parse(JSON.stringify(last));
    bad.labels[0].appliedByGroup.groupSize = 1;
    expect(() => parseLabelsFile(bad, "fixture")).toThrow(/not a valid labels file/);
  });
});
