/**
 * The gateway's own two tools — `chaperone/approve_change` and
 * `chaperone/pending_changes`. Unlike every namespaced upstream tool, these
 * are never gated (there is no upstream definition of them to drift) and
 * never excluded from `tools/list`: they are the only surface a resident
 * (or a host acting on their behalf) has for resolving a quarantine without
 * the console.
 */
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamConfig } from "@chaperone/upstream";
import type { CapabilityClass } from "@chaperone/policy";
import type { Quarantine } from "@chaperone/ledger";
import { renderConsentCardText, type ConsentCardModel } from "@chaperone/mcp-app";
import { ChaperoneError } from "@chaperone/errors";
import { childLogger } from "@chaperone/logger";
import { approveChange, listPendingChanges, type ApprovalDecision } from "./approve.js";
import { peekRevealedToken } from "./gate.js";

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

function upstreamLabel(upstreams: readonly UpstreamConfig[], upstreamId: string): string {
  return upstreams.find((u) => u.id === upstreamId)?.label ?? upstreamId;
}

/**
 * Shared by `handlePendingChanges` below and upstreamProxy.ts's `tools/call`
 * refusal — the one place that turns a stored `Quarantine` row back into
 * resident-facing text. `approvalToken` is the caller's problem: pass the
 * real one-time token when this is the moment it's being revealed, or a
 * placeholder string when it has already been shown and can't be re-derived
 * (packages/gateway/src/gate.ts never persists the plaintext).
 */
export function buildConsentCardText(quarantine: Quarantine, upstreamLabel: string, approvalToken: string): string {
  const before = JSON.parse(quarantine.fromCanonicalJson) as { description?: string };
  const after = JSON.parse(quarantine.toCanonicalJson) as { description?: string };
  const model: ConsentCardModel = {
    toolName: quarantine.toolName,
    upstreamLabel,
    capabilityClass: quarantine.capabilityClass as CapabilityClass,
    approvedAt: quarantine.detectedAt,
    beforeDescription: before.description ?? "",
    afterDescription: after.description ?? "",
    spans: quarantine.diffSpans,
    quarantineId: quarantine.quarantineId,
    approvalToken,
  };
  return renderConsentCardText(model);
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

  const cards = pending.map((quarantine) => {
    const revealedToken = peekRevealedToken(quarantine.quarantineId);
    return buildConsentCardText(
      quarantine,
      upstreamLabel(upstreams, quarantine.upstreamId),
      revealedToken ?? "(already shown once — see the original consent message)",
    );
  });

  return textResult(cards.join("\n\n---\n\n"));
}
