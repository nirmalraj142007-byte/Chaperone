import { canonicalizeTool, hashTool, type ToolDefinition } from "@chaperone/policy";
import { loadConfig } from "@chaperone/config";
import { appendEvent } from "../src/repos/ledgerEvent.js";
import { putPin } from "../src/repos/pin.js";

const UPSTREAM_ID = "grocery-demo";
const APPROVED_BY = "resident:demo";

const READ_TOOL: ToolDefinition = {
  name: "list_shopping_list",
  description: "Lists the items currently on the household shopping list.",
  inputSchema: { type: "object", properties: {} },
};

const TRANSACT_TOOL: ToolDefinition = {
  name: "checkout_shopping_list",
  description:
    "Places an order for the items on the shopping list and charges the household's saved payment method.",
  inputSchema: {
    type: "object",
    properties: { confirm: { type: "boolean" } },
    required: ["confirm"],
  },
};

async function pinTool(
  householdId: string,
  tool: ToolDefinition,
  capabilityClass: "read" | "transact",
): Promise<void> {
  const approvedHash = hashTool(tool);
  const approvedCanonicalJson = canonicalizeTool(tool);
  const approvedAt = new Date().toISOString();

  const { eventId: consentEventId } = await appendEvent({
    householdId,
    type: "CONSENT_SHOWN",
    actor: `household:${householdId}`,
    payload: { upstreamId: UPSTREAM_ID, toolName: tool.name, hash: approvedHash },
  });

  await appendEvent({
    householdId,
    type: "APPROVED",
    actor: APPROVED_BY,
    payload: { upstreamId: UPSTREAM_ID, toolName: tool.name, hash: approvedHash, consentEventId },
  });

  await putPin({
    householdId,
    upstreamId: UPSTREAM_ID,
    toolName: tool.name,
    approvedHash,
    approvedCanonicalJson,
    approvedAt,
    approvedBy: APPROVED_BY,
    consentEventId,
    capabilityClass,
  });

  await appendEvent({
    householdId,
    type: "PIN_CREATED",
    actor: APPROVED_BY,
    payload: { upstreamId: UPSTREAM_ID, toolName: tool.name, hash: approvedHash, consentEventId },
  });

  console.log(`pinned ${tool.name} (${capabilityClass}) — ${approvedHash}`);
}

async function seed(): Promise<void> {
  const { householdId } = loadConfig();
  await pinTool(householdId, READ_TOOL, "read");
  await pinTool(householdId, TRANSACT_TOOL, "transact");
}

seed()
  .then(() => {
    console.log("seed: done");
  })
  .catch((e: unknown) => {
    console.error("seed: failed —", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
