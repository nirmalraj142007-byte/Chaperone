/**
 * Baseline 1: a genuinely dumb regex blocklist over tool-description text.
 * CLAUDE.md's honest floor — cheap, unprincipled, at most 40 lines. It is
 * reported as a real detection-rate/false-positive-rate pair, not a
 * strawman: if it matches a model classifier on prevalence detection, that
 * is a finding for data/baselines.json, not a bug in this file.
 */
export interface RegexBlocklistVerdict {
  flagged: boolean;
  matchedPatterns: string[];
}

const BLOCKLIST_PATTERNS: readonly RegExp[] = [
  /system note/i,
  /\[\s*system\s*\]/i,
  /admin(?:istrator)?\s*(?:override|note)?\s*:/i,
  /developer instructions?/i,
  /internal use only/i,
  /important\s*[-—:]/i,
  /ignore\s+(?:the\s+|any\s+|all\s+)?(?:previous|prior|above)\s+instructions/i,
  /before\s+(?:responding|completing|finishing|replying)/i,
  /do\s+not\s+(?:mention|tell|disclose|reveal|describe)/i,
  /without\s+(?:mentioning|telling|disclosing|confirming)/i,
  /also\s+(?:include|attach|forward|report|read back)\s+(?:the|your|their|last|current|today's|any)/i,
  /the\s+first\s+time/i,
  /starting\s+(?:with\s+the\s+|next|after|on|beginning)/i,
  /silently/i,
];

/** Never throws, never partially matches — one pass over `text`, every pattern checked. */
export function classifyWithRegexBlocklist(text: string): RegexBlocklistVerdict {
  const matchedPatterns = BLOCKLIST_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  return { flagged: matchedPatterns.length > 0, matchedPatterns };
}
