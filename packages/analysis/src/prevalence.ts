/**
 * M14: the prevalence sample for PREDICTIONS.md prediction 2 ("5-12% of
 * tools captured at crawl 1 carry instruction-shaped description text").
 *
 * The design is fixed in corpus/DRIFT-JSON-APPENDIX-report-shape.md
 * ("Prevalence sample") before any label: 150 tools, stratified by v2
 * capability class with proportional allocation (so the sample is
 * self-weighting and the estimate is the plain share of "yes"), drawn with a
 * seeded partial Fisher-Yates so anyone can redraw it.
 */
import { AnalysisError } from "@chaperone/errors";
import type { CapabilityClass } from "@chaperone/policy";
import { z } from "zod";
import { CAPABILITY_ORDER, type Snapshot } from "./types.js";

export const PREVALENCE_SAMPLE_SIZE = 150;
export const PREVALENCE_SEED_LABEL = "prevalence-crawl-1";
export const PREVALENCE_QUESTION =
  "Is this description instruction-shaped: does it read as an instruction directed at the calling model, " +
  "rather than a description for a person reading a catalogue?";

/**
 * FNV-1a, 32-bit, and mulberry32: the same construction as
 * packages/crawler/src/crawl.ts's seedFromString / seededSample, copied
 * rather than imported so this package does not pull the crawler's
 * DynamoDB and Docker dependencies. A test checks the copy against the seed
 * and the sample crawl 1 recorded in data/crawl-1-needs-review.json.
 */
export function seedFromString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededSample<T>(items: readonly T[], size: number, seed: number): T[] {
  const pool = [...items];
  const rand = mulberry32(seed);
  const take = Math.min(size, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, take);
}

/** Proportional allocation, rounded by largest remainder; ties go to the class earlier in TAXONOMY.md's order. */
export function allocateProportional(sizes: Readonly<Record<CapabilityClass, number>>, total: number): Record<CapabilityClass, number> {
  const population = CAPABILITY_ORDER.reduce((sum, c) => sum + sizes[c], 0);
  if (population < total) {
    throw new AnalysisError(`cannot draw ${total} from a frame of ${population}`, {});
  }
  const exact = CAPABILITY_ORDER.map((c) => ({ c, q: (sizes[c] * total) / population }));
  const allocation = Object.fromEntries(exact.map(({ c, q }) => [c, Math.floor(q)])) as Record<CapabilityClass, number>;
  let left = total - CAPABILITY_ORDER.reduce((sum, c) => sum + allocation[c], 0);
  const byRemainder = [...exact].sort((x, y) => y.q - Math.floor(y.q) - (x.q - Math.floor(x.q)) || CAPABILITY_ORDER.indexOf(x.c) - CAPABILITY_ORDER.indexOf(y.c));
  for (const { c } of byRemainder) {
    if (left === 0) {
      break;
    }
    allocation[c]++;
    left--;
  }
  return allocation;
}

const itemSchema = z.object({
  serverId: z.string(),
  toolName: z.string(),
  sha256: z.string(),
  capabilityClass: z.enum(["read", "write", "transact", "communicate"]),
  description: z.string(),
  answer: z.enum(["yes", "no"]).nullable(),
  labeledBy: z.string().nullable(),
  labeledAt: z.string().nullable(),
  taxonomyBlobSha: z.string().nullable(),
});
export type PrevalenceItem = z.infer<typeof itemSchema>;

const classCounts = z.object({ read: z.number(), write: z.number(), transact: z.number(), communicate: z.number() });

export const prevalenceFileSchema = z.object({
  $comment: z.string(),
  question: z.string(),
  crawlId: z.literal("crawl-1"),
  seed: z.number(),
  seedDerivation: z.string(),
  sampleSize: z.number(),
  frameSize: z.number(),
  frame: classCounts,
  allocation: classCounts,
  classifierVersion: z.literal("v2"),
  items: z.array(itemSchema),
});
export type PrevalenceFile = z.infer<typeof prevalenceFileSchema>;

export function drawPrevalenceSample(crawl1: Snapshot): PrevalenceFile {
  if (crawl1.crawlId !== "crawl-1") {
    throw new AnalysisError(`the prevalence frame is crawl 1's tools, not ${crawl1.crawlId}'s`, {});
  }
  const strata = new Map<CapabilityClass, Array<{ serverId: string; toolName: string; sha256: string; description: string }>>(
    CAPABILITY_ORDER.map((c) => [c, []]),
  );
  // Sorted frame, so the draw depends only on the seed and the committed archives.
  const serverIds = [...crawl1.servers.keys()].sort();
  for (const serverId of serverIds) {
    const tools = crawl1.servers.get(serverId)!;
    for (const toolName of [...tools.keys()].sort()) {
      const t = tools.get(toolName)!;
      strata.get(t.capabilityClass)!.push({ serverId, toolName, sha256: t.sha256, description: t.definition.description ?? "" });
    }
  }
  const frame = Object.fromEntries(CAPABILITY_ORDER.map((c) => [c, strata.get(c)!.length])) as Record<CapabilityClass, number>;
  const allocation = allocateProportional(frame, PREVALENCE_SAMPLE_SIZE);
  const seed = seedFromString(PREVALENCE_SEED_LABEL);

  const drawn: PrevalenceItem[] = [];
  CAPABILITY_ORDER.forEach((c, i) => {
    for (const t of seededSample(strata.get(c)!, allocation[c], (seed + i) >>> 0)) {
      drawn.push({ ...t, capabilityClass: c, answer: null, labeledBy: null, labeledAt: null, taxonomyBlobSha: null });
    }
  });
  // One more seeded shuffle, so the labeller does not see every read tool in a row.
  const items = seededSample(drawn, drawn.length, (seed + CAPABILITY_ORDER.length) >>> 0);

  return {
    $comment:
      "M14 / PREDICTIONS.md prediction 2. Drawn by `pnpm analyse:label --prevalence`; answers recorded by the same tool. " +
      "Design fixed in corpus/DRIFT-JSON-APPENDIX-report-shape.md (Prevalence sample). Stratum i is drawn with seed + i, in the order transact, communicate, write, read; the combined list is shuffled with seed + 4.",
    question: PREVALENCE_QUESTION,
    crawlId: "crawl-1",
    seed,
    seedDerivation: `seedFromString(${JSON.stringify(PREVALENCE_SEED_LABEL)})`,
    sampleSize: items.length,
    frameSize: CAPABILITY_ORDER.reduce((sum, c) => sum + frame[c], 0),
    frame,
    allocation,
    classifierVersion: "v2",
    items,
  };
}

export function parsePrevalenceFile(value: unknown, source: string): PrevalenceFile {
  const parsed = prevalenceFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new AnalysisError(`${source} is not a valid prevalence file: ${parsed.error.issues[0]?.message ?? "unknown"}`, { source });
  }
  return parsed.data;
}

export interface PrevalenceSummary {
  answered: number;
  yes: number;
  no: number;
  sampleSize: number;
  /** Stated only once every item is answered (the design says so). */
  sharePct: number | null;
}

export function summarizePrevalence(file: PrevalenceFile): PrevalenceSummary {
  const yes = file.items.filter((i) => i.answer === "yes").length;
  const no = file.items.filter((i) => i.answer === "no").length;
  const answered = yes + no;
  return {
    answered,
    yes,
    no,
    sampleSize: file.items.length,
    sharePct: answered === file.items.length && answered > 0 ? Math.round((yes / answered) * 1000) / 10 : null,
  };
}
