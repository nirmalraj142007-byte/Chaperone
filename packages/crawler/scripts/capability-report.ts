// Re-runs the three live sources against the already-warm main HTTP cache
// (zero new network calls when crawl:assemble has run recently) to recover
// description text and apply estimateServerCapability. See that function's
// doc comment for why this is a rough pre-crawl-1 sanity check, not the
// taxonomy-grade Axis-2 label.
import { registrySource } from "../src/sources/registry.js";
import { smitherySource } from "../src/sources/smithery.js";
import { awesomeSource } from "../src/sources/awesome.js";
import { dedupeCandidates } from "../src/dedupe.js";
import { estimateServerCapability, type CapabilityEstimate } from "../src/capabilityEstimate.js";
import { descriptionOf } from "../src/rawDescription.js";
import type { RegistrySource, SourceServer } from "../src/types.js";

const CAPABILITIES: CapabilityEstimate[] = ["read", "write", "transact", "communicate"];

async function collect(source: RegistrySource): Promise<SourceServer[]> {
  const out: SourceServer[] = [];
  for await (const entry of source.fetchAll()) {
    out.push(entry);
  }
  return out;
}

async function main(): Promise<void> {
  const [registry, smithery, awesome] = await Promise.all([
    collect(registrySource),
    collect(smitherySource),
    collect(awesomeSource),
  ]);
  const all = [...registry, ...smithery, ...awesome];
  console.log("recovered raw entries:", all.length, {
    registry: registry.length,
    smithery: smithery.length,
    awesome: awesome.length,
  });

  const merged = dedupeCandidates(all);
  console.log("merged candidates:", merged.length);

  const dist: Record<CapabilityEstimate, number> = { read: 0, write: 0, transact: 0, communicate: 0 };
  let emptyDescription = 0;

  for (const candidate of merged) {
    const description = candidate.members.map(descriptionOf).find((d) => d.length > 0) ?? "";
    if (!description) {
      emptyDescription++;
    }
    dist[estimateServerCapability(candidate.displayName, description)]++;
  }

  console.log("");
  console.log(`capability distribution (n=${merged.length}):`);
  for (const capability of CAPABILITIES) {
    const pct = ((dist[capability] / merged.length) * 100).toFixed(1);
    console.log(`  ${capability.padEnd(12)} ${String(dist[capability]).padStart(4)}  (${pct}%)`);
  }
  const actionable = dist.transact + dist.communicate;
  console.log(`  transact+communicate combined: ${((actionable / merged.length) * 100).toFixed(1)}%`);
  console.log(`  entries with no recovered description: ${emptyDescription}`);
}

main().catch((e: unknown) => {
  console.error("capability-report: failed —", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
