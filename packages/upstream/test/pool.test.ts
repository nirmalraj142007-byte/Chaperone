import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { UpstreamError } from "@chaperone/errors";
import { buildApp as buildDemoUpstreamApp } from "@chaperone/demo-upstream";
import { getPool } from "../src/pool.js";
import type { UpstreamConfig, UpstreamPool } from "../src/types.js";

async function listen(app: express.Express): Promise<{ server: HttpServer; url: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

/** A port nothing is listening on, for real (unmocked) connection-refused failures. */
async function unusedPort(): Promise<number> {
  const probe = express().listen(0);
  await new Promise<void>((resolve) => probe.once("listening", resolve));
  const address = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

let groceryServer: HttpServer;
let grocery: UpstreamConfig;
let deadUpstream: UpstreamConfig;

beforeEach(async () => {
  const { server, url } = await listen(buildDemoUpstreamApp());
  groceryServer = server;
  grocery = { id: "grocery", url: `${url}/mcp`, label: "Household Grocery" };
  const port = await unusedPort();
  deadUpstream = { id: "dead", url: `http://127.0.0.1:${port}/mcp`, label: "Unreachable" };
});

afterEach(async () => {
  groceryServer.closeAllConnections();
  await new Promise<void>((resolve) => groceryServer.close(() => resolve()));
});

function abortableContext(overrides: Partial<Parameters<UpstreamPool["callTool"]>[3]> = {}) {
  return {
    downstreamRequestId: 1,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("getPool: listAllTools", () => {
  it("returns wire-complete tool definitions namespaced by upstreamId", async () => {
    const pool = await getPool([grocery]);
    const entries = await pool.listAllTools();
    const names = entries.map((e) => e.tool.name).sort();
    expect(names).toEqual(["add_item", "place_order", "read_list", "track_delivery"]);
    expect(entries.every((e) => e.upstreamId === "grocery")).toBe(true);
    const addItem = entries.find((e) => e.tool.name === "add_item");
    expect(addItem?.tool.description).toContain("Add an item");
    await pool.close();
  });

  it("excludes an unreachable upstream but still returns the healthy one's tools, within the per-upstream timeout", async () => {
    const pool = await getPool([grocery, deadUpstream]);
    const start = Date.now();
    const entries = await pool.listAllTools();
    const elapsedMs = Date.now() - start;
    expect(entries.every((e) => e.upstreamId === "grocery")).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(4_000);
    await pool.close();
  });

  it("recovers after an already-ready upstream restarts with a fresh session, rather than staying permanently stuck", async () => {
    // Reproduces a real bug found by running Phase 8's literal docker-compose
    // VERIFY step against a running daemon (friction-log.md Entry 018): a
    // handle that went `ready` and was then killed mid-life (not merely
    // never connected) was never marked failed on a listTools()-level
    // failure, so ensureConnected kept treating the same stale client as
    // usable forever — and even once marked failed, the stale `Client`
    // still held its old transport, so the *next* connect attempt threw
    // "Already connected to a transport" instead of actually reconnecting.
    const first = await listen(buildDemoUpstreamApp());
    const port = (first.server.address() as AddressInfo).port;
    const flaky: UpstreamConfig = { id: "flaky", url: `http://127.0.0.1:${port}/mcp`, label: "Flaky" };

    const pool = await getPool([flaky]);
    const before = await pool.listAllTools();
    expect(before.length).toBeGreaterThan(0);

    // Kill the server the pool is now `ready` against, and start a brand
    // new instance on the exact same port with no memory of the old
    // session — exactly like a container restart. closeAllConnections()
    // (not a graceful close()) because the pool's own client holds a
    // standalone GET SSE stream open against this server once it has seen
    // `tools.listChanged`, and Node's graceful close() waits forever for
    // exactly that kind of open keep-alive connection (same reasoning as
    // packages/gateway/test/gateway.test.ts's own teardown).
    first.server.closeAllConnections();
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    const replacement = buildDemoUpstreamApp().listen(port);
    await new Promise<void>((resolve) => replacement.once("listening", resolve));

    // First call after the restart: the pool still believes the old
    // session is good, so this one is expected to fail and be excluded.
    const immediatelyAfterRestart = await pool.listAllTools();
    expect(immediatelyAfterRestart).toEqual([]);

    // Past the reconnect backoff window, the pool must have flagged the
    // handle failed and be willing to dial a genuinely fresh connection —
    // not stay stuck excluding this upstream forever.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterRecovery = await pool.listAllTools();
    expect(afterRecovery.length).toBeGreaterThan(0);
    expect(afterRecovery.map((e) => e.tool.name).sort()).toEqual(before.map((e) => e.tool.name).sort());

    await pool.close();
    replacement.closeAllConnections();
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  }, 8_000);
});

describe("getPool: callTool", () => {
  it("forwards arguments unmodified and returns the upstream's result unmodified", async () => {
    const pool = await getPool([grocery]);
    const result = await pool.callTool("grocery", "add_item", { item: "batteries", quantity: 3 }, abortableContext());
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text;
    expect(text).toContain("3 × batteries");
    await pool.close();
  });

  it("preserves isError: true on a real tool-level failure", async () => {
    const pool = await getPool([grocery]);
    const result = await pool.callTool("grocery", "place_order", { confirm: false }, abortableContext());
    expect(result.isError).toBe(true);
    await pool.close();
  });

  it("throws UpstreamError for a name not naming any configured upstream", async () => {
    const pool = await getPool([grocery]);
    await expect(pool.callTool("not-configured", "add_item", {}, abortableContext())).rejects.toBeInstanceOf(UpstreamError);
    await pool.close();
  });

  it("throws UpstreamError, fail-closed, when the upstream is unreachable", async () => {
    const pool = await getPool([deadUpstream]);
    await expect(pool.callTool("dead", "whatever", {}, abortableContext())).rejects.toBeInstanceOf(UpstreamError);
    await pool.close();
  });

  it("relays progress notifications in order, only when a progressToken is supplied", async () => {
    const pool = await getPool([grocery]);
    const seen: number[] = [];
    const controller = new AbortController();
    const result = await pool.callTool("grocery", "track_delivery", {}, {
      downstreamRequestId: 7,
      progressToken: "tok-1",
      signal: controller.signal,
      onProgress: (p) => {
        expect(p.params.progressToken).toBe("tok-1");
        seen.push(p.params.progress);
      },
    });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([1, 2, 3, 4]);
    await pool.close();
  });

  it("never invokes onProgress when the call carried no progressToken", async () => {
    const pool = await getPool([grocery]);
    let calls = 0;
    await pool.callTool("grocery", "track_delivery", {}, abortableContext({ onProgress: () => (calls += 1) }));
    expect(calls).toBe(0);
    await pool.close();
  });

  it("aborting the caller's signal aborts the upstream call", async () => {
    const pool = await getPool([grocery]);
    const controller = new AbortController();
    const promise = pool.callTool("grocery", "track_delivery", {}, { downstreamRequestId: 1, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(promise).rejects.toThrow();
    await pool.close();
  });
});

describe("getPool: close", () => {
  it("closes every upstream connection without throwing", async () => {
    const pool = await getPool([grocery]);
    await pool.callTool("grocery", "read_list", {}, abortableContext());
    await expect(pool.close()).resolves.toBeUndefined();
  });
});
