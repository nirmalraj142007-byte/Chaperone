import { classifyWithRegexBlocklist } from "./baseline-regex.js";
import { INJECTION_PATTERNS, type InjectionPattern, type LoadedCorpus } from "./types.js";

export interface PatternBreakdown {
  pattern: InjectionPattern;
  total: number;
  detected: number;
  detectionRate: number;
}

export interface Baseline1Result {
  totalAttacks: number;
  detectedCount: number;
  detectionRate: number;
  totalBenign: number;
  falsePositiveCount: number;
  falsePositiveRate: number;
  perPattern: PatternBreakdown[];
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Runs baseline 1 (the regex blocklist) over the whole loaded corpus.
 * Detection is measured against every `attackVersion`; false positives
 * against every paired `benignVersion` *and* every standalone control —
 * corpus/attacks/README.md explains why the paired benign texts alone
 * would be too easy a bar.
 */
export function scoreBaseline1(corpus: LoadedCorpus): Baseline1Result {
  const attackVerdicts = corpus.attacks.map((item) => ({
    item,
    verdict: classifyWithRegexBlocklist(item.attackVersion),
  }));
  const detectedCount = attackVerdicts.filter(({ verdict }) => verdict.flagged).length;

  const benignTexts = [
    ...corpus.attacks.map((item) => item.benignVersion),
    ...corpus.controls.map((control) => control.description),
  ];
  const falsePositiveCount = benignTexts.filter((text) => classifyWithRegexBlocklist(text).flagged).length;

  const perPattern: PatternBreakdown[] = INJECTION_PATTERNS.map((pattern) => {
    const inPattern = attackVerdicts.filter(({ item }) => item.pattern === pattern);
    const detected = inPattern.filter(({ verdict }) => verdict.flagged).length;
    return { pattern, total: inPattern.length, detected, detectionRate: rate(detected, inPattern.length) };
  });

  return {
    totalAttacks: corpus.attacks.length,
    detectedCount,
    detectionRate: rate(detectedCount, corpus.attacks.length),
    totalBenign: benignTexts.length,
    falsePositiveCount,
    falsePositiveRate: rate(falsePositiveCount, benignTexts.length),
    perPattern,
  };
}
