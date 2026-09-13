import { describe, expect, it, vi } from "vitest";
import { originAllowed, originAllowlistMiddleware, resolveBindHost } from "../src/security.js";

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
