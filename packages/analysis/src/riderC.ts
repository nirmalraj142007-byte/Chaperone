/**
 * Rider C: PREDICTIONS.md prediction 3. Of the servers with a semantic-intent
 * change, how many published any signal of it inside the window? The signal
 * check itself (`checkChangelog`, packages/advisory) is injected, so this file
 * stays free of network code and a test can drive it.
 */
import type { Candidate } from "./types.js";

export type SignalEvidence = "release" | "tag" | "commit-message" | "none";

export type SignalChecker = (owner: string, repo: string, sinceIso: string) => Promise<{ evidence: SignalEvidence; evidenceUrl?: string }>;

/** PREDICTIONS.md prediction 3: "fewer than 30%". */
export const RIDER_C_PREDICTED_SHARE_BELOW = 0.3;

export interface RiderCPerServer {
  serverId: string;
  repoOwner: string;
  repoName: string;
  evidence: SignalEvidence;
  evidenceUrl: string | null;
}

export interface RiderCEvaluation {
  driftedServers: number;
  checkable: number;
  unverifiable: number;
  withPublishedSignal: number;
  evidenceCounts: Record<SignalEvidence, number>;
  shareWithSignalOfCheckable: number | null;
  shareWithSignalOfDrifted: number;
  verdict: "confirmed" | "refuted" | "inconclusive";
  perServer: RiderCPerServer[];
}

export async function evaluateRiderC(
  driftedServerIds: readonly string[],
  candidates: readonly Candidate[],
  windowStart: string,
  check: SignalChecker,
): Promise<RiderCEvaluation> {
  const byId = new Map(candidates.map((c) => [c.serverId, c]));
  const evidenceCounts: Record<SignalEvidence, number> = { release: 0, tag: 0, "commit-message": 0, none: 0 };
  const perServer: RiderCPerServer[] = [];
  let unverifiable = 0;

  for (const serverId of driftedServerIds) {
    const candidate = byId.get(serverId);
    const owner = candidate?.repoOwner;
    const repo = candidate?.repoName;
    if (!owner || !repo) {
      unverifiable++;
      continue;
    }
    const result = await check(owner, repo, windowStart);
    evidenceCounts[result.evidence]++;
    perServer.push({ serverId, repoOwner: owner, repoName: repo, evidence: result.evidence, evidenceUrl: result.evidenceUrl ?? null });
  }

  const checkable = perServer.length;
  const withPublishedSignal = checkable - evidenceCounts.none;
  const drifted = driftedServerIds.length;
  const ofCheckable = checkable === 0 ? null : withPublishedSignal / checkable;
  const ofDrifted = drifted === 0 ? 0 : withPublishedSignal / drifted;

  let verdict: RiderCEvaluation["verdict"] = "inconclusive";
  if (ofCheckable !== null) {
    if (ofCheckable < RIDER_C_PREDICTED_SHARE_BELOW && ofDrifted < RIDER_C_PREDICTED_SHARE_BELOW) {
      verdict = "confirmed";
    } else if (ofCheckable >= RIDER_C_PREDICTED_SHARE_BELOW && ofDrifted >= RIDER_C_PREDICTED_SHARE_BELOW) {
      verdict = "refuted";
    }
  }

  return {
    driftedServers: drifted,
    checkable,
    unverifiable,
    withPublishedSignal,
    evidenceCounts,
    shareWithSignalOfCheckable: ofCheckable,
    shareWithSignalOfDrifted: ofDrifted,
    verdict,
    perServer,
  };
}
