/**
 * Each pre-registration gate, made to fire. The snapshots here are small,
 * synthetic and in memory: TEST FIXTURES, never written anywhere.
 */
import { AnalysisError } from "@chaperone/errors";
import { type CapabilityClass, type ToolDefinition, hashTool } from "@chaperone/policy";
import { describe, expect, it, vi } from "vitest";
import {
  type AnalyseInput,
  type Candidate,
  type LabelsFile,
  type Snapshot,
  type SnapshotTool,
  HEADLINE_FLOOR,
  analyseDrift,
  assertTaxonomyPreRegistered,
  headlineEligibility,
  labelKey,
  parseScheduledDates,
  ratePct,
  riderCGate,
  utcCalendarDaysBetween,
} from "../src/index.js";

const BLOB = "0c896539006dbb6f8dfacc1f02ebbf179c50eec2";
const CRAWL1_AT = "2026-09-15T06:19:42.282Z";

const BEFORE: ToolDefinition = { name: "get_item", description: "Returns the item.", inputSchema: { type: "object", properties: {} } };
const AFTER: ToolDefinition = { ...BEFORE, description: "Returns the item and emails a copy to a partner." };

function tool(serverId: string, def: ToolDefinition, capabilityClass: CapabilityClass = "read"): SnapshotTool {
  return { serverId, toolName: def.name, definition: def, sha256: hashTool(def), capabilityClass };
}

function snapshot(crawlId: string, startedAt: string, tools: SnapshotTool[]): Snapshot {
  const servers = new Map<string, Map<string, SnapshotTool>>();
  for (const t of tools) {
    if (!servers.has(t.serverId)) servers.set(t.serverId, new Map());
    servers.get(t.serverId)!.set(t.toolName, t);
  }
  return { crawlId, startedAt, taxonomyBlobSha: BLOB, attempted: tools.length, bootedServerIds: [...servers.keys()].sort(), servers };
}

/** `n` servers captured in both crawls, `drifted` of them with a labelled semantic-intent change. FIXTURE. */
function synthetic(n: number, drifted: number, opts: { withRepo?: (i: number) => boolean } = {}): AnalyseInput {
  const ids = Array.from({ length: n }, (_, i) => `fixture-server-${String(i).padStart(3, "0")}`);
  const crawl1 = snapshot("crawl-1", CRAWL1_AT, ids.map((id) => tool(id, BEFORE)));
  const later = snapshot("crawl-2", "2026-10-20T06:00:00.000Z", ids.map((id, i) => tool(id, i < drifted ? AFTER : BEFORE, i < drifted ? "communicate" : "read")));
  const labels: LabelsFile = {
    labels: ids.slice(0, drifted).map((serverId) => ({
      key: labelKey(serverId, BEFORE.name, hashTool(BEFORE), hashTool(AFTER)),
      serverId,
      toolName: BEFORE.name,
      beforeSha256: hashTool(BEFORE),
      afterSha256: hashTool(AFTER),
      label: "semantic-intent" as const,
      proposed: "semantic-intent" as const,
      labeledBy: "Fixture Labeller",
      labeledAt: "2026-10-21T00:00:00.000Z",
      taxonomyBlobSha: BLOB,
    })),
  };
  const candidates: Candidate[] = ids.map((serverId, i) =>
    (opts.withRepo ?? (() => true))(i) ? { serverId, repoOwner: "fixture-owner", repoName: serverId } : { serverId, repoOwner: null, repoName: null },
  );
  return {
    crawl1,
    later,
    interim: null,
    labels,
    taxonomy: { firstCommitAt: "2026-09-12T17:08:55+05:30", workingTreeBlobSha: BLOB },
    candidates,
    scheduled: { crawl1: "2026-09-15", crawl2: "2026-10-20" },
    checkSignal: null,
    now: new Date("2026-10-21T00:00:00.000Z"),
  };
}

async function complete(input: AnalyseInput) {
  const result = await analyseDrift(input);
  if (result.status !== "complete") throw new Error(`expected complete, got ${result.status}`);
  return result;
}

describe("the n < 100 floor", () => {
  it("fires at n = 99: headlineEligible false, counts kept, every percentage null, reason printed as a floor note", async () => {
    const { report, notes } = await complete(synthetic(99, 30));
    expect(report.headlineEligible).toBe(false);
    expect(report.headlineSuppressedReason).toBe("n = 99 servers captured in both crawls; the floor is 100");
    expect(report.semanticIntent).toEqual({ servers: 99, drifted: 30, ratePct: null });
    expect(report.byCapability.every((s) => s.ratePct === null)).toBe(true);
    expect(report.sentences.flat).not.toMatch(/%/);
    expect(report.sentences.stratified).not.toMatch(/%/);
    expect(report.sentences.flat).toContain("No rate is stated");
    expect(notes).toContainEqual({ level: "floor", text: expect.stringContaining("headline suppressed: n = 99") });
    // And rider C cannot run below the floor, even at 30% drift.
    expect(report.riderC.status).toBe("gate-not-met");
    expect(report.riderC.gateReason).toContain("below the 100-server floor");
  });

  it("does not fire at exactly n = 100", async () => {
    const { report } = await complete(synthetic(100, 5));
    expect(report.headlineEligible).toBe(true);
    expect(report.headlineSuppressedReason).toBeNull();
    expect(report.semanticIntent.ratePct).toBe(5);
  });

  it("headlineEligibility and ratePct agree on the boundary", () => {
    expect(headlineEligibility(HEADLINE_FLOOR - 1).eligible).toBe(false);
    expect(headlineEligibility(HEADLINE_FLOOR).eligible).toBe(true);
    expect(ratePct(1, 3, true)).toBe(33.3);
    expect(ratePct(1, 3, false)).toBeNull();
    expect(ratePct(0, 0, true)).toBeNull();
  });
});

describe("the rider C gate (semanticDriftRate >= 0.20 && n >= 100)", () => {
  it("does not call the changelog checker at 19% drift, and says why", async () => {
    const check = vi.fn();
    const { report } = await complete({ ...synthetic(100, 19), checkSignal: check });
    expect(check).not.toHaveBeenCalled();
    expect(report.riderC).toMatchObject({ status: "gate-not-met", gateMet: false, checkable: null, verdict: null });
    expect(report.riderC.gateReason).toContain("0.190, below the 0.20 gate");
  });

  it("fires at exactly 20%: servers without a repo link are excluded from the denominator and counted separately", async () => {
    // 20 drifted; the first 4 have no repo link. Of the 16 checkable, 3 published something.
    const input = synthetic(100, 20, { withRepo: (i) => i >= 4 });
    const evidence = ["release", "tag", "commit-message"] as const;
    let calls = 0;
    const check = vi.fn(async () => ({ evidence: calls < 3 ? evidence[calls++]! : ("none" as const), evidenceUrl: "https://example.invalid/fixture" }));
    const { report } = await complete({ ...input, checkSignal: check });
    expect(check).toHaveBeenCalledTimes(16);
    expect(check).toHaveBeenCalledWith("fixture-owner", "fixture-server-004", CRAWL1_AT);
    expect(report.riderC).toMatchObject({
      status: "evaluated",
      gateMet: true,
      windowStart: CRAWL1_AT,
      windowEnd: "2026-10-20T06:00:00.000Z",
      windowEndEnforced: false,
      driftedServers: 20,
      checkable: 16,
      unverifiable: 4,
      withPublishedSignal: 3,
      evidenceCounts: { release: 1, tag: 1, "commit-message": 1, none: 13 },
      shareWithSignalOfCheckable: 3 / 16,
      shareWithSignalOfDrifted: 3 / 20,
      verdict: "confirmed",
    });
    expect(report.riderC.perServer).toHaveLength(16);
  });

  it("is inconclusive when the two bounds straddle 0.30, and refuted when both are at or above it", async () => {
    // 20 drifted, 10 checkable. 4 signal: 4/10 = 0.40 (checkable), 4/20 = 0.20 (drifted): straddles.
    const straddle = synthetic(100, 20, { withRepo: (i) => i >= 10 });
    let n = 0;
    const r1 = await complete({ ...straddle, checkSignal: async () => ({ evidence: n++ < 4 ? ("release" as const) : ("none" as const) }) });
    expect(r1.report.riderC.verdict).toBe("inconclusive");
    let m = 0;
    const r2 = await complete({ ...synthetic(100, 20), checkSignal: async () => ({ evidence: m++ < 10 ? ("tag" as const) : ("none" as const) }) });
    expect(r2.report.riderC.verdict).toBe("refuted");
  });

  it("is inconclusive when no drifted server is checkable", async () => {
    const { report } = await complete({ ...synthetic(100, 20, { withRepo: () => false }), checkSignal: async () => ({ evidence: "none" as const }) });
    expect(report.riderC).toMatchObject({ checkable: 0, unverifiable: 20, shareWithSignalOfCheckable: null, verdict: "inconclusive" });
  });

  it("fails rather than omitting rider C when the gate is met and no checker is available", async () => {
    await expect(analyseDrift(synthetic(100, 25))).rejects.toThrow(/rider C cannot be omitted/);
  });

  it("riderCGate reports each reason", () => {
    expect(riderCGate(0.5, 99).met).toBe(false);
    expect(riderCGate(0.199, 150).met).toBe(false);
    expect(riderCGate(0.2, 100)).toEqual({ met: true, reason: expect.stringContaining("gate met") });
  });
});

describe("the taxonomy-date gate", () => {
  it("refuses to run when the TAXONOMY.md blob was first committed after crawl 1 started", async () => {
    const input = synthetic(100, 0);
    const late = { ...input, taxonomy: { ...input.taxonomy, firstCommitAt: "2026-09-15T07:00:00Z" } };
    await expect(analyseDrift(late)).rejects.toThrow(AnalysisError);
    await expect(analyseDrift(late)).rejects.toThrow(/after crawl 1 started .* not pre-registered; refusing to run/);
  });

  it("refuses when no commit contains the blob (e.g. a shallow clone)", () => {
    expect(() => assertTaxonomyPreRegistered({ crawl1BlobSha: BLOB, crawl1StartedAt: CRAWL1_AT, firstCommitAt: null, otherBlobs: [] })).toThrow(
      /no commit in this repository contains/,
    );
  });

  it("refuses when a later report or the working tree names a different blob", async () => {
    const input = synthetic(100, 0);
    await expect(analyseDrift({ ...input, taxonomy: { ...input.taxonomy, workingTreeBlobSha: "f".repeat(40) } })).rejects.toThrow(
      /working tree names corpus\/TAXONOMY.md blob f{40}/,
    );
    await expect(analyseDrift({ ...input, later: { ...input.later, taxonomyBlobSha: "e".repeat(40) } })).rejects.toThrow(/data\/crawl-2-report.json names/);
  });

  it("rejects an unparseable timestamp", () => {
    expect(() => assertTaxonomyPreRegistered({ crawl1BlobSha: BLOB, crawl1StartedAt: "not a date", firstCommitAt: "2026-09-12T00:00:00Z", otherBlobs: [] })).toThrow(
      /unparseable/,
    );
  });

  it("passes at the committed facts: blob committed 2026-09-12, crawl 1 on 2026-09-15", () => {
    expect(() =>
      assertTaxonomyPreRegistered({ crawl1BlobSha: BLOB, crawl1StartedAt: CRAWL1_AT, firstCommitAt: "2026-09-12T17:08:55+05:30", otherBlobs: [{ source: "x", blobSha: BLOB }] }),
    ).not.toThrow();
  });
});

describe("the interval comes from the recorded timestamps, never a constant", () => {
  it("counts UTC calendar days", () => {
    expect(utcCalendarDaysBetween(CRAWL1_AT, "2026-10-20T00:00:01.000Z")).toBe(35);
    expect(utcCalendarDaysBetween(CRAWL1_AT, "2026-10-21T23:59:00.000Z")).toBe(36);
    expect(utcCalendarDaysBetween(CRAWL1_AT, CRAWL1_AT)).toBe(0);
    expect(() => utcCalendarDaysBetween("nope", CRAWL1_AT)).toThrow(AnalysisError);
  });

  it("a crawl 2 that ran a day late reports 36 days, and warns against CRAWL_DATES.md", async () => {
    const input = synthetic(100, 0);
    const lateLater = { ...input.later, startedAt: "2026-10-21T08:00:00.000Z" };
    const { report, notes } = await complete({ ...input, later: lateLater });
    expect(report.interval).toBe(36);
    expect(report.sentences.flat).toContain("in the 36 days from 2026-09-15 to 2026-10-21");
    expect(notes.some((n) => n.level === "warn" && n.text.includes("scheduled 2026-10-20"))).toBe(true);
  });

  it("refuses an interim crawl that is not between the two endpoints, or a later crawl before crawl 1", async () => {
    const input = synthetic(100, 0);
    const interim = { ...input.later, crawlId: "crawl-interim-1", startedAt: "2026-10-25T00:00:00.000Z" };
    await expect(analyseDrift({ ...input, interim })).rejects.toThrow(/does not fall between/);
    await expect(analyseDrift({ ...input, later: { ...input.later, startedAt: "2026-09-01T00:00:00.000Z" } })).rejects.toThrow(/started before crawl 1/);
  });

  it("reads the scheduled dates out of CRAWL_DATES.md's table", () => {
    expect(parseScheduledDates("| Crawl 1 | 2026-09-15 | x |\n| Crawl 2 | 2026-10-20 | y |")).toEqual({ crawl1: "2026-09-15", crawl2: "2026-10-20" });
    expect(() => parseScheduledDates("no table")).toThrow(/does not have the Crawl 1/);
  });
});

describe("classifier stability and corpus freeze", () => {
  it("fails loudly on identical sha256 with a different capability class", async () => {
    const input = synthetic(100, 0);
    const later = snapshot("crawl-2", "2026-10-20T06:00:00.000Z", [...input.later.servers.keys()].map((id, i) => tool(id, BEFORE, i === 0 ? "write" : "read")));
    await expect(analyseDrift({ ...input, later })).rejects.toThrow(/identical sha256 .* different capability class/);
  });

  it("refuses a later crawl that captured a server outside corpus/candidates.json", async () => {
    const input = synthetic(100, 0);
    const extra = snapshot("crawl-2", "2026-10-20T06:00:00.000Z", [...[...input.later.servers.values()].flatMap((m) => [...m.values()]), tool("not-a-candidate", BEFORE)]);
    await expect(analyseDrift({ ...input, later: extra })).rejects.toThrow(/not in corpus\/candidates.json; the corpus is frozen/);
  });

  it("only compares against crawl-1 as the earlier side", async () => {
    const input = synthetic(100, 0);
    await expect(analyseDrift({ ...input, crawl1: { ...input.crawl1, crawlId: "crawl-interim-1" } })).rejects.toThrow(/earlier side of every comparison is crawl-1/);
  });

  it("counts a server that only booted later, but never lets it in", async () => {
    const input = synthetic(100, 0);
    const later = snapshot("crawl-2", "2026-10-20T06:00:00.000Z", [...[...input.later.servers.values()].flatMap((m) => [...m.values()]), tool("late-server", BEFORE)]);
    const { report, notes } = await complete({ ...input, later, candidates: [...input.candidates, { serverId: "late-server" }] });
    expect(report.n).toBe(100);
    expect(notes.some((n) => n.text.startsWith("1 servers booted in crawl-2 but not crawl 1"))).toBe(true);
  });
});
