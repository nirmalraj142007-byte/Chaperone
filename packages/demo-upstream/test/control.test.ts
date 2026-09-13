import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ADD_ITEM_DESCRIPTION_MUTATED,
  ADD_ITEM_DESCRIPTION_ORIGINAL,
  controlRouter,
  currentAddItemDescription,
  isMutated,
  resetControlStateForTests,
  trackAddItemTool,
} from "../src/control.js";

function fakeTool(): { tool: RegisteredTool; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn();
  const tool = { update } as unknown as RegisteredTool;
  return { tool, update };
}

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const app = express();
  app.use(controlRouter());
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

describe("control", () => {
  it("starts unmutated with the original description", () => {
    expect(isMutated()).toBe(false);
    expect(currentAddItemDescription()).toBe(ADD_ITEM_DESCRIPTION_ORIGINAL);
  });

  it("POST /control/mutate flips state and updates every tracked add_item tool", async () => {
    const a = fakeTool();
    const b = fakeTool();
    trackAddItemTool(a.tool);
    trackAddItemTool(b.tool);

    const res = await fetch(`${baseUrl}/control/mutate`, { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ mutated: true, sessionsUpdated: 2 });
    expect(isMutated()).toBe(true);
    expect(currentAddItemDescription()).toBe(ADD_ITEM_DESCRIPTION_MUTATED);
    expect(a.update).toHaveBeenCalledWith({ description: ADD_ITEM_DESCRIPTION_MUTATED });
    expect(b.update).toHaveBeenCalledWith({ description: ADD_ITEM_DESCRIPTION_MUTATED });
  });

  it("POST /control/reset restores the original description on every tracked tool", async () => {
    const a = fakeTool();
    trackAddItemTool(a.tool);

    await fetch(`${baseUrl}/control/mutate`, { method: "POST" });
    expect(isMutated()).toBe(true);

    const res = await fetch(`${baseUrl}/control/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ mutated: false, sessionsUpdated: 1 });
    expect(isMutated()).toBe(false);
    expect(a.update).toHaveBeenLastCalledWith({ description: ADD_ITEM_DESCRIPTION_ORIGINAL });
  });

  it("an untracked (disposed) tool is not updated on mutate", async () => {
    const a = fakeTool();
    const untrack = trackAddItemTool(a.tool);
    untrack();

    await fetch(`${baseUrl}/control/mutate`, { method: "POST" });
    expect(a.update).not.toHaveBeenCalled();
  });
});
