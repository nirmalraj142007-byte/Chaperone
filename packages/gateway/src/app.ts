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
import { childLogger, requestLogger, runWithRequestContext } from "@chaperone/logger";
import { originAllowlistMiddleware } from "./security.js";
import { buildHealthReport, healthStatusCode, type StorageBackend } from "./health.js";
import { METRICS_CONTENT_TYPE, normaliseMcpMethod, renderMetrics, requestDurationSeconds, requestsTotal } from "./metrics.js";
import { handleInitialize, handleSessionRequest, isInitialize } from "./session.js";
import { buildPassthroughServer } from "./upstreamProxy.js";
import { buildApiRouter } from "./api.js";

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
  /**
   * What /healthz reports about the running build. Defaulted rather than
   * required so every existing caller — and every test that only cares
   * about the protocol surface — keeps working; index.ts passes the real
   * values from config. See health.ts on why these are resolved once here
   * instead of re-read per request.
   */
  build: { version?: string; commit?: string; storageBackend?: StorageBackend } = {},
): Express {
  const identity = {
    householdId,
    version: build.version ?? "0.0.0",
    commit: build.commit ?? "unknown",
    // Defaults to the local backend, because every caller that passes
    // nothing here is a test or an embedded app talking to a mocked or
    // local store — never a deployed gateway, which goes through index.ts.
    storageBackend: build.storageBackend ?? "dynamodb-local",
  };
  const app = express();

  // Ahead of every other middleware, including the body parser and the
  // Origin check, so that a request rejected by one of those still carries
  // an ID on its log line and its response header. A request that failed
  // before it was identified is the one hardest to ask about later.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    const requestId = ulid();
    // The session ID off the wire on the way in. On `initialize` there
    // isn't one yet — the transport mints it during the handler — so those
    // lines read "none", which is accurate rather than backfilled.
    const sessionId = req.header("mcp-session-id") ?? "none";
    const reqLog = requestLogger(sessionId, requestId);
    res.setHeader("X-Request-Id", requestId);

    res.on("finish", () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      // `req.body` is parsed by the time the response finishes, so the MCP
      // method is available here even though it was not when this
      // middleware ran. Normalised to a fixed label set — see metrics.ts.
      const mcpMethod = normaliseMcpMethod((req.body as { method?: unknown } | undefined)?.method);
      const labels = { http_method: req.method, mcp_method: mcpMethod };
      requestsTotal.inc({ ...labels, status: String(res.statusCode) });
      requestDurationSeconds.observe(labels, durationSeconds);
      reqLog.info(
        {
          method: req.method,
          path: req.path,
          mcpMethod,
          status: res.statusCode,
          durationMs: Math.round(durationSeconds * 1000),
        },
        "request handled",
      );
    });

    // Everything downstream of here — the route handler, the gate, the
    // upstream pool, the event store — runs inside this context, so every
    // log line those modules emit carries this request's ID without their
    // having been handed it. See @chaperone/logger's context.ts.
    runWithRequestContext({ requestId, sessionId }, next);
  });

  app.use(express.json());
  app.use(originAllowlistMiddleware(originAllowlist));

  /**
   * Liveness and readiness, and the Prometheus scrape.
   *
   * Both sit *behind* the Origin allowlist, which costs a health check
   * nothing — `originAllowed` returns true when there is no Origin header
   * at all, which is every ALB probe and every `curl` — while keeping a
   * browser on a disallowed origin from scraping `/metrics` through a
   * rebinding attack. Deliberately outside `/api`: that is the console's
   * surface and its 503 means "this view is unavailable", which is a
   * different claim from the one `/healthz` makes.
   */
  app.get("/healthz", (_req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const report = await buildHealthReport(pool, identity);
      // No caching anywhere between here and the load balancer: a cached
      // 200 outliving the outage it was measured before is the one way a
      // health endpoint can actively mislead.
      res.setHeader("Cache-Control", "no-store");
      res.status(healthStatusCode(report)).json(report);
    })().catch(next);
  });

  app.get("/metrics", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", METRICS_CONTENT_TYPE);
    res.setHeader("Cache-Control", "no-store");
    // `res.end`, not `res.send`: Express rewrites a text/* Content-Type to
    // insert its own charset parameter ahead of the others, turning the
    // exact `text/plain; version=0.0.4; charset=utf-8` that the exposition
    // format specifies into a reordered variant.
    res.end(renderMetrics());
  });

  // Read-only JSON for packages/console. The console's approve control does
  // not live here — it calls `chaperone/approve_change` over /mcp below.
  app.use("/api", buildApiRouter(householdId, upstreams, pool));

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
