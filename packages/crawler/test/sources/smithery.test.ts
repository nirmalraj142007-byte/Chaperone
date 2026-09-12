import { describe, expect, it } from "vitest";
import { parseSmitheryServer } from "../../src/sources/smithery.js";

// Real entries, captured live from https://registry.smithery.ai/servers on 2026-09-12.

describe("parseSmitheryServer", () => {
  it("does not set repoUrl for a non-github homepage", () => {
    const result = parseSmitheryServer({
      id: "50f26566-7dfe-4842-a5b8-1a9407fb91f4",
      qualifiedName: "brave",
      displayName: "Brave Search",
      homepage: "https://brave.com/search/api/",
    });
    expect(result.repoUrl).toBeUndefined();
    expect(result.slug).toBe("brave");
    expect(result.displayName).toBe("Brave Search");
  });

  it("sets repoUrl when the homepage is a github.com URL", () => {
    const result = parseSmitheryServer({
      id: "b091742a-98c5-4599-8e17-a30e5ad548a4",
      qualifiedName: "TitanSneaker/paper-search-mcp-openai-v2",
      displayName: "paper-search-mcp-openai-v2",
      homepage: "https://github.com/TitanSneaker/paper-search-mcp-openai",
    });
    expect(result.repoUrl).toBe("https://github.com/TitanSneaker/paper-search-mcp-openai");
  });

  it("falls back to qualifiedName as displayName when displayName is absent", () => {
    const result = parseSmitheryServer({ id: "x", qualifiedName: "subwayinfo" });
    expect(result.displayName).toBe("subwayinfo");
  });
});
