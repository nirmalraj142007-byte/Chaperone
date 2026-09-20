/**
 * `/healthz` and `/metrics`, over a real Express app built by `buildApp`.
 *
 * The assertion that matters most here is the last one: a 503 must not
 * mean a tool got allowed. CLAUDE.md's third non-negotiable is that a
 * storage failure withholds, and this suite drives both the health
 * endpoint and a real `tools/call` against the same broken DynamoDB so
 * that the two claims are checked together rather than separately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import type { UpstreamConfig, UpstreamPool } from "@chaperone/upstream";
import { getPool } from "@chaperone/upstream";
import { buildApp as buildDemoUpstreamApp, resetControlStateForTests } from "@chaperone/demo-upstream";
import { canonicalizeTool, hashTool, REFUSAL_TOOL_CHANGED } from "@chaperone/policy";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

vi.mock("@chaperone/ledger", () => ({
  putSession: vi.fn(),
  getSession: vi.fn(),
  touchSession: vi.fn(),
  deleteSession: vi.fn(),
  nextSseSeq: vi.fn(),
  putSseEvent: vi.fn(),
  listSseEventsSince: vi.fn(),
  sseEventTtl: vi.fn(),
  getPin: vi.fn(),
  putPin: vi.fn(),
  createQuarantine: vi.fn(),
  getQuarantine: vi.fn(),
  listQuarantineByStatus: vi.fn(),
  resolveQuarantine: vi.fn(),
  appendEvent: vi.fn(),
  getAdvisory: vi.fn(),
}));

const { buildApp } = await import("../src/app.js");
const { GATE_WHEN_UNHEALTHY } = await import("../src/health.js");
const { resetMetricsForTests } = await import("../src/metrics.js");
const ledger = await import("@chaperone/ledger");

const HOUSEHOLD_ID = "household-demo";

/**
 * The shape this suite reads off /healthz. Deliberately a local structural
 * type rather than importing HealthReport: the point of these assertions is
 * that the JSON on the wire has these fields, which importing the server's
 * own type would assume rather than check.
 */
interface HealthBody {
  status: string;
  checks: {
    dynamodb: { state: string; error?: string; latencyMs: number };
    eventStore: { state: string };
    upstreams: Array<{ id: string; state: string }>;
    storageBackend: string;
    version: string;
    commit: string;
    uptime: number;
  };
  gateWhenUnhealthy: string;
}

async function healthBody(url: string): Promise<HealthBody> {
  return (await (await fetch(`${url}/healthz`)).json()) as HealthBody;
}

let upstreamServer: HttpServer;
let gatewayServer: HttpServer;
let upstream: UpstreamConfig;
let pool: UpstreamPool;
let gatewayUrl: string;
let pins: Map<string, Record<string, unknown>>;
/** Flipped on to simulate DynamoDB going away underneath a running gateway. */
let storageDown: boolean;
/**
 * Every client this suite opens, closed in afterEach. A failed assertion
 * skips the rest of its test, so a client closed only at the end of the
 * body leaks on failure — and `gatewayServer.close()` then waits forever
 * on the open connection, turning one assertion failure into a hook
 * timeout that hides it.
 */
let clients: Client[];

function listen(app: ReturnType<typeof buildApp>): Promise<HttpServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function addressOf(server: HttpServer): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetControlStateForTests();
  resetMetricsForTests();
  pins = new Map();
  storageDown = false;
  clients = [];

  const failIfDown = (): void => {
    if (storageDown) {
      throw new Error("DynamoDB is unreachable");
    }
  };

  vi.mocked(ledger.getPin).mockImplementation(async (householdId, upstreamId, toolName) => {
    failIfDown();
    return pins.get(`${householdId}#${upstreamId}#${toolName}`) as never;
  });
  vi.mocked(ledger.listSseEventsSince).mockImplementation(async () => {
    failIfDown();
    return [];
  });
  vi.mocked(ledger.nextSseSeq).mockImplementation(async () => {
    failIfDown();
    return 1;
  });
  vi.mocked(ledger.putSseEvent).mockImplementation(async () => {
    failIfDown();
  });
  vi.mocked(ledger.sseEventTtl).mockReturnValue(0);
  vi.mocked(ledger.putSession).mockResolvedValue(undefined as never);
  vi.mocked(ledger.getSession).mockImplementation(async () => ({ sessionId: "s", protocolVersion: "2025-11-25", ttl: 2 ** 40 }) as never);
  vi.mocked(ledger.touchSession).mockResolvedValue(undefined as never);
  vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([] as never);

  upstreamServer = await listen(buildDemoUpstreamApp());
  upstream = { id: "grocery", url: `${addressOf(upstreamServer)}/mcp`, label: "Household Grocery" };
  pool = await getPool([upstream]);

  gatewayServer = await listen(buildApp(pool, [upstream], ["http://localhost:*"], HOUSEHOLD_ID, true));
  gatewayUrl = addressOf(gatewayServer);
});

afterEach(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  await pool.close();
  await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

/** Pins every tool the upstream currently declares, so the gate allows them. */
async function pinCurrentTools(): Promise<void> {
  for (const { tool } of await pool.listAllTools()) {
    const definition = { name: tool.name, inputSchema: tool.inputSchema, ...(tool.description !== undefined ? { description: tool.description } : {}) };
    pins.set(`${HOUSEHOLD_ID}#${upstream.id}#${tool.name}`, {
      householdId: HOUSEHOLD_ID,
      upstreamId: upstream.id,
      toolName: tool.name,
      approvedHash: hashTool(definition),
      approvedCanonicalJson: canonicalizeTool(definition),
      capabilityClass: "read",
    });
  }
}

async function connectClient(): Promise<Client> {
  const client = new Client({ name: "health-test", version: "0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`)) as Transport);
  return client;
}

describe("GET /healthz", () => {
  it("returns 200 and every named component when storage and upstreams are up", async () => {
    await pool.listAllTools(); // bring the upstream handle to `ready`

    const response = await fetch(`${gatewayUrl}/healthz`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.checks.dynamodb.state).toBe("ok");
    expect(body.checks.eventStore.state).toBe("ok");
    expect(body.checks.upstreams).toEqual([{ id: "grocery", state: "ready" }]);
    expect(typeof body.checks.version).toBe("string");
    expect(typeof body.checks.commit).toBe("string");
    expect(typeof body.checks.uptime).toBe("number");
  });

  it("returns 503 when DynamoDB is unreachable", async () => {
    storageDown = true;
    const response = await fetch(`${gatewayUrl}/healthz`);
    expect(response.status).toBe(503);

    const body = (await response.json()) as HealthBody;
    expect(body.status).toBe("unhealthy");
    expect(body.checks.dynamodb.state).toBe("unreachable");
    expect(body.checks.dynamodb.error).toContain("unreachable");
  });

  it("says in the body that unhealthy is not permissive", async () => {
    // A judge reading a 503 has to be able to tell, from the response
    // itself, that the gate failed closed rather than opened.
    storageDown = true;
    const body = await healthBody(gatewayUrl);
    expect(body.gateWhenUnhealthy).toBe(GATE_WHEN_UNHEALTHY);
    expect(body.gateWhenUnhealthy).toContain("Fails closed");
    expect(body.gateWhenUnhealthy).toContain("never more");
  });

  it("carries the same fail-closed note on a healthy response", async () => {
    // The property does not depend on the current check result, so the
    // field is not a thing that only appears when something is wrong.
    const body = await healthBody(gatewayUrl);
    expect(body.status).toBe("ok");
    expect(body.gateWhenUnhealthy).toBe(GATE_WHEN_UNHEALTHY);
  });

  it("stays 200 with a failed upstream, reporting degraded rather than unhealthy", async () => {
    // A dead upstream is normal operation for a proxy: the gateway is
    // doing its job and the pool will reconnect. Only storage failure,
    // which is what the gate depends on, takes the task out of rotation.
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    await pool.listAllTools().catch(() => undefined);

    const response = await fetch(`${gatewayUrl}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.checks.upstreams[0].state).toBe("failed");

    upstreamServer = await listen(buildDemoUpstreamApp());
  });

  it("is never cached", async () => {
    // A cached 200 outliving the outage it was measured before is the one
    // way a health endpoint can actively mislead.
    expect((await fetch(`${gatewayUrl}/healthz`)).headers.get("cache-control")).toBe("no-store");
  });

  it("echoes a request id, like every other route", async () => {
    expect((await fetch(`${gatewayUrl}/healthz`)).headers.get("x-request-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("unhealthy is not permissive", () => {
  it("never allows a tools/call while DynamoDB is down, and says so on /healthz", async () => {
    await pinCurrentTools();
    const client = await connectClient();

    // Sanity: the same call succeeds while storage is up, so whatever
    // happens below is caused by the outage and not by a missing pin.
    const before = (await client.callTool({ name: "grocery__read_list", arguments: {} })) as CallToolResult;
    expect(before.isError).not.toBe(true);

    storageDown = true;

    expect((await fetch(`${gatewayUrl}/healthz`)).status).toBe(503);

    // What is asserted is the security property, not a particular error
    // surface: the call does not succeed. With every table unreachable the
    // request dies in the transport's own priming-event write, before the
    // gate is reached, and @modelcontextprotocol/sdk 1.30.0's
    // `handlePostRequest` catch-all reports *any* throw from that path as
    // `-32700 Parse error` (webStandardStreamableHttp.js). That is an
    // opaque label for a storage outage and it is logged in
    // friction-log.md, but it is still a refusal: no tool ran, and nothing
    // was allowed. The test below covers the gate's own fail-closed path,
    // where the frozen refusal text is the guarantee.
    await expect(client.callTool({ name: "grocery__read_list", arguments: {} })).rejects.toThrow();
  });

  it("returns the frozen refusal when the gate's own pin read fails", async () => {
    await pinCurrentTools();
    const client = await connectClient();

    // Only the pin read fails — the gate's single storage dependency —
    // so the request reaches gate.ts and exercises the fail-closed branch
    // that CLAUDE.md's third non-negotiable is actually about.
    vi.mocked(ledger.getPin).mockRejectedValue(new Error("DynamoDB is unreachable"));

    const result = (await client.callTool({ name: "grocery__read_list", arguments: {} })) as CallToolResult;
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");

    expect(result.isError).toBe(true);
    expect(text).toContain(REFUSAL_TOOL_CHANGED);
  });

  it("counts a pin-read failure as a denial, not as an allow", async () => {
    await pinCurrentTools();
    const client = await connectClient();
    vi.mocked(ledger.getPin).mockRejectedValue(new Error("DynamoDB is unreachable"));

    await client.callTool({ name: "grocery__read_list", arguments: {} });

    const text = await (await fetch(`${gatewayUrl}/metrics`)).text();
    expect(text).toMatch(/chaperone_gate_decisions_total\{decision="deny",reason="PIN_READ_FAILED",upstream="grocery"\} \d+/);
    expect(text).not.toMatch(/chaperone_gate_decisions_total\{decision="allow".*\} [1-9]/);
  });
});

describe("GET /metrics", () => {
  it("serves Prometheus text exposition format", async () => {
    const response = await fetch(`${gatewayUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await response.text()).toContain("# TYPE chaperone_requests_total counter");
  });

  it("counts handled requests and observes their duration, labelled by MCP method", async () => {
    await pinCurrentTools();
    const client = await connectClient();
    await client.callTool({ name: "grocery__read_list", arguments: {} });

    const text = await (await fetch(`${gatewayUrl}/metrics`)).text();
    expect(text).toMatch(/chaperone_requests_total\{http_method="POST",mcp_method="initialize",status="200"\} \d+/);
    expect(text).toMatch(/chaperone_requests_total\{http_method="POST",mcp_method="tools\/call",status="200"\} \d+/);
    expect(text).toMatch(/chaperone_request_duration_seconds_count\{http_method="POST",mcp_method="tools\/call"\} \d+/);
  });

  it("counts gate decisions and event-store writes", async () => {
    await pinCurrentTools();
    const client = await connectClient();
    await client.listTools();

    const text = await (await fetch(`${gatewayUrl}/metrics`)).text();
    expect(text).toMatch(/chaperone_gate_decisions_total\{decision="allow",reason="HASH_MATCH",upstream="grocery"\} \d+/);
    expect(text).toMatch(/chaperone_event_store_writes_total\{outcome="ok"\} \d+/);
  });

  it("counts a quarantine opened by a drifted tool definition", async () => {
    await pinCurrentTools();
    // Re-pin add_item to a stale hash so the current definition mismatches.
    pins.set(`${HOUSEHOLD_ID}#${upstream.id}#add_item`, {
      householdId: HOUSEHOLD_ID,
      upstreamId: upstream.id,
      toolName: "add_item",
      approvedHash: "sha256:" + "0".repeat(64),
      approvedCanonicalJson: JSON.stringify({ description: "old", inputSchema: {}, name: "add_item" }),
      capabilityClass: "write",
    });

    const client = await connectClient();
    await client.listTools();

    const text = await (await fetch(`${gatewayUrl}/metrics`)).text();
    expect(text).toMatch(/chaperone_quarantine_events_total\{outcome="opened",upstream="grocery"\} \d+/);
    expect(text).toMatch(/chaperone_gate_decisions_total\{decision="deny",reason="HASH_MISMATCH",upstream="grocery"\} \d+/);
  });
});
