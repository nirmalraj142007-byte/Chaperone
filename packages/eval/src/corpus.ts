import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigError } from "@chaperone/errors";
import { INJECTION_PATTERNS, type AttackCorpusItem, type BenignControlItem, type LoadedCorpus } from "./types.js";

// packages/eval/src/corpus.ts -> packages/eval/src -> packages/eval -> packages -> repo root.
// Resolved from this file's own location, not process.cwd(), so loadAttackCorpus()
// gives the same answer whether it's invoked via `pnpm test` (cwd = repo root) or
// `pnpm --filter @chaperone/eval test` (cwd = packages/eval).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const ATTACKS_DIR = path.join(REPO_ROOT, "corpus", "attacks");
const CONTROLS_DIR = path.join(ATTACKS_DIR, "controls");

const CapabilityClassSchema = z.enum(["read", "write", "transact", "communicate"]);

/**
 * Mirrors the field list corpus/attacks/README.md documents. `authoredBy`
 * is a z.literal, not a z.enum of one — a corpus item claiming any other
 * provenance is a schema violation, not a value to tolerate.
 */
const AttackCorpusItemSchema = z.object({
  id: z.string().min(1),
  pattern: z.enum(INJECTION_PATTERNS),
  toolName: z.string().min(1),
  capabilityClass: CapabilityClassSchema,
  authoredBy: z.literal("project-author"),
  userRequest: z.string().min(1),
  benignVersion: z.string().min(1),
  attackVersion: z.string().min(1),
});

const BenignControlItemSchema = z.object({
  id: z.string().min(1),
  toolName: z.string().min(1),
  capabilityClass: CapabilityClassSchema,
  authoredBy: z.literal("project-author"),
  description: z.string().min(1),
});

const MIN_ATTACK_ITEMS = 30;
const MIN_PATTERNS_REPRESENTED = 5;
const MIN_CONTROLS = 10;

function readJsonFiles(dir: string): { file: string; json: unknown }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      try {
        return { file, json: JSON.parse(readFileSync(file, "utf8")) as unknown };
      } catch (error) {
        throw new ConfigError(`${file} is not valid JSON`, {
          file,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    });
}

/**
 * Loads and validates corpus/attacks/*.json (the paired attack items) and
 * corpus/attacks/controls/*.json (the standalone benign controls), and
 * enforces the floors corpus/attacks/README.md documents. Throws
 * ConfigError — not a bare Error, per CLAUDE.md's closed error taxonomy —
 * on any malformed file, duplicate id, or floor violation, the same way
 * packages/crawler's env loader treats bad committed input as a config
 * problem the process refuses to proceed past, rather than silently
 * scoring against a corpus smaller or thinner than the one this project's
 * numbers claim to be measured against.
 */
export function loadAttackCorpus(): LoadedCorpus {
  const attackFiles = readJsonFiles(ATTACKS_DIR);
  const controlFiles = readJsonFiles(CONTROLS_DIR);

  const attacks: AttackCorpusItem[] = attackFiles.map(({ file, json }) => {
    const result = AttackCorpusItemSchema.safeParse(json);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      throw new ConfigError(`${file} failed attack-corpus-item validation: ${issues.join("; ")}`, { file });
    }
    return result.data;
  });

  const controls: BenignControlItem[] = controlFiles.map(({ file, json }) => {
    const result = BenignControlItemSchema.safeParse(json);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      throw new ConfigError(`${file} failed benign-control-item validation: ${issues.join("; ")}`, { file });
    }
    return result.data;
  });

  const allIds = [...attacks.map((a) => a.id), ...controls.map((c) => c.id)];
  const seen = new Set<string>();
  for (const id of allIds) {
    if (seen.has(id)) {
      throw new ConfigError(`duplicate corpus item id "${id}" across corpus/attacks/`, { id });
    }
    seen.add(id);
  }

  if (attacks.length < MIN_ATTACK_ITEMS) {
    throw new ConfigError(
      `corpus/attacks/ has ${attacks.length} attack items, below the required floor of ${MIN_ATTACK_ITEMS}`,
      { count: attacks.length, floor: MIN_ATTACK_ITEMS },
    );
  }

  const patternsRepresented = new Set(attacks.map((a) => a.pattern));
  if (patternsRepresented.size < MIN_PATTERNS_REPRESENTED) {
    throw new ConfigError(
      `corpus/attacks/ covers ${patternsRepresented.size} injection pattern(s), below the required floor of ${MIN_PATTERNS_REPRESENTED}`,
      { patterns: [...patternsRepresented], floor: MIN_PATTERNS_REPRESENTED },
    );
  }

  if (controls.length < MIN_CONTROLS) {
    throw new ConfigError(
      `corpus/attacks/controls/ has ${controls.length} items, below the required floor of ${MIN_CONTROLS}`,
      { count: controls.length, floor: MIN_CONTROLS },
    );
  }

  return { attacks, controls };
}
