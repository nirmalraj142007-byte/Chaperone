/**
 * Does server size (tool count) explain the capability-class pattern in the
 * drift result? Reads only committed data and changes none of it; writes
 * data/size-check.json.
 *
 * Basis: the 149 servers captured in both crawls. Size = tools the server
 * exposed at crawl 1. Server capability class = the highest-consequence class
 * among its crawl-1 tools (transact > communicate > write > read), classifier
 * v2, which is how packages/analysis/src/analyse.ts stratifies. A server
 * "drifted" if at least one of its tools changed definition between crawl 1
 * and crawl 2 and the committed human label for that change is semantic-intent
 * (mechanical classes are never semantic-intent, so labels.json is sufficient).
 * The script checks its own totals against data/drift.json and exits 1 on a
 * mismatch.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hashTool, type ToolDefinition } from "@chaperone/policy";

const read = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const ORDER = ["transact", "communicate", "write", "read"] as const;
type Cls = (typeof ORDER)[number];

function load(crawl: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const f of readdirSync(`data/raw/${crawl}`)) {
    const a = read(`data/raw/${crawl}/${f}`) as { serverId: string; tools: ToolDefinition[] };
    if (!Array.isArray(a.tools) || a.tools.length === 0) continue;
    out.set(a.serverId, new Map(a.tools.map((t) => [t.name, hashTool(t)])));
  }
  return out;
}

const drift = read("data/drift.json");
const both: string[] = drift.capturedBothCrawls.serverIds;
const c1 = load("crawl-1");
const c2 = load("crawl-2");

const semantic = new Set<string>(
  read("data/labels.json").labels.filter((l: any) => l.label === "semantic-intent").map((l: any) => `${l.serverId}|${l.toolName}|${l.beforeSha256}|${l.afterSha256}`),
);
const drifted = new Set<string>();
for (const s of both) {
  for (const [name, before] of c1.get(s)!) {
    const after = c2.get(s)!.get(name);
    if (after !== undefined && after !== before && semantic.has(`${s}|${name}|${before}|${after}`)) drifted.add(s);
  }
}

const toolClass = new Map<string, Cls>();
for (const t of read("data/crawl-1-capabilities-v2.json")) toolClass.set(`${t.serverId}|${t.toolName}`, t.capabilityClass);
const serverClass = (s: string): Cls => {
  const present = new Set([...c1.get(s)!.keys()].map((n) => toolClass.get(`${s}|${n}`) ?? "read"));
  return ORDER.find((c) => present.has(c)) ?? "read";
};

interface Row { id: string; tools: number; cls: Cls; drifted: boolean }
const rows: Row[] = both.map((id) => ({ id, tools: c1.get(id)!.size, cls: serverClass(id), drifted: drifted.has(id) }));

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sizes = rows.map((r) => r.tools).sort((a, b) => a - b);
const q1 = sizes[Math.ceil(rows.length / 3) - 1]!;
const q2 = sizes[Math.ceil((2 * rows.length) / 3) - 1]!;
const band = (r: Row): "small" | "medium" | "large" => (r.tools <= q1 ? "small" : r.tools <= q2 ? "medium" : "large");
const tally = (rs: Row[]) => ({ servers: rs.length, drifted: rs.filter((r) => r.drifted).length, ratePct: rs.length ? Math.round((1000 * rs.filter((r) => r.drifted).length) / rs.length) / 10 : null });

const bands = (["small", "medium", "large"] as const).map((b) => {
  const rs = rows.filter((r) => band(r) === b);
  return {
    band: b,
    minTools: Math.min(...rs.map((r) => r.tools)),
    maxTools: Math.max(...rs.map((r) => r.tools)),
    ...tally(rs),
    transactServers: rs.filter((r) => r.cls === "transact").length,
    byClass: Object.fromEntries(ORDER.map((c) => [c, tally(rs.filter((r) => r.cls === c))])),
  };
});
const byClass = ORDER.map((c) => {
  const rs = rows.filter((r) => r.cls === c);
  return { capabilityClass: c, ...tally(rs), medianTools: median(rs.map((r) => r.tools)), minTools: Math.min(...rs.map((r) => r.tools)), maxTools: Math.max(...rs.map((r) => r.tools)) };
});
const driftedRows = rows.filter((r) => r.drifted);
const result = {
  basis: "149 servers captured in both crawls; size = crawl-1 tool count; server class = highest-consequence crawl-1 tool under classifier v2 (transact > communicate > write > read); drifted = >=1 semantic-intent change (labels.json)",
  cutoffs: { small: `<= ${q1} tools`, medium: `${q1 + 1} to ${q2} tools`, large: `>= ${q2 + 1} tools` },
  overall: tally(rows),
  medianToolsAllServers: median(sizes),
  medianToolsDriftedServers: median(driftedRows.map((r) => r.tools)),
  medianToolsUndriftedServers: median(rows.filter((r) => !r.drifted).map((r) => r.tools)),
  bySize: bands,
  byClass,
};

const problems: string[] = [];
if (result.overall.drifted !== drift.semanticIntent.drifted) problems.push(`drifted ${result.overall.drifted} != drift.json ${drift.semanticIntent.drifted}`);
for (const s of drift.byCapability) {
  const mine = byClass.find((c) => c.capabilityClass === s.capabilityClass)!;
  if (mine.servers !== s.servers || mine.drifted !== s.drifted) problems.push(`${s.capabilityClass}: ${mine.drifted}/${mine.servers} != drift.json ${s.drifted}/${s.servers}`);
}
writeFileSync("data/size-check.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
if (problems.length) { console.error("MISMATCH WITH data/drift.json:\n" + problems.join("\n")); process.exit(1); }
console.log("\nreconciles with data/drift.json: overall and all four capability strata match");
