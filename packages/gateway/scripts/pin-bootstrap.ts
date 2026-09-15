/**
 * `pnpm pin:bootstrap` — pins every tool currently listed by every
 * configured upstream, for the configured household. This is the trust
 * anchor gate.ts's `allow()` checks against on every request from then on:
 * before this runs, every upstream tool is UNPINNED and withheld, exactly
 * as a tool that was never reviewed should be.
 *
 * Connects to the real upstreams (via @chaperone/upstream's pool) rather
 * than hardcoding tool definitions — CLAUDE.md: never mock a boundary this
 * repo can reach for real, and a hand-typed tool definition here would only
 * ever validate itself, never the actual upstream.
 */
import { loadConfig } from "@chaperone/config";
import { getPool } from "@chaperone/upstream";
import { canonicalizeTool, classifyCapability, hashTool, type ToolDefinition } from "@chaperone/policy";
import { appendEvent, putPin } from "@chaperone/ledger";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const pool = await getPool(config.upstreams);

  try {
    const entries = await pool.listAllTools();
    if (entries.length === 0) {
      console.log("pin:bootstrap: no tools listed by any configured upstream — nothing to pin");
      return;
    }

    const actor = `resident:${config.householdId}`;

    for (const { upstreamId, tool } of entries) {
      const policyTool: ToolDefinition = {
        name: tool.name,
        inputSchema: tool.inputSchema,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
      };
      const approvedHash = hashTool(policyTool);
      const approvedCanonicalJson = canonicalizeTool(policyTool);
      const approvedAt = new Date().toISOString();
      const capabilityClass = classifyCapability(policyTool).class;

      const { eventId: consentEventId } = await appendEvent({
        householdId: config.householdId,
        type: "PIN_CREATED",
        actor,
        payload: { upstreamId, toolName: tool.name, hash: approvedHash },
      });

      await putPin({
        householdId: config.householdId,
        upstreamId,
        toolName: tool.name,
        approvedHash,
        approvedCanonicalJson,
        approvedAt,
        approvedBy: actor,
        consentEventId,
        capabilityClass,
      });

      console.log(`pinned ${upstreamId}__${tool.name} (${capabilityClass}) — ${approvedHash}`);
    }
  } finally {
    await pool.close();
  }
}

bootstrap()
  .then(() => {
    console.log("pin:bootstrap: done");
  })
  .catch((e: unknown) => {
    console.error("pin:bootstrap: failed —", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
