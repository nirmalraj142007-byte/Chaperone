/**
 * Phase 7: a single hardcoded upstream connection per gateway session,
 * transparently proxying whatever the configured upstream currently
 * reports via `tools/list`. Phase 8 replaces this with packages/upstream's
 * pooled, hash-pinned client pool with policy enforcement (allow/deny by
 * pinned hash, quarantine on mismatch) — this module is deliberately not
 * that. It exists so the gateway has something real, end to end, to proxy
 * today: no mocked tool list, no hardcoded schema, a real MCP client
 * talking to a real upstream server.
 *
 * Built on the low-level `Server` class rather than `McpServer`.
 * `McpServer.registerTool`'s `inputSchema` must be a Zod schema
 * (`AnySchema` = `z3.ZodTypeAny | z4.$ZodType`, per
 * server/zod-compat.d.ts) — there is no supported way to hand it a raw
 * JSON-Schema object like the ones upstream MCP servers actually declare.
 * A transparent proxy should not reinterpret an upstream's schema as Zod
 * anyway: `Server` exposes `tools/list` and `tools/call` as plain
 * JSON-RPC handlers you implement yourself, which lets every field other
 * than `name` pass through byte-identical to what the upstream declared —
 * matching this repo's own documented choice that namespacing tool names
 * as `{upstreamId}__{toolName}` is the *only* place this proxy is
 * deliberately not byte-transparent.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { UpstreamConfig } from "@chaperone/config";
import { childLogger } from "@chaperone/logger";

const log = childLogger({ component: "gateway-upstream-proxy" });

export function namespacedToolName(upstreamId: string, toolName: string): string {
  return `${upstreamId}__${toolName}`;
}

export interface PassthroughServer {
  server: Server;
  /** Closes the upstream client connection this session opened. */
  dispose: () => Promise<void>;
}

/**
 * Opens a fresh upstream MCP session and builds a gateway-side `Server`
 * that proxies to it. One upstream connection per gateway session — no
 * connection pooling or reuse across sessions in this phase.
 */
export async function buildPassthroughServer(upstream: UpstreamConfig): Promise<PassthroughServer> {
  const upstreamClient = new Client({ name: "chaperone-gateway", version: "0.0.0" });
  const clientTransport = new StreamableHTTPClientTransport(new URL(upstream.url));
  // `StreamableHTTPClientTransport.sessionId` is a getter typed
  // `string | undefined` — wider than the exact-optional `sessionId?:
  // string` the `Transport` interface requires under this repo's
  // `exactOptionalPropertyTypes`. Same class of finding as the server-side
  // cast in session.ts, this time on the client transport. Verified
  // against @modelcontextprotocol/sdk 1.30.0's client/streamableHttp.d.ts.
  await upstreamClient.connect(clientTransport as Transport);

  const prefix = `${namespacedToolName(upstream.id, "")}`;
  const server = new Server(
    { name: "chaperone-gateway", version: "0.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await upstreamClient.listTools();
    return {
      tools: tools.map((tool) => ({ ...tool, name: namespacedToolName(upstream.id, tool.name) })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!name.startsWith(prefix)) {
      throw new Error(`Unknown tool "${name}": not namespaced under upstream "${upstream.id}"`);
    }
    const upstreamToolName = name.slice(prefix.length);
    return upstreamClient.callTool({ name: upstreamToolName, arguments: args });
  });

  log.info({ upstreamId: upstream.id, upstreamUrl: upstream.url }, "connected to upstream");

  return {
    server,
    dispose: async () => {
      await upstreamClient.close();
    },
  };
}
