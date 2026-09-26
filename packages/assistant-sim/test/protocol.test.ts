/**
 * The wire constants this package copies rather than imports (it cannot
 * import @chaperone/mcp-app into a browser bundle: that package's entry point
 * drags in server-side code). If either side changes, this fails.
 */
import { describe, expect, it } from "vitest";
import { MCP_APP_EXTENSION_ID, MCP_APP_RESOURCE_MIME_TYPE, consentResourceUri } from "@chaperone/mcp-app";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import { MCP_APPS_EXTENSION_ID } from "../src/gateway";
import { CONSENT_URI_PREFIX } from "../src/outcome";
import { TOOLS } from "../src/rules";
import { APPROVE_CHANGE_TOOL_NAME, PENDING_CHANGES_TOOL_NAME } from "../../gateway/src/firstPartyTools";

describe("constants copied from other packages still agree with them", () => {
  it("the MCP Apps extension id", () => {
    expect(MCP_APPS_EXTENSION_ID).toBe(MCP_APP_EXTENSION_ID);
  });

  it("the consent card's ui:// scheme", () => {
    expect(consentResourceUri("Q1")).toBe(`${CONSENT_URI_PREFIX}Q1`);
  });

  it("the MCP Apps mime type the client declares is the one the gateway checks for", () => {
    expect(RESOURCE_MIME_TYPE).toBe(MCP_APP_RESOURCE_MIME_TYPE);
  });

  it("the gateway's own tool names", () => {
    expect(TOOLS.approveChange).toBe(APPROVE_CHANGE_TOOL_NAME);
    expect(TOOLS.pendingChanges).toBe(PENDING_CHANGES_TOOL_NAME);
  });
});
