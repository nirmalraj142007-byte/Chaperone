import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { childLogger } from "@chaperone/logger";
import { putCorpusServer } from "@chaperone/ledger";
import { registrySource } from "./sources/registry.js";
import { pulsemcpSource } from "./sources/pulsemcp.js";
import { glamaSource } from "./sources/glama.js";
import { smitherySource } from "./sources/smithery.js";
import { awesomeSource } from "./sources/awesome.js";
import { dedupeCandidates, type MergedCandidate } from "./dedupe.js";
import { fetchRepoReadme } from "./readme.js";
import { anyRequiresCredentials } from "./credentialScan.js";
import type { AssembleReport, RegistrySource, SourceId, SourceRunResult, SourceServer } from "./types.js";

const log = childLogger({ component: "crawler-assemble" });

const ALL_SOURCES: readonly RegistrySource[] = [
  registrySource,
  pulsemcpSource,
  glamaSource,
  smitherySource,
  awesomeSource,
];

export const CANDIDATES_PATH = path.join("corpus", "candidates.json");

export interface CandidateRecord {
  serverId: string;
  displayName: string;
  sources: SourceId[];
  repoUrl: string | null;
  repoOwner: string | null;
  repoName: string | null;
  installMethod: string | null;
  requiresCredentials: boolean;
  bootStatus: "not_attempted";
  firstSeenAt: string;
}

interface SourceRun {
  entries: SourceServer[];
  result: SourceRunResult;
}

async function runSource(source: RegistrySource): Promise<SourceRun> {
  const sourceLog = childLogger({ source: source.id });
  const start = Date.now();
  const entries: SourceServer[] = [];
  try {
    for await (const entry of source.fetchAll()) {
      entries.push(entry);
    }
    const durationMs = Date.now() - start;
    sourceLog.info({ fetched: entries.length, durationMs }, "source run complete");
    return {
      entries,
      result: {
        sourceId: source.id,
        fetched: entries.length,
        uniqueContributed: 0,
        durationMs,
        degraded: entries.length === 0,
      },
    };
  } catch (e) {
    const durationMs = Date.now() - start;
    const reason = e instanceof Error ? e.message : String(e);
    sourceLog.error({ error: reason, durationMs }, "source run failed; contributing 0 for this run");
    return {
      entries: [],
      result: { sourceId: source.id, fetched: 0, uniqueContributed: 0, durationMs, degraded: true, degradedReason: reason },
    };
  }
}

function toCandidateRecord(
  candidate: MergedCandidate,
  requiresCredentials: boolean,
  firstSeenAt: string,
): CandidateRecord {
  return {
    serverId: candidate.serverId,
    displayName: candidate.displayName,
    sources: [...candidate.sources].sort(),
    repoUrl: candidate.repoUrl ?? null,
    repoOwner: candidate.repo?.owner ?? null,
    repoName: candidate.repo?.name ?? null,
    installMethod: candidate.installHint?.method ?? null,
    requiresCredentials,
    bootStatus: "not_attempted",
    firstSeenAt,
  };
}

/**
 * Runs all five sources (one dead API can't fail the run — Promise.allSettled),
 * dedupes on repo then slug, scans each merged candidate's raw payloads and
 * (when it has a repo) its README for credential requirements, persists one
 * row per candidate to the corpus-server table, and writes
 * corpus/candidates.json. Does not enforce the N>=300 floor itself — that's
 * an acceptance policy, applied by the CLI entry point in scripts/assemble.ts,
 * so this function stays a pure "what did we find" report.
 */
export async function assembleCorpus(): Promise<AssembleReport> {
  const startedAt = new Date().toISOString();

  const settled = await Promise.allSettled(ALL_SOURCES.map((source) => runSource(source)));
  const perSource: SourceRun[] = settled.map((outcome, index) => {
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }
    const source = ALL_SOURCES[index]!;
    const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    log.error({ source: source.id, error: reason }, "source promise rejected unexpectedly; contributing 0");
    return {
      entries: [],
      result: { sourceId: source.id, fetched: 0, uniqueContributed: 0, durationMs: 0, degraded: true, degradedReason: reason },
    };
  });

  const allEntries = perSource.flatMap((p) => p.entries);
  const merged = dedupeCandidates(allEntries);
  const firstSeenAt = new Date().toISOString();

  const records: CandidateRecord[] = [];
  for (const candidate of merged) {
    const memberTexts = candidate.members.map((m) => JSON.stringify(m.raw));
    const readme = candidate.repo ? await fetchRepoReadme(candidate.repo) : undefined;
    const requiresCredentials = anyRequiresCredentials([...memberTexts, readme]);

    await putCorpusServer({
      serverId: candidate.serverId,
      displayName: candidate.displayName,
      sources: new Set(candidate.sources),
      repoUrl: candidate.repoUrl ?? "",
      repoOwner: candidate.repo?.owner ?? "",
      repoName: candidate.repo?.name ?? "",
      installMethod: candidate.installHint?.method ?? "manual",
      requiresCredentials,
      bootStatus: "not_attempted",
      firstSeenAt,
    });

    records.push(toCandidateRecord(candidate, requiresCredentials, firstSeenAt));
  }
  records.sort((a, b) => a.serverId.localeCompare(b.serverId));

  await mkdir(path.dirname(CANDIDATES_PATH), { recursive: true });
  await writeFile(CANDIDATES_PATH, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  const sourceRunById = new Map(perSource.map((p) => [p.result.sourceId, p.result]));
  for (const candidate of merged) {
    for (const sourceId of candidate.sources) {
      const run = sourceRunById.get(sourceId);
      if (run) {
        run.uniqueContributed++;
      }
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    sources: perSource.map((p) => p.result),
    totalBeforeDedup: allEntries.length,
    totalAfterDedup: merged.length,
    withRepoUrl: records.filter((r) => r.repoUrl !== null).length,
  };
}
