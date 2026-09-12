import { childLogger } from "@chaperone/logger";
import { UpstreamError } from "@chaperone/errors";
import { fetchWithPolicy } from "../http.js";
import { loadCrawlerEnv } from "../env.js";
import { parseRegistryServer, type RegistryEnvelope, type RegistryListResponse } from "./registry.js";
import type { RegistrySource, SourceServer } from "../types.js";

export const PULSEMCP_BASE_URL = "https://api.pulsemcp.com/v0.1/servers";

/**
 * DISCOVERED DISCREPANCY (recorded in friction-log.md): the prompt for this
 * phase assumed a paginated public PulseMCP server API. The v0beta API this
 * repo would naturally have reached for is fully sunset as of September
 * 2026 (confirmed via its own `API_SUNSET` error body) and its replacement,
 * v0.1, requires an `X-API-Key` (and `X-Tenant-ID`) this project doesn't
 * hold — confirmed with a live 401 against the real endpoint, not assumed.
 * PulseMCP's own public docs page (https://www.pulsemcp.com/api/docs/v0.1,
 * fetched 2026-09-12) describes a response shape identical to the official
 * MCP registry's `server.json` schema, so `parseRegistryServer` is reused
 * here rather than re-implemented — this path is therefore correct per
 * PulseMCP's documentation but has never been exercised end-to-end in this
 * repo, because no key is configured. Set `PULSEMCP_API_KEY` (and
 * `PULSEMCP_TENANT_ID` if issued one) to exercise it for real; without one,
 * this source contributes 0 with a clear log line, exactly like Smithery
 * was expected to (Smithery turned out to need no key at all — also logged).
 */
export const pulsemcpSource: RegistrySource = {
  id: "pulsemcp",
  async *fetchAll(): AsyncIterable<SourceServer> {
    const env = loadCrawlerEnv();
    const log = childLogger({ source: "pulsemcp" });

    if (!env.pulsemcpApiKey) {
      log.warn("PULSEMCP_API_KEY not set; PulseMCP v0.1 requires one (v0beta is sunset). Contributing 0.");
      return;
    }

    let cursor: string | undefined;
    let fetched = 0;

    for (;;) {
      const url = new URL(PULSEMCP_BASE_URL);
      url.searchParams.set("limit", "100");
      url.searchParams.set("version", "latest");
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      const headers: Record<string, string> = { "X-API-Key": env.pulsemcpApiKey };
      if (env.pulsemcpTenantId) {
        headers["X-Tenant-ID"] = env.pulsemcpTenantId;
      }

      const res = await fetchWithPolicy(url.toString(), { sourceId: "pulsemcp", headers });
      if (res.status === 401 || res.status === 403) {
        log.warn({ status: res.status }, "PulseMCP rejected the configured API key; contributing 0 for this run");
        return;
      }
      if (res.status !== 200) {
        throw new UpstreamError(`unexpected status ${res.status} from PulseMCP`, { status: res.status });
      }

      let parsed: RegistryListResponse;
      try {
        parsed = JSON.parse(res.body) as RegistryListResponse;
      } catch (e) {
        throw new UpstreamError("PulseMCP returned unparseable JSON", {
          cause: e instanceof Error ? e.message : String(e),
        });
      }

      for (const envelope of parsed.servers as RegistryEnvelope[]) {
        yield { ...parseRegistryServer(envelope), sourceId: "pulsemcp" };
        fetched++;
        if (fetched >= env.registryLimit) {
          return;
        }
      }

      cursor = parsed.metadata?.nextCursor;
      if (!cursor || parsed.servers.length === 0) {
        return;
      }
    }
  },
};
