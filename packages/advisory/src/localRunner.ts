import { childLogger } from "@chaperone/logger";
import * as ledger from "@chaperone/ledger";
import type { ModelProvider } from "./provider.js";
import { scoreDiff } from "./scoreDiff.js";

const log = childLogger({ component: "advisory-local-runner" });

interface ParsedTool {
  name?: string;
  description?: string;
}

function parseCanonicalTool(json: string): ParsedTool {
  try {
    const parsed = JSON.parse(json) as ParsedTool;
    return {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    };
  } catch {
    return {};
  }
}

function changedFieldsFor(before: ParsedTool, after: ParsedTool): string[] {
  const fields: string[] = [];
  if (before.name !== after.name) {
    fields.push("name");
  }
  if ((before.description ?? "") !== (after.description ?? "")) {
    fields.push("description");
  }
  return fields;
}

export interface RunLocalPipelineResult {
  candidates: number;
  scored: number;
  unavailable: number;
  skippedAlreadyScored: number;
  errored: number;
}

/**
 * The in-process stand-in for the AWS-01 Step Functions pipeline (not yet
 * built — see docs/AWS-BUILDER.md): one pass over every `pending`
 * quarantine this household has open, scoring whichever ones don't already
 * have an advisory row and writing the result with `putAdvisory`. This is
 * the first thing in the repo that calls `putAdvisory` — CLAUDE.md: "Nothing
 * currently calls putAdvisory — this phase wires the real producer."
 *
 * Idempotent per quarantine (an already-scored row is skipped, never
 * re-scored) and safe to run repeatedly against DynamoDB Local via `pnpm
 * advisory:run-local`. One quarantine's failure (a ledger read/write
 * hiccup, scoreDiff's own unexpected-error path) is caught, counted, and
 * logged rather than aborting the rest of the batch — the same
 * fail-one-item-not-the-batch posture `gate.ts` already uses for quarantine
 * detection.
 */
export async function runLocalAdvisoryPipeline(
  householdId: string,
  provider: ModelProvider,
): Promise<RunLocalPipelineResult> {
  const pending = (await ledger.listQuarantineByStatus("pending")).filter((q) => q.householdId === householdId);

  const result: RunLocalPipelineResult = {
    candidates: pending.length,
    scored: 0,
    unavailable: 0,
    skippedAlreadyScored: 0,
    errored: 0,
  };

  for (const quarantine of pending) {
    try {
      const existing = await ledger.getAdvisory(quarantine.quarantineId);
      if (existing !== undefined) {
        result.skippedAlreadyScored++;
        continue;
      }

      const before = parseCanonicalTool(quarantine.fromCanonicalJson);
      const after = parseCanonicalTool(quarantine.toCanonicalJson);

      const scoreResult = await scoreDiff(
        {
          toolName: quarantine.toolName,
          upstreamLabel: quarantine.upstreamId,
          capabilityClass: quarantine.capabilityClass,
          changedFields: changedFieldsFor(before, after),
          beforeDescription: before.description ?? "",
          afterDescription: after.description ?? "",
        },
        provider,
      );

      if (scoreResult.status === "unavailable") {
        result.unavailable++;
        log.warn(
          { quarantineId: quarantine.quarantineId, reason: scoreResult.reason },
          "advisory unavailable for quarantine",
        );
        continue;
      }

      await ledger.putAdvisory({
        quarantineId: quarantine.quarantineId,
        score: scoreResult.score,
        summary: scoreResult.summary,
        modelId: scoreResult.modelId,
        generatedAt: new Date().toISOString(),
        promptSha: scoreResult.promptSha,
      });
      result.scored++;
      log.info({ quarantineId: quarantine.quarantineId, score: scoreResult.score }, "advisory scored and written");
    } catch (error) {
      result.errored++;
      log.error({ quarantineId: quarantine.quarantineId, error }, "advisory pipeline failed for this quarantine");
    }
  }

  return result;
}
