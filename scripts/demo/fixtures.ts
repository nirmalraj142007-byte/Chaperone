/**
 * Loads demo/advisory-fixtures.json.
 *
 * That file is a FIXTURE: hand-written lines standing in for model output
 * that does not exist yet. It is parsed against a schema anyway. The
 * summary bounds are the ones a real model's output must meet
 * (packages/advisory/src/schema.ts), so a fixture can never show the card
 * something a model could not have been allowed to show it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FIXTURE_MODEL_ID_PREFIX } from "@chaperone/ledger";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES_PATH = path.join(REPO_ROOT, "demo", "advisory-fixtures.json");

const rowSchema = z.object({
  id: z.string().min(1),
  describes: z.string().min(1),
  upstreamId: z.string().min(1),
  toolName: z.string().min(1),
  mustContainAddedText: z.string().min(1),
  score: z.number().min(0).max(100),
  summary: z.string().trim().min(1).max(480),
});

export const fixtureFileSchema = z.object({
  $fixture: z.literal(true),
  notice: z.string().min(1),
  todo: z.string().regex(/^TODO\(blocker: .+; resolves .+\)/, "a TODO must name its blocker and when it resolves"),
  writtenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  modelId: z.string().startsWith(FIXTURE_MODEL_ID_PREFIX),
  rows: z.array(rowSchema).min(1),
});

export type FixtureFile = z.infer<typeof fixtureFileSchema>;
export type FixtureRow = z.infer<typeof rowSchema>;

export function parseFixtureFile(raw: string): FixtureFile {
  return fixtureFileSchema.parse(JSON.parse(raw));
}

export function loadFixtureFile(filePath: string = FIXTURES_PATH): FixtureFile {
  return parseFixtureFile(readFileSync(filePath, "utf8"));
}
