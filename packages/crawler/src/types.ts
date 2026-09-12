export type SourceId = "registry" | "pulsemcp" | "glama" | "smithery" | "awesome";

export interface InstallHint {
  method: "npx" | "uvx" | "docker" | "pip" | "manual";
  spec: string;
}

export interface SourceServer {
  sourceId: SourceId;
  slug: string;
  displayName: string;
  repoUrl?: string;
  installHint?: InstallHint;
  raw: unknown;
}

export interface RegistrySource {
  id: SourceId;
  fetchAll(): AsyncIterable<SourceServer>;
}

export interface SourceRunResult {
  sourceId: SourceId;
  fetched: number;
  uniqueContributed: number;
  durationMs: number;
  degraded: boolean;
  degradedReason?: string;
}

export interface AssembleReport {
  startedAt: string;
  finishedAt: string;
  sources: SourceRunResult[];
  totalBeforeDedup: number;
  totalAfterDedup: number;
  withRepoUrl: number;
}
