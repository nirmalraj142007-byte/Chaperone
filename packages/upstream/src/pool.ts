/**
 * The pooled MCP client side of the proxy: one `StreamableHTTPClientTransport`
 * per configured upstream, connected lazily on first use (not at pool
 * construction — a dead upstream must never block gateway startup or the
 * other, healthy upstreams) and reconnected with bounded, backed-off retries
 * on failure. Generalises packages/gateway/src/upstreamProxy.ts's Phase 7
 * single-hardcoded-upstream connection (see friction-log.md Entry 011: that
 * module is built on the low-level `Server` class rather than `McpServer`,
 * because `McpServer.registerTool`'s `inputSchema` must be an actual Zod
 * schema instance — there is no supported way to hand it an upstream's raw
 * JSON-Schema tool definition. This package only ever touches the *client*
 * side, so it doesn't hit that constraint, but the client-side
 * `exactOptionalPropertyTypes`/`Transport` cast Entry 012 found does still
 * apply here — see `connectTransport` below.)
 *
 * Connections are shared across every gateway session, not opened fresh per
 * session — the one hardcoded upstream Phase 7 dialed per session is now N
 * upstreams dialed once, for the life of the gateway process.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UpstreamError } from "@chaperone/errors";
import { childLogger } from "@chaperone/logger";
import type { CallContext, ToolDefinition, UpstreamConfig, UpstreamConnectionState, UpstreamPool } from "./types.js";

const log = childLogger({ component: "upstream-pool" });

/** Bounds a single connect (initialize handshake) or tools/list attempt against one upstream. */
const CONNECT_ATTEMPT_TIMEOUT_MS = 3_000;
/** Per-upstream budget for tools/list fan-out, so one slow/dead server can never hang the aggregate call. */
const LIST_TOOLS_TIMEOUT_MS = 3_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 30_000;

interface InternalHandle {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  client: Client;
  sessionId: string | null;
  state: UpstreamConnectionState;
  /** Set while a connect attempt is in flight, so concurrent callers dedupe onto the same attempt rather than dialing twice. */
  connecting: Promise<void> | null;
  consecutiveFailures: number;
  /** Epoch ms before which a new connect attempt is refused outright (fail-fast backoff window), rather than re-dialing a server that just failed. */
  nextAttemptAt: number;
}

function backoffMs(consecutiveFailures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
}

function markFailed(handle: InternalHandle): void {
  handle.state = "failed";
  handle.sessionId = null;
  handle.consecutiveFailures += 1;
  handle.nextAttemptAt = Date.now() + backoffMs(handle.consecutiveFailures);
}

// `StreamableHTTPClientTransport.sessionId` is a getter typed
// `string | undefined` — wider than the exact-optional `sessionId?: string`
// the `Transport` interface requires under this repo's
// `exactOptionalPropertyTypes`. Same finding as
// packages/gateway/src/upstreamProxy.ts (friction-log.md Entry 012),
// verified against @modelcontextprotocol/sdk 1.30.0's
// client/streamableHttp.d.ts vs shared/transport.d.ts.
async function connectTransport(client: Client, transport: StreamableHTTPClientTransport, signal: AbortSignal): Promise<void> {
  await client.connect(transport as Transport, { signal, timeout: CONNECT_ATTEMPT_TIMEOUT_MS });
}

async function attemptConnect(handle: InternalHandle, callerSignal: AbortSignal): Promise<void> {
  const attemptSignal = AbortSignal.any([callerSignal, AbortSignal.timeout(CONNECT_ATTEMPT_TIMEOUT_MS)]);
  try {
    // A fresh transport per attempt: the SDK's own `Client.connect` calls
    // `this.close()` (which tears down the transport and clears the
    // client's internal `_transport`, verified against shared/protocol.js)
    // on a failed initialize, so the same `Client` instance — the one
    // exposed on `UpstreamHandle.client` — is safe to reuse across retries.
    const transport = new StreamableHTTPClientTransport(new URL(handle.url));
    await connectTransport(handle.client, transport, attemptSignal);
    handle.sessionId = transport.sessionId ?? null;
    handle.state = "ready";
    handle.consecutiveFailures = 0;
    handle.nextAttemptAt = 0;
    log.info({ upstreamId: handle.id, upstreamUrl: handle.url }, "connected to upstream");
  } catch (error) {
    markFailed(handle);
    log.warn(
      { upstreamId: handle.id, upstreamUrl: handle.url, attempt: handle.consecutiveFailures, backoffMs: backoffMs(handle.consecutiveFailures), error },
      "failed to connect to upstream",
    );
    throw new UpstreamError(`failed to connect to upstream "${handle.id}"`, {
      upstreamId: handle.id,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Connects `handle` if it isn't already ready, deduping concurrent callers
 * onto one in-flight attempt and fail-fast-refusing a new attempt inside an
 * active backoff window rather than re-dialing a server that just failed.
 */
async function ensureConnected(handle: InternalHandle, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (handle.state === "ready") {
    return;
  }
  if (handle.connecting) {
    return handle.connecting;
  }
  const now = Date.now();
  if (handle.state === "failed" && now < handle.nextAttemptAt) {
    throw new UpstreamError(`upstream "${handle.id}" is in a reconnect backoff window`, {
      upstreamId: handle.id,
      retryInMs: handle.nextAttemptAt - now,
    });
  }
  handle.state = "connecting";
  const attempt = attemptConnect(handle, signal);
  handle.connecting = attempt.finally(() => {
    handle.connecting = null;
  });
  return handle.connecting;
}

class UpstreamPoolImpl implements UpstreamPool {
  constructor(private readonly handles: Map<string, InternalHandle>) {}

  async listAllTools(): Promise<Array<{ upstreamId: string; tool: ToolDefinition }>> {
    const handles = [...this.handles.values()];
    const settled = await Promise.allSettled(handles.map((handle) => this.listToolsForUpstream(handle)));

    const entries: Array<{ upstreamId: string; tool: ToolDefinition }> = [];
    for (let i = 0; i < settled.length; i++) {
      const handle = handles[i];
      const result = settled[i];
      if (handle === undefined || result === undefined) {
        continue;
      }
      if (result.status === "fulfilled") {
        entries.push(...result.value);
      } else {
        log.warn({ upstreamId: handle.id, error: result.reason }, "tools/list failed for upstream; excluding from fan-out");
      }
    }
    return entries;
  }

  private async listToolsForUpstream(handle: InternalHandle): Promise<Array<{ upstreamId: string; tool: ToolDefinition }>> {
    const timeoutSignal = AbortSignal.timeout(LIST_TOOLS_TIMEOUT_MS);
    await ensureConnected(handle, timeoutSignal);
    const { tools } = await handle.client.listTools(undefined, { signal: timeoutSignal, timeout: LIST_TOOLS_TIMEOUT_MS });
    return tools.map((tool) => ({ upstreamId: handle.id, tool }));
  }

  async callTool(upstreamId: string, name: string, args: unknown, ctx: CallContext): Promise<CallToolResult> {
    const handle = this.handles.get(upstreamId);
    if (handle === undefined) {
      throw new UpstreamError(`unknown upstream "${upstreamId}"`, { upstreamId });
    }

    await ensureConnected(handle, ctx.signal);

    const options: RequestOptions = { signal: ctx.signal };
    if (ctx.progressToken !== undefined) {
      const progressToken = ctx.progressToken;
      // The SDK's own `onprogress` plumbing (shared/protocol.js) strips the
      // token before invoking this callback and generates its own internal
      // request-scoped token for the outbound `_meta.progressToken` it sends
      // upstream — deliberate: what must survive the hop is the downstream's
      // *subscription* (did it ask for progress at all) and its own token
      // re-attached on the way back down, not the literal wire value sent
      // upstream, which is connection-scoped plumbing private to this hop.
      options.onprogress = (progress) => {
        ctx.onProgress?.({ method: "notifications/progress", params: { progressToken, ...progress } });
      };
    }

    try {
      const params: CallToolRequest["params"] = { name, arguments: args as CallToolRequest["params"]["arguments"] };
      // `Client.callTool`'s declared return type is a fixed, non-generic
      // union of `CallToolResult | { toolResult: unknown; ... }` (the
      // 2024-10-07 legacy shape) regardless of which `resultSchema` argument
      // is actually passed — verified against
      // @modelcontextprotocol/sdk 1.30.0's client/index.d.ts, which does not
      // overload this method per-schema. Passing `CallToolResultSchema`
      // explicitly (not `CompatibilityCallToolResultSchema`) guarantees the
      // legacy branch can never be produced at runtime, so this narrows a
      // real gap in the SDK's own types rather than asserting past a
      // genuine ambiguity.
      return (await handle.client.callTool(params, CallToolResultSchema, options)) as CallToolResult;
    } catch (error) {
      if (ctx.signal.aborted) {
        // Downstream-initiated cancellation, not an upstream health signal.
        // The gateway's own request dispatch (Server._onrequest, via the
        // low-level Server class) checks `abortController.signal.aborted`
        // before sending either a result or an error response for a
        // cancelled request, so whatever this throws here is discarded —
        // verified against shared/protocol.js. Rethrown as-is rather than
        // wrapped, and the upstream connection is not marked failed.
        throw error;
      }
      markFailed(handle);
      log.warn({ upstreamId, tool: name, error }, "tools/call failed against upstream");
      throw new UpstreamError(`tools/call to upstream "${upstreamId}" failed`, {
        upstreamId,
        tool: name,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.handles.values()].map(async (handle) => {
        try {
          await handle.client.close();
        } catch (error) {
          log.warn({ upstreamId: handle.id, error }, "error closing upstream connection");
        }
      }),
    );
  }
}

/**
 * Builds the pool. Deliberately does not connect anything itself — every
 * upstream starts `connecting` and is dialed on first real use (the first
 * `tools/list` fan-out or `tools/call` that touches it), so a dead upstream
 * configured alongside healthy ones never delays gateway startup.
 */
export async function getPool(cfgs: UpstreamConfig[]): Promise<UpstreamPool> {
  const handles = new Map<string, InternalHandle>();
  for (const cfg of cfgs) {
    handles.set(cfg.id, {
      id: cfg.id,
      label: cfg.label,
      url: cfg.url,
      client: new Client({ name: "chaperone-gateway", version: "0.0.0" }),
      sessionId: null,
      state: "connecting",
      connecting: null,
      consecutiveFailures: 0,
      nextAttemptAt: 0,
    });
  }
  return new UpstreamPoolImpl(handles);
}
