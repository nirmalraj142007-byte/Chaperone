import type { CapabilityClass, ToolDefinition } from "./types.js";

export interface CapabilityVerdict {
  class: CapabilityClass;
  confidence: "high" | "low";
  matchedRules: string[];
}

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
export const CAPABILITY_RULES: readonly CapabilityRule[] = [
  ruleFor("transact", [
    verb("purchase"),
    verb("order", ["s"]),
    verb("checkout"),
    verb("pay"),
    verb("charge"),
    verb("refund"),
    verb("invoice"),
    verb("subscribe"),
    verb("bid"),
  ]),
  ruleFor("communicate", [
    verb("send"),
    verb("email"),
    verb("message", ["ed", "ing"]),
    verb("post", ["ed", "ing"]),
    verb("notify"),
    verb("sms"),
    verb("slack"),
    verb("tweet"),
    verb("publish"),
  ]),
  ruleFor("write", [
    verb("create"),
    verb("update"),
    verb("delete"),
    verb("set"),
    verb("write"),
    verb("upload"),
    verb("move"),
    verb("rename"),
    verb("install"),
  ]),
];

/** Consequence order: a tool that can spend money is more dangerous unmonitored than one that can only message, which is more dangerous than one that only mutates local state. */
const PRECEDENCE: readonly CapabilityClass[] = ["transact", "communicate", "write", "read"];

function normalize(text: string): string {
  // Tool names are typically snake_case or kebab-case; treat separators as
  // word breaks so `\b` lines up on the verb inside e.g. "place_order".
  return text.replace(/[_-]+/g, " ");
}

export function classifyCapability(tool: ToolDefinition): CapabilityVerdict {
  const haystack = normalize(`${tool.name} ${tool.description ?? ""}`);
  const matchedRuleClasses = CAPABILITY_RULES.filter((rule) => rule.pattern.test(haystack)).map(
    (rule) => rule.class,
  );

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
