/**
 * Human labels for the pairs the mechanical proposal cannot settle.
 *
 * A label is keyed by `serverId | toolName | beforeSha256 | afterSha256`, so
 * it names the exact pair of definitions a person read. A label made on the
 * crawl-1 -> interim comparison is reused for crawl 1 -> crawl 2 only when
 * crawl 2's definition is byte-identical to the interim one, because only
 * then is the key the same.
 */
import { AnalysisError } from "@chaperone/errors";
import type { CapabilityClass } from "@chaperone/policy";
import { z } from "zod";
import { type Proposal, proposeChangeClass } from "./classify.js";
import type { ToolPair } from "./pair.js";
import type { PairChangeClass } from "./types.js";

export type HumanChoice = PairChangeClass | "skip";

export const labelRecordSchema = z.object({
  key: z.string(),
  serverId: z.string(),
  toolName: z.string(),
  beforeSha256: z.string(),
  afterSha256: z.string(),
  label: z.enum(["cosmetic", "schema-additive", "semantic-intent", "skip"]),
  proposed: z.enum(["cosmetic", "schema-additive", "semantic-intent"]),
  labeledBy: z.string().min(1),
  labeledAt: z.string(),
  taxonomyBlobSha: z.string(),
});
export type LabelRecord = z.infer<typeof labelRecordSchema>;

export const labelsFileSchema = z.object({
  $comment: z.string().optional(),
  labels: z.array(labelRecordSchema),
});
export type LabelsFile = z.infer<typeof labelsFileSchema>;

export const LABELS_FILE_COMMENT =
  "Human change-class labels, written by `pnpm analyse:label` from data/labels-todo.json. One entry per " +
  "serverId|toolName|beforeSha256|afterSha256. `skip` means not yet decided: the analysis treats it as missing. " +
  "See corpus/DRIFT-JSON-APPENDIX-report-shape.md.";

export function emptyLabelsFile(): LabelsFile {
  return { $comment: LABELS_FILE_COMMENT, labels: [] };
}

export function parseLabelsFile(value: unknown, source: string): LabelsFile {
  const parsed = labelsFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new AnalysisError(`${source} is not a valid labels file: ${parsed.error.issues[0]?.message ?? "unknown"}`, { source });
  }
  const seen = new Set<string>();
  for (const record of parsed.data.labels) {
    if (record.key !== labelKey(record.serverId, record.toolName, record.beforeSha256, record.afterSha256)) {
      throw new AnalysisError(`${source}: label key "${record.key}" does not match its own fields`, { key: record.key });
    }
    if (seen.has(record.key)) {
      throw new AnalysisError(`${source}: label key "${record.key}" appears twice`, { key: record.key });
    }
    seen.add(record.key);
    assertHumanLabeler(record.labeledBy);
  }
  return parsed.data;
}

/** `labeledBy` is a person. CLAUDE.md's ledger rule (actor is never `model`) applies to labels for the same reason. */
export function assertHumanLabeler(labeledBy: string): void {
  if (labeledBy.trim().length === 0 || /^model$/i.test(labeledBy.trim())) {
    throw new AnalysisError(`labeledBy must name the person labelling, not "${labeledBy}"`, { labeledBy });
  }
}

export function labelKey(serverId: string, toolName: string, beforeSha256: string, afterSha256: string): string {
  return [serverId, toolName, beforeSha256, afterSha256].join("|");
}

export interface TodoItem {
  key: string;
  serverId: string;
  toolName: string;
  /** Which comparisons need this label, e.g. "crawl-1 -> crawl-2". */
  comparisons: string[];
  beforeSha256: string;
  afterSha256: string;
  proposed: PairChangeClass;
  reason: string;
  descriptionChange: Proposal["descriptionChange"];
  schemaChange: Proposal["schemaChange"];
  capabilityBefore: CapabilityClass;
  /** v2 class of the later text. A difference from `capabilityBefore` is itself a sign of semantic-intent (TAXONOMY.md, Axis 2). */
  capabilityAfter: CapabilityClass;
  before: { description: string; inputSchema: unknown };
  after: { description: string; inputSchema: unknown };
}

export interface LabelsTodoFile {
  $comment: string;
  generatedAt: string;
  taxonomyBlobSha: string;
  items: TodoItem[];
}

export const labelsTodoFileSchema = z.object({
  $comment: z.string(),
  generatedAt: z.string(),
  taxonomyBlobSha: z.string(),
  items: z.array(
    z.object({
      key: z.string(),
      serverId: z.string(),
      toolName: z.string(),
      comparisons: z.array(z.string()),
      beforeSha256: z.string(),
      afterSha256: z.string(),
      proposed: z.enum(["cosmetic", "schema-additive", "semantic-intent"]),
      reason: z.string(),
      descriptionChange: z.enum(["none", "formatting", "words"]),
      schemaChange: z.enum(["none", "additive", "non-additive"]),
      capabilityBefore: z.enum(["read", "write", "transact", "communicate"]),
      capabilityAfter: z.enum(["read", "write", "transact", "communicate"]),
      before: z.object({ description: z.string(), inputSchema: z.unknown() }),
      after: z.object({ description: z.string(), inputSchema: z.unknown() }),
    }),
  ),
});

export function parseLabelsTodoFile(value: unknown, source: string): LabelsTodoFile {
  const parsed = labelsTodoFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new AnalysisError(`${source} is not a valid labels-todo file: ${parsed.error.issues[0]?.message ?? "unknown"}`, { source });
  }
  return parsed.data as LabelsTodoFile;
}

export type ClassSource = "unchanged" | "mechanical" | "human";

export interface ClassifiedPair extends ToolPair {
  proposal: Proposal | null;
  finalClass: PairChangeClass | "unchanged";
  source: ClassSource;
}

export interface ResolvedComparison {
  label: string;
  classified: ClassifiedPair[];
  pending: TodoItem[];
}

function todoItemFor(pair: ToolPair, proposal: Proposal, comparison: string): TodoItem {
  return {
    key: labelKey(pair.serverId, pair.toolName, pair.before.sha256, pair.after.sha256),
    serverId: pair.serverId,
    toolName: pair.toolName,
    comparisons: [comparison],
    beforeSha256: pair.before.sha256,
    afterSha256: pair.after.sha256,
    proposed: proposal.proposed,
    reason: proposal.reason,
    descriptionChange: proposal.descriptionChange,
    schemaChange: proposal.schemaChange,
    capabilityBefore: pair.before.capabilityClass,
    capabilityAfter: pair.after.capabilityClass,
    before: { description: pair.before.definition.description ?? "", inputSchema: pair.before.definition.inputSchema },
    after: { description: pair.after.definition.description ?? "", inputSchema: pair.after.definition.inputSchema },
  };
}

/**
 * Gives every pair its final class: unchanged (same sha256), mechanical (the
 * proposal was certain), or human (a label decided it). Pairs that need a
 * label and have none, or only `skip`, are returned in `pending`.
 */
export function resolveComparison(
  comparisonLabel: string,
  pairs: readonly ToolPair[],
  labels: ReadonlyMap<string, LabelRecord>,
  taxonomyBlobSha: string,
): ResolvedComparison {
  const classified: ClassifiedPair[] = [];
  const pending: TodoItem[] = [];

  for (const pair of pairs) {
    if (pair.before.sha256 === pair.after.sha256) {
      classified.push({ ...pair, proposal: null, finalClass: "unchanged", source: "unchanged" });
      continue;
    }
    const proposal = proposeChangeClass(pair.before.definition, pair.after.definition);
    // A capability class that moved is itself evidence of semantic-intent
    // (TAXONOMY.md, Axis 2). The classifier reads only name + description,
    // so this can only happen when description words changed, which already
    // needs a label; the check stays so that can never silently stop holding.
    const needsLabel = proposal.needsLabel || pair.before.capabilityClass !== pair.after.capabilityClass;
    if (!needsLabel) {
      classified.push({ ...pair, proposal, finalClass: proposal.proposed, source: "mechanical" });
      continue;
    }
    const label = labels.get(labelKey(pair.serverId, pair.toolName, pair.before.sha256, pair.after.sha256));
    if (label === undefined || label.label === "skip") {
      pending.push(todoItemFor(pair, proposal, comparisonLabel));
      continue;
    }
    if (label.taxonomyBlobSha !== taxonomyBlobSha) {
      throw new AnalysisError(
        `label ${label.key} was made against corpus/TAXONOMY.md blob ${label.taxonomyBlobSha}, not crawl 1's ${taxonomyBlobSha}`,
        { key: label.key },
      );
    }
    classified.push({ ...pair, proposal, finalClass: label.label, source: "human" });
  }

  return { label: comparisonLabel, classified, pending };
}

/** Merges pending items from several comparisons, one per key, keeping every comparison that needs it. */
export function mergeTodo(comparisons: readonly ResolvedComparison[]): TodoItem[] {
  const byKey = new Map<string, TodoItem>();
  for (const comparison of comparisons) {
    for (const item of comparison.pending) {
      const existing = byKey.get(item.key);
      if (existing === undefined) {
        byKey.set(item.key, { ...item, comparisons: [...item.comparisons] });
      } else {
        existing.comparisons.push(...item.comparisons.filter((c) => !existing.comparisons.includes(c)));
      }
    }
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function buildLabelsTodoFile(items: TodoItem[], taxonomyBlobSha: string, generatedAt: string): LabelsTodoFile {
  return {
    $comment:
      "Written by `pnpm analyse:drift`. Every pair here needs a person's change-class label before the analysis can " +
      "complete. Run `pnpm analyse:label` to work through it; answers go to data/labels.json. Regenerated on every run.",
    generatedAt,
    taxonomyBlobSha,
    items,
  };
}
