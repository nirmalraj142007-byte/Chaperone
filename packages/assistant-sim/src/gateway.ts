/**
 * The simulated assistant's one connection to the world: a real MCP client
 * speaking Streamable HTTP to the Chaperone gateway. Nothing else in this
 * package opens a network connection; there is no second path around the
 * gateway to a tool.
 *
 * SDK surface checked against the installed @modelcontextprotocol/sdk 1.30.0
 * type definitions, not from memory:
 *  - `Client.connect(transport)` runs `initialize` and
 *    `notifications/initialized` itself.
 *  - `StreamableHTTPClientTransport` exposes `sessionId` and
 *    `protocolVersion` getters (client/streamableHttp.d.ts), which is where
 *    the "what just happened" panel reads them from.
 *  - `ClientCapabilities.extensions` is typed in this SDK version, so the
 *    MCP Apps capability is declared through the ordinary `capabilities`
 *    option rather than a cast.
 *  - Its transport classes declare `sessionId?: string` without `| undefined`,
 *    which fails `Transport` under exactOptionalPropertyTypes; handled with
 *    the same cast as packages/console/src/mcp.ts and gateway/src/session.ts.
 *
 * Errors are surfaced, never retried. A dropped session is reported and the
 * resident asks again: silently re-sending a `tools/call` could place an
 * order twice.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_MIME_TYPE, isToolVisibilityAppOnly } from "@modelcontextprotocol/ext-apps/app-bridge";

/** The MCP Apps capability id. Also exported by @chaperone/mcp-app; test/protocol.test.ts asserts the two agree. */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";

export type Block =
  | { type: "text"; text: string }
  | { type: "resource"; uri: string; mimeType: string | undefined; text: string | undefined }
  | { type: "other"; kind: string };

export interface CallOutcome {
  tool: string;
  isError: boolean;
  blocks: Block[];
  /** Round trip as this browser saw it, through the dev/preview proxy. */
  ms: number;
  /** The gateway's `x-request-id`, which is also in its own logs. */
  requestId: string | undefined;
}

export interface ConnectionInfo {
  url: string;
  sessionId: string | undefined;
  protocolVersion: string | undefined;
  server: string | undefined;
}

/** `unreachable`: nothing (useful) answered. `session-lost`: the gateway no longer knows this session. */
export class GatewayError extends Error {
  constructor(
    readonly kind: "unreachable" | "session-lost",
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/**
 * Splits a `tools/list` answer the way an MCP Apps host must: a tool whose
 * `_meta.ui.visibility` is `["app"]` is callable by an app (the consent
 * card) and never shown to the model. Uses ext-apps 1.7.5's own
 * `isToolVisibilityAppOnly`, so this host reads the flag exactly as the
 * package defines it. The gateway marks `chaperone/approve_change` this way.
 */
export function splitByVisibility(tools: readonly Pick<Tool, "name" | "_meta">[]): { model: string[]; appOnly: string[] } {
  const model: string[] = [];
  const appOnly: string[] = [];
  for (const tool of tools) {
    (isToolVisibilityAppOnly(tool) ? appOnly : model).push(tool.name);
  }
  return { model, appOnly };
}

/** Thrown, before anything is sent, when the stand-in model names a tool only an app may call. */
export class AppOnlyToolError extends Error {
  constructor(readonly tool: string) {
    super(`"${tool}" is callable only by the consent card, not by the assistant`);
    this.name = "AppOnlyToolError";
  }
}

export interface GatewayHooks {
  /** The gateway sent `notifications/tools/list_changed`; `tools` is the refreshed model-visible list. */
  onListChanged: (tools: string[]) => void;
}

function toBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  return content.map((raw): Block => {
    const block = raw as { type?: string; text?: unknown; resource?: { uri?: unknown; mimeType?: unknown; text?: unknown } };
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (block.type === "resource" && typeof block.resource?.uri === "string") {
      return {
        type: "resource",
        uri: block.resource.uri,
        mimeType: typeof block.resource.mimeType === "string" ? block.resource.mimeType : undefined,
        text: typeof block.resource.text === "string" ? block.resource.text : undefined,
      };
    }
    return { type: "other", kind: String(block.type ?? "unknown") };
  });
}

export class GatewayConnection {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private lastRequestId: string | undefined;
  private toolNames: string[] = [];
  private appOnlyNames: string[] = [];

  constructor(
    private readonly url: URL,
    private readonly hooks: GatewayHooks,
  ) {}

  /** The tools the assistant's model sees. App-only tools are not in it. */
  get tools(): readonly string[] {
    return this.toolNames;
  }

  /** Tools the gateway listed as app-only: callable from the consent card, hidden from the model. */
  get appOnlyTools(): readonly string[] {
    return this.appOnlyNames;
  }

  get info(): ConnectionInfo {
    const server = this.client?.getServerVersion();
    return {
      url: this.url.pathname,
      sessionId: this.transport?.sessionId,
      protocolVersion: this.transport?.protocolVersion,
      server: server === undefined ? undefined : `${server.name} ${server.version}`,
    };
  }

  /** Records the request id of the most recent response, so a call's outcome can carry it. */
  private readonly capturingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const id = response.headers.get("x-request-id");
    if (id !== null && (init?.method ?? "GET") === "POST") this.lastRequestId = id;
    return response;
  };

  /** Opens a session: `initialize`, then `tools/list`. Throws GatewayError("unreachable") if the gateway cannot be spoken to. */
  async connect(): Promise<void> {
    await this.close();
    const transport = new StreamableHTTPClientTransport(this.url, { fetch: this.capturingFetch });
    const client = new Client(
      { name: "simulated-household-assistant", version: "0.0.0" },
      // This page really is an MCP Apps host (see ConsentCard.tsx), so saying
      // so is true, and it is what lets the gateway send the interactive card.
      { capabilities: { extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } },
    );
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.refreshTools().then(
        (tools) => this.hooks.onListChanged(tools),
        () => undefined,
      );
    });
    try {
      await client.connect(transport as Transport);
      this.client = client;
      this.transport = transport;
      await this.refreshTools();
    } catch (error) {
      this.client = undefined;
      this.transport = undefined;
      await client.close().catch(() => undefined);
      throw new GatewayError("unreachable", error instanceof Error ? error.message : String(error));
    }
  }

  async refreshTools(): Promise<string[]> {
    const client = this.requireClient();
    const listed = await client.listTools();
    const { model, appOnly } = splitByVisibility(listed.tools);
    this.toolNames = model;
    this.appOnlyNames = appOnly;
    return this.toolNames;
  }

  /**
   * The model's path. Refuses an app-only tool locally, before anything is
   * sent: the assistant cannot approve its own change even by naming the
   * tool. Other tools are sent even when the latest `tools/list` omitted
   * them (a quarantined tool is omitted, and calling it is how the resident
   * gets the refusal and the card).
   */
  async callTool(tool: string, args: Record<string, unknown>): Promise<CallOutcome> {
    if (this.appOnlyNames.includes(tool)) {
      throw new AppOnlyToolError(tool);
    }
    return this.send(tool, args);
  }

  /** The consent card's path (ConsentCard.tsx via useAssistant's `decide`): only app-only tools. */
  async callAppTool(tool: string, args: Record<string, unknown>): Promise<CallOutcome> {
    if (!this.appOnlyNames.includes(tool)) {
      throw new Error(`"${tool}" is not an app-only tool, so the card may not call it`);
    }
    return this.send(tool, args);
  }

  private async send(tool: string, args: Record<string, unknown>): Promise<CallOutcome> {
    const client = this.requireClient();
    const started = performance.now();
    this.lastRequestId = undefined;
    try {
      const result = await client.callTool({ name: tool, arguments: args });
      return {
        tool,
        isError: result.isError === true,
        blocks: toBlocks(result.content),
        ms: Math.round(performance.now() - started),
        requestId: this.lastRequestId,
      };
    } catch (error) {
      const lost = error instanceof StreamableHTTPError && error.code === 404;
      this.client = undefined;
      throw new GatewayError(lost ? "session-lost" : "unreachable", error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {
    const { client, transport } = this;
    this.client = undefined;
    this.transport = undefined;
    try {
      await transport?.terminateSession();
    } catch {
      // Best effort: the gateway's session TTL reaps an unterminated session.
    }
    await client?.close().catch(() => undefined);
  }

  private requireClient(): Client {
    if (this.client === undefined) {
      throw new GatewayError("unreachable", "not connected to the gateway");
    }
    return this.client;
  }
}
