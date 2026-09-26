/**
 * The mechanical half of Axis 1 (corpus/TAXONOMY.md). It proposes a change
 * class for a changed pair and says whether a person has to confirm it. It is
 * only CERTAIN in the two cases no reading of the text could dispute:
 *
 *   description unchanged or formatting-only, schema unchanged   -> cosmetic
 *   description unchanged or formatting-only, schema additive     -> schema-additive
 *
 * Everything else is proposed `semantic-intent` and goes to a human, because
 * TAXONOMY.md's cosmetic rule ends "If in doubt between `cosmetic` and
 * `semantic-intent`, it is not `cosmetic`", and because a changed word can
 * only be judged by reading it. The table is fixed in
 * corpus/DRIFT-JSON-APPENDIX-report-shape.md ("Change class").
 */
import { AnalysisError } from "@chaperone/errors";
import { type ToolDefinition, type ToolDiff, describeDiff } from "@chaperone/policy";
import type { PairChangeClass } from "./types.js";

export type DescriptionChange = "none" | "formatting" | "words";
export type SchemaChange = "none" | "additive" | "non-additive";

export interface Proposal {
  proposed: PairChangeClass;
  needsLabel: boolean;
  descriptionChange: DescriptionChange;
  schemaChange: SchemaChange;
  reason: string;
  diff: ToolDiff;
}

/** Equal keys mean the two descriptions differ only in case, whitespace, punctuation or markdown markers. */
export function formattingKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function proposeChangeClass(before: ToolDefinition, after: ToolDefinition): Proposal {
  const diff = describeDiff(before, after);
  const beforeDescription = before.description ?? "";
  const afterDescription = after.description ?? "";

  const descriptionChange: DescriptionChange = !diff.changedFields.includes("description")
    ? "none"
    : formattingKey(beforeDescription) === formattingKey(afterDescription)
      ? "formatting"
      : "words";
  const schemaChange: SchemaChange = !diff.changedFields.includes("inputSchema")
    ? "none"
    : diff.schemaAdditiveOnly
      ? "additive"
      : "non-additive";

  if (descriptionChange === "none" && schemaChange === "none") {
    // Pairs are joined on name, and only name/description/inputSchema are
    // hashed, so a changed hash always shows up in one of the two. Reaching
    // here means the caller passed an unchanged pair.
    throw new AnalysisError("proposeChangeClass called on a pair with no difference", { tool: before.name });
  }

  if (descriptionChange === "words") {
    return {
      proposed: "semantic-intent",
      needsLabel: true,
      descriptionChange,
      schemaChange,
      reason: "description words changed; only a person can say whether the claim changed",
      diff,
    };
  }
  if (schemaChange === "non-additive") {
    return {
      proposed: "semantic-intent",
      needsLabel: true,
      descriptionChange,
      schemaChange,
      reason: "input schema changed in a way that is not purely additive (new required field, removed property, narrowed enum or changed type)",
      diff,
    };
  }
  if (schemaChange === "additive") {
    return {
      proposed: "schema-additive",
      needsLabel: false,
      descriptionChange,
      schemaChange,
      reason: descriptionChange === "formatting" ? "optional field or enum value added; description changed in formatting only" : "optional field or enum value added",
      diff,
    };
  }
  return {
    proposed: "cosmetic",
    needsLabel: false,
    descriptionChange,
    schemaChange,
    reason: "description differs only in case, whitespace, punctuation or markdown markers",
    diff,
  };
}
