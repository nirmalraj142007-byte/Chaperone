import { fetchWithPolicy } from "./http.js";
import type { RepoRef } from "./dedupe.js";

export const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export type RepoActivityStatus = "active" | "dormant" | "not_found" | "error";

export interface RepoActivity {
  status: RepoActivityStatus;
  pushedAt?: string;
  detail?: string;
}

/** Whether an ISO timestamp falls within the last 90 days of `now` (defaults to the real clock). */
export function isWithinActivityWindow(pushedAtIso: string, now: number = Date.now()): boolean {
  return now - Date.parse(pushedAtIso) <= NINETY_DAYS_MS;
}

/**
 * `pushed_at` on GitHub's own repo object is the standard proxy for "has
 * this repo seen a commit recently" — one GET per repo, no separate
 * commit-list call needed. Unauthenticated GitHub REST is capped at 60
 * requests/hour; passing a token (no scopes needed for public metadata)
 * raises that to 5000/hour.
 */
export async function fetchRepoActivity(repo: RepoRef, githubToken: string | undefined): Promise<RepoActivity> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
  const res = await fetchWithPolicy(url, { sourceId: "github-activity", headers });

  if (res.status === 404) {
    return { status: "not_found" };
  }
  if (res.status !== 200) {
    return { status: "error", detail: `HTTP ${res.status}` };
  }

  let body: { pushed_at?: string };
  try {
    body = JSON.parse(res.body) as { pushed_at?: string };
  } catch {
    return { status: "error", detail: "unparseable JSON" };
  }
  if (!body.pushed_at) {
    return { status: "error", detail: "response had no pushed_at field" };
  }

  return { status: isWithinActivityWindow(body.pushed_at) ? "active" : "dormant", pushedAt: body.pushed_at };
}
