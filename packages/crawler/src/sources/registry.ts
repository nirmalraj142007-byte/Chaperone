import { childLogger } from "@chaperone/logger";
import { UpstreamError } from "@chaperone/errors";
import { fetchWithPolicy } from "../http.js";
import { loadCrawlerEnv } from "../env.js";
import type { InstallHint, RegistrySource, SourceServer } from "../types.js";

export const REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io/v0/servers";

export interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  runtimeHint?: string;
}

export interface RegistryServerPayload {
  name: string;
  description?: string;
  title?: string;
  version?: string;
  repository?: { url?: string; source?: string };
  packages?: RegistryPackage[];
  remotes?: unknown[];
}

export interface RegistryEnvelope {
  server: RegistryServerPayload;
  _meta?: unknown;
}

export interface RegistryListResponse {
  servers: RegistryEnvelope[];
  metadata?: { nextCursor?: string; count?: number };
}

/**
 * The registry's own package.registryType values are npm/pypi/cargo/oci/
 * nuget/mcpb (confirmed against openapi.yaml on 2026-09-12); runtimeHint,
 * when present, names the actual launcher (npx/uvx/docker) more precisely
 * than registryType does. Prefer runtimeHint; fall back to a registryType
 * mapping; anything unrecognised (cargo, nuget, mcpb) is "manual" rather than
 * guessed.
 */
export function mapToInstallMethod(
  registryType: string | undefined,
  runtimeHint: string | undefined,
): InstallHint["method"] {
  const hint = runtimeHint?.toLowerCase();
  if (hint === "npx" || hint === "uvx" || hint === "docker") {
    return hint;
  }
  switch (registryType) {
    case "npm":
      return "npx";
    case "pypi":
      return "pip";
    case "oci":
      return "docker";
    default:
      return "manual";
  }
}

export function toInstallHint(packages: RegistryPackage[] | undefined): InstallHint | undefined {
  const pkg = packages?.[0];
  if (!pkg?.identifier) {
    return undefined;
  }
  return { method: mapToInstallMethod(pkg.registryType, pkg.runtimeHint), spec: pkg.identifier };
}

export function parseRegistryServer(envelope: RegistryEnvelope): SourceServer {
  const server = envelope.server;
  const repoUrl = server.repository?.url;
  const installHint = toInstallHint(server.packages);
  return {
    sourceId: "registry",
    slug: server.name,
    displayName: server.title ?? server.name,
    ...(repoUrl ? { repoUrl } : {}),
    ...(installHint ? { installHint } : {}),
    raw: envelope,
  };
}

export const registrySource: RegistrySource = {
  id: "registry",
  async *fetchAll(): AsyncIterable<SourceServer> {
    const env = loadCrawlerEnv();
    const log = childLogger({ source: "registry" });
    let cursor: string | undefined;
    let fetched = 0;

    for (;;) {
      const url = new URL(REGISTRY_BASE_URL);
      url.searchParams.set("limit", "100");
      url.searchParams.set("version", "latest");
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      const res = await fetchWithPolicy(url.toString(), { sourceId: "registry" });
      if (res.status === 401 || res.status === 403) {
        log.warn({ status: res.status }, "registry access denied; contributing 0 for this run");
        return;
      }
      if (res.status !== 200) {
        throw new UpstreamError(`unexpected status ${res.status} from MCP registry`, { status: res.status });
      }

      let parsed: RegistryListResponse;
      try {
        parsed = JSON.parse(res.body) as RegistryListResponse;
      } catch (e) {
        throw new UpstreamError("MCP registry returned unparseable JSON", {
          cause: e instanceof Error ? e.message : String(e),
        });
      }

      for (const envelope of parsed.servers) {
        yield parseRegistryServer(envelope);
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
