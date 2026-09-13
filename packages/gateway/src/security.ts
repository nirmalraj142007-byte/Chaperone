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
