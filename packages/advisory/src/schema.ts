import { z } from "zod";

/**
 * The exact shape a model call must return: a 0-100 suspicion score and a
 * short plain-English summary a resident reads on the consent card.
 * Anything else in the JSON is silently dropped by `.parse`; anything
 * missing or malformed fails validation and drives the single
 * retry-once-on-parse-failure in scoreDiff.ts. The 480-char cap keeps the
 * summary to roughly what the card's advisory paragraph can hold — well
 * under MAX_RESPONSE_TOKENS's ~1200-character ceiling even before the model
 * spends any of its budget on JSON punctuation.
 */
export const AdvisorySchema = z.object({
  score: z.number().min(0).max(100),
  summary: z.string().trim().min(1).max(480),
});

export type AdvisoryModelOutput = z.infer<typeof AdvisorySchema>;
