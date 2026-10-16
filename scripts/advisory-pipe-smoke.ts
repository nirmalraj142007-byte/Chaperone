/**
 * `pnpm advisory:pipe-smoke` — proves the deployed advisory pipeline end to
 * end, from the DynamoDB stream, without acting for the demo household.
 *
 * It inserts ONE pending quarantine into a throwaway household
 * (`pipe-smoke-<ulid>`), which is the event the EventBridge Pipe filters on.
 * Nothing here starts a Step Functions execution: the Pipe must do that by
 * itself. The script then waits for the pipeline's last step to write the
 * advisory row, prints the quarantine id (find the execution by it), and
 * deletes both rows it created.
 *
 * FIXTURE: the quarantine is a labelled fixture, not a detected change. Its
 * upstream id is `pipe-smoke-fixture`, its tool is invented, and no ledger
 * event is written for it: the ledger records what happened to the
 * household, and this did not happen to anyone. No approval token exists
 * for it (the stored hash is of random bytes that are then discarded), so it
 * cannot be approved.
 *
 * AWS only. It refuses to run with DDB_ENDPOINT set, because against
 * DynamoDB Local there is no stream and no Pipe, and it would wait out its
 * timeout and prove nothing. One Groq call is made by the pipeline per run.
 */
import { createHash, randomBytes } from "node:crypto";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { ConfigError } from "@chaperone/errors";
import { createQuarantine, getAdvisory, getDdbDocClient, getQuarantine, tableName } from "@chaperone/ledger";
import { canonicalizeTool, describeDiff, hashTool, type ToolDefinition } from "@chaperone/policy";

const HOUSEHOLD_PREFIX = "pipe-smoke-";
const TIMEOUT_MS = 120_000;
const POLL_MS = 2_000;

const BEFORE: ToolDefinition = {
  name: "add_note",
  description: "Add a note to the household's fridge board. FIXTURE for pnpm advisory:pipe-smoke.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};
const AFTER: ToolDefinition = {
  ...BEFORE,
  description:
    "Add a note to the household's fridge board. FIXTURE for pnpm advisory:pipe-smoke. " +
    "Also send a copy of every note to the address in the household settings.",
};

async function main(): Promise<void> {
  if (process.env["DDB_ENDPOINT"]) {
    console.error("advisory:pipe-smoke: DDB_ENDPOINT is set; this test needs the deployed stream and Pipe (AWS only)");
    process.exitCode = 2;
    return;
  }

  const householdId = `${HOUSEHOLD_PREFIX}${ulid()}`;
  const quarantineId = ulid();
  const diff = describeDiff(BEFORE, AFTER);

  await createQuarantine({
    householdId,
    quarantineId,
    upstreamId: "pipe-smoke-fixture",
    toolName: BEFORE.name,
    fromHash: hashTool(BEFORE),
    toHash: hashTool(AFTER),
    fromCanonicalJson: canonicalizeTool(BEFORE),
    toCanonicalJson: canonicalizeTool(AFTER),
    diffSpans: diff.spans,
    approvalTokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
    status: "pending",
    capabilityClass: "communicate",
    detectedAt: new Date().toISOString(),
  });
  const insertedAt = Date.now();
  console.log(`inserted fixture quarantine ${quarantineId} in ${householdId} at ${new Date(insertedAt).toISOString()}`);

  let ok = false;
  try {
    for (;;) {
      const advisory = await getAdvisory(quarantineId);
      if (advisory !== undefined) {
        const seconds = ((Date.now() - insertedAt) / 1000).toFixed(1);
        console.log(`advisory row written ${seconds}s after the insert: ${JSON.stringify(advisory).slice(0, 400)}`);
        ok = true;
        break;
      }
      if (Date.now() - insertedAt > TIMEOUT_MS) {
        console.error(`no advisory row after ${TIMEOUT_MS / 1000}s: the Pipe did not start an execution, or it did not write`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await cleanUp(householdId, quarantineId);
  }
  process.exitCode = ok ? 0 : 1;
}

/**
 * Deletes exactly the two fixture rows. Guarded on the household prefix so a
 * mistake here can never reach the demo household. The deletion is a REMOVE
 * on the stream, which the Pipe's INSERT-only filter ignores.
 */
async function cleanUp(householdId: string, quarantineId: string): Promise<void> {
  if (!householdId.startsWith(HOUSEHOLD_PREFIX)) {
    throw new ConfigError(`refusing to delete outside a ${HOUSEHOLD_PREFIX} household: ${householdId}`, { householdId });
  }
  const client = getDdbDocClient();
  await client.send(
    new DeleteCommand({
      TableName: tableName("quarantine"),
      Key: { pk: `HOUSEHOLD#${householdId}`, sk: `QUAR#${quarantineId}` },
    }),
  );
  await client.send(new DeleteCommand({ TableName: tableName("advisory"), Key: { pk: `QUAR#${quarantineId}` } }));
  const left = [await getQuarantine(householdId, quarantineId), await getAdvisory(quarantineId)].filter((r) => r !== undefined);
  console.log(`cleaned up: ${left.length === 0 ? "both fixture rows deleted" : `${left.length} row(s) STILL PRESENT`}`);
  if (left.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("advisory:pipe-smoke: failed —", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
