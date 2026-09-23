/**
 * Re-runs the v2 capability classifier over crawl 1's already-archived tool
 * definitions and writes the result to a SEPARATE file — never touches
 * `data/crawl-1-capabilities.json` (v1's frozen record) or anything under
 * `data/raw/crawl-1/` (the frozen raw archives crawl 1 wrote).
 *
 * Why this exists: v1's write-verb list had no verb matching "add", so a
 * tool like `add_to_list(item)` — TAXONOMY.md's own Axis 2 `write`
 * example — defaulted to read/low under v1. Found 2026-09-20. Capability
 * class is assigned once, at first observation (TAXONOMY.md, Axis 2), so
 * crawl 1's frozen v1 labels can never be edited in place — this script
 * produces the v2 labels crawl 1's evidence *would* have gotten under the
 * corrected classifier, as its own artifact, so both are on record and
 * Phase 19's drift analysis can choose (and must choose the SAME version
 * for both crawls — see CLAUDE.md "Capability classifier versioning").
 *
 * Input: data/raw/crawl-1/*.json (each file is one server's boot result,
 * `{ serverId, status, tools: [{ name, description, inputSchema }, ...] }`
 * — only BOOTED servers have tools) and data/crawl-1-capabilities.json
 * (v1's labels, read only for the transition table below).
 *
 * Output: data/crawl-1-capabilities-v2.json (same row shape as v1's file,
 * plus `classifierVersion`) and a v1 -> v2 transition table printed to
 * stdout. Deterministic and reproducible: classifyCapability is a pure
 * function of the archived tool text, so re-running this script against
 * the same (frozen, never-changing) raw archives always reproduces the
 * exact same output file and the exact same transition table.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCapability, type CapabilityVerdict } from "@chaperone/policy";
import type { ToolDefinition } from "@chaperone/policy";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const RAW_DIR = path.join(REPO_ROOT, "data", "raw", "crawl-1");
const V1_CAPABILITIES_PATH = path.join(REPO_ROOT, "data", "crawl-1-capabilities.json");
const V2_OUTPUT_PATH = path.join(REPO_ROOT, "data", "crawl-1-capabilities-v2.json");

interface V1CapabilityRow {
  serverId: string;
  toolName: string;
  capabilityClass: string;
  confidence: string;
}

interface RawArchive {
  serverId: string;
  status: string;
  tools?: ToolDefinition[];
}

interface V2CapabilityRow {
  serverId: string;
  toolName: string;
  capabilityClass: string;
  confidence: string;
  classifierVersion: "v2";
}

function toolKey(serverId: string, toolName: string): string {
  return `${serverId}\u0000${toolName}`;
}

async function loadV1Capabilities(): Promise<Map<string, V1CapabilityRow>> {
  const raw = await readFile(V1_CAPABILITIES_PATH, "utf8");
  const rows = JSON.parse(raw) as V1CapabilityRow[];
  return new Map(rows.map((row) => [toolKey(row.serverId, row.toolName), row]));
}

async function loadRawArchives(): Promise<RawArchive[]> {
  const files = await readdir(RAW_DIR);
  const archives: RawArchive[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    const raw = await readFile(path.join(RAW_DIR, file), "utf8");
    archives.push(JSON.parse(raw) as RawArchive);
  }
  return archives;
}

async function main(): Promise<void> {
  const v1ByKey = await loadV1Capabilities();
  const archives = await loadRawArchives();

  const v2Rows: V2CapabilityRow[] = [];
  // Keyed "v1class>v2class" so the table prints in a stable, sorted order.
  const transitions = new Map<string, number>();
  let missingV1Label = 0;

  for (const archive of archives) {
    if (archive.status !== "BOOTED" || !archive.tools) continue;
    for (const tool of archive.tools) {
      const verdict: CapabilityVerdict = classifyCapability(tool, "v2");
      v2Rows.push({
        serverId: archive.serverId,
        toolName: tool.name,
        capabilityClass: verdict.class,
        confidence: verdict.confidence,
        classifierVersion: "v2",
      });

      const v1Row = v1ByKey.get(toolKey(archive.serverId, tool.name));
      if (!v1Row) {
        missingV1Label++;
        continue;
      }
      const key = `${v1Row.capabilityClass} -> ${verdict.class}`;
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
    }
  }

  v2Rows.sort((a, b) => (a.serverId === b.serverId ? a.toolName.localeCompare(b.toolName) : a.serverId.localeCompare(b.serverId)));

  await writeFile(V2_OUTPUT_PATH, `${JSON.stringify(v2Rows, null, 2)}\n`, "utf8");

  const moved = [...transitions.entries()].filter(([key]) => {
    const [from, , to] = key.split(" ");
    return from !== to;
  });
  const totalMoved = moved.reduce((sum, [, count]) => sum + count, 0);

  console.log(`reclassify-crawl-1-v2: wrote ${v2Rows.length} rows to data/crawl-1-capabilities-v2.json`);
  if (missingV1Label > 0) {
    console.log(`  (${missingV1Label} tool(s) in the raw archives had no matching v1 row — excluded from the transition table)`);
  }
  console.log("");
  console.log("v1 -> v2 transition table (unchanged classes omitted; see console for full counts):");
  for (const [key, count] of [...transitions.entries()].sort()) {
    console.log(`  ${key.padEnd(20)} ${count}`);
  }
  console.log("");
  console.log(`  total tools reclassified into a DIFFERENT class: ${totalMoved} of ${v2Rows.length}`);
}

main().catch((e: unknown) => {
  console.error("reclassify-crawl-1-v2: failed —", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
