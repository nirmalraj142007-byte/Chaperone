import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { UpstreamConfig, UpstreamPool } from "@chaperone/upstream";
import { getPool } from "@chaperone/upstream";
import {
  ADD_ITEM_DESCRIPTION_MUTATED,
  ADD_ITEM_DESCRIPTION_ORIGINAL,
  buildApp as buildDemoUpstreamApp,
  resetControlStateForTests,
} from "@chaperone/demo-upstream";
import { canonicalizeTool, hashTool, REFUSAL_TOOL_CHANGED, REFUSAL_TOOL_UNPINNED } from "@chaperone/policy";
import {
  MCP_APP_RESOURCE_MIME_TYPE,
  MCP_APP_RESOURCE_URI_META_KEY,
  consentResourceUri,
} from "@chaperone/mcp-app";

// Mocked so this test never touches real DynamoDB — an in-memory stand-in
// wired up per test in beforeEach. Exercises session.ts's real logic
// (TTL/expiry checks, 404-on-unknown, fail-closed-on-storage-error) against
// a fake store rather than re-testing DynamoDB itself, which
// packages/ledger/test/session.test.ts already covers. `nextSseSeq` /
// `putSseEvent` / `listSseEventsSince` / `sseEventTtl` back event-store.ts —
// every SDK client here negotiates 2025-11-25, so the transport's own
// priming-event write (webStandardStreamableHttp.js's `writePrimingEvent`)
// calls these on every POST response stream, not just the resumption suite.
vi.mock("@chaperone/ledger", () => ({
  putSession: vi.fn(),
  getSession: vi.fn(),
  touchSession: vi.fn(),
  deleteSession: vi.fn(),
  nextSseSeq: vi.fn(),
  putSseEvent: vi.fn(),
  listSseEventsSince: vi.fn(),
  sseEventTtl: vi.fn(),
  // Phase 10: gate.ts/approve.ts's storage — the same in-memory-stand-in
  // philosophy as the session/sse mocks above, real DynamoDB behaviour
  // already covered by packages/ledger/test/{pin,quarantine}.test.ts.
  getPin: vi.fn(),
  putPin: vi.fn(),
  createQuarantine: vi.fn(),
  getQuarantine: vi.fn(),
  listQuarantineByStatus: vi.fn(),
  resolveQuarantine: vi.fn(),
  appendEvent: vi.fn(),
  // Phase 11: consentCard.ts reads this on every refusal to decide
  // loading/pending/advisory-unavailable — undefined (no advisory ever
  // written in this suite) exercises the "Bedrock never answers" path.
  getAdvisory: vi.fn(),
}));

const { buildApp } = await import("../src/app.js");
const ledger = await import("@chaperone/ledger");

const HOUSEHOLD_ID = "household-demo";

let upstreamServer: HttpServer;
let gatewayServer: HttpServer;
let upstream: UpstreamConfig;
let pool: UpstreamPool;
let gatewayUrl: string;
let sessionStore: Map<string, { sessionId: string; protocolVersion: string; ttl: number; [k: string]: unknown }>;
let sseEvents: Map<string, Array<{ sessionId: string; streamId: string; seq: number; eventId: string; message: string; ts: string; ttl: number }>>;
let sseSeqCounters: Map<string, number>;
let pins: Map<string, Record<string, unknown>>;
let quarantines: Map<string, Record<string, unknown>>;
let ledgerEvents: Array<{ type: string; actor: string; payload: unknown }>;

function sseKey(sessionId: string, streamId: string): string {
  return `${sessionId}#${streamId}`;
}

function pinKey(upstreamId: string, toolName: string): string {
  return `${upstreamId}#${toolName}`;
}

/** Pins every tool the real (test) upstream currently lists, so tools appear by default — mirrors `pnpm pin:bootstrap` against a live upstream. */
async function bootstrapPins(): Promise<void> {
  const entries = await pool.listAllTools();
  for (const { upstreamId, tool } of entries) {
    const policyTool = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
    pins.set(pinKey(upstreamId, tool.name), {
      householdId: HOUSEHOLD_ID,
      upstreamId,
      toolName: tool.name,
      approvedHash: hashTool(policyTool),
      approvedCanonicalJson: canonicalizeTool(policyTool),
      approvedAt: "2026-09-13T00:00:00.000Z",
      approvedBy: `resident:${HOUSEHOLD_ID}`,
      consentEventId: "bootstrap",
      capabilityClass: "write",
    });
  }
}

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

  sseEvents = new Map();
  sseSeqCounters = new Map();
  vi.mocked(ledger.nextSseSeq).mockImplementation(async (sessionId, streamId) => {
    const key = sseKey(sessionId, streamId);
    const next = (sseSeqCounters.get(key) ?? 0) + 1;
    sseSeqCounters.set(key, next);
    return next;
  });
  vi.mocked(ledger.putSseEvent).mockImplementation(async (event) => {
    const key = sseKey(event.sessionId, event.streamId);
    const arr = sseEvents.get(key) ?? [];
    arr.push(event);
    sseEvents.set(key, arr);
  });
  vi.mocked(ledger.listSseEventsSince).mockImplementation(async (sessionId, streamId, sinceSeq) => {
    const key = sseKey(sessionId, streamId);
    return (sseEvents.get(key) ?? []).filter((e) => e.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  });
  vi.mocked(ledger.sseEventTtl).mockImplementation(() => Math.floor(Date.now() / 1000) + 24 * 60 * 60);

  pins = new Map();
  quarantines = new Map();
  ledgerEvents = [];
  vi.mocked(ledger.getPin).mockImplementation(
    async (_householdId, upstreamId, toolName) => pins.get(pinKey(upstreamId, toolName)) as never,
  );
  vi.mocked(ledger.putPin).mockImplementation(async (pin) => {
    pins.set(pinKey(pin.upstreamId, pin.toolName), pin as never);
  });
  vi.mocked(ledger.createQuarantine).mockImplementation(async (q) => {
    quarantines.set(q.quarantineId, q as never);
  });
  vi.mocked(ledger.getQuarantine).mockImplementation(
    async (_householdId, quarantineId) => quarantines.get(quarantineId) as never,
  );
  vi.mocked(ledger.listQuarantineByStatus).mockImplementation(
    async (status) => [...quarantines.values()].filter((q) => q["status"] === status) as never,
  );
  vi.mocked(ledger.resolveQuarantine).mockImplementation(async (_householdId, quarantineId, status, resolvedAt) => {
    const existing = quarantines.get(quarantineId);
    if (existing) {
      existing["status"] = status;
      existing["resolvedAt"] = resolvedAt;
    }
  });
  vi.mocked(ledger.appendEvent).mockImplementation(async ({ type, actor, payload }) => {
    ledgerEvents.push({ type, actor, payload });
    return { eventId: `evt-${ledgerEvents.length}`, payloadHash: "hash", prevEventHash: "prev" };
  });

  pool = await getPool([upstream]);
  await bootstrapPins();
  const gatewayApp = buildApp(pool, [upstream], ["http://localhost:*"], HOUSEHOLD_ID, true);
  const gatewayListen = await listen(gatewayApp);
  gatewayServer = gatewayListen.server;
  gatewayUrl = gatewayListen.url;
});

afterEach(async () => {
  vi.clearAllMocks();
  resetControlStateForTests();
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
  it("lists the upstream's tools under the grocery__ namespace, byte-identical except name, plus the gateway's own two tools", async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "chaperone/approve_change",
      "chaperone/pending_changes",
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

describe("gateway: policy gate end to end (bootstrap -> mutate -> refuse -> approve -> replay fails)", () => {
  async function connectClientWithListChangedCounter(): Promise<{
    client: Client;
    listChangedCount: () => number;
  }> {
    const { client } = await connectClient();
    let count = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      count += 1;
    });
    return { client, listChangedCount: () => count };
  }

  it("excludes a mutated tool from tools/list and fires notifications/tools/list_changed", async () => {
    const { client, listChangedCount } = await connectClientWithListChangedCounter();
    const before = await client.listTools();
    expect(before.tools.map((t) => t.name)).toContain("grocery__add_item");

    await fetch(`http://127.0.0.1:${new URL(upstream.url).port}/control/mutate`, { method: "POST" });

    const after = await client.listTools();
    expect(after.tools.map((t) => t.name)).not.toContain("grocery__add_item");
    // The other, untouched tools stay listed — only the drifted one is withheld.
    expect(after.tools.map((t) => t.name)).toContain("grocery__read_list");

    await vi.waitFor(() => expect(listChangedCount()).toBeGreaterThan(0));
  });

  it("returns the frozen REFUSAL_TOOL_CHANGED verbatim plus a consent card on tools/call, and records the detection events", async () => {
    const { client } = await connectClient();
    await client.listTools(); // establishes nothing pin-relevant; mutate first
    await fetch(`http://127.0.0.1:${new URL(upstream.url).port}/control/mutate`, { method: "POST" });

    const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
    expect(result.isError).toBe(true);
    const blocks = result.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]?.text).toBe(REFUSAL_TOOL_CHANGED);
    expect(blocks[1]?.text).toContain("add_item");

    expect(ledgerEvents.map((e) => e.type)).toEqual(["MISMATCH_DETECTED", "TOOL_QUARANTINED", "CONSENT_SHOWN"]);
    expect(ledgerEvents.every((e) => e.actor !== "model")).toBe(true);
  });

  it("chaperone/pending_changes surfaces the open quarantine; approving with the token restores the tool; replaying the same token fails distinctly", async () => {
    const { client } = await connectClient();
    await fetch(`http://127.0.0.1:${new URL(upstream.url).port}/control/mutate`, { method: "POST" });
    // Trip the quarantine and capture the token from the refusal's consent card.
    const refusal = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
    const card = (refusal.content as Array<{ type: string; text?: string }>)[1]?.text ?? "";
    const tokenMatch = /approvalToken=(\S+)/.exec(card);
    const quarantineMatch = /quarantineId=(\S+)/.exec(card);
    expect(tokenMatch?.[1]).toBeDefined();
    expect(quarantineMatch?.[1]).toBeDefined();
    const approvalToken = tokenMatch![1]!;
    const quarantineId = quarantineMatch![1]!;

    const pending = await client.callTool({ name: "chaperone/pending_changes", arguments: {} });
    expect((pending.content as Array<{ text?: string }>)[0]?.text).toContain(quarantineId);

    const approveResult = await client.callTool({
      name: "chaperone/approve_change",
      arguments: { quarantineId, approvalToken, decision: "approve" },
    });
    expect(approveResult.isError).toBeFalsy();

    const afterApproval = await client.listTools();
    expect(afterApproval.tools.map((t) => t.name)).toContain("grocery__add_item");
    const addItem = afterApproval.tools.find((t) => t.name === "grocery__add_item");
    expect(addItem?.description).toBe(ADD_ITEM_DESCRIPTION_MUTATED);

    const replay = await client.callTool({
      name: "chaperone/approve_change",
      arguments: { quarantineId, approvalToken, decision: "approve" },
    });
    expect(replay.isError).toBe(true);
    expect((replay.content as Array<{ text?: string }>)[0]?.text).toContain("already resolved");
  });

  it("denies a tool with no pin at all as REFUSAL_TOOL_UNPINNED, distinct from a changed tool", async () => {
    pins.delete(pinKey("grocery", "read_list"));
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("grocery__read_list");

    const result = await client.callTool({ name: "grocery__read_list", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text?: string }>)[0]?.text).toBe(REFUSAL_TOOL_UNPINNED);
  });

  it("fails closed on tools/call when the pin store is unreachable: verbatim REFUSAL_TOOL_CHANGED, tool never invoked", async () => {
    const { client } = await connectClient();
    vi.mocked(ledger.getPin).mockRejectedValueOnce(new Error("DynamoDB unreachable"));

    const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text?: string }>)[0]?.text).toBe(REFUSAL_TOOL_CHANGED);
  });
});

describe("gateway: MCP App consent card (Phase 11)", () => {
  it("chaperone/approve_change carries the _meta ui/resourceUri linkage, both the legacy flat key and the modern nested one", async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const approveChange = tools.find((t) => t.name === "chaperone/approve_change");
    const meta = approveChange?._meta as Record<string, unknown> | undefined;
    expect(meta?.[MCP_APP_RESOURCE_URI_META_KEY]).toBe("ui://chaperone/consent/{quarantineId}");
    expect((meta?.["ui"] as { resourceUri?: string } | undefined)?.resourceUri).toBe(
      "ui://chaperone/consent/{quarantineId}",
    );
  });

  it("lists the consent card resource template", async () => {
    const { client } = await connectClient();
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates).toHaveLength(1);
    expect(resourceTemplates[0]?.uriTemplate).toBe("ui://chaperone/consent/{quarantineId}");
    expect(resourceTemplates[0]?.mimeType).toBe(MCP_APP_RESOURCE_MIME_TYPE);
  });

  it("a refusal carries a third, embedded-resource content block with the HTML card when the client's UI-resource support is undetermined (\"when in doubt, return both\")", async () => {
    const { client } = await connectClient();
    await fetch(`http://127.0.0.1:${new URL(upstream.url).port}/control/mutate`, { method: "POST" });

    const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
    expect(result.isError).toBe(true);
    const blocks = result.content as Array<{ type: string; text?: string; resource?: { uri: string; mimeType?: string; text?: string } }>;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.text).toBe(REFUSAL_TOOL_CHANGED);
    expect(blocks[1]?.type).toBe("text");
    expect(blocks[2]?.type).toBe("resource");
    expect(blocks[2]?.resource?.mimeType).toBe(MCP_APP_RESOURCE_MIME_TYPE);
    expect(blocks[2]?.resource?.text).toContain("<button type=\"button\" class=\"approve\">");
    expect(blocks[2]?.resource?.uri).toMatch(/^ui:\/\/chaperone\/consent\//);
  });

  it("the same card is independently readable via resources/read at the uri the refusal embedded", async () => {
    const { client } = await connectClient();
    await fetch(`http://127.0.0.1:${new URL(upstream.url).port}/control/mutate`, { method: "POST" });
    const refusal = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
    const resourceBlock = (refusal.content as Array<{ type: string; resource?: { uri: string } }>).find(
      (b) => b.type === "resource",
    );
    const uri = resourceBlock?.resource?.uri;
    expect(uri).toBeDefined();

    const read = await client.readResource({ uri: uri! });
    expect(read.contents[0]?.mimeType).toBe(MCP_APP_RESOURCE_MIME_TYPE);
    expect(read.contents[0]?.text).toContain("add_item");
  });

  it("resources/read 404s (as an MCP error) for a quarantine id that doesn't exist", async () => {
    const { client } = await connectClient();
    await expect(client.readResource({ uri: consentResourceUri("no-such-quarantine") })).rejects.toThrow();
  });

  it("MCP_APP_ENABLED=false suppresses the embedded resource block — only the frozen text and the text consent card remain", async () => {
    const { buildApp } = await import("../src/app.js");
    const noAppGatewayApp = buildApp(pool, [upstream], ["http://localhost:*"], HOUSEHOLD_ID, false);
    const { server: noAppServer, url: noAppUrl } = await listen(noAppGatewayApp);
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`${noAppUrl}/mcp`));
      const client = new Client({ name: "test-client-no-app", version: "0.0.0" });
      await client.connect(transport as Transport);

      await fetch(`http://127.0.0.1:${new URL(upstream.url).port}/control/mutate`, { method: "POST" });
      const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
      const blocks = result.content as Array<{ type: string }>;
      expect(blocks).toHaveLength(2);
      expect(blocks.every((b) => b.type === "text")).toBe(true);
    } finally {
      noAppServer.closeAllConnections();
      await new Promise<void>((resolve) => noAppServer.close(() => resolve()));
    }
  });
});
