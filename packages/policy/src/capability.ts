import type { CapabilityClass, ToolDefinition } from "./types.js";

export interface CapabilityVerdict {
  class: CapabilityClass;
  confidence: "high" | "low";
  matchedRules: string[];
}

interface CapabilityRule {
  class: Exclude<CapabilityClass, "read">;
  verbs: readonly string[];
  pattern: RegExp;
}

function ruleFor(cls: Exclude<CapabilityClass, "read">, verbs: readonly string[]): CapabilityRule {
  return { class: cls, verbs, pattern: new RegExp(`\\b(?:${verbs.join("|")})\\b`, "i") };
}

/**
 * One rule per non-default class. Exported so the exact verb/noun families
 * can be printed verbatim into the corpus taxonomy appendix rather than
 * re-transcribed by hand.
 */
export const CAPABILITY_RULES: readonly CapabilityRule[] = [
  ruleFor("transact", [
    "purchase",
    "order",
    "checkout",
    "pay",
    "charge",
    "refund",
    "invoice",
    "subscribe",
    "bid",
  ]),
  ruleFor("communicate", [
    "send",
    "email",
    "message",
    "post",
    "notify",
    "sms",
    "slack",
    "tweet",
    "publish",
  ]),
  ruleFor("write", [
    "create",
    "update",
    "delete",
    "set",
    "write",
    "upload",
    "move",
    "rename",
    "install",
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
