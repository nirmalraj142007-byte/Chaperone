/**
 * Chaperone gateway — the self-hosted MCP server. Spec 2025-11-25,
 * Streamable HTTP. This file does exactly five things: load config, build
 * the upstream pool, construct the Express app (app.ts), start listening,
 * and close the pool on shutdown. Protocol negotiation lives in
 * protocol.ts, Origin/bind enforcement in security.ts, the pooled-upstream
 * passthrough in upstreamProxy.ts, route wiring in app.ts.
 *
 * `StreamableHTTPServerTransport` construction lives in session.ts, one
 * instance per session, rather than a single transport built here. A
 * single transport can serve exactly one session for the whole process
 * lifetime — a second `initialize`, from a second client or even a second
 * CLI invocation of the same host, is rejected with "Server already
 * initialized." packages/mcp-app/src/spike-server.ts hit exactly this and
 * flagged it as work for this package (see friction-log.md); session.ts's
 * `Map<sessionId, transport>` is that fix.
 */
import { loadConfig } from "@chaperone/config";
import { getPool } from "@chaperone/upstream";
import { childLogger } from "@chaperone/logger";
import { buildApp } from "./app.js";
import { resolveBindHost } from "./security.js";

const log = childLogger({ component: "gateway" });
const config = loadConfig();

const pool = await getPool(config.upstreams);
const app = buildApp(pool, config.upstreams, config.originAllowlist, config.householdId, config.mcpAppEnabled);

const host = resolveBindHost(config.bindAll);
const httpServer = app.listen(config.port, host, () => {
  log.info(
    { host, port: config.port, upstreamIds: config.upstreams.map((u) => u.id) },
    "gateway listening",
  );
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  log.info({ signal }, "shutting down");
  httpServer.close();
  await pool.close();
  process.exit(0);
}

process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));
