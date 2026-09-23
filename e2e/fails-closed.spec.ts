/**
 * The failure paths, end to end, against the real stack. What this proves is
 * the product's central promise about failure: when something goes wrong the
 * tool stays withheld, and nothing says "allowed" by accident.
 *
 *   1. DynamoDB down: a quarantined tool is still refused, /healthz says 503,
 *      no HTML error page reaches the client, and the gateway recovers when
 *      DynamoDB returns, without being restarted.
 *   2. A consumed approval token cannot be replayed: a distinct error, and
 *      nothing is written.
 *   3. "Keep blocked" is final: two more tools/list calls open no new
 *      quarantine and mint no new token.
 */
import { expect, test } from "@playwright/test";
import { REFUSAL_TOOL_CHANGED } from "@chaperone/policy";
import {
  blocks,
  cardActionOf,
  connectGateway,
  demoUpstreamControl,
  getJson,
  isReachable,
  pollUntil,
  textOf,
} from "../scripts/demo/harness.js";
import { HOUSEHOLD_ID, STACK, compose, freshDemo, freshSession, householdEvents, ledger, ledgerTypes } from "./support.js";
import { execFileSync } from "node:child_process";

test.beforeEach(async () => {
  await freshDemo();
});

test.afterAll(async () => {
  // Leave the stack as `pnpm demo:reset` leaves it, not with the last test's quarantine in it.
  compose("start", "ddb");
  await freshDemo();
});

test.afterEach(async () => {
  // Whatever a test did to DynamoDB, the next one (and the next spec) starts with it running.
  compose("start", "ddb");
  await pollUntil("DynamoDB Local", async () => ((await isReachable(`${STACK.ddbEndpoint}/`)) || undefined), 60_000).catch(() => undefined);
});

/** Puts add_item into quarantine and returns the card's action, as a resident would receive it. */
async function quarantineAddItem(client: Awaited<ReturnType<typeof freshSession>>): Promise<{ quarantineId: string; approvalToken: string }> {
  await demoUpstreamControl("mutate");
  const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
  expect(result.isError).toBe(true);
  expect(textOf(blocks(result)[0])).toBe(REFUSAL_TOOL_CHANGED);
  return cardActionOf(textOf(blocks(result)[1]));
}

function gatewayStartedAt(): string {
  return execFileSync("docker", ["inspect", "-f", "{{.State.StartedAt}}", "chaperone-gateway"], { encoding: "utf8" }).trim();
}

test("DynamoDB down: the quarantined tool is still refused, /healthz says 503, no HTML leaks, and the gateway recovers unrestarted", async () => {
  const client = await freshSession("e2e-fails-closed-ddb");
  try {
    await quarantineAddItem(client);
    const startedBefore = gatewayStartedAt();

    compose("stop", "ddb");
    await pollUntil("DynamoDB Local to stop answering", async () => ((await isReachable(`${STACK.ddbEndpoint}/`)) ? undefined : true), 30_000);

    await test.step("tools/call still refuses, and never allows", async () => {
      // Raw HTTP as well as the SDK client: the client would turn a transport
      // error into an exception, and what has to be shown is what is on the wire.
      const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } }).catch((e: unknown) => e);
      if (result instanceof Error) {
        // A protocol-level error is an acceptable way to fail closed; an allow is not.
        test.info().annotations.push({ type: "tools/call with DynamoDB down", description: `protocol error: ${result.message.slice(0, 120)}` });
        // What the gateway does today: an HTTP 503 carrying JSON-RPC error -32003 "Service Unavailable" (session store unreachable).
        // It must be that deliberate refusal to serve, not some other failure that merely happened not to allow.
        expect(result.message).toMatch(/-32003|Service Unavailable|503/);
        expect(result.message).not.toMatch(/Added \d/);
      } else {
        const content = blocks(result);
        expect((result as { isError?: boolean }).isError).toBe(true);
        const first = textOf(content[0]);
        expect(first).toBe(REFUSAL_TOOL_CHANGED);
        expect(first).not.toMatch(/Added \d/);
        test.info().annotations.push({ type: "tools/call with DynamoDB down", description: "frozen refusal returned as a tool result" });
      }
    });

    await test.step("no HTML error page reaches a client, on any surface", async () => {
      const probes: Array<[string, () => Promise<Response>]> = [
        ["/healthz", () => fetch(`${STACK.gatewayUrl}/healthz`)],
        ["/api/quarantine", () => fetch(`${STACK.gatewayUrl}/api/quarantine`)],
        ["/api/ledger/verify", () => fetch(`${STACK.gatewayUrl}/api/ledger/verify`)],
        [
          "POST /mcp initialize",
          () =>
            fetch(`${STACK.gatewayUrl}/mcp`, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e-raw", version: "0" } },
              }),
            }),
        ],
      ];
      for (const [label, send] of probes) {
        const res = await send();
        const body = await res.text();
        expect(res.headers.get("content-type") ?? "", `${label} content-type`).not.toMatch(/text\/html/i);
        expect(body.trimStart().startsWith("<"), `${label} body must not be markup: ${body.slice(0, 80)}`).toBe(false);
        expect(body, `${label} must not leak a stack trace`).not.toMatch(/\n\s+at .+\(.+:\d+:\d+\)/);
      }
    });

    await test.step("/healthz returns 503, and says a 503 is not a permissive state", async () => {
      const health = await getJson<{ status: string; gateWhenUnhealthy?: string }>(`${STACK.gatewayUrl}/healthz`);
      expect(health.status).toBe(503);
      expect(health.body.status).not.toBe("ok");
      expect(health.body.gateWhenUnhealthy ?? "").toMatch(/not a permissive state/i);
      // The read API reports the outage as JSON too, never as an empty queue.
      const queue = await getJson<{ error?: string }>(`${STACK.gatewayUrl}/api/quarantine`);
      expect(queue.status).toBe(503);
      expect(queue.body.error).toBe("storage_unavailable");
    });

    await test.step("DynamoDB returns; the gateway recovers without being restarted", async () => {
      compose("start", "ddb");
      await pollUntil(
        "/healthz to return to 200",
        async () => {
          const res = await fetch(`${STACK.gatewayUrl}/healthz`).catch(() => undefined);
          return res?.status === 200 ? true : undefined;
        },
        90_000,
      );
      expect(gatewayStartedAt()).toBe(startedBefore);

      // Recovery is real service, not just a green light: the change is still
      // quarantined (it was persisted), so the tool is still withheld...
      const fresh = await connectGateway("e2e-fails-closed-recovered");
      try {
        const names = (await fresh.listTools()).tools.map((t) => t.name);
        expect(names).not.toContain("grocery__add_item");
        expect(names).toContain("grocery__read_list");
        const refused = await fresh.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
        expect(refused.isError).toBe(true);
        expect(textOf(blocks(refused)[0])).toBe(REFUSAL_TOOL_CHANGED);
      } finally {
        await fresh.close();
      }
      // ...and outage did not corrupt the chain.
      expect((await getJson<{ ok: boolean }>(`${STACK.gatewayUrl}/api/ledger/verify`)).body.ok).toBe(true);
    });
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("a consumed approval token cannot be replayed: a distinct error, and no pin is written", async () => {
  const client = await freshSession("e2e-fails-closed-replay");
  try {
    const { quarantineId, approvalToken } = await quarantineAddItem(client);
    const approve = { name: "chaperone/approve_change", arguments: { quarantineId, approvalToken, decision: "approve" } } as const;

    const first = await client.callTool(approve);
    expect(first.isError).not.toBe(true);

    const pinAfterFirst = await ledger.getPin(HOUSEHOLD_ID, "grocery", "add_item");
    const eventsAfterFirst = await householdEvents();
    expect(ledgerTypes(eventsAfterFirst).slice(-2)).toEqual(["APPROVED", "REPIN"]);

    const replay = await client.callTool(approve);
    expect(replay.isError).toBe(true);
    const message = textOf(blocks(replay)[0]);
    // Its own error: "already resolved", not "invalid token", not "expired", not the frozen refusal.
    expect(message).toMatch(/already resolved as "approved"/);
    expect(message).not.toMatch(/invalid approval token|expired/i);
    expect(message).not.toBe(REFUSAL_TOOL_CHANGED);

    expect(await ledger.getPin(HOUSEHOLD_ID, "grocery", "add_item")).toEqual(pinAfterFirst);
    const eventsAfterReplay = await householdEvents();
    expect(eventsAfterReplay).toEqual(eventsAfterFirst);
    expect(eventsAfterReplay.filter((e) => e.type === "REPIN")).toHaveLength(1);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("Keep blocked is final: two more tools/list calls open no new quarantine and mint no new token", async () => {
  const client = await freshSession("e2e-fails-closed-final");
  try {
    const { quarantineId, approvalToken } = await quarantineAddItem(client);
    const block = await client.callTool({
      name: "chaperone/approve_change",
      arguments: { quarantineId, approvalToken, decision: "block" },
    });
    expect(block.isError).not.toBe(true);

    const queueAfterBlock = await getJson<{ total: number; items: Array<{ quarantineId: string; reviewState: string }> }>(
      `${STACK.gatewayUrl}/api/quarantine`,
    );
    expect(queueAfterBlock.body.total).toBe(1);
    expect(queueAfterBlock.body.items[0]?.reviewState).toBe("refused");
    const eventsAfterBlock = await householdEvents();

    for (let i = 0; i < 2; i++) {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("grocery__add_item");
    }

    // Calling it again: still withheld, still the frozen text, and no fresh token in what comes back.
    const again = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
    expect(again.isError).toBe(true);
    expect(textOf(blocks(again)[0])).toBe(REFUSAL_TOOL_CHANGED);
    for (const block of blocks(again)) {
      if (block.type === "text") {
        expect(block.text).not.toContain("approvalToken=");
      }
    }

    const queueAfter = await getJson<{ total: number; items: Array<{ quarantineId: string; reviewState: string }> }>(
      `${STACK.gatewayUrl}/api/quarantine`,
    );
    expect(queueAfter.body.total).toBe(1);
    expect(queueAfter.body.items.map((i) => i.quarantineId)).toEqual([quarantineId]);
    expect(queueAfter.body.items[0]?.reviewState).toBe("refused");
    // No mismatch, quarantine or consent event was appended: the ledger is exactly as "Keep blocked" left it.
    expect(await householdEvents()).toEqual(eventsAfterBlock);
    // The pin is still the staged 12 January approval: nothing re-pinned it.
    expect((await ledger.getPin(HOUSEHOLD_ID, "grocery", "add_item"))?.approvedAt).toMatch(/^2026-01-12T10:30:0\d\./);
  } finally {
    await client.close().catch(() => undefined);
  }
});
