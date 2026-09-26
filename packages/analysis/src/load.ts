/**
 * Rebuilds one crawl from the committed evidence: `data/{crawlId}-report.json`,
 * the raw archives under `data/raw/{crawlId}/`, and that crawl's v2 capability
 * rows. It never reads DynamoDB. The `corpus-server` table is empty and the
 * `tool-snapshot` rows are not committed, so neither is evidence
 * (planning audit M1; corpus/DRIFT-JSON-APPENDIX-report-shape.md, "Inputs, fixed").
 *
 * Every inconsistency is fatal. The analysis is a diff over explicit,
 * committed sets, and a report that disagrees with its own archives cannot
 * be diffed honestly.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { AnalysisError } from "@chaperone/errors";
import { type CapabilityClass, type ClassifierVersion, type ToolDefinition, classifyCapability, hashTool } from "@chaperone/policy";
import { z } from "zod";
import type { Candidate, Snapshot, SnapshotTool } from "./types.js";

/**
 * The classifier version BOTH sides of every comparison are read under.
 * Pinned to "v2" deliberately rather than following CLASSIFIER_VERSION:
 * crawl 1 was reclassified under v2 (data/crawl-1-capabilities-v2.json) and
 * the interim crawl and crawl 2 stamp v2, so if CLASSIFIER_VERSION ever moves
 * on, this comparison must still be v2 against v2 (CLAUDE.md, "Capability
 * classifier versioning", rule 3).
 */
export const ANALYSIS_CLASSIFIER_VERSION: ClassifierVersion = "v2";

const reportSchema = z.object({
  crawlId: z.string(),
  startedAt: z.string(),
  attempted: z.number().int().nonnegative(),
  bootedServerIds: z.array(z.string()),
  taxonomyBlobSha: z.string(),
});

const archiveSchema = z.object({
  serverId: z.string(),
  status: z.string(),
  tools: z
    .array(
      z
        .object({
          name: z.string(),
          description: z.string().optional(),
          inputSchema: z.unknown(),
        })
        .passthrough(),
    )
    .default([]),
});

const capabilityRowSchema = z.object({
  serverId: z.string(),
  toolName: z.string(),
  capabilityClass: z.enum(["read", "write", "transact", "communicate"]),
  classifierVersion: z.string().optional(),
});

const candidateSchema = z.array(
  z
    .object({
      serverId: z.string(),
      repoOwner: z.string().nullable().optional(),
      repoName: z.string().nullable().optional(),
    })
    .passthrough(),
);

async function readJson(filePath: string, what: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new AnalysisError(`${what} not found at ${filePath}`, { filePath, cause: String(error) });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AnalysisError(`${what} at ${filePath} is not valid JSON`, { filePath, cause: String(error) });
  }
}

function parseWith<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string, filePath: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AnalysisError(`${what} at ${filePath} does not have the expected shape: ${parsed.error.issues[0]?.message ?? "unknown"}`, {
      filePath,
    });
  }
  return parsed.data as z.output<S>;
}

export const toolKey = (serverId: string, toolName: string): string => `${serverId}\u0000${toolName}`;

export interface LoadSnapshotOptions {
  /** The directory holding `{crawlId}-report.json` and `raw/{crawlId}/`. `data/` in the repo; a temp dir in tests. */
  dataDir: string;
  crawlId: string;
  /** Crawl 1: `data/crawl-1-capabilities-v2.json`. Any later crawl: `data/{crawlId}-capabilities.json`. */
  capabilitiesPath: string;
}

export function defaultCapabilitiesPath(dataDir: string, crawlId: string): string {
  return crawlId === "crawl-1"
    ? path.join(dataDir, "crawl-1-capabilities-v2.json")
    : path.join(dataDir, `${crawlId}-capabilities.json`);
}

export async function loadSnapshot(opts: LoadSnapshotOptions): Promise<Snapshot> {
  const reportPath = path.join(opts.dataDir, `${opts.crawlId}-report.json`);
  const report = parseWith(reportSchema, await readJson(reportPath, `the ${opts.crawlId} report`), "crawl report", reportPath);
  if (report.crawlId !== opts.crawlId) {
    throw new AnalysisError(`${reportPath} says crawlId "${report.crawlId}", expected "${opts.crawlId}"`, { reportPath });
  }

  // Every archive, not only the booted ones, so a BOOTED archive the report
  // forgot is caught as well as a reported ID with no archive.
  const rawDir = path.join(opts.dataDir, "raw", opts.crawlId);
  let files: string[];
  try {
    files = (await readdir(rawDir)).filter((f) => f.endsWith(".json")).sort();
  } catch (error) {
    throw new AnalysisError(`raw archive directory ${rawDir} not found`, { rawDir, cause: String(error) });
  }

  const archivedTools = new Map<string, ToolDefinition[]>();
  for (const file of files) {
    const filePath = path.join(rawDir, file);
    const archive = parseWith(archiveSchema, await readJson(filePath, "raw archive"), "raw archive", filePath);
    if (`${archive.serverId}.json` !== file) {
      throw new AnalysisError(`${filePath} holds serverId "${archive.serverId}", which does not match its file name`, { filePath });
    }
    if (archive.status === "BOOTED" && archive.tools.length > 0) {
      archivedTools.set(
        archive.serverId,
        archive.tools.map((t) => ({ name: t.name, ...(t.description !== undefined ? { description: t.description } : {}), inputSchema: t.inputSchema })),
      );
    }
  }

  const reported = new Set(report.bootedServerIds);
  if (reported.size !== report.bootedServerIds.length) {
    throw new AnalysisError(`${reportPath} lists a serverId twice in bootedServerIds`, { reportPath });
  }
  const missingArchive = [...reported].filter((id) => !archivedTools.has(id));
  const unreported = [...archivedTools.keys()].filter((id) => !reported.has(id));
  if (missingArchive.length > 0 || unreported.length > 0) {
    throw new AnalysisError(
      `${opts.crawlId}: bootedServerIds and the BOOTED raw archives disagree ` +
        `(${missingArchive.length} reported without a BOOTED archive with tools, ${unreported.length} archived but not reported)`,
      { missingArchive: missingArchive.slice(0, 10), unreported: unreported.slice(0, 10) },
    );
  }

  const rows = parseWith(
    z.array(capabilityRowSchema),
    await readJson(opts.capabilitiesPath, `the ${opts.crawlId} capability rows`),
    "capability rows",
    opts.capabilitiesPath,
  );
  const recordedClass = new Map<string, CapabilityClass>();
  for (const row of rows) {
    if (row.classifierVersion !== ANALYSIS_CLASSIFIER_VERSION) {
      throw new AnalysisError(
        `${opts.capabilitiesPath}: a row for ${row.serverId} / ${row.toolName} was produced by classifier ` +
          `${row.classifierVersion ?? "(unstamped)"}, not ${ANALYSIS_CLASSIFIER_VERSION}. Both sides of a comparison must be ${ANALYSIS_CLASSIFIER_VERSION}.`,
        { capabilitiesPath: opts.capabilitiesPath },
      );
    }
    recordedClass.set(toolKey(row.serverId, row.toolName), row.capabilityClass);
  }

  const servers = new Map<string, Map<string, SnapshotTool>>();
  let recomputedMismatches = 0;
  for (const serverId of report.bootedServerIds) {
    const tools = new Map<string, SnapshotTool>();
    for (const definition of archivedTools.get(serverId)!) {
      if (tools.has(definition.name)) {
        throw new AnalysisError(
          `${opts.crawlId}: ${serverId} lists the tool "${definition.name}" twice, so (serverId, toolName) cannot be joined unambiguously`,
          { serverId, toolName: definition.name },
        );
      }
      const recorded = recordedClass.get(toolKey(serverId, definition.name));
      if (recorded === undefined) {
        throw new AnalysisError(`${opts.capabilitiesPath} has no row for ${serverId} / ${definition.name}`, { serverId });
      }
      if (classifyCapability(definition, ANALYSIS_CLASSIFIER_VERSION).class !== recorded) {
        recomputedMismatches++;
      }
      tools.set(definition.name, { serverId, toolName: definition.name, definition, sha256: hashTool(definition), capabilityClass: recorded });
    }
    servers.set(serverId, tools);
  }
  if (recomputedMismatches > 0) {
    throw new AnalysisError(
      `${opts.crawlId}: ${recomputedMismatches} recorded capability classes do not reproduce under classifyCapability(tool, "${ANALYSIS_CLASSIFIER_VERSION}"). ` +
        "The classifier changed underneath the recorded rows; that is a bug, not drift.",
      { recomputedMismatches },
    );
  }
  const toolCount = [...servers.values()].reduce((sum, t) => sum + t.size, 0);
  if (rows.length !== toolCount) {
    throw new AnalysisError(`${opts.capabilitiesPath} has ${rows.length} rows for ${toolCount} archived tools`, { rows: rows.length, toolCount });
  }

  return {
    crawlId: report.crawlId,
    startedAt: report.startedAt,
    taxonomyBlobSha: report.taxonomyBlobSha,
    attempted: report.attempted,
    bootedServerIds: [...report.bootedServerIds].sort(),
    servers,
  };
}

export async function loadCandidates(candidatesPath: string): Promise<Candidate[]> {
  return parseWith(candidateSchema, await readJson(candidatesPath, "corpus/candidates.json"), "candidate list", candidatesPath);
}
