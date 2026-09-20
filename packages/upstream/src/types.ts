import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, ProgressNotification, Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wire-complete tool definition, exactly as an upstream's own `tools/list`
 * declares it (name, description, inputSchema, outputSchema, annotations,
 * _meta — every field). Aliased to the SDK's own `Tool` type rather than
 * redeclared, so this can never silently drift from what the SDK actually
 * parses off the wire. Deliberately NOT @chaperone/policy's `ToolDefinition`
 * (which narrows to only the three fields that enter the pin hash) — a
 * transparent proxy must forward every field it was handed, not just the
 * ones the hash cares about.
 */
export type ToolDefinition = Tool;

export interface UpstreamConfig {
  id: string;
  url: string;
  label: string;
}

export type UpstreamConnectionState = "connecting" | "ready" | "failed";

export interface UpstreamHandle {
  id: string;
  label: string;
  client: Client;
  sessionId: string | null;
  state: UpstreamConnectionState;
}

export interface CallContext {
  downstreamRequestId: string | number;
  progressToken?: string | number;
  signal: AbortSignal;
  onProgress?: (p: ProgressNotification) => void;
}

/**
 * A read-only snapshot of one upstream's connection, for the console's
 * /upstreams screen. Deliberately carries no URL and no session ID: the
 * console is a browser surface and neither is its business. `connectedAt`
 * is when this process last completed an MCP handshake with the upstream,
 * not when it was configured.
 */
export interface UpstreamStatus {
  id: string;
  label: string;
  state: UpstreamConnectionState;
  connectedAt: string | null;
  /** True while a session ID from that handshake is still held. */
  sessionOpen: boolean;
  consecutiveFailures: number;
}

export interface UpstreamPool {
  listAllTools(): Promise<Array<{ upstreamId: string; tool: ToolDefinition }>>;
  /** Synchronous: reports what the pool already knows, and never dials an upstream to find out. */
  describe(): UpstreamStatus[];
  callTool(upstreamId: string, name: string, args: unknown, ctx: CallContext): Promise<CallToolResult>;
  close(): Promise<void>;
}
