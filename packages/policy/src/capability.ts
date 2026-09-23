import type { CapabilityClass, ToolDefinition } from "./types.js";

export interface CapabilityVerdict {
  class: CapabilityClass;
  confidence: "high" | "low";
  matchedRules: string[];
}

/**
 * A capability verdict is only comparable to another verdict produced by
 * the same classifier version. Every verdict crawl.ts persists records
 * which version produced it (`capabilityAssignedBy`), so a rule-table fix
 * never silently reclassifies crawl 1's frozen evidence — see
 * `corpus/TAXONOMY-APPENDIX-classifier-v2.md` and CLAUDE.md's "Capability
 * classifier versioning" section for why this exists and how Phase 19's
 * drift analysis must use it.
 */
export type ClassifierVersion = "v1" | "v2";

/** The version new classifications should record. Bump only alongside a new rule set below, never in place. */
export const CLASSIFIER_VERSION: ClassifierVersion = "v2";

interface VerbEntry {
  stem: string;
  /**
   * Inflection suffixes this stem is allowed to match with, beyond the bare
   * form (which always matches). Not a stemmer — a fixed, per-verb, hand-
   * reviewed list, so the whole table stays printable into the taxonomy
   * appendix and readable by a judge in one pass.
   */
  suffixes: readonly string[];
}

interface CapabilityRule {
  class: Exclude<CapabilityClass, "read">;
  verbs: readonly VerbEntry[];
  pattern: RegExp;
}

/**
 * MCP tool descriptions are conventionally third-person singular ("Sends a
 * message", "Creates a file", "Uploads a document"), so matching only the
 * bare stem misses the majority case, not an edge case. `s`/`es`/`ed`/`ing`
 * covers the common regular inflections; irregulars (sent, paid) are not
 * handled — accepted, since handling them would mean a stem-by-stem
 * spelling table anyway and these are rare in tool-description text.
 */
const DEFAULT_SUFFIXES = ["s", "es", "ed", "ing"] as const;

function verb(stem: string, suffixes: readonly string[] = DEFAULT_SUFFIXES): VerbEntry {
  return { stem, suffixes };
}

/**
 * Applies exactly one English spelling rule — drop a stem's trailing silent
 * `e` before an `-ed` or `-ing` suffix ("write" + "ing" → "writing", not
 * "writeing") — and nothing else. This is not a stemmer: it's a single,
 * named, reversible transformation, applied the same way to every stem, so
 * the resulting surface forms are still fully enumerable and printable.
 * `-s`/`-es` never drop the `e` ("message" + "s" → "messages", correctly).
 */
function stemWithSuffix(stem: string, suffix: string): string {
  const dropsSilentE = (suffix === "ed" || suffix === "ing") && stem.endsWith("e");
  return dropsSilentE ? `${stem.slice(0, -1)}${suffix}` : `${stem}${suffix}`;
}

function buildPattern(verbs: readonly VerbEntry[]): RegExp {
  const alternatives = verbs.flatMap(({ stem, suffixes }) => [
    stem,
    ...suffixes.map((suffix) => stemWithSuffix(stem, suffix)),
  ]);
  return new RegExp(`\\b(?:${alternatives.join("|")})\\b`, "i");
}

function ruleFor(cls: Exclude<CapabilityClass, "read">, verbs: readonly VerbEntry[]): CapabilityRule {
  return { class: cls, verbs, pattern: buildPattern(verbs) };
}

/**
 * One rule (one combined regex) per non-default class, built from a
 * per-verb suffix table. Exported so the exact verb families — and which
 * inflections each one accepts — can be printed verbatim into the corpus
 * taxonomy appendix rather than re-transcribed by hand.
 *
 * Three stems below deliberately don't get the default suffix set, because
 * their inflected form collides with an unrelated, common noun sense in
 * ordinary tool-description text:
 *
 * - `order` → suffixes restricted to `s` only. "ordering" / "ordered"
 *   overwhelmingly mean sequence ("results in a specified ordering"), not a
 *   purchase, in this kind of text; the bare and plural forms ("order an
 *   item", "recent orders") are unambiguous and stay.
 * - `message` and `post` → suffixes restricted to `ed`/`ing`, dropping
 *   `s`/`es`. "messages" and "posts" are overwhelmingly the plural nouns
 *   ("reads messages from the inbox", "lists recent posts from the blog"),
 *   not the verb. The bare form and the unambiguous verb inflections
 *   ("messaged", "messaging", "posted", "posting") still match.
 *
 * A word-position heuristic ("only counts in the first four words") was
 * considered and rejected: in "Lists recent posts from the blog", "posts"
 * is the third word; in "Places an order for groceries", "order" is also
 * the third word. Position is identical and the correct verdict is
 * opposite, so position cannot be the signal — the inflected *form* is.
 * `bill`/`billing` is not currently a listed transact verb at all, so it
 * cannot fire today; no restriction is needed for it yet.
 */
const TRANSACT_VERBS: readonly VerbEntry[] = [
  verb("purchase"),
  verb("order", ["s"]),
  verb("checkout"),
  verb("pay"),
  verb("charge"),
  verb("refund"),
  verb("invoice"),
  verb("subscribe"),
  verb("bid"),
];

const COMMUNICATE_VERBS: readonly VerbEntry[] = [
  verb("send"),
  verb("email"),
  verb("message", ["ed", "ing"]),
  verb("post", ["ed", "ing"]),
  verb("notify"),
  verb("sms"),
  verb("slack"),
  verb("tweet"),
  verb("publish"),
];

/** v1's write list — frozen exactly as crawl 1 saw it. Never add to this array; add to WRITE_VERBS_V2 instead. */
const WRITE_VERBS_V1: readonly VerbEntry[] = [
  verb("create"),
  verb("update"),
  verb("delete"),
  verb("set"),
  verb("write"),
  verb("upload"),
  verb("move"),
  verb("rename"),
  verb("install"),
];

/**
 * v2's write list — found Sept 20, 2026: v1 has no verb matching
 * "add"/"adds"/"adding", so a tool like `add_item("Adds an item to your
 * shopping list.")` — TAXONOMY.md's Axis 2 `write` example verbatim —
 * defaulted to `read`/`low` under v1. Every stem below is justified only
 * against `corpus/TAXONOMY.md`'s frozen `write` definition ("mutates state
 * that belongs to the user"), never against a drift result — no crawl 2
 * exists yet, so there is nothing to have tuned toward. See
 * `corpus/TAXONOMY-APPENDIX-classifier-v2.md` for the full evidence review
 * against crawl 1's `data/raw/crawl-1/` archives (947 servers, 6,058
 * tools) that produced the suffix restrictions and the one deliberate
 * omission below.
 *
 * - `add`, `insert`, `append`, `clear`: unrestricted (default suffixes).
 *   Reviewing every read/low-confidence crawl-1 tool whose text matches
 *   these stems found true positives dominant and no suffix-fixable false
 *   positive pattern (unlike the three below) — the residual risk that
 *   remains (e.g. "add" inside a clause describing what an optional
 *   *parameter* does to a read tool's output, not what the tool itself
 *   does; "clear" used as an adjective, "a clear error") is a scope- or
 *   part-of-speech ambiguity no fixed suffix list resolves, the same
 *   category of irreducible noise `set` (v1) already carries. Accepted and
 *   documented in `docs/LIMITATIONS.md`, not engineered around.
 * - `save` → suffixes restricted to `s` only, matching `order`'s pattern
 *   above. "saved" is overwhelmingly an adjective describing data a
 *   *read* tool then lists ("saved icons", "profiles saved for the
 *   token") in crawl-1 text, not this tool's own action; "-ing" showed no
 *   confirmed safe use either. The bare form ("Save a new link") and
 *   third-person-singular ("Saves the PDF to disk") are unambiguous and
 *   stay — though the bare form still carries its own residual risk in a
 *   compound noun ("save time", "save icon"), the same irreducible,
 *   suffix-unfixable category called out for `add`/`clear` above.
 * - `edit` → suffixes restricted to `ed`/`ing` only, matching
 *   `message`/`post`'s pattern above. "edits" is a plural noun in ordinary
 *   crawl-1 text ("edits to the original stop reaching it") exactly the
 *   way "messages"/"posts" are; the bare form and the unambiguous verb
 *   inflections stay.
 * - `remove` → suffixes restricted to `s` only. Across crawl-1 matches,
 *   the bare/third-person-singular form was the tool's own imperative
 *   action ("Remove a service", "removes it from favourites") while
 *   "-ed"/"-ing" was dominated by describing some *other* fact — a
 *   regulatory status ("devices removed... from the market"), a diff
 *   output label ("added / removed / changed"), or a read tool's internal
 *   text processing ("removing navigation, ads, and clutter") — never this
 *   tool's own mutation.
 *
 * `modify` was reviewed and deliberately NOT added: every true positive it
 * matched in crawl-1 was already caught by `edit` (the same
 * image-editing tools describe themselves with both words), while its
 * false positives were disproportionate for a small sample — two explicit
 * negations ("does not modify the crawl", "Does not modify any pixel
 * data"), one instance of a read tool's own description naming a
 * *different* tool by name ("Call this BEFORE modify_diagram"), and one
 * instance of the *user's* action, not the tool's ("whenever you modify a
 * route... [and use this tool to] confirm"). Zero unique true-positive
 * value against real false-positive cost — the same judgment call v1
 * already made for `bill`/`billing` (see the module-level comment above).
 */
const WRITE_VERBS_V2: readonly VerbEntry[] = [
  ...WRITE_VERBS_V1,
  verb("add"),
  verb("insert"),
  verb("append"),
  verb("clear"),
  verb("save", ["s"]),
  verb("edit", ["ed", "ing"]),
  verb("remove", ["s"]),
];

const CAPABILITY_RULES_V1: readonly CapabilityRule[] = [
  ruleFor("transact", TRANSACT_VERBS),
  ruleFor("communicate", COMMUNICATE_VERBS),
  ruleFor("write", WRITE_VERBS_V1),
];

const CAPABILITY_RULES_V2: readonly CapabilityRule[] = [
  ruleFor("transact", TRANSACT_VERBS),
  ruleFor("communicate", COMMUNICATE_VERBS),
  ruleFor("write", WRITE_VERBS_V2),
];

/** Every classifier version's rule table, keyed by the version string recorded alongside each verdict. */
export const CAPABILITY_RULES_BY_VERSION: Readonly<Record<ClassifierVersion, readonly CapabilityRule[]>> = {
  v1: CAPABILITY_RULES_V1,
  v2: CAPABILITY_RULES_V2,
};

/** The rule table for `CLASSIFIER_VERSION` — kept for callers (and the taxonomy appendix) that want "the current rules" without naming a version. */
export const CAPABILITY_RULES: readonly CapabilityRule[] = CAPABILITY_RULES_BY_VERSION[CLASSIFIER_VERSION];

/** Consequence order: a tool that can spend money is more dangerous unmonitored than one that can only message, which is more dangerous than one that only mutates local state. */
const PRECEDENCE: readonly CapabilityClass[] = ["transact", "communicate", "write", "read"];

function normalize(text: string): string {
  // Tool names are typically snake_case or kebab-case; treat separators as
  // word breaks so `\b` lines up on the verb inside e.g. "place_order".
  return text.replace(/[_-]+/g, " ");
}

export function classifyCapability(
  tool: ToolDefinition,
  version: ClassifierVersion = CLASSIFIER_VERSION,
): CapabilityVerdict {
  const haystack = normalize(`${tool.name} ${tool.description ?? ""}`);
  const rules = CAPABILITY_RULES_BY_VERSION[version];
  const matchedRuleClasses = rules.filter((rule) => rule.pattern.test(haystack)).map((rule) => rule.class);

  if (matchedRuleClasses.length === 0) {
    return { class: "read", confidence: "low", matchedRules: [] };
  }

  // A tool can genuinely span classes (create the order, then email the
  // receipt) — that is exactly what the precedence order exists to resolve,
  // not a reason to hedge. `low` is reserved for the no-match case, where
  // the verdict is a default rather than something the text actually said.
  const matchedClassSet = new Set<CapabilityClass>(matchedRuleClasses);
  const winner = PRECEDENCE.find((cls) => matchedClassSet.has(cls))!;

  return {
    class: winner,
    confidence: "high",
    matchedRules: matchedRuleClasses,
  };
}

/** The minimal shape Phase 19's drift analysis needs from a `ToolSnapshot` row to check classifier stability. */
export interface HashedCapability {
  sha256: string;
  capabilityClass: CapabilityClass;
}

export interface CapabilityClassifierArtifact {
  sha256: string;
  crawl1Class: CapabilityClass;
  crawl2Class: CapabilityClass;
}

/**
 * A tool's capability class is assigned once, at first observation
 * (`corpus/TAXONOMY.md`, Axis 2) and never re-derived at crawl 2 for a tool
 * that already existed at crawl 1 — so if two crawls recorded the exact
 * same canonical bytes (`sha256` identical) for a tool, under the SAME
 * classifier version, nothing the classifier reads changed, and its
 * verdict must not have changed either. A mismatch here is never real
 * drift; it is either a bug (classifier nondeterminism) or a caller
 * comparing two different classifier versions against each other, which
 * CLAUDE.md's "Capability classifier versioning" section forbids. Phase
 * 19's drift analysis calls this before publishing any capability-class
 * transition and treats a non-empty result as a hard failure, not a
 * reportable finding.
 */
export function findCapabilityClassifierArtifacts(
  crawl1: readonly HashedCapability[],
  crawl2: readonly HashedCapability[],
): CapabilityClassifierArtifact[] {
  const crawl1ClassBySha = new Map(crawl1.map((row) => [row.sha256, row.capabilityClass]));
  const artifacts: CapabilityClassifierArtifact[] = [];

  for (const row of crawl2) {
    const crawl1Class = crawl1ClassBySha.get(row.sha256);
    if (crawl1Class !== undefined && crawl1Class !== row.capabilityClass) {
      artifacts.push({ sha256: row.sha256, crawl1Class, crawl2Class: row.capabilityClass });
    }
  }

  return artifacts;
}
