/**
 * Phase 8: the downstream-facing side of the proxy, built on packages/upstream's
 * pooled MCP client connections rather than Phase 7's single hardcoded
 * upstream (see friction-log.md Entry 011 for why this is built on the
 * low-level `Server` class rather than `McpServer` — that constraint is
 * unchanged, this module just fans a single `tools/list`/`tools/call` out
 * over N pooled upstreams instead of one).
 *
 * Every field of every tool definition passes through byte-identical to
 * what the upstream declared, with exactly one deliberate exception:
 * `{upstreamId}__{toolName}` namespacing on `tools/list`, undone on
 * `tools/call` by matching the longest configured upstream-id prefix. This
 * is the one place this proxy is not byte-transparent, and spec/ asserts it
 * directly rather than leaving it implicit.
 *
 * Phase 10: every namespaced tool now passes through gate.ts before it
 * reaches either side of the wire. `tools/list` excludes anything gate.ts
 * denies — CLAUDE.md: "a tool the model can see is a tool the model can be
 * talked into calling" — and `tools/call` re-checks the *current* upstream
 * definition (not a cached one from the last `tools/list`) before ever
 * forwarding to `pool.callTool`, so a mutation that lands between a
 * client's list and its call is still caught. Two gateway-native tools,
 * `chaperone/approve_change` and `chaperone/pending_changes`
 * (firstPartyTools.ts), are appended unnamespaced and are never themselves
 * gated — there is no upstream definition of them to drift against.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ProgressNotification } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamConfig, UpstreamPool } from "@chaperone/upstream";
import { UpstreamError } from "@chaperone/errors";
import { REFUSAL_TOOL_CHANGED, REFUSAL_TOOL_UNPINNED, REFUSAL_UPSTREAM_UNAVAILABLE } from "@chaperone/policy";
import {
  renderConsentCardText,
  renderConsentCardHtml,
  MCP_APP_RESOURCE_MIME_TYPE,
  CONSENT_RESOURCE_URI_TEMPLATE,
  consentResourceUri,
  parseConsentResourceUri,
} from "@chaperone/mcp-app";
import { childLogger } from "@chaperone/logger";
import { createCallRegistry } from "./call-registry.js";
import { gateToolCall, gateToolList, type GateDecision } from "./gate.js";
import { loadConsentCardModel } from "./consentCard.js";
import {
  APPROVE_CHANGE_TOOL_NAME,
  FIRST_PARTY_TOOLS,
  PENDING_CHANGES_TOOL_NAME,
  handleApproveChange,
  handlePendingChanges,
} from "./firstPartyTools.js";

const log = childLogger({ component: "gateway-upstream-proxy" });
const NAMESPACE_SEPARATOR = "__";

export function namespacedToolName(upstreamId: string, toolName: string): string {
  return `${upstreamId}${NAMESPACE_SEPARATOR}${toolName}`;
}

/**
 * Splits a namespaced downstream tool name against the gateway's configured
 * upstream ids, matching the first configured id whose `{id}__` prefix the
 * name starts with. Returns undefined for a name that no configured
 * upstream owns (an unknown or stale tool name).
 */
export function resolveNamespacedTool(
  name: string,
  upstreamIds: readonly string[],
): { upstreamId: string; toolName: string } | undefined {
  for (const upstreamId of upstreamIds) {
    const prefix = namespacedToolName(upstreamId, "");
    if (name.startsWith(prefix)) {
      return { upstreamId, toolName: name.slice(prefix.length) };
    }
  }
  return undefined;
}

export interface PassthroughServer {
  server: Server;
  /** No-op in Phase 8: upstream connections are pooled and shared across every gateway session (see index.ts), not opened per session, so there is nothing session-scoped left to dispose here. */
  dispose: () => Promise<void>;
}

function notifyListChanged(server: Server, reason: string): void {
  void server.sendToolListChanged().catch((error: unknown) => {
    log.warn({ error, reason }, "failed to send notifications/tools/list_changed");
  });
}

/**
 * Builds the refusal for a denied `tools/call`. `REFUSAL_TOOL_UNPINNED` is
 * only for the one condition it names — a tool that has never been
 * approved at all. Every other denial, including a pin-read failure that
 * left the gate unable to tell mismatch from unpinned, is withheld under
 * `REFUSAL_TOOL_CHANGED`: CLAUDE.md's fail-closed rule names this exact
 * text for "a ledger or quarantine write failed," and treating an
 * unreadable trust state as anything less cautious than "something about
 * this tool's approval can no longer be verified" would be the wrong
 * default to fail toward.
 *
 * A second content block — the text consent card — is added whenever
 * there's an actual quarantine row to show, so the card appears in the
 * same turn as the refusal with no extra round trip. A *third* block, the
 * MCP App HTML resource, is added on top of that whenever
 * `MCP_APP_ENABLED` is true and this session hasn't been positively
 * detected as lacking UI-resource support: `supportsMcpApp === false` is
 * the only case that suppresses it, so an undetermined client (no
 * `io.modelcontextprotocol/ui` extension declared either way) gets both —
 * "when in doubt, return both, since a host that ignores one will show the
 * other."
 */
async function buildRefusalResult(
  householdId: string,
  upstreams: readonly UpstreamConfig[],
  decision: GateDecision,
  mcpAppEnabled: boolean,
  supportsMcpApp: boolean | undefined,
): Promise<CallToolResult> {
  if (decision.reason === "UNPINNED") {
    return { content: [{ type: "text" as const, text: REFUSAL_TOOL_UNPINNED }], isError: true };
  }

  const content: CallToolResult["content"] = [{ type: "text" as const, text: REFUSAL_TOOL_CHANGED }];
  if (decision.quarantineId !== undefined) {
    const model = await loadConsentCardModel(householdId, upstreams, decision.quarantineId, {
      ...(decision.approvalToken !== undefined ? { approvalToken: decision.approvalToken } : {}),
    });
    if (model !== undefined) {
      content.push({ type: "text" as const, text: renderConsentCardText(model) });
      if (mcpAppEnabled && supportsMcpApp !== false) {
        content.push({
          type: "resource" as const,
          resource: {
            uri: consentResourceUri(decision.quarantineId),
            mimeType: MCP_APP_RESOURCE_MIME_TYPE,
            text: renderConsentCardHtml(model),
          },
        });
      }
    }
  }
  return { content, isError: true };
}

/**
 * Builds a gateway-side `Server` whose `tools/list` fans out across every
 * pooled upstream (namespacing names on the way out, gating on the way
 * out) and whose `tools/call` routes by that namespace, re-gates against
 * the upstream's *current* definition, and — once allowed — forwards
 * arguments unmodified and returns the upstream's result unmodified,
 * including `isError`, `content`, and `structuredContent`.
 */
export function buildPassthroughServer(
  pool: UpstreamPool,
  upstreams: readonly UpstreamConfig[],
  householdId: string,
  mcpAppEnabled: boolean,
  supportsMcpApp: boolean | undefined,
): PassthroughServer {
  const upstreamIds = upstreams.map((u) => u.id);
  const server = new Server(
    { name: "chaperone-gateway", version: "0.0.0" },
    { capabilities: { tools: { listChanged: true }, resources: {} } },
  );
  // One registry per session (this function is called once per session —
  // see session.ts), so a duplicate `tools/call` for a request ID this
  // session has already seen attaches to the original upstream call instead
  // of re-invoking it. See call-registry.ts.
  const callRegistry = createCallRegistry();

  // The consent card's own resource surface — a single template, since
  // every card is addressed by its quarantine id. Registered unconditionally
  // (a client that never reads it costs nothing); `mcpAppEnabled` and
  // `supportsMcpApp` only gate whether the *embedded* resource block gets
  // attached to a refusal result below, not whether the template exists.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: CONSENT_RESOURCE_URI_TEMPLATE,
        name: "Chaperone consent card",
        description: "The before/after review card for one quarantined tool-definition change.",
        mimeType: MCP_APP_RESOURCE_MIME_TYPE,
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const quarantineId = parseConsentResourceUri(request.params.uri);
    if (quarantineId === undefined) {
      throw new UpstreamError(`unknown resource "${request.params.uri}"`, { uri: request.params.uri });
    }
    const model = await loadConsentCardModel(householdId, upstreams, quarantineId);
    if (model === undefined) {
      throw new UpstreamError(`no quarantine "${quarantineId}" for this household`, { quarantineId });
    }
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: renderConsentCardHtml(model),
        },
      ],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const entries = await pool.listAllTools();
    const decisions = await gateToolList(householdId, entries);

    if (decisions.some((d) => d.newlyQuarantined)) {
      notifyListChanged(server, "tool quarantined during tools/list");
    }

    const tools = decisions
      .filter((d) => d.allowed)
      .map((d) => ({ ...d.tool, name: namespacedToolName(d.upstreamId, d.tool.name) }));

    return { tools: [...tools, ...FIRST_PARTY_TOOLS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === APPROVE_CHANGE_TOOL_NAME) {
      return handleApproveChange(householdId, request.params.arguments, () => {
        notifyListChanged(server, "quarantine approved");
      });
    }
    if (request.params.name === PENDING_CHANGES_TOOL_NAME) {
      return handlePendingChanges(householdId, upstreams);
    }

    const resolved = resolveNamespacedTool(request.params.name, upstreamIds);
    if (resolved === undefined) {
      throw new UpstreamError(`unknown tool "${request.params.name}": not namespaced under any configured upstream`, {
        name: request.params.name,
      });
    }

    // Re-fetched fresh, not read from the last `tools/list` this session
    // saw — a mutation landing between that list and this call must still
    // be caught, not forwarded on a stale, already-approved definition.
    const entries = await pool.listAllTools();
    const currentEntry = entries.find(
      (entry) => entry.upstreamId === resolved.upstreamId && entry.tool.name === resolved.toolName,
    );
    if (currentEntry === undefined) {
      log.warn({ upstreamId: resolved.upstreamId, tool: resolved.toolName }, "tool not currently listed by upstream; returning frozen refusal");
      return { content: [{ type: "text" as const, text: REFUSAL_UPSTREAM_UNAVAILABLE }], isError: true };
    }

    const decision = await gateToolCall(householdId, resolved.upstreamId, resolved.toolName, currentEntry.tool);
    if (!decision.allowed) {
      if (decision.newlyQuarantined) {
        notifyListChanged(server, "tool quarantined during tools/call");
      }
      return buildRefusalResult(householdId, upstreams, decision, mcpAppEnabled, supportsMcpApp);
    }

    const progressToken = request.params._meta?.progressToken;
    // Relays progress notifications strictly in arrival order even though
    // `extra.sendNotification` is async and packages/upstream's `onProgress`
    // callback fires synchronously — chaining onto the prior send's promise
    // guarantees each notification reaches the wire before the next one is
    // attempted, rather than racing concurrent sends.
    //
    // MCP-03 requires progress relayed with ordering preserved relative to
    // the result too, not just relative to other notifications — and the
    // SDK's own response path (`Protocol._onrequest`: resolve the handler,
    // then `await transport.send(response)`) shares no queue with this
    // relay chain. Without awaiting `relayChain` before returning below, the
    // result's own `transport.send()` — a real write, with its own
    // event-store round trip — can finish and reach the client while the
    // last-relayed notification's write is still in flight, dropping or
    // reordering exactly that one notification. Every checkpoint but the
    // last has the tool's own tick interval as slack for its write to land
    // first; the last one races the result with none. Regression test:
    // spec/conformance.spec.test.ts, "spec: progress" ("REGRESSION: the
    // final progress notification's downstream write is not raced against
    // the result").
    let relayChain = Promise.resolve();

    try {
      const result = await callRegistry.runOnce<CallToolResult>(extra.requestId, () =>
        pool.callTool(resolved.upstreamId, resolved.toolName, request.params.arguments, {
          downstreamRequestId: extra.requestId,
          signal: extra.signal,
          ...(progressToken !== undefined
            ? {
                progressToken,
                onProgress: (notification: ProgressNotification) => {
                  relayChain = relayChain
                    .then(() => extra.sendNotification(notification))
                    .catch((error: unknown) => {
                      log.warn({ error, upstreamId: resolved.upstreamId }, "failed to relay progress notification downstream");
                    });
                },
              }
            : {}),
        }),
      );
      await relayChain;
      return result;
    } catch (error) {
      if (error instanceof UpstreamError) {
        log.warn(
          { error, upstreamId: resolved.upstreamId, tool: resolved.toolName },
          "upstream unavailable for tools/call; returning frozen refusal",
        );
        return { content: [{ type: "text" as const, text: REFUSAL_UPSTREAM_UNAVAILABLE }], isError: true };
      }
      throw error;
    }
  });

  return {
    server,
    dispose: async () => {},
  };
}
