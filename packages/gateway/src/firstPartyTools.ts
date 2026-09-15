/**
 * The gateway's own two tools — `chaperone/approve_change` and
 * `chaperone/pending_changes`. Unlike every namespaced upstream tool, these
 * are never gated (there is no upstream definition of them to drift) and
 * never excluded from `tools/list`: they are the only surface a resident
 * (or a host acting on their behalf) has for resolving a quarantine without
 * the console.
 *
 * Phase 11: `APPROVE_CHANGE_TOOL` carries the `_meta` linkage
 * (`MCP_APP_RESOURCE_URI_META_KEY`, both the flat legacy key and the
 * nested modern one — ext-apps hosts are documented to check both) that
 * the Phase 6 spike identified as the second missing piece, alongside the
 * real `ui/initialize` handshake in render.ts, for MCP Inspector's Apps tab
 * to treat this tool as UI-enabled. The concrete per-quarantine card itself
 * is attached directly to the *triggering* tool's refusal result
 * (upstreamProxy.ts's `buildRefusalResult`), not fetched separately through
 * this tool — the `_meta` link exists so a host that inspects
 * `chaperone/approve_change` on its own (as Inspector's Apps tab does)
 * still discovers that it renders a UI, and so a host that prefers to
 * dereference `ui://chaperone/consent/{quarantineId}` itself via
 * `resources/read` (the template registered in upstreamProxy.ts) has a
 * documented place to find that URI shape.
 */
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamConfig } from "@chaperone/upstream";
import {
  renderConsentCardText,
  MCP_APP_RESOURCE_URI_META_KEY,
  CONSENT_RESOURCE_URI_TEMPLATE,
} from "@chaperone/mcp-app";
import { ChaperoneError } from "@chaperone/errors";
import { childLogger } from "@chaperone/logger";
import { loadConsentCardModel, upstreamLabelFor } from "./consentCard.js";
import { approveChange, listPendingChanges, type ApprovalDecision } from "./approve.js";

const log = childLogger({ component: "gateway-first-party-tools" });

export const APPROVE_CHANGE_TOOL_NAME = "chaperone/approve_change";
export const PENDING_CHANGES_TOOL_NAME = "chaperone/pending_changes";

export const APPROVE_CHANGE_TOOL: Tool = {
  name: APPROVE_CHANGE_TOOL_NAME,
  description:
    "Approve or block a tool-definition change that has been withheld pending household review. " +
    "Requires the one-time approval token shown alongside the change.",
  inputSchema: {
    type: "object",
    properties: {
      quarantineId: { type: "string" },
      approvalToken: { type: "string" },
      decision: { type: "string", enum: ["approve", "block"] },
    },
    required: ["quarantineId", "approvalToken", "decision"],
  },
  _meta: {
    [MCP_APP_RESOURCE_URI_META_KEY]: CONSENT_RESOURCE_URI_TEMPLATE,
    ui: { resourceUri: CONSENT_RESOURCE_URI_TEMPLATE },
  },
};

export const PENDING_CHANGES_TOOL: Tool = {
  name: PENDING_CHANGES_TOOL_NAME,
  description: "List tool-definition changes currently withheld pending household review.",
  inputSchema: { type: "object", properties: {} },
};

export const FIRST_PARTY_TOOLS: readonly Tool[] = [APPROVE_CHANGE_TOOL, PENDING_CHANGES_TOOL];

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text" as const, text }], isError };
}

interface ApproveChangeArgs {
  quarantineId: string;
  approvalToken: string;
  decision: ApprovalDecision;
}

type ParsedArgs = { ok: true; value: ApproveChangeArgs } | { ok: false; message: string };

/** Manual validation, not a zod schema: this tool is registered on the low-level `Server`, which — unlike `McpServer.registerTool` — never validates `tools/call` arguments against the declared `inputSchema` itself. */
function parseApproveChangeArgs(args: unknown): ParsedArgs {
  if (typeof args !== "object" || args === null) {
    return { ok: false, message: "chaperone/approve_change requires an arguments object" };
  }
  const { quarantineId, approvalToken, decision } = args as Record<string, unknown>;
  if (typeof quarantineId !== "string" || quarantineId.length === 0) {
    return { ok: false, message: '"quarantineId" must be a non-empty string' };
  }
  if (typeof approvalToken !== "string" || approvalToken.length === 0) {
    return { ok: false, message: '"approvalToken" must be a non-empty string' };
  }
  if (decision !== "approve" && decision !== "block") {
    return { ok: false, message: '"decision" must be "approve" or "block"' };
  }
  return { ok: true, value: { quarantineId, approvalToken, decision } };
}

/**
 * `onApproved` fires only when the decision was `"approve"` — the caller
 * (upstreamProxy.ts) uses it to send `notifications/tools/list_changed`,
 * since only an approval changes what the next `tools/list` returns.
 */
export async function handleApproveChange(
  householdId: string,
  args: unknown,
  onApproved: () => void,
): Promise<CallToolResult> {
  const parsed = parseApproveChangeArgs(args);
  if (!parsed.ok) {
    return textResult(parsed.message, true);
  }

  try {
    const result = await approveChange(
      householdId,
      parsed.value.quarantineId,
      parsed.value.approvalToken,
      parsed.value.decision,
    );
    if (result.decision === "approve") {
      onApproved();
      return textResult(`Quarantine ${result.quarantineId} approved. New definition pinned as ${(result.newHash ?? "").slice(0, 12)}.`);
    }
    return textResult(`Quarantine ${result.quarantineId} ${result.status}.`);
  } catch (error) {
    if (error instanceof ChaperoneError) {
      log.warn({ error, quarantineId: parsed.value.quarantineId }, "approve_change rejected");
      return textResult(error.message, true);
    }
    throw error;
  }
}

export async function handlePendingChanges(
  householdId: string,
  upstreams: readonly UpstreamConfig[],
): Promise<CallToolResult> {
  const pending = await listPendingChanges(householdId);
  if (pending.length === 0) {
    return textResult("No tool-definition changes are currently pending review.");
  }

  // Each quarantine's own card is loaded independently (rather than grouped
  // into a single "batch" model) — this tool is a flat list-everything
  // surface for hosts with no UI-resource rendering at all, distinct from
  // the "batch" consent-card *state*, which groups siblings on one upstream
  // into one collapsed-accordion card when a resident is looking at any one
  // of them via the refusal path or the `ui://` resource template.
  const cards = await Promise.all(
    pending.map(async (quarantine) => {
      const model = await loadConsentCardModel(householdId, upstreams, quarantine.quarantineId);
      if (model === undefined) {
        return `(quarantine ${quarantine.quarantineId} could not be loaded)`;
      }
      if (model.state === "batch") {
        // This one quarantine has siblings; render just its own item so the
        // flat list stays one card per pending change, not N nested cards.
        const item = model.items.find((entry) => entry.quarantineId === quarantine.quarantineId);
        return item === undefined
          ? renderConsentCardText(model)
          : renderConsentCardText({ state: "pending", item });
      }
      return renderConsentCardText(model);
    }),
  );

  return textResult(cards.join("\n\n---\n\n"));
}

export { upstreamLabelFor };
