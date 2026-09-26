/**
 * Joins two crawls on (serverId, toolName). The denominator starts from the
 * EARLIER crawl's bootedServerIds: a server that only booted later cannot
 * enter the comparison, because the corpus was frozen at crawl 1.
 */
import type { Snapshot, SnapshotTool } from "./types.js";

export interface ToolPair {
  serverId: string;
  toolName: string;
  before: SnapshotTool;
  after: SnapshotTool;
}

export interface Pairing {
  earlierCrawlId: string;
  laterCrawlId: string;
  /** Booted with tools in both crawls, sorted. `n` for this comparison. */
  capturedBoth: string[];
  /** Every (serverId, toolName) present in both, changed or not, for servers in `capturedBoth`. */
  pairs: ToolPair[];
  toolAdded: SnapshotTool[];
  toolRemoved: SnapshotTool[];
  /** Booted with tools in the earlier crawl but not the later one: a boot outcome, never `tool-removed`. */
  serverAbsent: Array<{ serverId: string; tools: number }>;
  /** Booted only in the later crawl. Excluded from every count; listed so the console can say so. */
  laterOnlyServers: string[];
}

export interface PairOptions {
  /** Restrict the comparison to these servers (the segment population). Defaults to all of the earlier crawl's. */
  population?: ReadonlySet<string>;
}

export function pairSnapshots(earlier: Snapshot, later: Snapshot, opts: PairOptions = {}): Pairing {
  const population = opts.population;
  const earlierIds = earlier.bootedServerIds.filter((id) => population === undefined || population.has(id));
  const capturedBoth: string[] = [];
  const pairs: ToolPair[] = [];
  const toolAdded: SnapshotTool[] = [];
  const toolRemoved: SnapshotTool[] = [];
  const serverAbsent: Pairing["serverAbsent"] = [];

  for (const serverId of earlierIds) {
    const beforeTools = earlier.servers.get(serverId)!;
    const afterTools = later.servers.get(serverId);
    if (afterTools === undefined) {
      serverAbsent.push({ serverId, tools: beforeTools.size });
      continue;
    }
    capturedBoth.push(serverId);
    for (const [toolName, before] of [...beforeTools].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const after = afterTools.get(toolName);
      if (after === undefined) {
        toolRemoved.push(before);
      } else {
        pairs.push({ serverId, toolName, before, after });
      }
    }
    for (const [toolName, after] of [...afterTools].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!beforeTools.has(toolName)) {
        toolAdded.push(after);
      }
    }
  }

  const earlierSet = new Set(earlier.bootedServerIds);
  const laterOnlyServers = later.bootedServerIds.filter((id) => !earlierSet.has(id));

  return {
    earlierCrawlId: earlier.crawlId,
    laterCrawlId: later.crawlId,
    capturedBoth,
    pairs,
    toolAdded,
    toolRemoved,
    serverAbsent,
    laterOnlyServers,
  };
}
