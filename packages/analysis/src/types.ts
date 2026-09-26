import type { CapabilityClass, ToolDefinition } from "@chaperone/policy";

/** The three Axis-1 classes a pair of present-in-both tools can end up in (TAXONOMY.md). */
export type PairChangeClass = "cosmetic" | "schema-additive" | "semantic-intent";

/** One tool from one crawl, rebuilt from the committed raw archive. */
export interface SnapshotTool {
  serverId: string;
  toolName: string;
  definition: ToolDefinition;
  /** hashTool(definition), recomputed from the archive, never read from DynamoDB. */
  sha256: string;
  /** v2 class, as recorded by the crawl and re-verified against classifyCapability(definition, "v2"). */
  capabilityClass: CapabilityClass;
}

/** One crawl, as the analysis sees it. */
export interface Snapshot {
  crawlId: string;
  startedAt: string;
  taxonomyBlobSha: string;
  attempted: number;
  bootedServerIds: readonly string[];
  /** serverId -> toolName -> tool. Keys are exactly `bootedServerIds`. */
  servers: ReadonlyMap<string, ReadonlyMap<string, SnapshotTool>>;
}

/** The fields of a `corpus/candidates.json` entry the analysis reads. */
export interface Candidate {
  serverId: string;
  repoOwner?: string | null | undefined;
  repoName?: string | null | undefined;
}

export const CAPABILITY_ORDER: readonly CapabilityClass[] = ["transact", "communicate", "write", "read"];
