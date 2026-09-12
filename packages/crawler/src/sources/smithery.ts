import { childLogger } from "@chaperone/logger";
import { UpstreamError } from "@chaperone/errors";
import { fetchWithPolicy } from "../http.js";
import { loadCrawlerEnv } from "../env.js";
import type { RegistrySource, SourceServer } from "../types.js";

export const SMITHERY_BASE_URL = "https://registry.smithery.ai/servers";

interface SmitheryServer {
  id: string;
  qualifiedName: string;
  displayName?: string;
  description?: string;
  homepage?: string;
}

interface SmitheryListResponse {
  servers: SmitheryServer[];
  pagination: { currentPage: number; pageSize: number; totalPages: number; totalCount: number };
}

/**
 * Smithery's `qualifiedName` is frequently `owner/repo`-shaped (e.g.
 * "TitanSneaker/paper-search-mcp-openai") for community-submitted servers,
 * but is never guaranteed to be a real GitHub path — `homepage` is checked
 * separately by the shared dedup pass in dedupe.ts, which is what actually
 * resolves a repoUrl when one exists (a plain github.com homepage). This
 * function does not itself invent a repoUrl from qualifiedName.
 */
export function parseSmitheryServer(raw: SmitheryServer): SourceServer {
  const repoUrl = raw.homepage && /^https?:\/\/(www\.)?github\.com\//i.test(raw.homepage) ? raw.homepage : undefined;
  return {
    sourceId: "smithery",
    slug: raw.qualifiedName,
    displayName: raw.displayName ?? raw.qualifiedName,
    ...(repoUrl ? { repoUrl } : {}),
    raw,
  };
}

/**
 * DISCOVERED DISCREPANCY (recorded in friction-log.md): the prompt assumed
 * Smithery might require an API key and asked for 401-detect-and-degrade
 * handling. The opposite turned out to be true — `registry.smithery.ai/
 * servers` is fully open, no key needed, confirmed with a live 200 and a
 * real payload (14,502 total servers at last check). The 401/403 guard below
 * is kept anyway as defensive degradation in case that policy changes.
 */
export const smitherySource: RegistrySource = {
  id: "smithery",
  async *fetchAll(): AsyncIterable<SourceServer> {
    const env = loadCrawlerEnv();
    const log = childLogger({ source: "smithery" });
    let page = 1;
    let fetched = 0;

    for (;;) {
      const url = new URL(SMITHERY_BASE_URL);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", "100");

      const res = await fetchWithPolicy(url.toString(), { sourceId: "smithery" });
      if (res.status === 401 || res.status === 403) {
        log.warn({ status: res.status }, "Smithery access denied; contributing 0 for this run");
        return;
      }
      if (res.status !== 200) {
        throw new UpstreamError(`unexpected status ${res.status} from Smithery`, { status: res.status });
      }

      let parsed: SmitheryListResponse;
      try {
        parsed = JSON.parse(res.body) as SmitheryListResponse;
      } catch (e) {
        throw new UpstreamError("Smithery returned unparseable JSON", {
          cause: e instanceof Error ? e.message : String(e),
        });
      }

      for (const raw of parsed.servers) {
        yield parseSmitheryServer(raw);
        fetched++;
        if (fetched >= env.smitheryLimit) {
          return;
        }
      }

      if (parsed.servers.length === 0 || page >= parsed.pagination.totalPages) {
        return;
      }
      page++;
    }
  },
};
