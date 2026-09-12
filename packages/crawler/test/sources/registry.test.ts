import { describe, expect, it } from "vitest";
import { mapToInstallMethod, parseRegistryServer, type RegistryEnvelope } from "../../src/sources/registry.js";

// Real envelope shapes, captured live from
// https://registry.modelcontextprotocol.io/v0/servers?limit=3&version=latest
// and from PulseMCP's public v0.1 docs example (same modelcontextprotocol
// server.json schema) on 2026-09-12 — see friction-log.md.

const REMOTE_WITH_REPO: RegistryEnvelope = {
  server: {
    name: "ac.tandem/docs-mcp",
    description: "Remote MCP server for Tandem docs, install guides, SDKs, workflows, and agent setup help.",
    repository: { url: "https://github.com/frumu-ai/tandem", source: "github" },
    version: "0.3.2",
    remotes: [{ type: "streamable-http", url: "https://tandem.ac/mcp" }],
  },
  _meta: {},
};

const REMOTE_NO_REPO: RegistryEnvelope = {
  server: {
    name: "ac.snag/snag",
    description: "Gives your coding agent the captured console, network, replay and screenshot evidence for a bug.",
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: "https://mcp.snag.ac/mcp" }],
  },
  _meta: {},
};

const PACKAGED_NPX: RegistryEnvelope = {
  server: {
    name: "io.github.modelcontextprotocol/filesystem",
    title: "Filesystem Server",
    description: "MCP server providing secure filesystem operations.",
    version: "1.2.0",
    repository: { url: "https://github.com/modelcontextprotocol/servers", source: "github" },
    packages: [
      {
        registryType: "npm",
        identifier: "@modelcontextprotocol/server-filesystem",
        runtimeHint: "npx",
      },
    ],
  },
  _meta: {},
};

describe("mapToInstallMethod", () => {
  it("prefers an explicit runtimeHint over registryType", () => {
    expect(mapToInstallMethod("npm", "npx")).toBe("npx");
    expect(mapToInstallMethod("pypi", "uvx")).toBe("uvx");
    expect(mapToInstallMethod("oci", "docker")).toBe("docker");
  });

  it("falls back to a registryType mapping when there is no runtimeHint", () => {
    expect(mapToInstallMethod("npm", undefined)).toBe("npx");
    expect(mapToInstallMethod("pypi", undefined)).toBe("pip");
    expect(mapToInstallMethod("oci", undefined)).toBe("docker");
  });

  it("returns manual for unrecognised registry types (cargo, nuget, mcpb)", () => {
    expect(mapToInstallMethod("cargo", undefined)).toBe("manual");
    expect(mapToInstallMethod(undefined, undefined)).toBe("manual");
  });
});

describe("parseRegistryServer", () => {
  it("extracts repoUrl from a remote server with a repository field", () => {
    const result = parseRegistryServer(REMOTE_WITH_REPO);
    expect(result.sourceId).toBe("registry");
    expect(result.slug).toBe("ac.tandem/docs-mcp");
    expect(result.repoUrl).toBe("https://github.com/frumu-ai/tandem");
    expect(result.installHint).toBeUndefined();
  });

  it("omits repoUrl when the server has no repository field", () => {
    const result = parseRegistryServer(REMOTE_NO_REPO);
    expect(result.repoUrl).toBeUndefined();
    expect(result.displayName).toBe("ac.snag/snag");
  });

  it("derives an npx installHint from a packaged server's runtimeHint", () => {
    const result = parseRegistryServer(PACKAGED_NPX);
    expect(result.installHint).toEqual({ method: "npx", spec: "@modelcontextprotocol/server-filesystem" });
    expect(result.displayName).toBe("Filesystem Server");
  });
});
