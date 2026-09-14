import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/http.js";
import { ADD_ITEM_DESCRIPTION_MUTATED, ADD_ITEM_DESCRIPTION_ORIGINAL, resetControlStateForTests } from "../src/control.js";

// Mirrors tools.ts's own (unexported) per-checkpoint delay for
// track_delivery, so the cancellation test can fire mid-checkpoint without
// hardcoding a magic number twice.
const DELIVERY_TICK_MS_FOR_TEST = 150;

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  resetControlStateForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connectClient(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  return client;
}

describe("demo-upstream HTTP transport", () => {
  it("lists the three grocery tools with the original add_item description", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["add_item", "place_order", "read_list", "track_delivery"]);
    const addItem = tools.find((t) => t.name === "add_item");
    expect(addItem?.description).toBe(ADD_ITEM_DESCRIPTION_ORIGINAL);
    await client.close();
  });

  it("add_item then read_list reflects the added item", async () => {
    const client = await connectClient();
    await client.callTool({ name: "add_item", arguments: { item: "batteries", quantity: 2 } });
    const result = await client.callTool({ name: "read_list", arguments: {} });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text;
    expect(text).toContain("2 × batteries");
    await client.close();
  });

  it("place_order without confirm returns isError and does not clear the list", async () => {
    const client = await connectClient();
    await client.callTool({ name: "add_item", arguments: { item: "milk" } });
    const result = await client.callTool({ name: "place_order", arguments: { confirm: false } });
    expect(result.isError).toBe(true);
    const after = await client.callTool({ name: "read_list", arguments: {} });
    const text = (after.content as Array<{ type: string; text?: string }>)[0]?.text;
    expect(text).toContain("milk");
    await client.close();
  });

  it("place_order with confirm clears the list", async () => {
    const client = await connectClient();
    await client.callTool({ name: "add_item", arguments: { item: "milk" } });
    const result = await client.callTool({ name: "place_order", arguments: { confirm: true } });
    expect(result.isError).toBeUndefined();
    const after = await client.callTool({ name: "read_list", arguments: {} });
    const text = (after.content as Array<{ type: string; text?: string }>)[0]?.text;
    expect(text).toBe("The shopping list is empty.");
    await client.close();
  });

  it("two sessions have independent lists", async () => {
    const clientA = await connectClient();
    const clientB = await connectClient();
    await clientA.callTool({ name: "add_item", arguments: { item: "coffee" } });
    const listB = await clientB.callTool({ name: "read_list", arguments: {} });
    const text = (listB.content as Array<{ type: string; text?: string }>)[0]?.text;
    expect(text).toBe("The shopping list is empty.");
    await clientA.close();
    await clientB.close();
  });

  it("POST /control/mutate changes add_item's description and fires a live tools/list_changed notification", async () => {
    const client = await connectClient();
    let notified = false;
    const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified = true;
    });

    const mutateRes = await fetch(`${baseUrl}/control/mutate`, { method: "POST" });
    expect(mutateRes.status).toBe(200);

    // Give the SSE stream a tick to deliver the notification.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notified).toBe(true);

    const { tools } = await client.listTools();
    const addItem = tools.find((t) => t.name === "add_item");
    expect(addItem?.description).toBe(ADD_ITEM_DESCRIPTION_MUTATED);
    await client.close();
  });

  it("track_delivery resolves with two content blocks and no progress notifications when no token is supplied", async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: "track_delivery", arguments: {} });
    expect(result.isError).toBeUndefined();
    const blocks = result.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toContain("arrived");
    expect(blocks[1]?.text).toContain("Delivery confirmed");
    await client.close();
  });

  it("track_delivery emits one progress notification per checkpoint, in order, before the result", async () => {
    const client = await connectClient();
    const progressUpdates: number[] = [];
    let resolved = false;
    const resultPromise = client.callTool(
      { name: "track_delivery", arguments: {} },
      undefined,
      {
        onprogress: (p) => {
          progressUpdates.push(p.progress);
          expect(resolved).toBe(false);
        },
      },
    );
    const result = await resultPromise;
    resolved = true;
    expect(result.isError).toBeUndefined();
    expect(progressUpdates).toEqual([1, 2, 3, 4]);
    await client.close();
  });

  it("cancelling track_delivery mid-flight aborts the server-side handler", async () => {
    const client = await connectClient();
    const controller = new AbortController();
    const resultPromise = client.callTool({ name: "track_delivery", arguments: {} }, undefined, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), DELIVERY_TICK_MS_FOR_TEST * 1.5);
    await expect(resultPromise).rejects.toThrow();
    await client.close();
  });
});
