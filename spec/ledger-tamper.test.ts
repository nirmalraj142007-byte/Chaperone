/**
 * Ledger tamper regression — against real DynamoDB Local, not a mock.
 *
 * The same tamper-and-restore pattern as Phase 3's acceptance test: an
 * attacker with raw table access mutates or removes an item directly with
 * the `aws dynamodb` CLI (outside the repo layer, which offers no update or
 * delete), `verifyChain` must report the break at the right index, and
 * restoring the item must make the chain verify again.
 *
 * The three vectors are the ones found while building the console
 * (Phase 14): editing an event's `type`, editing its `actor`, and deleting
 * an event whose payload collides with its neighbour's. All three passed
 * verification while the stored hash covered `payload` alone.
 *
 * Each run writes to its own throwaway household partition, so the demo
 * household's chain is never touched; the partition is removed afterwards.
 *
 * Needs `docker compose up -d ddb` and `pnpm ddb:migrate`.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DDB_ENDPOINT = process.env["DDB_ENDPOINT"] ?? "http://localhost:8000";
const TABLE = `${process.env["DDB_TABLE_PREFIX"] ?? "chaperone"}-ledger-event`;
const HOUSEHOLD = `tamper-test-${Date.now()}`;
const PK = `HOUSEHOLD#${HOUSEHOLD}`;

// loadConfig() needs these before the ledger package is first imported.
process.env["DDB_ENDPOINT"] = DDB_ENDPOINT;
process.env["CHAPERONE_UPSTREAMS"] ??= JSON.stringify([{ id: "grocery", url: "http://localhost:4000/mcp", label: "Grocery" }]);
process.env["AWS_ACCESS_KEY_ID"] ??= "local";
process.env["AWS_SECRET_ACCESS_KEY"] ??= "local";
process.env["AWS_REGION"] ??= "us-east-1";

const { appendEvent, verifyChain } = await import("@chaperone/ledger");

/** Runs `aws dynamodb <args>` against DynamoDB Local — the raw-access attacker. */
function aws(...args: string[]): string {
  return execFileSync("aws", ["dynamodb", ...args, "--endpoint-url", DDB_ENDPOINT, "--output", "json"], {
    encoding: "utf8",
    env: process.env,
  });
}

function key(sk: string): string {
  return JSON.stringify({ pk: { S: PK }, sk: { S: sk } });
}

function setString(sk: string, attribute: string, value: string): void {
  aws(
    "update-item",
    "--table-name", TABLE,
    "--key", key(sk),
    "--update-expression", "SET #a = :v",
    "--expression-attribute-names", JSON.stringify({ "#a": attribute }),
    "--expression-attribute-values", JSON.stringify({ ":v": { S: value } }),
  );
}

const events: Array<{ sk: string; type: string; actor: string }> = [];

beforeAll(async () => {
  // Index 1 and 2 carry byte-identical payloads — the shape TOOL_QUARANTINED
  // and CONSENT_SHOWN really share in gate.ts — which is what let a deletion
  // of index 2 slip past the payload-only hash.
  const colliding = { upstreamId: "grocery", toolName: "add_item", quarantineId: "Q-TAMPER" };
  const script = [
    { type: "PIN_CREATED", actor: "resident:tamper", payload: { upstreamId: "grocery", toolName: "add_item", hash: "sha256:aa" } },
    { type: "TOOL_QUARANTINED", actor: "system:gateway", payload: colliding },
    { type: "CONSENT_SHOWN", actor: "system:gateway", payload: colliding },
    { type: "APPROVED", actor: "resident:tamper", payload: { upstreamId: "grocery", toolName: "add_item", quarantineId: "Q-TAMPER" , decision: "approve" } },
  ] as const;
  for (const e of script) {
    const { eventId } = await appendEvent({ householdId: HOUSEHOLD, type: e.type, actor: e.actor, payload: { ...e.payload } });
    events.push({ sk: eventId, type: e.type, actor: e.actor });
  }
});

afterAll(() => {
  for (const e of events) {
    aws("delete-item", "--table-name", TABLE, "--key", key(e.sk));
  }
});

describe("ledger tamper regression (real DynamoDB Local)", () => {
  it("an untouched chain verifies", async () => {
    await expect(verifyChain(HOUSEHOLD)).resolves.toEqual({ ok: true, count: 4 });
  });

  it("editing an event's type is detected at that index, and restoring it verifies again", async () => {
    const target = events[3]!;
    setString(target.sk, "type", "REFUSED");
    try {
      await expect(verifyChain(HOUSEHOLD)).resolves.toMatchObject({ ok: false, index: 3, brokenSk: target.sk });
    } finally {
      setString(target.sk, "type", target.type);
    }
    await expect(verifyChain(HOUSEHOLD)).resolves.toEqual({ ok: true, count: 4 });
  });

  it("editing an event's actor is detected at that index, and restoring it verifies again", async () => {
    const target = events[1]!;
    setString(target.sk, "actor", "resident:someone-else");
    try {
      await expect(verifyChain(HOUSEHOLD)).resolves.toMatchObject({ ok: false, index: 1, brokenSk: target.sk });
    } finally {
      setString(target.sk, "actor", target.actor);
    }
    await expect(verifyChain(HOUSEHOLD)).resolves.toEqual({ ok: true, count: 4 });
  });

  it("deleting an event whose payload collides with its neighbour's is detected, and re-putting it verifies again", async () => {
    const victim = events[2]!;
    const successor = events[3]!;
    const saved = JSON.parse(aws("get-item", "--table-name", TABLE, "--key", key(victim.sk), "--consistent-read")) as {
      Item: Record<string, unknown>;
    };
    expect(saved.Item).toBeDefined();
    aws("delete-item", "--table-name", TABLE, "--key", key(victim.sk));
    try {
      // With the victim gone, its successor now sits at index 2 and no longer links to what precedes it.
      await expect(verifyChain(HOUSEHOLD)).resolves.toMatchObject({ ok: false, index: 2, brokenSk: successor.sk });
    } finally {
      aws("put-item", "--table-name", TABLE, "--item", JSON.stringify(saved.Item));
    }
    await expect(verifyChain(HOUSEHOLD)).resolves.toEqual({ ok: true, count: 4 });
  });
});
