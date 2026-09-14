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
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ProgressNotification } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamConfig, UpstreamPool } from "@chaperone/upstream";
import { UpstreamError } from "@chaperone/errors";
import { REFUSAL_UPSTREAM_UNAVAILABLE } from "@chaperone/policy";
import { childLogger } from "@chaperone/logger";
import { createCallRegistry } from "./call-registry.js";

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

/**
 * Builds a gateway-side `Server` whose `tools/list` fans out across every
 * pooled upstream (namespacing names on the way out) and whose `tools/call`
 * routes by that namespace, forwarding arguments unmodified and returning
 * the upstream's result unmodified — including `isError`, `content`, and
 * `structuredContent`.
 */
export function buildPassthroughServer(pool: UpstreamPool, upstreams: readonly UpstreamConfig[]): PassthroughServer {
  const upstreamIds = upstreams.map((u) => u.id);
  const server = new Server(
    { name: "chaperone-gateway", version: "0.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  // One registry per session (this function is called once per session —
  // see session.ts), so a duplicate `tools/call` for a request ID this
  // session has already seen attaches to the original upstream call instead
  // of re-invoking it. See call-registry.ts.
  const callRegistry = createCallRegistry();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const entries = await pool.listAllTools();
    return {
      tools: entries.map(({ upstreamId, tool }) => ({ ...tool, name: namespacedToolName(upstreamId, tool.name) })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const resolved = resolveNamespacedTool(request.params.name, upstreamIds);
    if (resolved === undefined) {
      throw new UpstreamError(`unknown tool "${request.params.name}": not namespaced under any configured upstream`, {
        name: request.params.name,
      });
    }

    const progressToken = request.params._meta?.progressToken;
    // Relays progress notifications strictly in arrival order even though
    // `extra.sendNotification` is async and packages/upstream's `onProgress`
    // callback fires synchronously — chaining onto the prior send's promise
    // guarantees each notification reaches the wire before the next one is
    // attempted, rather than racing concurrent sends.
    let relayChain = Promise.resolve();

    try {
      return await callRegistry.runOnce<CallToolResult>(extra.requestId, () =>
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
