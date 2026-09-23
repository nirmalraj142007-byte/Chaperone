/**
 * The staged history the demo starts from: a household that approved the
 * grocery server's tools on 12 January 2026.
 *
 * THIS IS A FIXTURE. No household approved anything on that date; the demo
 * needs a resident who has been living with these tools for a while so the
 * consent card can say "You approved this on 12 January". Everything here
 * is labelled that way where it is stored and where it is shown:
 *
 *   - each PIN_CREATED event's payload carries `staged: true` and a note
 *     saying so, and the ledger console prints payloads;
 *   - the events are timestamped 12 January, not now. That is the whole
 *     point of staging, and it is the one place in the repo that writes a
 *     ledger event with a caller-chosen time, which is why it lives here
 *     and not in packages/ledger (appendEvent always stamps the real time,
 *     and the gateway imports that package).
 *
 * The events still form a valid hash chain: `hashEvent` is the ledger's own
 * function, and demo:reset finishes by running `verifyChain` over them. If
 * this item layout ever drifts from ledgerEvent.ts's, that check fails.
 * Events written after these (by the gate, live) chain onto the last one.
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import {
  GENESIS_EVENT_HASH,
  getDdbDocClient,
  hashEvent,
  putPin,
  tableName,
  type StoredLedgerEvent,
} from "@chaperone/ledger";
import { canonicalizeTool, classifyCapability, CLASSIFIER_VERSION, hashTool, type ToolDefinition } from "@chaperone/policy";

/** The instant the staged household "approved" its tools. 10:30 UTC reads as 12 January in every timezone from UTC-10:30 to UTC+13:30. */
export const STAGED_APPROVED_AT = "2026-01-12T10:30:00.000Z";

export const STAGED_NOTE =
  "STAGED FIXTURE: this approval was written by `pnpm demo:reset` to give the offline demo a household with history. " +
  "It did not happen on this date.";

export interface StagedPin {
  upstreamId: string;
  toolName: string;
  hash: string;
  capabilityClass: string;
  approvedAt: string;
}

/** Writes one staged PIN_CREATED event plus its pin per tool, chained from genesis. Returns what it pinned. */
export async function stageApprovedPins(
  householdId: string,
  tools: ReadonlyArray<{ upstreamId: string; tool: ToolDefinition }>,
): Promise<StagedPin[]> {
  const actor = `resident:${householdId}`;
  const startMs = Date.parse(STAGED_APPROVED_AT);
  const staged: StagedPin[] = [];
  let prevEventHash = GENESIS_EVENT_HASH;

  for (const [index, { upstreamId, tool }] of tools.entries()) {
    // One second apart, so each event's ULID (which encodes its time) sorts in write order.
    const atMs = startMs + index * 1000;
    const ts = new Date(atMs).toISOString();
    const eventId = ulid(atMs);
    const hash = hashTool(tool);
    const capabilityClass = classifyCapability(tool, CLASSIFIER_VERSION).class;
    const payload = { upstreamId, toolName: tool.name, hash, staged: true, note: STAGED_NOTE };
    const eventHash = hashEvent({ type: "PIN_CREATED", actor, ts, payload, prevEventHash });

    await getDdbDocClient().send(
      new PutCommand({
        TableName: tableName("ledger-event"),
        Item: {
          pk: `HOUSEHOLD#${householdId}`,
          sk: eventId,
          type: "PIN_CREATED",
          actor,
          payload,
          eventHash,
          prevEventHash,
          ts,
        } satisfies StoredLedgerEvent,
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
    prevEventHash = eventHash;

    await putPin({
      householdId,
      upstreamId,
      toolName: tool.name,
      approvedHash: hash,
      approvedCanonicalJson: canonicalizeTool(tool),
      approvedAt: ts,
      approvedBy: actor,
      consentEventId: eventId,
      capabilityClass,
    });

    staged.push({ upstreamId, toolName: tool.name, hash, capabilityClass, approvedAt: ts });
  }

  return staged;
}
