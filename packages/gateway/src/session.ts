/**
 * Session handling.
 *
 * What @modelcontextprotocol/sdk 1.30.0's `StreamableHTTPServerTransport`
 * already owns (verified against server/webStandardStreamableHttp.js):
 * generating the session ID via `sessionIdGenerator`, returning it on the
 * `Mcp-Session-Id` response header, rejecting a POST with neither a known
 * session ID nor an `initialize` body, and running `onsessionclosed` when a
 * DELETE terminates a session. What it does NOT own, and this module does:
 * persisting the session (protocol version, client info, 24h TTL) to
 * DynamoDB via @chaperone/ledger so the session is real state rather than
 * only an in-memory map entry, and returning 404 (not the transport's own
 * 400) for a session ID that is well-formed but unknown or expired, per
 * the MCP spec's "session ID not found -> 404" requirement.
 *
 * One `StreamableHTTPServerTransport` per session, kept in an in-memory
 * map keyed by session ID — the same pattern as the SDK's own
 * simpleStreamableHttp.ts example and this repo's
 * packages/mcp-app/src/spike-server.ts. ALB stickiness (infra/) keeps a
 * resumed stream on the task instance holding that map entry; a request
 * that lands on a different task for a session this process never saw
 * fails closed as 404 rather than guessing.
 */
import { ulid } from "ulid";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as ledger from "@chaperone/ledger";
import { ProtocolError } from "@chaperone/errors";
import { childLogger } from "@chaperone/logger";
import { assertSupportedProtocolVersion, echoProtocolVersionHeader } from "./protocol.js";
import { createSessionEventStore } from "./event-store.js";

const log = childLogger({ component: "gateway-session" });
const SESSION_TTL_SECONDS = 24 * 60 * 60;

const transports = new Map<string, StreamableHTTPServerTransport>();

export function transportCount(): number {
  return transports.size;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function nowIso(): string {
  return new Date().toISOString();
}

function ttlSecondsFromNow(): number {
  return Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
}

// `StreamableHTTPServerTransport`'s onclose/onerror/onmessage setters accept
// `(() => void) | undefined` explicitly — wider than the exact-optional
// `() => void` the `Transport` interface requires under this repo's
// `exactOptionalPropertyTypes`. Same finding as
// packages/mcp-app/src/spike-server.ts and packages/demo-upstream/src/http.ts,
// verified against SDK 1.30.0.
async function connectServer(transport: StreamableHTTPServerTransport, server: Server): Promise<void> {
  await server.connect(transport as Transport);
}

/**
 * `buildServer` is called once, after the client's declared protocol
 * version has been validated, so a rejected `initialize` never opens an
 * upstream connection.
 */
export async function handleInitialize(
  req: Request,
  res: Response,
  buildServer: () => Promise<{ server: Server; dispose: () => Promise<void> }>,
): Promise<void> {
  const body = req.body as { params?: { protocolVersion?: unknown; clientInfo?: unknown } } | undefined;
  const declaredVersion = body?.params?.protocolVersion;
  if (typeof declaredVersion !== "string") {
    jsonRpcError(res, 400, -32600, "Bad Request: initialize is missing params.protocolVersion");
    return;
  }

  try {
    assertSupportedProtocolVersion(declaredVersion);
  } catch (error) {
    if (error instanceof ProtocolError) {
      jsonRpcError(res, 400, -32600, error.message);
      return;
    }
    throw error;
  }

  const clientInfo = (body?.params?.clientInfo as Record<string, unknown> | undefined) ?? {};
  const { server, dispose } = await buildServer();

  // Minted up front, rather than inside `sessionIdGenerator`, so it's known
  // in time to close the `eventStore` below over it — the SDK calls
  // `sessionIdGenerator` internally before `onsessioninitialized` fires, so
  // there is no earlier hook that hands the ID back before construction.
  const sessionId = ulid();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    eventStore: createSessionEventStore(sessionId),
    onsessioninitialized: (sessionId) => {
      transports.set(sessionId, transport);
      const createdAt = nowIso();
      void ledger
        .putSession({
          sessionId,
          upstreamSessions: {},
          protocolVersion: declaredVersion,
          clientInfo,
          createdAt,
          lastSeenAt: createdAt,
          ttl: ttlSecondsFromNow(),
        })
        .catch((error: unknown) => {
          log.error({ error, sessionId }, "failed to persist new session");
        });
    },
    onsessionclosed: (sessionId) => {
      void ledger.deleteSession(sessionId).catch((error: unknown) => {
        log.error({ error, sessionId }, "failed to delete session on termination");
      });
    },
  });
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid !== undefined) {
      transports.delete(sid);
    }
    void dispose().catch((error: unknown) => {
      log.error({ error, sessionId: sid }, "failed to dispose upstream connection on transport close");
    });
  };

  await connectServer(transport, server);
  await transport.handleRequest(req, res, req.body);
}

/** POST/GET/DELETE against an existing session. */
export async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.header("mcp-session-id");
  if (sessionId === undefined) {
    jsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  const transport = transports.get(sessionId);
  if (transport === undefined) {
    jsonRpcError(res, 404, -32001, `Not Found: no session "${sessionId}"`);
    return;
  }

  let session;
  try {
    session = await ledger.getSession(sessionId);
  } catch (error) {
    // Fail closed: a storage error is never treated as "session valid."
    log.error({ error, sessionId }, "session lookup failed");
    jsonRpcError(res, 503, -32003, "Service Unavailable: session store unreachable");
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (session === undefined || session.ttl <= nowSeconds) {
    transports.delete(sessionId);
    jsonRpcError(res, 404, -32001, `Not Found: session "${sessionId}" is unknown or has expired`);
    return;
  }

  try {
    await ledger.touchSession(sessionId, nowIso(), ttlSecondsFromNow());
  } catch (error) {
    log.error({ error, sessionId }, "failed to refresh session");
    jsonRpcError(res, 503, -32003, "Service Unavailable: session store unreachable");
    return;
  }

  echoProtocolVersionHeader(res, session.protocolVersion);
  await transport.handleRequest(req, res, req.method === "POST" ? req.body : undefined);
}

export function isInitialize(body: unknown): boolean {
  return isInitializeRequest(body);
}
