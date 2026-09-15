/**
 * Builds the gateway's Express app: security middleware, request-id
 * logging, and the `/mcp` route wiring. Split out of index.ts (Phase 8) so
 * the same app-construction logic backs both the real process (index.ts,
 * which loads config, builds the pool, and listens) and tests — spec/'s
 * conformance suite and packages/gateway/test/gateway.test.ts both build a
 * real Express app via this function rather than each hand-rolling their
 * own copy of the route wiring, which is exactly the kind of drift
 * CLAUDE.md's "one hashing implementation" rule warns about for a
 * different pair of modules.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ulid } from "ulid";
import { getUiCapability } from "@modelcontextprotocol/ext-apps/server";
import type { UpstreamConfig, UpstreamPool } from "@chaperone/upstream";
import { MCP_APP_RESOURCE_MIME_TYPE } from "@chaperone/mcp-app";
import { childLogger, requestLogger } from "@chaperone/logger";
import { originAllowlistMiddleware } from "./security.js";
import { handleInitialize, handleSessionRequest, isInitialize } from "./session.js";
import { buildPassthroughServer } from "./upstreamProxy.js";

const log = childLogger({ component: "gateway" });

/**
 * Whether *this* `initialize` declared MCP Apps support, via
 * `@modelcontextprotocol/ext-apps`'s own `getUiCapability` — checked against
 * the real installed package rather than hand-rolled, since the exact
 * `extensions` key and shape are namespaced, versioned protocol surface,
 * not something worth re-deriving from memory (see CLAUDE.md, "verify
 * rather than remember"). `undefined` means the client said nothing either
 * way — deliberately distinct from `false` (declared, but without our mime
 * type) so upstreamProxy.ts can offer the HTML resource "when in doubt."
 */
function detectMcpAppSupport(body: unknown): boolean | undefined {
  const capabilities = (body as { params?: { capabilities?: unknown } } | undefined)?.params?.capabilities as
    | Parameters<typeof getUiCapability>[0]
    | undefined;
  const uiCapability = getUiCapability(capabilities);
  if (uiCapability === undefined) {
    return undefined;
  }
  return uiCapability.mimeTypes?.includes(MCP_APP_RESOURCE_MIME_TYPE) ?? false;
}

export function buildApp(
  pool: UpstreamPool,
  upstreams: readonly UpstreamConfig[],
  originAllowlist: readonly string[],
  householdId: string,
  mcpAppEnabled: boolean,
): Express {
  const app = express();
  app.use(express.json());
  app.use(originAllowlistMiddleware(originAllowlist));

  // Every request gets its own ID, bound into a child logger and echoed
  // back on the response header, so a single request's log lines and its
  // client side (the header) can be correlated with each other.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const requestId = ulid();
    const sessionId = req.header("mcp-session-id") ?? "none";
    const reqLog = requestLogger(sessionId, requestId);
    res.setHeader("X-Request-Id", requestId);
    res.on("finish", () => {
      reqLog.info(
        { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - start },
        "request handled",
      );
    });
    next();
  });

  app.post("/mcp", (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const sessionId = req.header("mcp-session-id");
      if (sessionId === undefined && isInitialize(req.body)) {
        const supportsMcpApp = detectMcpAppSupport(req.body);
        await handleInitialize(req, res, () =>
          Promise.resolve(buildPassthroughServer(pool, upstreams, householdId, mcpAppEnabled, supportsMcpApp)),
        );
        return;
      }
      await handleSessionRequest(req, res);
    })().catch(next);
  });

  app.get("/mcp", (req: Request, res: Response, next: NextFunction) => {
    handleSessionRequest(req, res).catch(next);
  });

  app.delete("/mcp", (req: Request, res: Response, next: NextFunction) => {
    handleSessionRequest(req, res).catch(next);
  });

  // Catch-all: any unhandled route or thrown error becomes a well-formed
  // JSON-RPC error, never an Express HTML stack trace.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ jsonrpc: "2.0", error: { code: -32601, message: "Not Found" }, id: null });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      return;
    }
    // `express.json()` (body-parser) throws this specific `.type` before any
    // route handler runs when the request body isn't valid JSON — the one
    // case JSON-RPC has its own reserved code for (-32700 Parse error)
    // rather than the generic -32603 every other unhandled error gets here.
    if (error instanceof SyntaxError && (error as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid JSON" }, id: null });
      return;
    }
    log.error({ error }, "unhandled error");
    res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  });

  return app;
}
