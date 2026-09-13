import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/http.js";
import { ADD_ITEM_DESCRIPTION_MUTATED, ADD_ITEM_DESCRIPTION_ORIGINAL, resetControlStateForTests } from "../src/control.js";

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
    expect(tools.map((t) => t.name).sort()).toEqual(["add_item", "place_order", "read_list"]);
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
});
