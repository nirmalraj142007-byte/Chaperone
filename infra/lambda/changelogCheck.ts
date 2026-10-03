/**
 * AWS-01's changelog-check Lambda: the parallel branch that needs no model.
 * For a quarantined tool it asks the question the proposal's rider C asks of
 * the whole corpus, for one live change: between the day the household pinned
 * this tool and the day the change was caught, did the vendor leave any public
 * trace (a GitHub release, a tag, a commit)?
 *
 * Its role may read `chaperone-quarantine` and `chaperone-pin` and nothing
 * else: no write verb, no model access, no secret. It calls the public GitHub
 * REST API unauthenticated (60 requests/hour; one household's quarantines are
 * far under that).
 *
 * A quarantine row records `upstreamId`, never a GitHub owner/repo, so the
 * repository comes from `UPSTREAM_REPOS`, a JSON map `{ upstreamId: {owner,
 * repo} }` in this function's environment. An upstream that is not in the map
 * (the staged demo upstream is not a GitHub project) gets `unresolved`, which
 * is deliberately not the same as `none`: "we could not look" must never read
 * as "the vendor said nothing".
 */
import { checkChangelog, type ChangelogEvidence } from "@chaperone/advisory";
import { getPin, getQuarantine } from "@chaperone/ledger";
import { childLogger } from "@chaperone/logger";

const log = childLogger({ component: "advisory-pipeline-changelog" });

interface ChangelogCheckEvent {
  householdId: string;
  quarantineId: string;
}

export type ChangelogCheckOutput =
  | { status: "checked"; quarantineId: string; evidence: ChangelogEvidence; evidenceUrl?: string; windowStart: string; windowEnd: string }
  | { status: "unresolved"; quarantineId: string; reason: "quarantine-not-found" | "upstream-has-no-repo" | "no-pin" };

interface RepoRef {
  owner: string;
  repo: string;
}

function upstreamRepos(): Record<string, RepoRef> {
  try {
    return JSON.parse(process.env["UPSTREAM_REPOS"] ?? "{}") as Record<string, RepoRef>;
  } catch {
    log.error("UPSTREAM_REPOS is not valid JSON; treating every upstream as unresolved");
    return {};
  }
}

export async function handler(event: ChangelogCheckEvent): Promise<ChangelogCheckOutput> {
  const quarantine = await getQuarantine(event.householdId, event.quarantineId);
  if (quarantine === undefined) {
    return { status: "unresolved", quarantineId: event.quarantineId, reason: "quarantine-not-found" };
  }

  const repoRef = upstreamRepos()[quarantine.upstreamId];
  if (repoRef === undefined) {
    return { status: "unresolved", quarantineId: event.quarantineId, reason: "upstream-has-no-repo" };
  }

  const pin = await getPin(event.householdId, quarantine.upstreamId, quarantine.toolName);
  if (pin === undefined) {
    return { status: "unresolved", quarantineId: event.quarantineId, reason: "no-pin" };
  }

  const result = await checkChangelog(
    repoRef.owner,
    repoRef.repo,
    pin.approvedAt,
    process.env["GITHUB_TOKEN"],
    undefined,
    quarantine.detectedAt,
  );

  return {
    status: "checked",
    quarantineId: event.quarantineId,
    evidence: result.evidence,
    ...(result.evidenceUrl !== undefined ? { evidenceUrl: result.evidenceUrl } : {}),
    windowStart: pin.approvedAt,
    windowEnd: quarantine.detectedAt,
  };
}
