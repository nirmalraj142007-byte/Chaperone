import { describe, expect, it } from "vitest";
import { anyRequiresCredentials, extractDeclaredEnvVarNames, textRequiresCredentials } from "../src/credentialScan.js";

describe("credentialScan", () => {
  it("matches API_KEY, TOKEN, SECRET, and CLIENT_ID case-insensitively", () => {
    expect(textRequiresCredentials("Set BRAVE_API_KEY before running.")).toBe(true);
    expect(textRequiresCredentials("requires an access token")).toBe(true);
    expect(textRequiresCredentials("export GITHUB_SECRET=...")).toBe(true);
    expect(textRequiresCredentials("configure your client_id")).toBe(true);
  });

  it("does not match plain text with no credential-shaped words", () => {
    expect(textRequiresCredentials("Search the web with Brave's independent index.")).toBe(false);
  });

  it("anyRequiresCredentials is true if any provided text matches, ignoring undefined entries", () => {
    expect(anyRequiresCredentials([undefined, "nothing to see here", "needs an API_KEY"])).toBe(true);
    expect(anyRequiresCredentials([undefined, "nothing to see here"])).toBe(false);
    expect(anyRequiresCredentials([])).toBe(false);
  });
});

describe("extractDeclaredEnvVarNames", () => {
  it("extracts env-var-shaped tokens that also match the credential-keyword pattern", () => {
    const text = "Set BRAVE_API_KEY and GITHUB_TOKEN before running `npx -y brave-mcp`.";
    expect(extractDeclaredEnvVarNames(text)).toEqual(expect.arrayContaining(["BRAVE_API_KEY", "GITHUB_TOKEN"]));
  });

  it("ignores all-caps tokens that don't contain a credential keyword", () => {
    expect(extractDeclaredEnvVarNames("Requires NODE_ENV and LOG_LEVEL to be set.")).toEqual([]);
  });

  it("ignores a bare word with no underscore segment, even if it matches a keyword", () => {
    // A single token like "TOKEN" alone would also match every incidental
    // all-caps acronym in a README; the pattern requires at least two
    // underscore-separated segments.
    expect(extractDeclaredEnvVarNames("Pass your TOKEN as an argument.")).toEqual([]);
  });

  it("dedupes repeated mentions of the same variable", () => {
    expect(extractDeclaredEnvVarNames("API_KEY is required. Set API_KEY in your shell.")).toEqual(["API_KEY"]);
  });

  it("returns an empty array for text with no credential-shaped tokens", () => {
    expect(extractDeclaredEnvVarNames("A simple MCP server with no configuration.")).toEqual([]);
  });
});
