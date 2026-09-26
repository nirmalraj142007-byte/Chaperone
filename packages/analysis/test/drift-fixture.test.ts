/**
 * End to end over a TEST FIXTURE (test/fixtures/README.md): real crawl-1
 * evidence plus invented interim and crawl-2 snapshots, each mutation built
 * to land in one specific bucket. Everything is written to a temp dir; the
 * repository's data/ is only read.
 */
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AnalyseInput,
  type LabelsFile,
  type LabelsTodoFile,
  type Snapshot,
  analyseDrift,
  buildLabelsTodoFile,
  defaultCapabilitiesPath,
  emptyLabelsFile,
  labelKey,
  loadCandidates,
  loadSnapshot,
  makeStyle,
  runChangeLabelSession,
  writeDriftReport,
} from "../src/index.js";
import { REAL_DATA_DIR, REPO_ROOT, S, buildDriftFixture } from "./fixtures/drift-fixture.js";

const TAXONOMY_BLOB = "0c896539006dbb6f8dfacc1f02ebbf179c50eec2";
/** Value of `git log --find-object` for that blob, as recorded in CRAWL_DATES.md's history; injected so this test needs no git. */
const TAXONOMY_FIRST_COMMIT = "2026-09-12T17:08:55+05:30";

let dir: string;
let crawl1: Snapshot;
let interim: Snapshot;
let crawl2: Snapshot;
let base: Omit<AnalyseInput, "labels">;

const load = (crawlId: string, dataDir = dir) => loadSnapshot({ dataDir, crawlId, capabilitiesPath: defaultCapabilitiesPath(dataDir, crawlId) });

beforeAll(async () => {
  dir = await buildDriftFixture();
  [crawl1, interim, crawl2] = await Promise.all([load("crawl-1"), load("crawl-interim-1"), load("crawl-2")]);
  base = {
    crawl1,
    later: crawl2,
    interim,
    taxonomy: { firstCommitAt: TAXONOMY_FIRST_COMMIT, workingTreeBlobSha: TAXONOMY_BLOB },
    candidates: await loadCandidates(path.join(REPO_ROOT, "corpus", "candidates.json")),
    scheduled: { crawl1: "2026-09-15", crawl2: "2026-10-20" },
    checkSignal: null,
    now: new Date("2026-10-21T00:00:00.000Z"),
  };
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A scripted labeller: answers by server, the way a person reading each item would. */
function scriptedAnswers(todo: LabelsTodoFile): string[] {
  return todo.items.map((item) => (item.serverId === S.typoHumanCosmetic.serverId ? "c" : "i"));
}

async function labelEverything(todo: LabelsTodoFile, answers: string[], labels: LabelsFile = emptyLabelsFile()): Promise<LabelsFile> {
  let saved = labels;
  const queue = [...answers];
  await runChangeLabelSession({
    todo,
    labels,
    labeledBy: "Fixture Labeller",
    taxonomyBlobSha: TAXONOMY_BLOB,
    io: { ask: async () => queue.shift() ?? null, print: () => undefined },
    style: makeStyle(false),
    now: () => new Date("2026-10-21T01:00:00.000Z"),
    save: async (l) => {
      saved = l;
    },
  });
  return saved;
}

describe("drift analysis over the three-snapshot fixture", () => {
  it("stops for labels first, listing exactly the pairs a person must judge", async () => {
    const result = await analyseDrift({ ...base, labels: emptyLabelsFile() });
    expect(result.status).toBe("needs-labels");
    if (result.status !== "needs-labels") return;

    const byServer = new Map(result.todo.map((t) => [t.serverId, t]));
    // cosmetic (formatting only) and schema-additive (optional field) are mechanical: never asked.
    expect(byServer.has(S.cosmetic.serverId)).toBe(false);
    expect(byServer.has(S.schemaAdditive.serverId)).toBe(false);

    const semantic = byServer.get(S.semanticByInterim.serverId)!;
    expect(semantic.proposed).toBe("semantic-intent");
    expect(semantic.descriptionChange).toBe("words");
    // Same bytes at interim and crawl 2, so one label serves both comparisons.
    expect(semantic.comparisons.sort()).toEqual(["crawl-1 -> crawl-2", "crawl-1 -> crawl-interim-1"]);

    const required = byServer.get(S.semanticRequired.serverId)!;
    expect(required.schemaChange).toBe("non-additive");
    expect(required.descriptionChange).toBe("none");
    expect(required.comparisons.sort()).toEqual(["crawl-1 -> crawl-2", "crawl-interim-1 -> crawl-2"]);

    expect(byServer.get(S.typoHumanCosmetic.serverId)!.proposed).toBe("semantic-intent");
    expect(byServer.get(S.absentAtInterim.serverId)!.comparisons).toEqual(["crawl-1 -> crawl-2"]);

    // The reversion needs two labels: the change at interim, and the change back.
    const reversionItems = result.todo.filter((t) => t.serverId === S.reversion.serverId);
    expect(reversionItems.map((t) => t.comparisons[0]).sort()).toEqual(["crawl-1 -> crawl-interim-1", "crawl-interim-1 -> crawl-2"]);

    expect(result.todo).toHaveLength(6);
    expect(result.labelsRequired).toBe(6);
  });

  it("the labelling tool resumes: quit half-way, run again, nothing is asked twice", async () => {
    const first = await analyseDrift({ ...base, labels: emptyLabelsFile() });
    if (first.status !== "needs-labels") throw new Error("expected needs-labels");
    const todo = buildLabelsTodoFile(first.todo, TAXONOMY_BLOB, "2026-10-21T00:00:00.000Z");
    const answers = scriptedAnswers(todo);

    const partial = await labelEverything(todo, [...answers.slice(0, 2), "q"]);
    expect(partial.labels).toHaveLength(2);

    const resumed = await analyseDrift({ ...base, labels: partial });
    expect(resumed.status).toBe("needs-labels");
    if (resumed.status !== "needs-labels") return;
    expect(resumed.todo).toHaveLength(4);

    const remainingTodo = buildLabelsTodoFile(resumed.todo, TAXONOMY_BLOB, "2026-10-21T00:00:00.000Z");
    const full = await labelEverything(todo, answers.slice(2), partial);
    expect(full.labels).toHaveLength(6);
    expect(full.labels.every((l) => l.labeledBy === "Fixture Labeller" && l.taxonomyBlobSha === TAXONOMY_BLOB)).toBe(true);
    expect(remainingTodo.items.every((i) => !partial.labels.some((l) => l.key === i.key))).toBe(true);
  });

  describe("once labelled", () => {
    let report: Extract<Awaited<ReturnType<typeof analyseDrift>>, { status: "complete" }>["report"];

    beforeAll(async () => {
      const first = await analyseDrift({ ...base, labels: emptyLabelsFile() });
      if (first.status !== "needs-labels") throw new Error("expected needs-labels");
      const todo = buildLabelsTodoFile(first.todo, TAXONOMY_BLOB, "2026-10-21T00:00:00.000Z");
      const labels = await labelEverything(todo, scriptedAnswers(todo));
      const result = await analyseDrift({ ...base, labels });
      if (result.status !== "complete") throw new Error("expected complete");
      report = result.report;
    });

    it("pairs on (serverId, toolName) into the four buckets, from crawl 1's bootedServerIds", () => {
      const toolsOf = (id: string) => crawl1.servers.get(id)!.size;
      expect(report.n).toBe(151);
      expect(report.capturedBothCrawls.count).toBe(151);
      expect(report.capturedBothCrawls.serverIds).not.toContain(S.absentAtCrawl2.serverId);
      expect(report.pairing.serverAbsentInLaterCrawl).toEqual({ servers: 1, tools: toolsOf(S.absentAtCrawl2.serverId), serverIds: [S.absentAtCrawl2.serverId] });
      expect(report.pairing.toolAdded).toEqual({ servers: 1, tools: 1 });
      expect(report.pairing.toolRemoved).toEqual({ servers: 1, tools: 1 });
      expect(report.pairing.presentInBoth).toEqual({ servers: 151, tools: 6058 - toolsOf(S.absentAtCrawl2.serverId) - 1 });
    });

    it("classifies each mutation into its class, and only semantic-intent reaches the headline", () => {
      expect(report.toolEvents).toMatchObject({ cosmetic: 2, schemaAdditive: 1, semanticIntent: 3, toolAdded: 1, toolRemoved: 1 });
      expect(report.countedSeparately).toMatchObject({ cosmetic: 2, schemaAdditive: 1, toolAdded: 1, toolRemoved: 1 });
      // drifted = the calendar clause, the required field, and the server absent at interim.
      // Not: cosmetic, schema-additive, the typo a person called cosmetic, the reversion, add/remove.
      expect(report.semanticIntent).toEqual({ servers: 151, drifted: 3, ratePct: 2 });
      expect(report.labels).toMatchObject({ required: 6, human: 6, mechanical: 2, humanOverrodeProposal: 1 });
    });

    it("computes the interval from the timestamps: 35 calendar days although crawl 2 started earlier in the day", () => {
      expect(report.interval).toBe(35);
      expect(report.timeToFirstChange.daysCrawl1ToInterim).toBe(17);
      expect(report.timeToFirstChange.daysInterimToCrawl2).toBe(18);
    });

    it("reports time to first change in two bins, plus drifted servers the interim crawl missed", () => {
      expect(report.timeToFirstChange).toMatchObject({
        headline: false,
        observedAtInterim: 1,
        firstObservedOnlyAtCrawl2: 1,
        driftedNotCapturedAtInterim: 1,
      });
    });

    it("detects the reversion, and keeps it out of the headline", () => {
      expect(report.timeToFirstChange.changedThenRevertedByCrawl2).toBe(1);
      expect(report.timeToFirstChange.reversions).toEqual([
        expect.objectContaining({ serverId: S.reversion.serverId, toolName: S.reversion.tool, interimClass: "semantic-intent" }),
      ]);
      const r = report.timeToFirstChange.reversions![0]!;
      expect(r.crawl1Sha256).toBe(crawl1.servers.get(S.reversion.serverId)!.get(S.reversion.tool)!.sha256);
      expect(r.interimSha256).not.toBe(r.crawl1Sha256);
    });

    it("segments are structure, over the servers the interim crawl also captured", () => {
      expect(report.segments).not.toBeNull();
      expect(report.segments!.headline).toBe(false);
      expect(report.segments!.crawl1ToInterim).toMatchObject({ n: 150, semanticIntentServers: 2 });
      expect(report.segments!.interimToCrawl2).toMatchObject({ n: 150, semanticIntentServers: 2 });
    });

    it("stratifies servers by their highest crawl-1 capability class, summing back to the flat numbers", () => {
      expect(report.byCapability.map((s) => s.capabilityClass)).toEqual(["transact", "communicate", "write", "read"]);
      expect(report.byCapability.reduce((sum, s) => sum + s.servers, 0)).toBe(report.n);
      expect(report.byCapability.reduce((sum, s) => sum + s.drifted, 0)).toBe(report.semanticIntent.drifted);
      expect(report.sentences.flat).toContain("Of 151 MCP servers captured in both crawls, 3 (2.0%)");
      expect(report.sentences.flat).toContain("in the 35 days from 2026-09-15 to 2026-10-20");
      expect(report.sentences.stratified).toMatch(/^Semantic-intent drift by what a server's tools can do: transact \d+ of \d+ \(/);
    });

    it("keeps rider C off below the 0.20 gate, saying why", () => {
      expect(report.riderC).toMatchObject({ status: "gate-not-met", gateMet: false, driftedServers: null, verdict: null });
      expect(report.riderC.gateReason).toContain("below the 0.20 gate");
    });

    it("refuses to write a fixture's report to data/drift.json, and never touches it", async () => {
      const before = await stat(path.join(REAL_DATA_DIR, "drift.json"));
      const driftPath = path.join(REPO_ROOT, "data", "drift.json");
      await expect(writeDriftReport(driftPath, REPO_ROOT, { earlier: "crawl-1", later: "crawl-1", dryRun: true }, report)).rejects.toThrow(/refusing to write/);
      await expect(writeDriftReport(driftPath, REPO_ROOT, { earlier: "crawl-1", later: "crawl-interim-1", dryRun: false }, report)).rejects.toThrow(/refusing to write/);
      const tmpOut = path.join(dir, "drift.json");
      await writeDriftReport(tmpOut, REPO_ROOT, { earlier: "crawl-1", later: "crawl-2", dryRun: false }, report);
      expect(JSON.parse(await readFile(tmpOut, "utf8"))).toMatchObject({ status: "complete", n: 151 });
      const after = await stat(path.join(REAL_DATA_DIR, "drift.json"));
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });
  });

  it("a label is bound to the exact pair of definitions: a different after-hash does not reuse it", async () => {
    const pair = crawl1.servers.get(S.semanticByInterim.serverId)!.get(S.semanticByInterim.tool)!;
    const staleKey = labelKey(pair.serverId, pair.toolName, pair.sha256, "sha256:not-the-crawl-2-definition");
    const labels: LabelsFile = {
      labels: [
        {
          key: staleKey,
          serverId: pair.serverId,
          toolName: pair.toolName,
          beforeSha256: pair.sha256,
          afterSha256: "sha256:not-the-crawl-2-definition",
          label: "cosmetic",
          proposed: "semantic-intent",
          labeledBy: "Fixture Labeller",
          labeledAt: "2026-10-21T00:00:00.000Z",
          taxonomyBlobSha: TAXONOMY_BLOB,
        },
      ],
    };
    const result = await analyseDrift({ ...base, labels });
    expect(result.status).toBe("needs-labels");
    if (result.status === "needs-labels") {
      expect(result.todo.some((t) => t.serverId === S.semanticByInterim.serverId)).toBe(true);
    }
  });

  it("refuses a label made against a different taxonomy blob", async () => {
    const first = await analyseDrift({ ...base, labels: emptyLabelsFile() });
    if (first.status !== "needs-labels") throw new Error("expected needs-labels");
    const item = first.todo[0]!;
    const labels: LabelsFile = {
      labels: [
        {
          key: item.key,
          serverId: item.serverId,
          toolName: item.toolName,
          beforeSha256: item.beforeSha256,
          afterSha256: item.afterSha256,
          label: "semantic-intent",
          proposed: item.proposed,
          labeledBy: "Fixture Labeller",
          labeledAt: "2026-10-21T00:00:00.000Z",
          taxonomyBlobSha: "ffffffffffffffffffffffffffffffffffffffff",
        },
      ],
    };
    await expect(analyseDrift({ ...base, labels })).rejects.toThrow(/was made against corpus\/TAXONOMY.md blob/);
  });

  it("without an interim crawl, the interim-only fields stay null and the headline is unchanged", async () => {
    const first = await analyseDrift({ ...base, interim: null, labels: emptyLabelsFile() });
    if (first.status !== "needs-labels") throw new Error("expected needs-labels");
    expect(first.todo).toHaveLength(4); // no reversion pairs, no interim-only comparisons
    const todo = buildLabelsTodoFile(first.todo, TAXONOMY_BLOB, "2026-10-21T00:00:00.000Z");
    const result = await analyseDrift({ ...base, interim: null, labels: await labelEverything(todo, scriptedAnswers(todo)) });
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.report.segments).toBeNull();
    expect(result.report.timeToFirstChange).toMatchObject({ observedAtInterim: null, reversions: null, daysCrawl1ToInterim: null });
    expect(result.report.semanticIntent).toEqual({ servers: 151, drifted: 3, ratePct: 2 });
    expect(result.report.attempted.interim).toBeNull();
  });
});
