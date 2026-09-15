/**
 * MCP conformance suite (Phase 8). Every test connects to a real
 * `demo-upstream` server and a real gateway proxying it — no mocks except
 * `@chaperone/ledger` (an in-memory stand-in for DynamoDB; session.ts's own
 * logic against it is unit-tested directly in packages/gateway/test, so
 * re-mocking it here just keeps this suite from needing Docker/DynamoDB
 * Local to run). Each assertion is named for the spec behaviour it checks —
 * this output is filmed at 1:45 in the demo, hence the "verbose" reporter
 * configured in spec/vitest.config.ts.
 *
 * `{upstreamId}__{toolName}` namespacing is asserted directly (see "tools/list
 * equivalence") as the one place this proxy is deliberately not
 * byte-transparent, per CLAUDE.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamConfig, UpstreamPool } from "@chaperone/upstream";
import { getPool } from "@chaperone/upstream";
import { buildApp as buildDemoUpstreamApp, deliveryCancellationCount, resetControlStateForTests } from "@chaperone/demo-upstream";
import { canonicalizeTool, hashTool } from "@chaperone/policy";

vi.mock("@chaperone/ledger", () => ({
  putSession: vi.fn(),
  getSession: vi.fn(),
  touchSession: vi.fn(),
  deleteSession: vi.fn(),
  nextSseSeq: vi.fn(),
  putSseEvent: vi.fn(),
  listSseEventsSince: vi.fn(),
  sseEventTtl: vi.fn(),
  // Phase 10: gate.ts's storage — same in-memory-stand-in philosophy as the
  // session/sse mocks above. Without these, gate.ts's `ledger.getPin(...)`
  // call throws (calling `undefined` as a function), which gate.ts's own
  // try/catch turns into a silent fail-closed deny on every single tool —
  // exactly the regression this suite hit and didn't notice, because
  // `pnpm spec` isn't part of `pnpm test` and nothing re-ran it after
  // Phase 10 wired the gate in.
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

const { buildApp: buildGatewayApp } = await import("@chaperone/gateway");
const ledger = await import("@chaperone/ledger");

const HOUSEHOLD_ID = "household-spec";
const GROCERY_PREFIX = "grocery__";
/** Gateway-native tools (chaperone/approve_change, chaperone/pending_changes) are unnamespaced and always present, unaffected by upstream health or pin state — every equivalence/emptiness check below is about upstream-sourced tools specifically, so these are filtered out first. */
const isFirstPartyTool = (name: string): boolean => name.startsWith("chaperone/");

type ContentBlock = { type: string; text?: string };

async function listen(app: express.Express): Promise<{ server: HttpServer; url: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

let upstreamServer: HttpServer;
let upstreamUrl: string;
let upstream: UpstreamConfig;
let pool: UpstreamPool;
let gatewayServer: HttpServer;
let gatewayUrl: string;
let sessionStore: Map<string, { sessionId: string; protocolVersion: string; ttl: number; [k: string]: unknown }>;
let sseEvents: Map<string, Array<{ sessionId: string; streamId: string; seq: number; eventId: string; message: string; ts: string; ttl: number }>>;
let sseSeqCounters: Map<string, number>;
let pins: Map<string, Record<string, unknown>>;
let quarantines: Map<string, Record<string, unknown>>;

function sseKey(sessionId: string, streamId: string): string {
  return `${sessionId}#${streamId}`;
}

function pinKey(upstreamId: string, toolName: string): string {
  return `${upstreamId}#${toolName}`;
}

/** Pins every tool the real upstream currently lists — mirrors `pnpm pin:bootstrap` against a live upstream, so tools/list and tools/call both see them as allowed by default. */
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
      approvedAt: "2026-09-15T00:00:00.000Z",
      approvedBy: `resident:${HOUSEHOLD_ID}`,
      consentEventId: "bootstrap",
      capabilityClass: "write",
    });
  }
}

beforeEach(async () => {
  resetControlStateForTests();

  const demo = await listen(buildDemoUpstreamApp());
  upstreamServer = demo.server;
  upstreamUrl = demo.url;
  upstream = { id: "grocery", url: `${upstreamUrl}/mcp`, label: "Household Grocery" };

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
    void type;
    void actor;
    void payload;
    return { eventId: "evt", payloadHash: "hash", prevEventHash: "prev" };
  });

  pool = await getPool([upstream]);
  await bootstrapPins();
  const gw = await listen(buildGatewayApp(pool, [upstream], ["http://localhost:*"], HOUSEHOLD_ID, true));
  gatewayServer = gw.server;
  gatewayUrl = gw.url;
});

afterEach(async () => {
  vi.clearAllMocks();
  await pool.close();
  gatewayServer.closeAllConnections();
  upstreamServer.closeAllConnections();
  await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

async function connectClient(baseUrl: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new Client({ name: "spec-client", version: "0.0.0" });
  await client.connect(transport as Transport);
  return { client, transport };
}

function blocks(result: { content?: unknown }): ContentBlock[] {
  return (result.content as ContentBlock[] | undefined) ?? [];
}

/**
 * `StreamableHTTPServerTransport` answers a successful (2xx) POST as either
 * a flat `application/json` body or a `text/event-stream` stream whose
 * payload is the JSON-RPC message carried on a `data:` line (verified
 * against @modelcontextprotocol/sdk 1.30.0's
 * server/webStandardStreamableHttp.js `writeSSEEvent`) — synchronous 4xx
 * error responses (bad Origin, bad session, parse failure) are always flat
 * JSON, but a real 200 is not guaranteed to be, so every raw-fetch helper
 * below reads the body through this rather than `res.json()` directly.
 *
 * Since Phase 9 (event-store.ts), every such stream opens with a *priming*
 * event first — `id: <eventId>\ndata: \n\n`, empty by design
 * (`writePrimingEvent`) — so the first `data:` line is never the payload
 * this helper wants. Skips to the first `data:` line with non-empty
 * content after the prefix, rather than the first `data:` line at all.
 */
async function readJsonRpcBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data:") && line.slice("data:".length).trim().length > 0);
    if (dataLine === undefined) {
      throw new Error(`no non-empty "data:" line found in SSE response body: ${text}`);
    }
    return JSON.parse(dataLine.slice("data:".length).trim()) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

interface RawInitializeResponse {
  res: Response;
  body: {
    result?: { protocolVersion: string; capabilities: { tools?: unknown }; serverInfo: { name: string; version: string } };
    error?: { code: number; message: string };
  };
}

async function rawInitialize(baseUrl: string, protocolVersion = "2025-11-25"): Promise<RawInitializeResponse> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "spec-raw-client", version: "0" } },
    }),
  });
  const body = (await readJsonRpcBody(res)) as RawInitializeResponse["body"];
  return { res, body };
}

async function rawSessionRequest(
  baseUrl: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<{ res: Response; body: { result?: unknown; error?: { code: number; message: string } } }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify(body),
  });
  const json = (await readJsonRpcBody(res)) as { result?: unknown; error?: { code: number; message: string } };
  return { res, body: json };
}

async function establishedSession(baseUrl: string): Promise<string> {
  // rawInitialize() already fully drains and parses the response body via
  // readJsonRpcBody(); reading it again here would throw ("body already
  // consumed"), so this only needs the header.
  const init = await rawInitialize(baseUrl);
  const sessionId = init.res.headers.get("mcp-session-id");
  if (sessionId === null) {
    throw new Error("initialize did not issue a session id");
  }
  return sessionId;
}

describe("spec: initialize", () => {
  it("initialize result shape: gateway echoes protocolVersion 2025-11-25, a tools capability, and serverInfo, matching a direct upstream initialize", async () => {
    const direct = await rawInitialize(upstreamUrl);
    const viaGateway = await rawInitialize(gatewayUrl);

    expect(direct.body.result?.protocolVersion).toBe("2025-11-25");
    expect(viaGateway.body.result?.protocolVersion).toBe("2025-11-25");
    expect(direct.body.result?.capabilities.tools).toBeTruthy();
    expect(viaGateway.body.result?.capabilities.tools).toBeTruthy();
    expect(typeof viaGateway.body.result?.serverInfo.name).toBe("string");
  });
});

describe("spec: protocol version negotiation", () => {
  it("accepts protocolVersion 2025-11-25 and issues a session id", async () => {
    const init = await rawInitialize(gatewayUrl, "2025-11-25");
    expect(init.res.status).toBe(200);
    expect(init.res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("rejects an older protocol revision with 400, naming both the declared and minimum versions", async () => {
    const init = await rawInitialize(gatewayUrl, "2024-11-05");
    expect(init.res.status).toBe(400);
    expect(init.body.error?.message).toContain("2024-11-05");
    expect(init.body.error?.message).toContain("2025-11-25");
    expect(init.res.headers.get("mcp-session-id")).toBeNull();
  });
});

describe("spec: MCP-Protocol-Version header", () => {
  it("echoes MCP-Protocol-Version on a non-initialize response", async () => {
    const sessionId = await establishedSession(gatewayUrl);
    const { res } = await rawSessionRequest(gatewayUrl, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.headers.get("mcp-protocol-version")).toBe("2025-11-25");
  });
});

describe("spec: session lifecycle", () => {
  it("returns 400 for a non-initialize POST carrying no Mcp-Session-Id header at all", async () => {
    const res = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404, not 400, for a well-formed but unknown session id", async () => {
    const { res } = await rawSessionRequest(gatewayUrl, "01JUNKNOWNSESSIONID000000", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(res.status).toBe(404);
  });

  it("a GET with no session id header also returns 400", async () => {
    const res = await fetch(`${gatewayUrl}/mcp`, { method: "GET" });
    expect(res.status).toBe(400);
  });

  it("DELETE terminates a session; a subsequent request against it 404s", async () => {
    const sessionId = await establishedSession(gatewayUrl);
    const deleteRes = await fetch(`${gatewayUrl}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    expect([200, 204]).toContain(deleteRes.status);

    const followUp = await rawSessionRequest(gatewayUrl, sessionId, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(followUp.res.status).toBe(404);
  });

  it("two independent initializes each get their own session id, not a shared single-session transport", async () => {
    const a = await establishedSession(gatewayUrl);
    const b = await establishedSession(gatewayUrl);
    expect(a).not.toBe(b);
    const listA = await rawSessionRequest(gatewayUrl, a, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const listB = await rawSessionRequest(gatewayUrl, b, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listA.res.status).toBe(200);
    expect(listB.res.status).toBe(200);
  });
});

describe("spec: tools/list equivalence", () => {
  it("prefixes every upstream-sourced tool name with {upstreamId}__ — the proxy's one deliberate non-transparency", async () => {
    const { client: viaGateway } = await connectClient(gatewayUrl);
    const { tools: gatewayTools } = await viaGateway.listTools();
    const upstreamSourced = gatewayTools.filter((t) => !isFirstPartyTool(t.name));
    expect(upstreamSourced.length).toBeGreaterThan(0);
    expect(upstreamSourced.every((t) => t.name.startsWith(GROCERY_PREFIX))).toBe(true);
  });

  it("the gateway also lists its own two unnamespaced first-party tools alongside the upstream's", async () => {
    const { client: viaGateway } = await connectClient(gatewayUrl);
    const { tools: gatewayTools } = await viaGateway.listTools();
    expect(gatewayTools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["chaperone/approve_change", "chaperone/pending_changes"]),
    );
  });

  it("stripping that prefix exactly reconstructs the upstream's own tool name set, with every other field byte-identical", async () => {
    const { client: direct } = await connectClient(upstreamUrl);
    const { client: viaGateway } = await connectClient(gatewayUrl);

    const { tools: directTools } = await direct.listTools();
    const { tools: allGatewayTools } = await viaGateway.listTools();
    const gatewayTools = allGatewayTools.filter((t) => !isFirstPartyTool(t.name));

    const strippedNames = gatewayTools.map((t) => t.name.slice(GROCERY_PREFIX.length)).sort();
    expect(strippedNames).toEqual(directTools.map((t) => t.name).sort());

    for (const directTool of directTools) {
      const gatewayTool = gatewayTools.find((t) => t.name === `${GROCERY_PREFIX}${directTool.name}`);
      expect({ ...gatewayTool, name: directTool.name }).toEqual(directTool);
    }
  });
});

describe("spec: tools/call equivalence", () => {
  it("a successful call returns byte-identical content whether made directly or through the gateway, given identical arguments", async () => {
    const { client: direct } = await connectClient(upstreamUrl);
    const { client: viaGateway } = await connectClient(gatewayUrl);

    const args = { item: "equivalence-probe", quantity: 5 };
    const directResult = await direct.callTool({ name: "add_item", arguments: args });
    const gatewayResult = await viaGateway.callTool({ name: `${GROCERY_PREFIX}add_item`, arguments: args });

    expect(blocks(gatewayResult)[0]?.text).toBe(blocks(directResult)[0]?.text);
  });

  it("forwards arguments unmodified: the exact item and quantity appear verbatim in the tool's own response", async () => {
    const { client } = await connectClient(gatewayUrl);
    const result = await client.callTool({
      name: `${GROCERY_PREFIX}add_item`,
      arguments: { item: "argument-passthrough-probe", quantity: 7 },
    });
    expect(blocks(result)[0]?.text).toBe("Added 7 × argument-passthrough-probe to the shopping list.");
  });

  it("preserves isError: true through the gateway, identical to calling the upstream directly", async () => {
    const { client: direct } = await connectClient(upstreamUrl);
    const { client: viaGateway } = await connectClient(gatewayUrl);

    const directResult = await direct.callTool({ name: "place_order", arguments: { confirm: false } });
    const gatewayResult = await viaGateway.callTool({ name: `${GROCERY_PREFIX}place_order`, arguments: { confirm: false } });

    expect(gatewayResult.isError).toBe(true);
    expect(gatewayResult.isError).toBe(directResult.isError);
    expect(blocks(gatewayResult)[0]?.text).toBe(blocks(directResult)[0]?.text);
  });

  it("forwards a multi-content-block result with the same block count and text through the gateway", async () => {
    const { client: direct } = await connectClient(upstreamUrl);
    const { client: viaGateway } = await connectClient(gatewayUrl);

    const directResult = await direct.callTool({ name: "track_delivery", arguments: {} });
    const gatewayResult = await viaGateway.callTool({ name: `${GROCERY_PREFIX}track_delivery`, arguments: {} });

    expect(blocks(gatewayResult)).toHaveLength(2);
    expect(blocks(gatewayResult)).toEqual(blocks(directResult));
  });

  it("rejects a namespaced tool name whose prefix matches no configured upstream, rather than silently forwarding it", async () => {
    const { client } = await connectClient(gatewayUrl);
    await expect(client.callTool({ name: "not_configured__add_item", arguments: {} })).rejects.toThrow();
  });
});

describe("spec: progress", () => {
  it("relays every notifications/progress from the upstream, in order, before the final result", async () => {
    const { client } = await connectClient(gatewayUrl);
    const seen: number[] = [];
    let resultSeen = false;

    const result = await client.callTool({ name: `${GROCERY_PREFIX}track_delivery`, arguments: {} }, undefined, {
      onprogress: (p) => {
        expect(resultSeen).toBe(false);
        seen.push(p.progress);
      },
    });
    resultSeen = true;

    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("REGRESSION: the final progress notification's downstream write is not raced against the result (MCP-03 ordering)", async () => {
    // Reproduces, deterministically, the CI failure where spec/long-stream.test.ts
    // received 35 of 36 progress notifications — always the last one, never a
    // middle one. Root cause: upstreamProxy.ts's tools/call handler kicks off
    // each relayed `notifications/progress` via `extra.sendNotification(...)`
    // inside a fire-and-forget `relayChain` promise, but never awaits that
    // chain before returning the tool's result. The SDK's own response path
    // (protocol.js: `.then(() => handler(...)).then(async (result) => { await
    // transport.send(response); })`) has no shared queue with our relay, so
    // nothing stops the result's own `transport.send()` — which does its own
    // real event-store write — from finishing and reaching the client before
    // a still-in-flight notification write does. For checkpoints 1..(N-1) this
    // never surfaces: each has the tool's own tick interval (150ms here, 5s in
    // the long-stream test) to comfortably finish its write with room to
    // spare. Only the *last* checkpoint races the result directly, with no
    // slack at all — which is exactly the "always the last one" shape the CI
    // failure showed.
    //
    // This suite's ledger mock is normally synchronous, which is precisely
    // why this defect never showed up here before: with no real async gap on
    // either side, the untested race never had room to go the wrong way. This
    // test manufactures that gap on purpose — an artificial delay standing in
    // for the real DynamoDB round trip `event-store.ts`'s `storeEvent` makes on
    // every write — applied only to the final checkpoint's notification, and
    // not to the result. If the proxy doesn't wait for its own relay to
    // finish, this fails on every run, not just an unlucky one.
    const basePutSseEvent = vi.mocked(ledger.putSseEvent).getMockImplementation();
    if (!basePutSseEvent) {
      throw new Error("putSseEvent mock has no base implementation to wrap — check beforeEach's setup order");
    }
    vi.mocked(ledger.putSseEvent).mockImplementation(async (event) => {
      const message = JSON.parse(event.message) as {
        method?: string;
        params?: { progress?: number; total?: number };
      };
      if (message.method === "notifications/progress" && message.params?.progress === message.params?.total) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return basePutSseEvent(event);
    });

    const { client } = await connectClient(gatewayUrl);
    const seen: number[] = [];

    const result = await client.callTool({ name: `${GROCERY_PREFIX}track_delivery`, arguments: {} }, undefined, {
      onprogress: (p) => {
        seen.push(p.progress);
      },
    });

    expect(result.isError).toBeUndefined();
    // The bug drops or reorders exactly the last checkpoint — assert the
    // exact sequence, not just the count, so a reorder (delivered but out of
    // place) fails this the same way a drop does.
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("never sends a progress notification when the call carried no progressToken", async () => {
    const { client } = await connectClient(gatewayUrl);
    let progressCount = 0;
    client.setNotificationHandler(ProgressNotificationSchema, () => {
      progressCount += 1;
    });

    const result = await client.callTool({ name: `${GROCERY_PREFIX}track_delivery`, arguments: {} });
    expect(result.isError).toBeUndefined();
    expect(progressCount).toBe(0);
  });
});

describe("spec: cancellation", () => {
  it("propagates a downstream cancellation to the real upstream process, observed via the upstream's own state", async () => {
    const { client } = await connectClient(gatewayUrl);
    const controller = new AbortController();

    const resultPromise = client.callTool({ name: `${GROCERY_PREFIX}track_delivery`, arguments: {} }, undefined, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);

    await expect(resultPromise).rejects.toThrow();
    // Give the notifications/cancelled message a moment to reach the real
    // upstream process and the tool handler's own abort check to observe
    // it — a real message over a real connection, not simulated.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(deliveryCancellationCount()).toBeGreaterThan(0);
  });
});

describe("spec: JSON-RPC error shapes", () => {
  it("an unrecognized method returns -32601 Method not found, matching a direct call to the upstream", async () => {
    const gatewaySessionId = await establishedSession(gatewayUrl);
    const upstreamSessionId = await establishedSession(upstreamUrl);

    const viaGateway = await rawSessionRequest(gatewayUrl, gatewaySessionId, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/frobnicate",
    });
    const direct = await rawSessionRequest(upstreamUrl, upstreamSessionId, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/frobnicate",
    });

    expect(viaGateway.body.error?.code).toBe(-32601);
    expect(direct.body.error?.code).toBe(-32601);
  });

  it("malformed JSON in the request body returns -32700 Parse error", async () => {
    const res = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{ this is not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await readJsonRpcBody(res)) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

describe("spec: transport-level enforcement", () => {
  it("rejects a POST missing the required Accept header with 406, matching the upstream's own transport behaviour", async () => {
    const requestInit = {
      method: "POST" as const,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "spec", version: "0" } },
      }),
    };
    const viaGateway = await fetch(`${gatewayUrl}/mcp`, requestInit);
    const direct = await fetch(`${upstreamUrl}/mcp`, requestInit);
    expect(viaGateway.status).toBe(406);
    expect(direct.status).toBe(406);
  });

  it("rejects a disallowed Origin with 403 — a gateway-only policy the bare upstream has no equivalent of", async () => {
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

  it("allows a request that carries no Origin header at all (a non-browser MCP client), consistent with the SDK's own posture", async () => {
    const init = await rawInitialize(gatewayUrl);
    expect(init.res.status).toBe(200);
  });
});

describe("spec: upstream failure handling", () => {
  it("fails closed to an empty upstream-sourced tools/list within the per-upstream budget when the upstream goes down, rather than hanging or 500ing", async () => {
    const { client } = await connectClient(gatewayUrl);
    upstreamServer.closeAllConnections();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));

    const start = Date.now();
    const { tools } = await client.listTools();
    const elapsedMs = Date.now() - start;

    // The gateway's own two first-party tools are unaffected by upstream
    // health — only the upstream-sourced portion of the list must go empty.
    expect(tools.filter((t) => !isFirstPartyTool(t.name))).toEqual([]);
    expect(elapsedMs).toBeLessThan(4_000);
  });
});
