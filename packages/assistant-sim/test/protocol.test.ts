/**
 * The wire constants this package copies rather than imports (it cannot
 * import @chaperone/mcp-app into a browser bundle: that package's entry point
 * drags in server-side code). If either side changes, this fails.
 */
import { describe, expect, it } from "vitest";
import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_RESOURCE_MIME_TYPE,
  TEXT_CARD_DECISION_LINE as RENDERED_DECISION_LINE,
  approvalsFromCardHtml,
  consentResourceUri,
  renderConsentCardHtml,
  renderConsentCardText,
  type ConsentCardItem,
} from "@chaperone/mcp-app";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import { MCP_APPS_EXTENSION_ID, splitByVisibility } from "../src/gateway";
import { CONSENT_URI_PREFIX, TEXT_CARD_DECISION_LINE, approvalFromCardHtml, isTextCard } from "../src/outcome";
import { TOOLS } from "../src/rules";
import { CARD_TOOL } from "../src/components/ConsentCard";
import { APPROVE_CHANGE_TOOL_NAME, FIRST_PARTY_TOOLS, PENDING_CHANGES_TOOL_NAME } from "../../gateway/src/firstPartyTools";

const ITEM: ConsentCardItem = {
  quarantineId: "01JTESTQUARANTINE",
  toolName: "add_item",
  upstreamLabel: "Grocery",
  capabilityClass: "write",
  detectedAt: "2026-10-20T00:00:00.000Z",
  beforeDescription: "Add an item to the list.",
  afterDescription: "Add an item to the list and share it.",
  spans: [],
  approvalToken: "tok_abc-123_XYZ",
};

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
    expect(CARD_TOOL).toBe(APPROVE_CHANGE_TOOL_NAME);
    expect(TOOLS.pendingChanges).toBe(PENDING_CHANGES_TOOL_NAME);
  });

  it("the text card's decision line, and a real rendered text card is recognised by it", () => {
    expect(TEXT_CARD_DECISION_LINE).toBe(RENDERED_DECISION_LINE);
    expect(isTextCard(renderConsentCardText({ state: "pending", item: ITEM }))).toBe(true);
  });

  it("the HTML card's approval attributes: this package reads the same id and token as @chaperone/mcp-app", () => {
    const html = renderConsentCardHtml({ state: "pending", item: ITEM });
    const expected = { quarantineId: ITEM.quarantineId, approvalToken: ITEM.approvalToken };
    expect(approvalsFromCardHtml(html)).toEqual([expected]);
    expect(approvalFromCardHtml(html)).toEqual(expected);
  });
});

describe("the assistant's model never sees chaperone/approve_change", () => {
  it("splitting the gateway's real first-party tools by visibility puts approve_change on the card's side only", () => {
    const { model, appOnly } = splitByVisibility(FIRST_PARTY_TOOLS);
    expect(appOnly).toEqual([APPROVE_CHANGE_TOOL_NAME]);
    expect(model).toEqual([PENDING_CHANGES_TOOL_NAME]);
    expect(model).not.toContain(APPROVE_CHANGE_TOOL_NAME);
  });

  it("no tool the stand-in model can name is approve_change", () => {
    expect(Object.values(TOOLS)).not.toContain(APPROVE_CHANGE_TOOL_NAME);
  });
});
