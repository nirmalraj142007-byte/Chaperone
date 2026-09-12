import { describe, expect, it } from "vitest";
import { dedupeCandidates, deriveServerId, parseGithubRepo } from "../src/dedupe.js";
import type { SourceServer } from "../src/types.js";

function entry(partial: Partial<SourceServer> & Pick<SourceServer, "sourceId" | "slug">): SourceServer {
  return { displayName: partial.slug, raw: {}, ...partial };
}

describe("parseGithubRepo", () => {
  it("extracts owner/repo from a plain repo URL", () => {
    expect(parseGithubRepo("https://github.com/punkpeye/awesome-mcp-servers")).toEqual({
      owner: "punkpeye",
      name: "awesome-mcp-servers",
    });
  });

  it("normalises case, a trailing slash, a .git suffix, and extra path segments", () => {
    expect(parseGithubRepo("https://github.com/Owner/Repo/")).toEqual({ owner: "owner", name: "repo" });
    expect(parseGithubRepo("https://github.com/Owner/Repo.git")).toEqual({ owner: "owner", name: "repo" });
    expect(parseGithubRepo("https://github.com/owner/repo/tree/main/src")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("returns undefined for non-github URLs and undefined input", () => {
    expect(parseGithubRepo("https://gitlab.com/owner/repo")).toBeUndefined();
    expect(parseGithubRepo(undefined)).toBeUndefined();
  });
});

describe("deriveServerId", () => {
  it("uses owner__repo__slugSuffix, lowercased, when a repo is known", () => {
    const id = deriveServerId({
      sourceId: "awesome",
      slug: "Team886/FindAgent-MCP",
      repo: { owner: "team886", name: "findagent-mcp" },
    });
    expect(id).toBe("team886__findagent-mcp__team886-findagent-mcp");
  });

  it("falls back to sourceId__slug when no repo is known", () => {
    const id = deriveServerId({ sourceId: "smithery", slug: "Gmail" });
    expect(id).toBe("smithery__gmail");
  });

  it("is deterministic across calls with the same input", () => {
    const input = { sourceId: "registry" as const, slug: "ac.tandem/docs-mcp" };
    expect(deriveServerId(input)).toBe(deriveServerId(input));
  });
});

describe("dedupeCandidates", () => {
  it("merges two entries sharing a normalised GitHub repo into one candidate, unioning sources", () => {
    const entries: SourceServer[] = [
      entry({ sourceId: "registry", slug: "io.github.acme/widget", repoUrl: "https://github.com/acme/widget" }),
      entry({ sourceId: "awesome", slug: "acme/widget", repoUrl: "https://github.com/acme/widget/" }),
    ];
    const result = dedupeCandidates(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.sources.sort()).toEqual(["awesome", "registry"]);
  });

  it("merges two repo-less entries sharing a normalised slug", () => {
    const entries: SourceServer[] = [
      entry({ sourceId: "smithery", slug: "Gmail" }),
      entry({ sourceId: "registry", slug: "gmail" }),
    ];
    const result = dedupeCandidates(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.sources.sort()).toEqual(["registry", "smithery"]);
  });

  it("does NOT merge two distinct repos whose slugs happen to collide", () => {
    const entries: SourceServer[] = [
      entry({ sourceId: "awesome", slug: "filesystem", repoUrl: "https://github.com/ownerA/filesystem" }),
      entry({ sourceId: "registry", slug: "filesystem", repoUrl: "https://github.com/ownerB/filesystem" }),
    ];
    const result = dedupeCandidates(entries);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.repo?.owner).sort()).toEqual(["ownera", "ownerb"]);
  });

  it("prefers awesome's installHint over another source's when merging", () => {
    const entries: SourceServer[] = [
      entry({
        sourceId: "registry",
        slug: "acme/widget",
        repoUrl: "https://github.com/acme/widget",
        installHint: { method: "manual", spec: "see readme" },
      }),
      entry({
        sourceId: "awesome",
        slug: "acme/widget",
        repoUrl: "https://github.com/acme/widget",
        installHint: { method: "npx", spec: "npx -y acme-widget" },
      }),
    ];
    const result = dedupeCandidates(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.installHint).toEqual({ method: "npx", spec: "npx -y acme-widget" });
  });

  it("keeps an existing installHint when a later merge has none", () => {
    const entries: SourceServer[] = [
      entry({
        sourceId: "awesome",
        slug: "acme/widget",
        repoUrl: "https://github.com/acme/widget",
        installHint: { method: "npx", spec: "npx -y acme-widget" },
      }),
      entry({ sourceId: "registry", slug: "acme/widget", repoUrl: "https://github.com/acme/widget" }),
    ];
    const result = dedupeCandidates(entries);
    expect(result[0]!.installHint).toEqual({ method: "npx", spec: "npx -y acme-widget" });
  });

  it("keeps distinct entries with no repo and no slug collision separate", () => {
    const entries: SourceServer[] = [
      entry({ sourceId: "smithery", slug: "brave" }),
      entry({ sourceId: "smithery", slug: "onesignal" }),
    ];
    expect(dedupeCandidates(entries)).toHaveLength(2);
  });
});
