import { AdvisorySchema, type AdvisoryModelOutput } from "./schema.js";

// Matches a whole response wrapped in a ``` or ```json fence, capturing the
// interior. Models reliably wrap JSON in a fence even when told not to.
const FENCE_PATTERN = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = FENCE_PATTERN.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

export type ParseResult =
  | { ok: true; value: AdvisoryModelOutput }
  | { ok: false; reason: string };

/** Fence-strips, JSON.parses, then validates against AdvisorySchema. Never throws — every failure mode returns `{ ok: false, reason }`. */
export function parseAdvisoryResponse(raw: string): ParseResult {
  const stripped = stripCodeFence(raw);

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (error) {
    return { ok: false, reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const result = AdvisorySchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    return { ok: false, reason: `schema validation failed: ${issues.join("; ")}` };
  }

  return { ok: true, value: result.data };
}
