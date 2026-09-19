import type { CapabilityClass } from "@chaperone/policy";

export type { CapabilityClass };

/**
 * Exactly the five patterns corpus/attacks/README.md documents. Kept as a
 * const tuple (not a bare union) so both the zod schema in corpus.ts and
 * the per-pattern breakdown in scoreCorpus.ts can iterate it instead of
 * hand-listing the five values a second time somewhere.
 */
export const INJECTION_PATTERNS = [
  "direct-instruction",
  "false-authority",
  "data-exfiltration",
  "scope-widening",
  "delayed-trigger",
] as const;

export type InjectionPattern = (typeof INJECTION_PATTERNS)[number];

/**
 * One attack corpus item: a matched benign/attack pair for the same tool.
 * `authoredBy` is always the literal "project-author" — never omitted,
 * never any other value — because that fact is the entire reason
 * CLAUDE.md #7 forbids reporting a bare Chaperone block rate against this
 * corpus. See corpus/attacks/README.md.
 */
export interface AttackCorpusItem {
  id: string;
  pattern: InjectionPattern;
  toolName: string;
  capabilityClass: CapabilityClass;
  authoredBy: "project-author";
  userRequest: string;
  benignVersion: string;
  attackVersion: string;
}

/**
 * A standalone benign tool description with no attack counterpart at all —
 * corpus/attacks/README.md explains why the paired `benignVersion` fields
 * above are not a sufficient false-positive check on their own.
 */
export interface BenignControlItem {
  id: string;
  toolName: string;
  capabilityClass: CapabilityClass;
  authoredBy: "project-author";
  description: string;
}

export interface LoadedCorpus {
  attacks: readonly AttackCorpusItem[];
  controls: readonly BenignControlItem[];
}
