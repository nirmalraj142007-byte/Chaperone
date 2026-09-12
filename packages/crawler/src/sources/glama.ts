import { childLogger } from "@chaperone/logger";
import { UpstreamError } from "@chaperone/errors";
import { fetchWithPolicy } from "../http.js";
import { loadCrawlerEnv } from "../env.js";
import type { RegistrySource, SourceServer } from "../types.js";

export const GLAMA_BASE_URL = "https://glama.ai/api/mcp/v1/servers";

interface GlamaServer {
  id?: string;
  slug?: string;
  name?: string;
  description?: string;
  repository?: { url?: string };
  url?: string;
}

interface GlamaListResponse {
  servers?: GlamaServer[];
  pageInfo?: { endCursor?: string; hasNextPage?: boolean };
}

function parseGlamaServer(raw: GlamaServer): SourceServer {
  const repoUrl = raw.repository?.url;
  return {
    sourceId: "glama",
    slug: raw.slug ?? raw.id ?? raw.name ?? "unknown",
    displayName: raw.name ?? raw.slug ?? "unknown",
    ...(repoUrl ? { repoUrl } : {}),
    raw,
  };
}

/**
 * DISCOVERED DISCREPANCY (recorded in friction-log.md): `glama.ai/api/mcp/v1/
 * servers` requires an API key on every call — confirmed with a live 401
 * whose body reads "This endpoint requires an API key. Create one at
 * https://glama.ai/settings/api-keys" (fetched 2026-09-12). Unlike PulseMCP,
 * Glama publishes no API reference describing the authenticated response
 * shape, so the cursor-based pagination below (`after`/`pageInfo.endCursor`,
 * the shape their marketing site's own GraphQL-flavoured URLs suggest) is a
 * best-effort guess, never verified against a real response, and is dead
 * code unless `GLAMA_API_KEY` is set. The verified, exercised behaviour is
 * the 401 path: contribute 0, log why, keep the run alive.
 */
export const glamaSource: RegistrySource = {
  id: "glama",
  async *fetchAll(): AsyncIterable<SourceServer> {
    const env = loadCrawlerEnv();
    const log = childLogger({ source: "glama" });

    if (!env.glamaApiKey) {
      log.warn("GLAMA_API_KEY not set; Glama's server list API requires one. Contributing 0.");
      return;
    }

    let cursor: string | undefined;
    let fetched = 0;

    for (;;) {
      const url = new URL(GLAMA_BASE_URL);
      url.searchParams.set("first", "100");
      if (cursor) {
        url.searchParams.set("after", cursor);
      }

      const res = await fetchWithPolicy(url.toString(), {
        sourceId: "glama",
        headers: { Authorization: `Bearer ${env.glamaApiKey}` },
      });
      if (res.status === 401 || res.status === 403) {
        log.warn({ status: res.status }, "Glama rejected the configured API key; contributing 0 for this run");
        return;
      }
      if (res.status !== 200) {
        throw new UpstreamError(`unexpected status ${res.status} from Glama`, { status: res.status });
      }

      let parsed: GlamaListResponse;
      try {
        parsed = JSON.parse(res.body) as GlamaListResponse;
      } catch (e) {
        throw new UpstreamError("Glama returned unparseable JSON", {
          cause: e instanceof Error ? e.message : String(e),
        });
      }

      for (const raw of parsed.servers ?? []) {
        yield parseGlamaServer(raw);
        fetched++;
        if (fetched >= env.registryLimit) {
          return;
        }
      }

      if (!parsed.pageInfo?.hasNextPage || !parsed.pageInfo.endCursor) {
        return;
      }
      cursor = parsed.pageInfo.endCursor;
    }
  },
};
