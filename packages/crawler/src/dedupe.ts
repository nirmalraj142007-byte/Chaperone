import { createHash } from "node:crypto";
import type { InstallHint, SourceId, SourceServer } from "./types.js";

export interface RepoRef {
  owner: string;
  name: string;
}

const GITHUB_REPO_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[/?#].*)?$/i;

export function parseGithubRepo(url: string | undefined): RepoRef | undefined {
  if (!url) {
    return undefined;
  }
  const match = GITHUB_REPO_URL.exec(url.trim());
  if (!match) {
    return undefined;
  }
  const [, owner, name] = match;
  if (!owner || !name) {
    return undefined;
  }
  return { owner: owner.toLowerCase(), name: name.toLowerCase() };
}

function sanitizeSlugSuffix(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length > 0) {
    return cleaned.slice(0, 32);
  }
  return createHash("sha1").update(slug).digest("hex").slice(0, 8);
}

/** `{owner}__{repo}__{slugSuffix}` for repo-identified servers, `{sourceId}__{slug}` otherwise — both lowercased. */
export function deriveServerId(entry: { sourceId: SourceId; slug: string; repo?: RepoRef }): string {
  const suffix = sanitizeSlugSuffix(entry.slug);
  if (entry.repo) {
    return `${entry.repo.owner}__${entry.repo.name}__${suffix}`.toLowerCase();
  }
  return `${entry.sourceId}__${suffix}`.toLowerCase();
}

export interface MergedCandidate {
  serverId: string;
  displayName: string;
  sources: SourceId[];
  repo?: RepoRef;
  repoUrl?: string;
  installHint?: InstallHint;
  members: SourceServer[];
}

function mergeInto(existing: MergedCandidate, entry: SourceServer, repo: RepoRef | undefined): void {
  if (!existing.sources.includes(entry.sourceId)) {
    existing.sources.push(entry.sourceId);
  }
  existing.members.push(entry);
  // Awesome is the only source that reliably yields an install path (see
  // sources/awesome.ts) — prefer its hint over a merged-in guess from
  // elsewhere, but keep whatever hint is already known if awesome has none.
  if (entry.installHint && (!existing.installHint || entry.sourceId === "awesome")) {
    existing.installHint = entry.installHint;
  }
  if (!existing.repo && repo && entry.repoUrl) {
    existing.repo = repo;
    existing.repoUrl = entry.repoUrl;
  }
}

function createCandidate(entry: SourceServer, repo: RepoRef | undefined): MergedCandidate {
  return {
    serverId: deriveServerId({ sourceId: entry.sourceId, slug: entry.slug, ...(repo ? { repo } : {}) }),
    displayName: entry.displayName,
    sources: [entry.sourceId],
    ...(repo && entry.repoUrl ? { repo, repoUrl: entry.repoUrl } : {}),
    ...(entry.installHint ? { installHint: entry.installHint } : {}),
    members: [entry],
  };
}

/**
 * Dedupes on normalised GitHub owner/repo first, then on slug — per the
 * phase prompt. A repo-identified entry only ever merges with another entry
 * sharing that exact repo; slug matching applies only among entries that
 * have no resolvable repo, so two distinctly-repo'd servers that happen to
 * share a display slug (e.g. two unrelated "gmail" tools) are never
 * conflated by that second pass.
 */
export function dedupeCandidates(entries: SourceServer[]): MergedCandidate[] {
  const byRepoKey = new Map<string, MergedCandidate>();
  const bySlugKey = new Map<string, MergedCandidate>();
  const order: MergedCandidate[] = [];

  for (const entry of entries) {
    const repo = parseGithubRepo(entry.repoUrl);
    const slugKey = entry.slug.toLowerCase();

    if (repo) {
      const repoKey = `${repo.owner}/${repo.name}`;
      const existing = byRepoKey.get(repoKey);
      if (existing) {
        mergeInto(existing, entry, repo);
        bySlugKey.set(slugKey, existing);
        continue;
      }
      const created = createCandidate(entry, repo);
      byRepoKey.set(repoKey, created);
      bySlugKey.set(slugKey, created);
      order.push(created);
      continue;
    }

    const existing = bySlugKey.get(slugKey);
    if (existing) {
      mergeInto(existing, entry, undefined);
      continue;
    }
    const created = createCandidate(entry, undefined);
    bySlugKey.set(slugKey, created);
    order.push(created);
  }

  return order;
}
