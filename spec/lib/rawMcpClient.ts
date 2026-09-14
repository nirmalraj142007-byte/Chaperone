/**
 * Minimal hand-rolled MCP-over-Streamable-HTTP client, used only by
 * spec/resumption.test.ts and scripts/resume-demo.ts.
 *
 * Deliberately NOT @modelcontextprotocol/sdk's own `StreamableHTTPClientTransport`:
 * that client reconnects over `fetch()` (client/streamableHttp.js's
 * `_startOrAuthSse`), and Node's `fetch` (undici) does not expose the
 * underlying socket — there is no supported way to reach in and kill it.
 * Phase 9's acceptance test requires forcibly destroying the SSE socket "at
 * the TCP level," so this talks to the gateway with `node:http`/`node:https`
 * directly, which does hand back the real `ClientRequest`/`IncomingMessage`
 * pair a raw socket can be pulled off and destroyed.
 */
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import https from "node:https";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RawSession {
  /** The gateway's full MCP endpoint URL, e.g. "http://localhost:3000/mcp". */
  mcpUrl: string;
  sessionId: string;
  protocolVersion: string;
}

interface SseFrame {
  // Not optional: under this repo's `exactOptionalPropertyTypes`, an object
  // literal that always sets the key (even to `undefined`, for a data-only
  // frame with no `id:` line) needs the key itself to be non-optional.
  id: string | undefined;
  data: string;
}

function moduleFor(url: URL): typeof http | typeof https {
  return url.protocol === "https:" ? https : http;
}

function rawRequest(
  url: URL,
  method: "POST" | "GET" | "DELETE",
  headers: Record<string, string>,
  body?: string,
): { req: ClientRequest; response: Promise<IncomingMessage> } {
  const mod = moduleFor(url);
  let req!: ClientRequest;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req = mod.request(url, { method, headers }, (res) => resolve(res));
    req.on("error", reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
  return { req, response };
}

/** Drains a response body without inspecting it — for endpoints whose only signal is the status code. */
async function drain(res: IncomingMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    res.on("data", () => {});
    res.on("end", resolve);
    res.on("error", reject);
  });
}

/**
 * Parses one `\n\n`-terminated SSE frame at a time out of a raw chunk
 * stream, incrementally — a single `res.on("data", ...)` chunk boundary
 * never lines up with an SSE frame boundary in general, so this buffers
 * across calls rather than parsing each chunk in isolation.
 */
export function sseFrameReader(onFrame: (frame: SseFrame) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      let id: string | undefined;
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("id:")) {
          id = line.slice(3).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      onFrame({ id, data: dataLines.join("\n") });
    }
  };
}

/**
 * `initialize` + `notifications/initialized`, both as raw JSON POSTs (not
 * streamed — the SDK's response to `initialize` is small and this doesn't
 * need to observe it as SSE). Throws with a pointed message if nothing is
 * listening at `mcpUrl`, rather than leaving a bare ECONNREFUSED for
 * whoever runs this.
 */
export async function initializeSession(mcpUrl: string, clientName: string): Promise<RawSession> {
  const protocolVersion = "2025-11-25";
  let res: IncomingMessage;
  try {
    const { response } = rawRequest(
      new URL(mcpUrl),
      "POST",
      { "content-type": "application/json", accept: "application/json, text/event-stream" },
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion, capabilities: {}, clientInfo: { name: clientName, version: "0.0.0" } },
      }),
    );
    res = await response;
  } catch (error) {
    throw new Error(
      `could not reach the gateway at ${mcpUrl} — is "docker compose up -d" running? (${String(error)})`,
    );
  }
  const sessionId = res.headers["mcp-session-id"];
  await drain(res);
  if (typeof sessionId !== "string") {
    throw new Error(`initialize against ${mcpUrl} did not return an Mcp-Session-Id header (status ${res.statusCode})`);
  }

  const session: RawSession = { mcpUrl, sessionId, protocolVersion };
  const { response: initializedResponse } = rawRequest(
    new URL(mcpUrl),
    "POST",
    {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": session.protocolVersion,
    },
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  await drain(await initializedResponse);
  return session;
}

export async function terminateSession(session: RawSession): Promise<void> {
  const { response } = rawRequest(new URL(session.mcpUrl), "DELETE", {
    "mcp-session-id": session.sessionId,
    "mcp-protocol-version": session.protocolVersion,
  });
  await drain(await response);
}

/** A single, non-streaming `tools/call` (or any request) — used for setup steps like `add_item` that don't need to be interrupted. */
export async function callToolAndAwaitResult(
  session: RawSession,
  requestId: number,
  toolName: string,
  args: Record<string, unknown>,
): Promise<JsonRpcMessage> {
  const { req, res } = await openToolCallStream(session, requestId, toolName, args);
  try {
    return await waitForResult(res, requestId);
  } finally {
    req.destroy();
  }
}

/**
 * Opens the SSE stream for a `tools/call` and returns the live
 * request/response pair without waiting for a result — the caller decides
 * whether to read it to completion (`waitForResult`) or destroy the socket
 * mid-flight to simulate a dropped connection.
 */
export async function openToolCallStream(
  session: RawSession,
  requestId: number,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  const { req, response } = rawRequest(
    new URL(session.mcpUrl),
    "POST",
    {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": session.protocolVersion,
    },
    JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: toolName, arguments: args } }),
  );
  const res = await response;
  return { req, res };
}

/** Reconnects an existing session's dropped stream via GET + `Last-Event-ID`, per the MCP Streamable HTTP resumption flow. */
export async function reconnectStream(session: RawSession, lastEventId: string): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  const { req, response } = rawRequest(new URL(session.mcpUrl), "GET", {
    accept: "text/event-stream",
    "mcp-session-id": session.sessionId,
    "mcp-protocol-version": session.protocolVersion,
    "last-event-id": lastEventId,
  });
  const res = await response;
  return { req, res };
}

/**
 * Attaches an SSE frame reader to `res` and resolves with the first frame
 * whose data is a JSON-RPC message carrying the given `requestId` and a
 * `result` or `error` — skipping the empty priming frame and any progress
 * notifications along the way. Also tracks the latest non-empty event ID
 * seen, exposed via the second element of the returned tuple's callback so
 * a caller reading `waitForResult` concurrently with wanting "the last
 * event ID so far" (see `readUntilFirstEventId` below) doesn't need a
 * second, competing listener on the same stream.
 */
export function waitForResult(res: IncomingMessage, requestId: number, onEventId?: (eventId: string) => void): Promise<JsonRpcMessage> {
  return new Promise<JsonRpcMessage>((resolve, reject) => {
    res.on(
      "data",
      sseFrameReader((frame) => {
        if (frame.id !== undefined) {
          onEventId?.(frame.id);
        }
        if (frame.data.trim().length === 0) {
          return;
        }
        const message = JSON.parse(frame.data) as JsonRpcMessage;
        if (message.id === requestId && (message.result !== undefined || message.error !== undefined)) {
          resolve(message);
        }
      }),
    );
    res.on("error", reject);
    res.on("end", () => reject(new Error(`SSE stream ended before a result for request ${requestId} arrived`)));
  });
}

/** Resolves as soon as the first SSE event ID (the priming event, ordinarily) has been observed on `res`, without waiting for the call to finish. */
export function readUntilFirstEventId(res: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    res.on(
      "data",
      sseFrameReader((frame) => {
        if (frame.id !== undefined) {
          resolve(frame.id);
        }
      }),
    );
    res.on("error", reject);
    res.on("end", () => reject(new Error("SSE stream ended before any event ID was observed")));
  });
}

/** Destroys the raw TCP connection carrying `res` — simulates a dropped connection, not a graceful close. */
export function destroyConnection(req: ClientRequest, res: IncomingMessage): void {
  res.destroy();
  req.destroy();
}

export interface DemoUpstreamControl {
  baseUrl: string;
}

async function controlPost(control: DemoUpstreamControl, path: string, body: unknown): Promise<void> {
  const { response } = rawRequest(
    new URL(`${control.baseUrl}${path}`),
    "POST",
    { "content-type": "application/json" },
    JSON.stringify(body),
  );
  const res = await response;
  await drain(res);
  if (res.statusCode !== 200) {
    throw new Error(`POST ${path} against ${control.baseUrl} returned ${res.statusCode}`);
  }
}

export async function setPlaceOrderDelay(control: DemoUpstreamControl, delayMs: number): Promise<void> {
  await controlPost(control, "/control/place-order-delay", { delayMs });
}

export interface DemoUpstreamStats {
  mutated: boolean;
  deliveryCancellations: number;
  placeOrderInvocations: number;
  placeOrderDelayMs: number;
}

export async function getStats(control: DemoUpstreamControl): Promise<DemoUpstreamStats> {
  const { response } = rawRequest(new URL(`${control.baseUrl}/control/stats`), "GET", {});
  const res = await response;
  let text = "";
  await new Promise<void>((resolve, reject) => {
    res.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    res.on("end", resolve);
    res.on("error", reject);
  });
  return JSON.parse(text) as DemoUpstreamStats;
}
