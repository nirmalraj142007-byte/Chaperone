/**
 * How many servers would have shown a resident at least one consent card between
 * crawl 1 and crawl 2? A card appears when an approved tool's hash changes, or a
 * tool with no pin appears. Hashes come from @chaperone/policy's hashTool, the
 * same function the gateway and crawler use. Reads only committed data
 * (data/crawl-{1,2}-report.json, data/raw/crawl-{1,2}/); writes
 * data/card-servers.json. Servers are the 149 captured in both crawls.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hashTool, type ToolDefinition } from "@chaperone/policy";

const read = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
interface Archive { serverId: string; status: string; tools: ToolDefinition[] }
interface Report { bootedServerIds: string[] }

function load(crawl: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const f of readdirSync(`data/raw/${crawl}`)) {
    const a = read(`data/raw/${crawl}/${f}`) as Archive;
    if (!Array.isArray(a.tools) || a.tools.length === 0) continue;
    out.set(a.serverId, new Map(a.tools.map((t) => [t.name, hashTool(t)])));
  }
  return out;
}

const r1 = read("data/crawl-1-report.json") as Report;
const r2 = read("data/crawl-2-report.json") as Report;
const both = r1.bootedServerIds.filter((s) => r2.bootedServerIds.includes(s));
const c1 = load("crawl-1");
const c2 = load("crawl-2");

let changedTools = 0;
let addedTools = 0;
const changedServers = new Set<string>();
const addedServers = new Set<string>();
for (const s of both) {
  const a = c1.get(s)!;
  const b = c2.get(s)!;
  for (const [name, h] of b) {
    const before = a.get(name);
    if (before === undefined) { addedTools++; addedServers.add(s); }
    else if (before !== h) { changedTools++; changedServers.add(s); }
  }
}
const card = new Set([...changedServers, ...addedServers]);
const result = {
  basis: "servers captured in both crawls; hashTool from @chaperone/policy; a card = hash change on an existing tool or a tool with no pin",
  serversInBoth: both.length,
  serversWithAtLeastOneCard: card.size,
  serversWithHashChange: changedServers.size,
  serversWithNewTool: addedServers.size,
  toolsHashChanged: changedTools,
  toolsAdded: addedTools,
};
writeFileSync("data/card-servers.json", JSON.stringify(result, null, 2) + "\n");
console.log(result);
