/**
 * "Keep blocked" is final for the exact change it was shown — against real
 * DynamoDB Local, not a mock.
 *
 * Before this fix, gate.ts only looked for a *pending* quarantine before
 * opening one, so after a resident refused a change, the very next
 * tools/list opened a fresh quarantine with a fresh token for the identical
 * (fromHash → toHash) transition, asking again about something already
 * answered (found in the Phase 14 console session).
 *
 * The gateway and demo upstream run in-process so this file can mutate the
 * upstream without racing the other stack suites, which share the compose
 * stack's demo upstream. The ledger, pin, and quarantine repos are the real
 * ones, talking to DynamoDB Local, under a throwaway household id; that
 * household's rows are removed afterwards with the `aws` CLI.
 *
 * Needs `docker compose up -d ddb` and `pnpm ddb:migrate`.
 */
import { execFileSync } from "node:child_process";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const DDB_ENDPOINT = process.env["DDB_ENDPOINT"] ?? "http://localhost:8000";
const PREFIX = process.env["DDB_TABLE_PREFIX"] ?? "chaperone";
const HOUSEHOLD = `refusal-test-${Date.now()}`;
const PK = `HOUSEHOLD#${HOUSEHOLD}`;

// loadConfig() needs these before the ledger package is first imported.
process.env["DDB_ENDPOINT"] = DDB_ENDPOINT;
process.env["CHAPERONE_UPSTREAMS"] ??= JSON.stringify([{ id: "grocery", url: "http://localhost:4000/mcp", label: "Grocery" }]);
process.env["AWS_ACCESS_KEY_ID"] ??= "local";
process.env["AWS_SECRET_ACCESS_KEY"] ??= "local";
process.env["AWS_REGION"] ??= "us-east-1";

const ledger = await import("@chaperone/ledger");
const { canonicalizeTool, classifyCapability, hashTool, REFUSAL_TOOL_CHANGED } = await import("@chaperone/policy");
const { getPool } = await import("@chaperone/upstream");
const { buildApp: buildDemoUpstreamApp, resetControlStateForTests } = await import("@chaperone/demo-upstream");
const { buildApp: buildGatewayApp } = await import("@chaperone/gateway");

type Pool = Awaited<ReturnType<typeof getPool>>;
type TextBlock = { type: string; text?: string };

let upstreamServer: HttpServer;
let gatewayServer: HttpServer;
let upstreamUrl: string;
let gatewayUrl: string;
let pool: Pool;

async function listen(app: express.Express): Promise<{ server: HttpServer; url: string }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function connect(): Promise<Client> {
  const client = new Client({ name: "refusal-final-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`)) as Transport);
  return client;
}

async function householdQuarantines(): Promise<import("@chaperone/ledger").Quarantine[]> {
  const all = await Promise.all((["pending", "approved", "refused"] as const).map((s) => ledger.listQuarantineByStatus(s)));
  return all.flat().filter((q) => q.householdId === HOUSEHOLD);
}

function aws(...args: string[]): string {
  return execFileSync("aws", ["dynamodb", ...args, "--endpoint-url", DDB_ENDPOINT, "--output", "json"], {
    encoding: "utf8",
    env: process.env,
  });
}

beforeAll(async () => {
  resetControlStateForTests();
  const upstreamListen = await listen(buildDemoUpstreamApp());
  upstreamServer = upstreamListen.server;
  upstreamUrl = upstreamListen.url;
  const upstreams = [{ id: "grocery", url: `${upstreamUrl}/mcp`, label: "Grocery" }];
  pool = await getPool(upstreams);

  // The same pinning pin:bootstrap does, for this household only.
  for (const { upstreamId, tool } of await pool.listAllTools()) {
    const policyTool = {
      name: tool.name,
      inputSchema: tool.inputSchema,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
    };
    const { eventId } = await ledger.appendEvent({
      householdId: HOUSEHOLD,
      type: "PIN_CREATED",
      actor: `resident:${HOUSEHOLD}`,
      payload: { upstreamId, toolName: tool.name, hash: hashTool(policyTool) },
    });
    await ledger.putPin({
      householdId: HOUSEHOLD,
      upstreamId,
      toolName: tool.name,
      approvedHash: hashTool(policyTool),
      approvedCanonicalJson: canonicalizeTool(policyTool),
      approvedAt: new Date().toISOString(),
      approvedBy: `resident:${HOUSEHOLD}`,
      consentEventId: eventId,
      capabilityClass: classifyCapability(policyTool).class,
    });
  }

  const gatewayListen = await listen(buildGatewayApp(pool, upstreams, ["http://localhost:*"], HOUSEHOLD, false));
  gatewayServer = gatewayListen.server;
  gatewayUrl = gatewayListen.url;
});

afterAll(async () => {
  resetControlStateForTests();
  await pool.close();
  gatewayServer.closeAllConnections();
  upstreamServer.closeAllConnections();
  await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  // Remove this household's rows so repeated runs don't accumulate in DynamoDB Local.
  for (const table of ["ledger-event", "pin", "quarantine"]) {
    const { Items } = JSON.parse(
      aws(
        "query",
        "--table-name", `${PREFIX}-${table}`,
        "--key-condition-expression", "pk = :p",
        "--expression-attribute-values", JSON.stringify({ ":p": { S: PK } }),
        "--projection-expression", "pk, sk",
      ),
    ) as { Items: Array<Record<string, unknown>> };
    for (const item of Items) {
      aws("delete-item", "--table-name", `${PREFIX}-${table}`, "--key", JSON.stringify(item));
    }
  }
});

describe("a refused change stays refused (real DynamoDB Local)", () => {
  it("refuse once, then two more tools/list calls open no second quarantine and mint no second token", async () => {
    const client = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("grocery__add_item");

    await fetch(`${upstreamUrl}/control/mutate`, { method: "POST" });

    // Trip the gate and take the one-time token from the refusal's consent card.
    const refusal = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
    const card = (refusal.content as TextBlock[])[1]?.text ?? "";
    const quarantineId = /quarantineId=(\S+)/.exec(card)?.[1];
    const approvalToken = /approvalToken=(\S+)/.exec(card)?.[1];
    expect(quarantineId).toBeDefined();
    expect(approvalToken).toBeDefined();

    const blocked = await client.callTool({
      name: "chaperone/approve_change",
      arguments: { quarantineId, approvalToken, decision: "block" },
    });
    expect(blocked.isError).toBeFalsy();
    expect((blocked.content as TextBlock[])[0]?.text).toContain("refused");

    const quarantinesAfterRefusal = await householdQuarantines();
    const eventsAfterRefusal = await ledger.listEvents(HOUSEHOLD);
    expect(quarantinesAfterRefusal).toHaveLength(1);
    expect(quarantinesAfterRefusal[0]).toMatchObject({ quarantineId, status: "refused" });
    expect(eventsAfterRefusal.at(-1)?.type).toBe("REFUSED");

    // The two calls the resident should not be asked again on.
    for (let i = 0; i < 2; i++) {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("grocery__add_item");
    }

    const quarantinesAfter = await householdQuarantines();
    expect(quarantinesAfter).toHaveLength(1);
    expect(quarantinesAfter.filter((q) => q.status === "pending")).toHaveLength(0);
    expect(quarantinesAfter[0]?.approvalTokenHash).toBe(quarantinesAfterRefusal[0]?.approvalTokenHash);
    expect((await ledger.listEvents(HOUSEHOLD)).map((e) => e.sk)).toEqual(eventsAfterRefusal.map((e) => e.sk));
    expect((await client.callTool({ name: "chaperone/pending_changes", arguments: {} })).content).toEqual([
      { type: "text", text: "No tool-definition changes are currently pending review." },
    ]);

    // A direct call still gets the same frozen refusal, now carrying the
    // refused card with no token, and still writes nothing.
    const again = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
    const blocks = again.content as TextBlock[];
    expect(again.isError).toBe(true);
    expect(blocks[0]?.text).toBe(REFUSAL_TOOL_CHANGED);
    expect(blocks.map((b) => b.text ?? "").join("\n")).not.toMatch(/approvalToken=/);
    expect(await householdQuarantines()).toHaveLength(1);
    expect((await ledger.listEvents(HOUSEHOLD)).length).toBe(eventsAfterRefusal.length);

    await expect(ledger.verifyChain(HOUSEHOLD)).resolves.toEqual({ ok: true, count: eventsAfterRefusal.length });
    await client.close();
  });
});
