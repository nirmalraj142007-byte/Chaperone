import { describe, expect, it } from "vitest";
import { anyRequiresCredentials, textRequiresCredentials } from "../src/credentialScan.js";

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
