import { childLogger } from "@chaperone/logger";
import { fetchGithub } from "./githubClient.js";

const log = childLogger({ component: "advisory-changelog" });

export type ChangelogEvidence = "release" | "tag" | "commit-message" | "none";

export interface ChangelogResult {
  evidence: ChangelogEvidence;
  evidenceUrl?: string;
}

interface CommitEntry {
  sha: string;
  html_url: string;
}

interface ReleaseEntry {
  published_at?: string;
  html_url: string;
}

interface TagEntry {
  name: string;
  commit?: { sha: string };
}

const GITHUB_API_BASE = "https://api.github.com";

function repoPath(owner: string, repo: string): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * Answers the proposal's "did they say so anywhere" cross-check: of a
 * server whose tool description changed since this household pinned it,
 * did the vendor leave *any* public trace — a GitHub Release, a tag, or
 * even just a commit — since the pin date? Ranked release > tag >
 * commit-message > none by how legible the signal would have been to a
 * resident who went looking. Three REST calls (commits since the pin date,
 * all releases, all tags), each disk-cached and token-bucketed via
 * `fetchGithub`. A 403 (GitHub's unauthenticated-rate-limit response, or a
 * blocked/private repo) or any other non-200 on the first call degrades to
 * "none" rather than throwing — an unresolved changelog status must never
 * block the advisory pipeline it decorates, matching scoreDiff's own
 * never-throws contract.
 *
 * Not currently called by localRunner.ts: a live household's `Quarantine`
 * row records only `upstreamId` (an id into `CHAPERONE_UPSTREAMS`), never a
 * GitHub owner/repo — there is nothing to cross-check yet for the gateway's
 * own connected upstreams. This function exists for the corpus-wide drift
 * analysis (`packages/analysis`, not yet built — CLAUDE.md's repo layout,
 * targeted for Phase 19 against crawl 2 on 2026-10-20), which will need to
 * resolve a `DriftRecord.serverId` to a `repoOwner`/`repoName` before it can
 * call this function.
 *
 * That join must read `corpus/candidates.json` (the frozen, git-committed
 * corpus — every entry already carries `serverId`, `repoOwner`, `repoName`),
 * NOT the DynamoDB `corpus-server` table via `@chaperone/ledger`'s
 * `getCorpusServer`. Verified 2026-09-19: the local `corpus-server` table is
 * currently empty (a `docker compose down -v` during Phase 10 dropped the
 * volume), and nothing re-populates it short of re-running
 * `crawl:assemble` — forbidden post-freeze (CLAUDE.md: "The corpus was
 * frozen at crawl 1. Never re-assemble it."). Confirmed by reading
 * `packages/crawler/src/crawl.ts`'s own `runCrawl`: its one `putCorpusServer`
 * call is gated behind `if (existing)` — a crawl 2 run only *updates* a
 * corpus-server row that's already there, it never creates one from
 * scratch, so simply re-running the crawler won't refill the table either.
 * `assemble.ts` is the only code path that ever creates a fresh
 * corpus-server row, and that path is exactly what the freeze rule forbids
 * running again. See docs/AWS-BUILDER.md.
 */
export async function checkChangelog(
  owner: string,
  repo: string,
  sinceIso: string,
  githubToken: string | undefined,
  apiBase: string = GITHUB_API_BASE,
): Promise<ChangelogResult> {
  try {
    const base = `${apiBase}/repos/${repoPath(owner, repo)}`;

    const commitsRes = await fetchGithub(`${base}/commits?since=${encodeURIComponent(sinceIso)}&per_page=100`, githubToken);
    if (commitsRes.status !== 200 || !Array.isArray(commitsRes.json)) {
      log.debug({ owner, repo, status: commitsRes.status }, "commits-since lookup did not return 200; degrading to none");
      return { evidence: "none" };
    }
    const commitsSince = commitsRes.json as CommitEntry[];
    if (commitsSince.length === 0) {
      return { evidence: "none" };
    }
    const shasSince = new Set(commitsSince.map((c) => c.sha));

    const releasesRes = await fetchGithub(`${base}/releases?per_page=100`, githubToken);
    if (releasesRes.status === 200 && Array.isArray(releasesRes.json)) {
      const sinceMs = Date.parse(sinceIso);
      const release = (releasesRes.json as ReleaseEntry[]).find(
        (r) => r.published_at !== undefined && Date.parse(r.published_at) > sinceMs,
      );
      if (release) {
        return { evidence: "release", evidenceUrl: release.html_url };
      }
    }

    const tagsRes = await fetchGithub(`${base}/tags?per_page=100`, githubToken);
    if (tagsRes.status === 200 && Array.isArray(tagsRes.json)) {
      const tag = (tagsRes.json as TagEntry[]).find((t) => t.commit?.sha !== undefined && shasSince.has(t.commit.sha));
      if (tag) {
        return {
          evidence: "tag",
          evidenceUrl: `https://github.com/${repoPath(owner, repo)}/releases/tag/${encodeURIComponent(tag.name)}`,
        };
      }
    }

    const mostRecentCommit = commitsSince[0]!;
    return { evidence: "commit-message", evidenceUrl: mostRecentCommit.html_url };
  } catch (error) {
    log.warn({ owner, repo, error }, "changelog cross-check failed unexpectedly; degrading to none");
    return { evidence: "none" };
  }
}
