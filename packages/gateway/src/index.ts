/**
 * Chaperone gateway — the self-hosted MCP server. Spec 2025-11-25,
 * Streamable HTTP. This file does exactly five things: load config,
 * construct the Express app with security middleware, mount
 * `POST /mcp`, `GET /mcp`, `DELETE /mcp`, and start listening. Protocol
 * negotiation lives in protocol.ts, Origin/bind enforcement in
 * security.ts, the (Phase 7, hardcoded) upstream passthrough in
 * upstreamProxy.ts.
 *
 * `StreamableHTTPServerTransport` construction lives in session.ts, one
 * instance per session, rather than a single transport built here. A
 * single transport can serve exactly one session for the whole process
 * lifetime — a second `initialize`, from a second client or even a second
 * CLI invocation of the same host, is rejected with "Server already
 * initialized." packages/mcp-app/src/spike-server.ts hit exactly this and
 * flagged it as work for this package (see friction-log.md); session.ts's
 * `Map<sessionId, transport>` is that fix. What's visible here — the
 * branch between a fresh `initialize` and a request against an existing
 * session — is the actual session lifecycle decision; the transport
 * plumbing behind each branch is not.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { ulid } from "ulid";
import { loadConfig } from "@chaperone/config";
import { childLogger, requestLogger } from "@chaperone/logger";
import { originAllowlistMiddleware, resolveBindHost } from "./security.js";
import { handleInitialize, handleSessionRequest, isInitialize } from "./session.js";
import { buildPassthroughServer } from "./upstreamProxy.js";

const log = childLogger({ component: "gateway" });
const config = loadConfig();

// Phase 7: a single hardcoded upstream (the first, and expected only,
// entry in CHAPERONE_UPSTREAMS). Phase 8's upstream pool iterates all of
// them; see upstreamProxy.ts.
const upstream = config.upstreams[0];
if (upstream === undefined) {
  throw new Error("CHAPERONE_UPSTREAMS must configure at least one upstream");
}

const app = express();
app.use(express.json());
app.use(originAllowlistMiddleware(config.originAllowlist));

// Every request gets its own ID, bound into a child logger and echoed back
// on the response header, so a single request's log lines and its client
// side (the header) can be correlated with each other.
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
      await handleInitialize(req, res, () => buildPassthroughServer(upstream));
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
  log.error({ error }, "unhandled error");
  if (!res.headersSent) {
    res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

const host = resolveBindHost(config.bindAll);
app.listen(config.port, host, () => {
  log.info({ host, port: config.port, upstreamId: upstream.id }, "gateway listening");
});
