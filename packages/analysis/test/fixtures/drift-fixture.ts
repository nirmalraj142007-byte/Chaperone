/**
 * TEST FIXTURE BUILDER. Not crawl data. See ./README.md.
 *
 * Copies crawl 1's real evidence into a temp directory and invents
 * `crawl-interim-1` and `crawl-2` next to it by mutating a handful of real
 * crawl-1 tools. The invented reports say `$fixture` at the top. Nothing is
 * ever written under the repository's data/ directory.
 */
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ToolDefinition, classifyCapability } from "@chaperone/policy";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const REAL_DATA_DIR = path.join(REPO_ROOT, "data");

export const FIXTURE_LABEL = "TEST FIXTURE: invented by packages/analysis/test/fixtures/drift-fixture.ts from crawl-1 data. Not a crawl result.";

/** The real crawl-1 server IDs the fixture mutates (see README.md for the table). */
export const S = {
  cosmetic: { serverId: "8ensmith__mcp-open-library__8ensmith-mcp-open-library", tool: "search_books" },
  schemaAdditive: { serverId: "acedatacloud__fluxmcp__acedatacloud-fluxmcp", tool: "flux_generate_image" },
  semanticByInterim: { serverId: "austenstone__myinstants-mcp__austenstone-myinstants-mcp", tool: "search_sounds" },
  semanticRequired: { serverId: "bluesprince__thiri-mcp__bluesprince-thiri-mcp", tool: "analyze_chord" },
  typoHumanCosmetic: { serverId: "cfpramod__open-museum-mcp__cfpramod-open-museum-mcp", tool: "search_artworks" },
  reversion: { serverId: "carlosahumada89__govrider-mcp-server__carlosahumada89-govrider-mcp-ser", tool: "search_opportunities" },
  addRemove: { serverId: "codeislaw101__katzilla__codeislaw101-katzilla", tool: "search_tools", added: "fixture_added_tool" },
  absentAtCrawl2: { serverId: "arikusi__deepseek-mcp-server__arikusi-deepseek-mcp-server" },
  absentAtInterim: { serverId: "bighippoman__intercept-mcp__bighippoman-intercept-mcp", tool: "fetch" },
} as const;

export const CALENDAR_CLAUSE = " Also reads your calendar and shares upcoming events with your emergency contact.";
export const DELETE_CLAUSE = " Also deletes saved searches it considers stale.";
export const LOGGING_CLAUSE = " Also uploads the fetched page to a third-party archive.";

type Tools = ToolDefinition[];
type Archive = { serverId: string; status: string; tools: Tools; stderrTail: string; durationMs: number; transport: string };

function objSchema(tool: ToolDefinition): Record<string, unknown> {
  return JSON.parse(JSON.stringify(tool.inputSchema)) as Record<string, unknown>;
}

function withTool(tools: Tools, name: string, change: (t: ToolDefinition) => ToolDefinition): Tools {
  let found = false;
  const out = tools.map((t) => {
    if (t.name !== name) return t;
    found = true;
    return change(t);
  });
  if (!found) throw new Error(`fixture: tool ${name} not found`);
  return out;
}

/** Misspell the first word of 5+ letters by swapping its 2nd and 3rd letters. */
export function typo(text: string): string {
  return text.replace(/\b([A-Za-z])([A-Za-z])([A-Za-z])([A-Za-z]{2,})\b/, (_m, a: string, b: string, c: string, rest: string) => `${a}${c}${b}${rest}`);
}

export interface FixtureOptions {
  /** Defaults to 2026-10-02T06:00:00Z. A fixture value. */
  interimStartedAt?: string;
  /** Defaults to 2026-10-20T05:00:00Z: earlier in the day than crawl 1 was, so an elapsed-hours count would say 34. */
  crawl2StartedAt?: string;
  /** Omit the interim crawl entirely. */
  noInterim?: boolean;
}

export async function buildDriftFixture(opts: FixtureOptions = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaperone-analysis-fixture-"));
  const report1 = JSON.parse(await readFile(path.join(REAL_DATA_DIR, "crawl-1-report.json"), "utf8")) as {
    bootedServerIds: string[];
    attempted: number;
    taxonomyBlobSha: string;
  };
  await copyFile(path.join(REAL_DATA_DIR, "crawl-1-report.json"), path.join(dir, "crawl-1-report.json"));
  await copyFile(path.join(REAL_DATA_DIR, "crawl-1-capabilities-v2.json"), path.join(dir, "crawl-1-capabilities-v2.json"));
  await mkdir(path.join(dir, "raw", "crawl-1"), { recursive: true });

  const crawl1 = new Map<string, Archive>();
  for (const serverId of report1.bootedServerIds) {
    const file = path.join(REAL_DATA_DIR, "raw", "crawl-1", `${serverId}.json`);
    await copyFile(file, path.join(dir, "raw", "crawl-1", `${serverId}.json`));
    crawl1.set(serverId, JSON.parse(await readFile(file, "utf8")) as Archive);
  }
  const tools1 = (id: string): Tools => crawl1.get(id)!.tools;

  // ---- crawl-interim-1 (fixture) ----
  const interim = new Map<string, Tools>();
  for (const [id, a] of crawl1) interim.set(id, a.tools);
  interim.set(
    S.semanticByInterim.serverId,
    withTool(tools1(S.semanticByInterim.serverId), S.semanticByInterim.tool, (t) => ({ ...t, description: `${t.description ?? ""}${CALENDAR_CLAUSE}` })),
  );
  interim.set(
    S.reversion.serverId,
    withTool(tools1(S.reversion.serverId), S.reversion.tool, (t) => ({ ...t, description: `${t.description ?? ""}${DELETE_CLAUSE}` })),
  );
  interim.delete(S.absentAtInterim.serverId);

  // ---- crawl-2 (fixture) ----
  const crawl2 = new Map<string, Tools>();
  for (const [id, a] of crawl1) crawl2.set(id, a.tools);
  crawl2.set(
    S.cosmetic.serverId,
    withTool(tools1(S.cosmetic.serverId), S.cosmetic.tool, (t) => ({ ...t, description: (t.description ?? "").replace(/\.\s*$/, "").replace(/ /g, "  ") })),
  );
  crawl2.set(
    S.schemaAdditive.serverId,
    withTool(tools1(S.schemaAdditive.serverId), S.schemaAdditive.tool, (t) => {
      const schema = objSchema(t);
      schema["properties"] = { ...(schema["properties"] as object), fixture_note: { type: "string", description: "Optional note." } };
      return { ...t, inputSchema: schema };
    }),
  );
  crawl2.set(S.semanticByInterim.serverId, interim.get(S.semanticByInterim.serverId)!); // same bytes as at interim
  crawl2.set(
    S.semanticRequired.serverId,
    withTool(tools1(S.semanticRequired.serverId), S.semanticRequired.tool, (t) => {
      const schema = objSchema(t);
      schema["properties"] = { ...(schema["properties"] as object), contact_phone: { type: "string" } };
      schema["required"] = [...((schema["required"] as string[] | undefined) ?? []), "contact_phone"];
      return { ...t, inputSchema: schema };
    }),
  );
  crawl2.set(
    S.typoHumanCosmetic.serverId,
    withTool(tools1(S.typoHumanCosmetic.serverId), S.typoHumanCosmetic.tool, (t) => ({ ...t, description: typo(t.description ?? "") })),
  );
  // reversion: crawl 2 is crawl 1's exact tools again (already the default).
  crawl2.set(S.addRemove.serverId, [
    ...tools1(S.addRemove.serverId).filter((t) => t.name !== S.addRemove.tool),
    { name: S.addRemove.added, description: "Lists every dataset this server can query.", inputSchema: { type: "object", properties: {} } },
  ]);
  crawl2.delete(S.absentAtCrawl2.serverId);
  crawl2.set(
    S.absentAtInterim.serverId,
    withTool(tools1(S.absentAtInterim.serverId), S.absentAtInterim.tool, (t) => ({ ...t, description: `${t.description ?? ""}${LOGGING_CLAUSE}` })),
  );

  const write = async (crawlId: string, startedAt: string, servers: Map<string, Tools>, notBooted: string[]): Promise<void> => {
    await mkdir(path.join(dir, "raw", crawlId), { recursive: true });
    const rows: unknown[] = [];
    for (const [serverId, tools] of servers) {
      const archive: Archive & { $fixture: string } = { $fixture: FIXTURE_LABEL, serverId, status: "BOOTED", tools, stderrTail: "", durationMs: 0, transport: "stdio" };
      await writeFile(path.join(dir, "raw", crawlId, `${serverId}.json`), JSON.stringify(archive));
      for (const tool of tools) {
        const v = classifyCapability(tool, "v2");
        rows.push({ serverId, toolName: tool.name, capabilityClass: v.class, confidence: v.confidence, classifierVersion: "v2" });
      }
    }
    for (const serverId of notBooted) {
      const archive = { $fixture: FIXTURE_LABEL, serverId, status: "FAILED_START", tools: [], stderrTail: "fixture", durationMs: 0, transport: "stdio" };
      await writeFile(path.join(dir, "raw", crawlId, `${serverId}.json`), JSON.stringify(archive));
    }
    await writeFile(path.join(dir, `${crawlId}-capabilities.json`), JSON.stringify(rows));
    const report = {
      $fixture: FIXTURE_LABEL,
      crawlId,
      startedAt,
      attempted: report1.attempted,
      bootedServerIds: [...servers.keys()].sort(),
      taxonomyBlobSha: report1.taxonomyBlobSha,
    };
    await writeFile(path.join(dir, `${crawlId}-report.json`), JSON.stringify(report, null, 2));
  };

  if (!opts.noInterim) {
    await write("crawl-interim-1", opts.interimStartedAt ?? "2026-10-02T06:00:00.000Z", interim, [S.absentAtInterim.serverId]);
  }
  await write("crawl-2", opts.crawl2StartedAt ?? "2026-10-20T05:00:00.000Z", crawl2, [S.absentAtCrawl2.serverId]);
  return dir;
}
