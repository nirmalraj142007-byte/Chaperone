/**
 * CLAUDE.md's fail-closed rule, proven against a real dead DynamoDB
 * endpoint rather than a mocked rejection — this file deliberately does
 * NOT mock @chaperone/ledger, so `getPin` makes a genuine network call
 * that genuinely fails.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigForTests } from "@chaperone/config";
import { getPin, resetDdbClientForTests } from "@chaperone/ledger";
import type { ToolDefinition } from "@chaperone/upstream";
import { gateToolCall, gateToolList } from "../src/gate.js";

const TOOL: ToolDefinition = {
  name: "add_item",
  description: "Add an item to the household's shopping list.",
  inputSchema: { type: "object", properties: {} },
};

let previousUpstreams: string | undefined;
let previousEndpoint: string | undefined;

beforeEach(() => {
  previousUpstreams = process.env["CHAPERONE_UPSTREAMS"];
  previousEndpoint = process.env["DDB_ENDPOINT"];
  process.env["CHAPERONE_UPSTREAMS"] = JSON.stringify([
    { id: "grocery", url: "http://localhost:4001/mcp", label: "Grocery" },
  ]);
  // Port 9 ("discard") is IANA-reserved and nothing on this machine ever
  // listens on it — a real connection refusal, not a simulated one.
  process.env["DDB_ENDPOINT"] = "http://127.0.0.1:9";
  resetConfigForTests();
  resetDdbClientForTests();
});

afterEach(() => {
  if (previousUpstreams === undefined) {
    delete process.env["CHAPERONE_UPSTREAMS"];
  } else {
    process.env["CHAPERONE_UPSTREAMS"] = previousUpstreams;
  }
  if (previousEndpoint === undefined) {
    delete process.env["DDB_ENDPOINT"];
  } else {
    process.env["DDB_ENDPOINT"] = previousEndpoint;
  }
  resetConfigForTests();
  resetDdbClientForTests();
});

describe("fail-closed against a genuinely dead DynamoDB endpoint", () => {
  it("proves the endpoint really is unreachable", async () => {
    await expect(getPin("household-demo", "grocery", "add_item")).rejects.toThrow();
  });

  it("gateToolCall denies rather than allowing when the pin store can't be reached", async () => {
    const decision = await gateToolCall("household-demo", "grocery", "add_item", TOOL);
    expect(decision.allowed).toBe(false);
  });

  it("gateToolList excludes the tool entirely rather than allowing it", async () => {
    const decisions = await gateToolList("household-demo", [{ upstreamId: "grocery", tool: TOOL }]);
    expect(decisions.every((d) => d.allowed === false)).toBe(true);
  });
});
