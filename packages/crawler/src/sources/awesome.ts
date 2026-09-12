import { childLogger } from "@chaperone/logger";
import { UpstreamError } from "@chaperone/errors";
import { fetchWithPolicy } from "../http.js";
import { loadCrawlerEnv } from "../env.js";
import type { InstallHint, RegistrySource, SourceServer } from "../types.js";

export const AWESOME_README_URL = "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md";

const LEADING_LINK = /^-\s+\[([^\]]*)\]\((https:\/\/github\.com\/[^)\s]+)\)/;
const REPO_PATH = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+?)\/?$/i;
const NESTED_BADGE_LINK = /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g;
const SIMPLE_LINK = /\[[^\]]*\]\([^)]*\)/g;

/**
 * README entries put install commands in inline code spans (`` `npx -y foo` ``,
 * `` `pip install bar` ``, ...). This is the "only source that reliably
 * yields an install path" the prompt calls out, precisely because it's the
 * only one where a human wrote the launch command in prose rather than a
 * publisher filling in a structured `packages[]` field.
 */
export function extractInstallHint(description: string): InstallHint | undefined {
  const codeSpans = [...description.matchAll(/`([^`]+)`/g)].map((m) => m[1]?.trim() ?? "");
  for (const span of codeSpans) {
    if (/^npx\b/.test(span)) {
      return { method: "npx", spec: span };
    }
    if (/^uvx\b/.test(span)) {
      return { method: "uvx", spec: span };
    }
    if (/^pip install\b/i.test(span)) {
      return { method: "pip", spec: span.replace(/^pip install\s+/i, "") };
    }
    if (/^docker (run|pull)\b/i.test(span)) {
      return { method: "docker", spec: span };
    }
  }
  return undefined;
}

/**
 * Parses one `- [owner/repo](https://github.com/owner/repo) [badge](link)
 * emoji-legend - description` line. Returns undefined for anything that
 * isn't a repo-linked list item (section headers, the Clients/Tutorials/
 * Community/Legend prose, blank lines, entries linking to a non-repo GitHub
 * URL such as an org page).
 */
export function parseAwesomeLine(rawLine: string): SourceServer | undefined {
  const line = rawLine.trim();
  const linkMatch = LEADING_LINK.exec(line);
  if (!linkMatch) {
    return undefined;
  }
  const [fullMatch, linkText, linkUrl] = linkMatch;
  const repoMatch = REPO_PATH.exec(linkUrl ?? "");
  if (!repoMatch) {
    return undefined;
  }
  const [, ownerRaw, repoRaw] = repoMatch;
  const owner = (ownerRaw ?? "").replace(/\.git$/i, "");
  const repo = (repoRaw ?? "").replace(/\.git$/i, "");
  if (!owner || !repo) {
    return undefined;
  }

  let rest = line.slice(fullMatch.length);
  rest = rest.replace(NESTED_BADGE_LINK, "");
  rest = rest.replace(SIMPLE_LINK, "");
  const sepIdx = rest.indexOf(" - ");
  const description = (sepIdx >= 0 ? rest.slice(sepIdx + 3) : rest).trim();

  const installHint = extractInstallHint(description);
  const slug = `${owner}/${repo}`;

  return {
    sourceId: "awesome",
    slug,
    displayName: linkText || slug,
    repoUrl: `https://github.com/${owner}/${repo}`,
    ...(installHint ? { installHint } : {}),
    raw: { line: rawLine, description },
  };
}

export const awesomeSource: RegistrySource = {
  id: "awesome",
  async *fetchAll(): AsyncIterable<SourceServer> {
    const env = loadCrawlerEnv();
    const log = childLogger({ source: "awesome" });

    const res = await fetchWithPolicy(AWESOME_README_URL, { sourceId: "awesome" });
    if (res.status !== 200) {
      throw new UpstreamError(`unexpected status ${res.status} fetching awesome-mcp-servers README`, {
        status: res.status,
      });
    }

    let count = 0;
    for (const line of res.body.split("\n")) {
      const entry = parseAwesomeLine(line);
      if (!entry) {
        continue;
      }
      yield entry;
      count++;
      if (count >= env.awesomeLimit) {
        log.info({ count, capped: true }, "reached CRAWLER_AWESOME_LIMIT");
        return;
      }
    }
    log.info({ count }, "parsed awesome-mcp-servers README");
  },
};
