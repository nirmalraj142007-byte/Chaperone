/**
 * crawl-1 against itself, from the committed archives: the pipeline's
 * identity check. It must show exactly zero change and zero classifier
 * artifacts. Reads data/, writes nothing.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyseDrift, defaultCapabilitiesPath, emptyLabelsFile, loadCandidates, loadSnapshot, parseScheduledDates } from "../src/index.js";
import { REAL_DATA_DIR, REPO_ROOT } from "./fixtures/drift-fixture.js";

describe("dry run: crawl-1 vs crawl-1 on the real committed archives", () => {
  it("shows 0 drift and 0 classifier artifacts over all 152 servers and 6058 tools", async () => {
    const crawl1 = await loadSnapshot({ dataDir: REAL_DATA_DIR, crawlId: "crawl-1", capabilitiesPath: defaultCapabilitiesPath(REAL_DATA_DIR, "crawl-1") });
    const result = await analyseDrift({
      crawl1,
      later: crawl1,
      interim: null,
      labels: emptyLabelsFile(),
      // The script looks this up with `git log --find-object`; injected here so CI's shallow checkout can run it.
      taxonomy: { firstCommitAt: "2026-09-12T17:08:55+05:30", workingTreeBlobSha: crawl1.taxonomyBlobSha },
      candidates: await loadCandidates(path.join(REPO_ROOT, "corpus", "candidates.json")),
      scheduled: parseScheduledDates(await readFile(path.join(REPO_ROOT, "CRAWL_DATES.md"), "utf8")),
      checkSignal: null,
      now: new Date("2026-09-26T00:00:00.000Z"),
    });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    const r = result.report;
    expect(r.n).toBe(152);
    expect(r.interval).toBe(0);
    expect(r.toolEvents).toEqual({ unchanged: 6058, cosmetic: 0, schemaAdditive: 0, semanticIntent: 0, toolAdded: 0, toolRemoved: 0 });
    expect(r.pairing.serverAbsentInLaterCrawl.servers).toBe(0);
    expect(r.semanticIntent).toEqual({ servers: 152, drifted: 0, ratePct: 0 });
    expect(r.classifier).toMatchObject({ version: "v2", recomputedMismatches: 0, artifacts: [] });
    expect(r.labels).toMatchObject({ required: 0, human: 0, mechanical: 0 });
    expect(r.byCapability.reduce((sum, s) => sum + s.servers, 0)).toBe(152);
    expect(r.riderC.status).toBe("gate-not-met");
  }, 60_000);
});

describe("loader refuses inconsistent evidence", () => {
  async function scratch(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "chaperone-analysis-loader-"));
    await mkdir(path.join(dir, "raw", "crawl-x"), { recursive: true });
    return dir;
  }
  const tool = { name: "get_item", description: "Returns the item.", inputSchema: { type: "object" } };
  async function write(dir: string, report: object, archives: object[], rows: object[]): Promise<void> {
    await writeFile(path.join(dir, "crawl-x-report.json"), JSON.stringify({ crawlId: "crawl-x", startedAt: "2026-10-02T00:00:00Z", attempted: 1, taxonomyBlobSha: "b", ...report }));
    for (const a of archives as Array<{ serverId: string }>) {
      await writeFile(path.join(dir, "raw", "crawl-x", `${a.serverId}.json`), JSON.stringify(a));
    }
    await writeFile(path.join(dir, "crawl-x-capabilities.json"), JSON.stringify(rows));
  }
  const load = (dir: string) => loadSnapshot({ dataDir: dir, crawlId: "crawl-x", capabilitiesPath: path.join(dir, "crawl-x-capabilities.json") });
  const row = { serverId: "s1", toolName: "get_item", capabilityClass: "read", classifierVersion: "v2" };

  it("loads a consistent crawl", async () => {
    const dir = await scratch();
    await write(dir, { bootedServerIds: ["s1"] }, [{ serverId: "s1", status: "BOOTED", tools: [tool] }, { serverId: "s2", status: "FAILED_START" }], [row]);
    const snap = await load(dir);
    expect(snap.bootedServerIds).toEqual(["s1"]);
    expect(snap.servers.get("s1")!.get("get_item")!.sha256).toMatch(/^sha256:/);
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ["a reported server with no BOOTED archive", { bootedServerIds: ["s1", "s2"] }, [{ serverId: "s1", status: "BOOTED", tools: [tool] }], [row], /disagree/],
    ["a BOOTED archive the report omits", { bootedServerIds: [] }, [{ serverId: "s1", status: "BOOTED", tools: [tool] }], [], /disagree/],
    ["a duplicate tool name", { bootedServerIds: ["s1"] }, [{ serverId: "s1", status: "BOOTED", tools: [tool, tool] }], [row], /twice/],
    ["an unstamped capability row", { bootedServerIds: ["s1"] }, [{ serverId: "s1", status: "BOOTED", tools: [tool] }], [{ ...row, classifierVersion: undefined }], /\(unstamped\)/],
    ["a v1 capability row", { bootedServerIds: ["s1"] }, [{ serverId: "s1", status: "BOOTED", tools: [tool] }], [{ ...row, classifierVersion: "v1" }], /classifier v1, not v2/],
    ["a class that does not reproduce under v2", { bootedServerIds: ["s1"] }, [{ serverId: "s1", status: "BOOTED", tools: [tool] }], [{ ...row, capabilityClass: "transact" }], /do not reproduce/],
    ["a tool with no capability row", { bootedServerIds: ["s1"] }, [{ serverId: "s1", status: "BOOTED", tools: [tool] }], [], /has no row/],
    ["an extra capability row", { bootedServerIds: ["s1"] }, [{ serverId: "s1", status: "BOOTED", tools: [tool] }], [row, { ...row, toolName: "ghost" }], /2 rows for 1 archived tools/],
    ["a duplicated bootedServerId", { bootedServerIds: ["s1", "s1"] }, [{ serverId: "s1", status: "BOOTED", tools: [tool] }], [row], /twice in bootedServerIds/],
    ["a report for a different crawl", { crawlId: "crawl-y", bootedServerIds: [] }, [], [], /says crawlId "crawl-y"/],
  ])("refuses %s", async (_name, report, archives, rows, error) => {
    const dir = await scratch();
    await write(dir, report, archives, rows);
    await expect(load(dir)).rejects.toThrow(error);
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a missing report, a missing raw directory, malformed JSON and a misnamed archive", async () => {
    const dir = await scratch();
    await expect(load(dir)).rejects.toThrow(/not found/);
    await writeFile(path.join(dir, "crawl-x-report.json"), "{ not json");
    await expect(load(dir)).rejects.toThrow(/not valid JSON/);
    await writeFile(path.join(dir, "crawl-x-report.json"), JSON.stringify({ crawlId: "crawl-x" }));
    await expect(load(dir)).rejects.toThrow(/expected shape/);
    await write(dir, { bootedServerIds: [] }, [], []);
    await writeFile(path.join(dir, "raw", "crawl-x", "wrong-name.json"), JSON.stringify({ serverId: "s1", status: "BOOTED", tools: [tool] }));
    await expect(load(dir)).rejects.toThrow(/does not match its file name/);
    await rm(path.join(dir, "raw"), { recursive: true, force: true });
    await expect(load(dir)).rejects.toThrow(/raw archive directory/);
    await rm(dir, { recursive: true, force: true });
  });

  it("the committed crawl-1 capability file is the v2 one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "chaperone-analysis-v1-"));
    await copyFile(path.join(REAL_DATA_DIR, "crawl-1-report.json"), path.join(dir, "crawl-1-report.json"));
    expect(defaultCapabilitiesPath(REAL_DATA_DIR, "crawl-1")).toMatch(/crawl-1-capabilities-v2\.json$/);
    expect(defaultCapabilitiesPath(REAL_DATA_DIR, "crawl-2")).toMatch(/crawl-2-capabilities\.json$/);
    await rm(dir, { recursive: true, force: true });
  });
});
