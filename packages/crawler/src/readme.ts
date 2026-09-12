import { fetchWithPolicy } from "./http.js";
import type { RepoRef } from "./dedupe.js";

const README_CANDIDATES = ["README.md", "README", "readme.md"];

/**
 * `HEAD` is accepted by raw.githubusercontent.com as an alias for the
 * repo's default branch (confirmed live against both a `main`-default and a
 * `master`-default repo on 2026-09-12), so this needs exactly one guess per
 * filename instead of branch-guessing on top of filename-guessing.
 */
export async function fetchRepoReadme(repo: RepoRef): Promise<string | undefined> {
  for (const filename of README_CANDIDATES) {
    const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/HEAD/${filename}`;
    const res = await fetchWithPolicy(url, { sourceId: "readme" });
    if (res.status === 200) {
      return res.body;
    }
  }
  return undefined;
}
