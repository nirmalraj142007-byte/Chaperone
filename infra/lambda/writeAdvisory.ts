/**
 * AWS-01's writer Lambda — deliberately the ONLY function in this pipeline
 * that can write to `chaperone-advisory`, and it cannot call Bedrock at all
 * (see `../lib/advisory-pipeline-stack.ts`'s separate IAM role for this
 * function). The Step Functions state machine only reaches this state when
 * `scoreAdvisory.ts` returned `status: "scored"` — an "unavailable" result
 * short-circuits to Succeed upstream and this function is never invoked for
 * it, matching `scoreDiff`'s own contract that an unavailable advisory is
 * simply absent, never a written row with placeholder content.
 */
import { getAdvisory, putAdvisory } from "@chaperone/ledger";
import { childLogger } from "@chaperone/logger";

const log = childLogger({ component: "advisory-pipeline-write" });

interface WriteAdvisoryEvent {
  status: "scored";
  quarantineId: string;
  score: number;
  summary: string;
  modelId: string;
  promptSha: string;
}

export interface WriteAdvisoryOutput {
  quarantineId: string;
  written: boolean;
}

export async function handler(event: WriteAdvisoryEvent): Promise<WriteAdvisoryOutput> {
  const existing = await getAdvisory(event.quarantineId);
  if (existing !== undefined) {
    log.info({ quarantineId: event.quarantineId }, "advisory already scored; skipping write (idempotent)");
    return { quarantineId: event.quarantineId, written: false };
  }

  await putAdvisory({
    quarantineId: event.quarantineId,
    score: event.score,
    summary: event.summary,
    modelId: event.modelId,
    generatedAt: new Date().toISOString(),
    promptSha: event.promptSha,
  });

  log.info({ quarantineId: event.quarantineId, score: event.score }, "advisory scored and written");
  return { quarantineId: event.quarantineId, written: true };
}
