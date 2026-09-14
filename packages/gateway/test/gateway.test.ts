import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { UpstreamConfig, UpstreamPool } from "@chaperone/upstream";
import { getPool } from "@chaperone/upstream";
import { ADD_ITEM_DESCRIPTION_ORIGINAL, buildApp as buildDemoUpstreamApp } from "@chaperone/demo-upstream";

// Mocked so this test never touches real DynamoDB — an in-memory stand-in
// wired up per test in beforeEach. Exercises session.ts's real logic
// (TTL/expiry checks, 404-on-unknown, fail-closed-on-storage-error) against
// a fake store rather than re-testing DynamoDB itself, which
// packages/ledger/test/session.test.ts already covers.
vi.mock("@chaperone/ledger", () => ({
  putSession: vi.fn(),
  getSession: vi.fn(),
  touchSession: vi.fn(),
  deleteSession: vi.fn(),
}));

const { buildApp } = await import("../src/app.js");
const ledger = await import("@chaperone/ledger");

let upstreamServer: HttpServer;
let gatewayServer: HttpServer;
let upstream: UpstreamConfig;
let pool: UpstreamPool;
let gatewayUrl: string;
let sessionStore: Map<string, { sessionId: string; protocolVersion: string; ttl: number; [k: string]: unknown }>;

async function listen(app: express.Express): Promise<{ server: HttpServer; url: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

beforeEach(async () => {
  const demoApp = buildDemoUpstreamApp();
  const upstreamListen = await listen(demoApp);
  upstreamServer = upstreamListen.server;
  upstream = { id: "grocery", url: `${upstreamListen.url}/mcp`, label: "Grocery" };

  sessionStore = new Map();
  vi.mocked(ledger.putSession).mockImplementation(async (session) => {
    sessionStore.set(session.sessionId, session as never);
  });
  vi.mocked(ledger.getSession).mockImplementation(async (sessionId) => sessionStore.get(sessionId) as never);
  vi.mocked(ledger.touchSession).mockImplementation(async (sessionId, lastSeenAt, ttl) => {
    const existing = sessionStore.get(sessionId);
    if (existing) {
      existing["lastSeenAt"] = lastSeenAt;
      existing.ttl = ttl;
    }
  });
  vi.mocked(ledger.deleteSession).mockImplementation(async (sessionId) => {
    sessionStore.delete(sessionId);
  });

  pool = await getPool([upstream]);
  const gatewayApp = buildApp(pool, [upstream], ["http://localhost:*"]);
  const gatewayListen = await listen(gatewayApp);
  gatewayServer = gatewayListen.server;
  gatewayUrl = gatewayListen.url;
});

afterEach(async () => {
  vi.clearAllMocks();
  await pool.close();
  // A client that detects the gateway's `tools.listChanged` capability
  // opens a standalone GET SSE stream that, by design, never ends on its
  // own — Node's graceful `server.close()` waits for exactly that kind of
  // open keep-alive connection, so it would hang past any test timeout.
  // closeAllConnections() force-closes them immediately; that's correct
  // for test teardown even though it would never be called in production.
  gatewayServer.closeAllConnections();
  upstreamServer.closeAllConnections();
  await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

async function connectClient(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport as Transport);
  return { client, transport };
}

describe("gateway: initialize and passthrough", () => {
  it("lists the upstream's tools under the grocery__ namespace, byte-identical except name", async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "grocery__add_item",
      "grocery__place_order",
      "grocery__read_list",
      "grocery__track_delivery",
    ]);
    const addItem = tools.find((t) => t.name === "grocery__add_item");
    expect(addItem?.description).toBe(ADD_ITEM_DESCRIPTION_ORIGINAL);
  });

  it("persists the new session with the negotiated protocol version", async () => {
    const { transport } = await connectClient();
    expect(transport.sessionId).toBeDefined();
    const stored = sessionStore.get(transport.sessionId!);
    expect(stored?.protocolVersion).toBe("2025-11-25");
  });

  it("proxies a tools/call through to the real upstream", async () => {
    const { client } = await connectClient();
    const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries", quantity: 3 } });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text;
    expect(text).toContain("3 × batteries");
  });

  it("returns the frozen upstream-unavailable refusal, not a protocol error, when the upstream is down", async () => {
    const { client } = await connectClient();
    upstreamServer.closeAllConnections();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));

    const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text;
    expect(text).toContain("could not be reached");
  });
});

describe("gateway: protocol version enforcement", () => {
  it("rejects an initialize declaring an older revision with 400 naming both versions", async () => {
    const res = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "old-client", version: "0" } },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("2024-11-05");
    expect(body.error.message).toContain("2025-11-25");
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });
});

describe("gateway: session lifecycle", () => {
  it("returns 400 for a non-initialize POST with no Mcp-Session-Id header", async () => {
    const res = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown Mcp-Session-Id", async () => {
    const res = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "01JUNKNOWNSESSIONID000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE terminates the session; a subsequent request against it 404s", async () => {
    const { transport } = await connectClient();
    const sessionId = transport.sessionId!;

    const deleteRes = await fetch(`${gatewayUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    expect([200, 204]).toContain(deleteRes.status);
    expect(sessionStore.has(sessionId)).toBe(false);

    const followUp = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    expect(followUp.status).toBe(404);
  });

  it("fails closed with 503 when the session store is unreachable", async () => {
    // A raw fetch `initialize`, not the SDK Client: the Client auto-opens a
    // standalone GET SSE stream once it sees this server's
    // `tools.listChanged` capability, which would race the single queued
    // rejection below against whichever request reaches getSession first.
    const initRes = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
      }),
    });
    expect(initRes.status).toBe(200);
    await initRes.text(); // drain so the connection is free for reuse below
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    vi.mocked(ledger.getSession).mockRejectedValueOnce(new Error("DynamoDB unreachable"));

    const res = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("gateway: Origin allowlist", () => {
  it("returns 403 for a disallowed Origin", async () => {
    const res = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://evil.example",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("allows a request from an allowlisted localhost origin", async () => {
    const res = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "http://localhost:5173",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
    });
    // Rejected downstream (no session), but NOT by the origin middleware.
    expect(res.status).not.toBe(403);
  });
});
