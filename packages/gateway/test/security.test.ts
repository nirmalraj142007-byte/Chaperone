import { describe, expect, it, vi } from "vitest";
import {
  apiCorsMiddleware,
  originAllowed,
  originAllowlistMiddleware,
  resolveBindHost,
  securityHeadersMiddleware,
} from "../src/security.js";

describe("originAllowed", () => {
  const allowlist = ["http://localhost:*", "https://deployed.example.com"];

  it("allows a request with no Origin header at all", () => {
    expect(originAllowed(undefined, allowlist)).toBe(true);
  });

  it("allows any port on a wildcard-port pattern", () => {
    expect(originAllowed("http://localhost:5173", allowlist)).toBe(true);
    expect(originAllowed("http://localhost:3000", allowlist)).toBe(true);
  });

  it("rejects a non-numeric suffix on a wildcard-port pattern", () => {
    expect(originAllowed("http://localhost:abc", allowlist)).toBe(false);
  });

  it("allows an exact match", () => {
    expect(originAllowed("https://deployed.example.com", allowlist)).toBe(true);
  });

  it("rejects an origin not on the allowlist", () => {
    expect(originAllowed("https://evil.example", allowlist)).toBe(false);
  });

  it("rejects a different scheme on an otherwise-matching host:port pattern", () => {
    expect(originAllowed("https://localhost:3000", allowlist)).toBe(false);
  });
});

describe("originAllowlistMiddleware", () => {
  function fakeRes() {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    return { status, json } as unknown as Parameters<ReturnType<typeof originAllowlistMiddleware>>[1];
  }

  it("calls next() when the origin is allowed", () => {
    const middleware = originAllowlistMiddleware(["http://localhost:*"]);
    const req = { header: () => "http://localhost:3000" } as unknown as Parameters<typeof middleware>[0];
    const res = fakeRes();
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("responds 403 with a JSON-RPC error when the origin is disallowed", () => {
    const middleware = originAllowlistMiddleware(["http://localhost:*"]);
    const req = { header: () => "https://evil.example" } as unknown as Parameters<typeof middleware>[0];
    const res = fakeRes();
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ jsonrpc: "2.0", error: expect.objectContaining({ code: -32000 }) }),
    );
  });
});

describe("resolveBindHost", () => {
  it("binds loopback by default", () => {
    expect(resolveBindHost(false)).toBe("127.0.0.1");
  });

  it("binds all interfaces when bindAll is true", () => {
    expect(resolveBindHost(true)).toBe("0.0.0.0");
  });
});

function fakeSecurityRes() {
  const headers: Record<string, string> = {};
  const setHeader = vi.fn((name: string, value: string) => {
    headers[name] = value;
  });
  const json = vi.fn();
  const end = vi.fn();
  const status = vi.fn().mockReturnValue({ json, end });
  return { setHeader, headers, status, json, end } as unknown as Parameters<
    ReturnType<typeof securityHeadersMiddleware>
  >[1] & { headers: Record<string, string> };
}

describe("securityHeadersMiddleware", () => {
  it("sets CSP, nosniff, and no-referrer on every response, but never HSTS in development", () => {
    const middleware = securityHeadersMiddleware("development");
    const res = fakeSecurityRes();
    const next = vi.fn();
    middleware({} as never, res, next);
    expect(res.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(res.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(res.headers["Strict-Transport-Security"]).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("adds Strict-Transport-Security only in production", () => {
    const res = fakeSecurityRes();
    securityHeadersMiddleware("production")({} as never, res, vi.fn());
    expect(res.headers["Strict-Transport-Security"]).toContain("max-age=");
  });
});

describe("apiCorsMiddleware", () => {
  const allowlist = ["http://localhost:*"];

  it("reflects an allowed origin with Vary: Origin", () => {
    const middleware = apiCorsMiddleware(allowlist);
    const req = { header: () => "http://localhost:5173", method: "GET" } as unknown as Parameters<
      typeof middleware
    >[0];
    const res = fakeSecurityRes();
    const next = vi.fn();
    middleware(req, res, next);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(res.headers["Vary"]).toBe("Origin");
    expect(next).toHaveBeenCalledOnce();
  });

  it("never reflects a disallowed origin", () => {
    const middleware = apiCorsMiddleware(allowlist);
    const req = { header: () => "https://evil.example", method: "GET" } as unknown as Parameters<typeof middleware>[0];
    const res = fakeSecurityRes();
    middleware(req, res, vi.fn());
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("never sets Access-Control-Allow-Origin to '*'", () => {
    const middleware = apiCorsMiddleware(allowlist);
    const req = { header: () => "http://localhost:3000", method: "GET" } as unknown as Parameters<typeof middleware>[0];
    const res = fakeSecurityRes();
    middleware(req, res, vi.fn());
    expect(res.headers["Access-Control-Allow-Origin"]).not.toBe("*");
  });

  it("answers an OPTIONS preflight directly, without calling next()", () => {
    const middleware = apiCorsMiddleware(allowlist);
    const req = { header: () => "http://localhost:3000", method: "OPTIONS" } as unknown as Parameters<
      typeof middleware
    >[0];
    const res = fakeSecurityRes();
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.headers["Access-Control-Allow-Methods"]).toContain("GET");
  });
});
