/**
 * Origin allowlist and bind-address enforcement for the gateway's `/mcp`
 * routes.
 *
 * @modelcontextprotocol/sdk 1.30.0's `WebStandardStreamableHTTPServerTransportOptions`
 * exposes `allowedOrigins` / `allowedHosts` / `enableDnsRebindingProtection`,
 * but all three are marked `@deprecated` in favour of doing this in
 * external middleware (webStandardStreamableHttp.d.ts) — which is what this
 * file is, and why the gateway does not pass any of those three options to
 * the transport.
 *
 * The SDK's Accept-header check (`application/json` and `text/event-stream`
 * both required on POST) is NOT reimplemented here: it already runs inside
 * `WebStandardStreamableHTTPServerTransport.handlePostRequest`, unconditionally,
 * for every POST — 406 Not Acceptable on failure. Reimplementing it in this
 * middleware would just be a second, possibly-inconsistent copy of a check
 * the transport already makes.
 */
import type { NextFunction, Request, Response } from "express";

function matchesOriginPattern(origin: string, pattern: string): boolean {
  if (pattern === origin) {
    return true;
  }
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1); // keep the trailing ':'
    return origin.startsWith(prefix) && /^\d+$/.test(origin.slice(prefix.length));
  }
  return false;
}

export function originAllowed(origin: string | undefined, allowlist: readonly string[]): boolean {
  if (origin === undefined) {
    // No Origin header at all — a same-origin curl/server-to-server MCP
    // client, not a browser cross-origin request. Nothing to check an
    // Origin allowlist against.
    return true;
  }
  return allowlist.some((pattern) => matchesOriginPattern(origin, pattern));
}

export function originAllowlistMiddleware(allowlist: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header("origin");
    if (!originAllowed(origin, allowlist)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Forbidden: origin "${origin}" is not in the allowlist` },
        id: null,
      });
      return;
    }
    next();
  };
}

/** `BIND_ALL=true` binds every interface; anything else binds loopback only. */
export function resolveBindHost(bindAll: boolean): string {
  return bindAll ? "0.0.0.0" : "127.0.0.1";
}

/**
 * Applied to every response. The gateway never serves third-party HTML (it
 * serves JSON-RPC, JSON, and an SSE event stream — the one place upstream-
 * controlled HTML is ever produced is packages/mcp-app's consent card,
 * which travels inside an MCP resource, not as an HTTP response from this
 * server), so the CSP is maximally strict rather than tuned for a page that
 * doesn't exist here: nothing may load, nothing may frame this origin,
 * there is no base URI to rewrite. `X-Content-Type-Options: nosniff` stops
 * a browser from executing a JSON response as anything else if it's ever
 * loaded outside a `fetch()` call; `Referrer-Policy: no-referrer` keeps a
 * quarantineId or approvalToken that leaked into a URL (it shouldn't, but
 * see docs/SECURITY.md) from also leaking into a Referer header on the next
 * cross-origin navigation.
 *
 * HSTS only fires when `env === "production"`: on a plain-HTTP local or
 * demo deployment, telling a browser to upgrade every future request to
 * this host to HTTPS is actively wrong, not just unnecessary — the host may
 * not terminate TLS at all.
 */
export function securityHeadersMiddleware(env: "development" | "production") {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (env === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    }
    next();
  };
}

/**
 * Real CORS for /api/* — the console is a browser client reading this
 * origin cross-origin in local dev (its own Vite dev server, a different
 * port). `originAllowlistMiddleware` above only ever *rejects*; it never
 * echoes back `Access-Control-Allow-Origin`, so a browser would still
 * refuse to let console JS read an otherwise-200 response. This mirrors
 * the same allowlist (never `*`) and only ever reflects an origin already
 * on it, with `Vary: Origin` so an intermediate cache can't serve one
 * origin's preflight response to another's.
 */
export function apiCorsMiddleware(allowlist: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header("origin");
    if (origin !== undefined && originAllowed(origin, allowlist)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.status(204).end();
      return;
    }
    next();
  };
}
