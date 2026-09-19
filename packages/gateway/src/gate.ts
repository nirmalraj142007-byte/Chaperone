/**
 * Plumbing around Phase 2's `allow()` — the pure hash comparison stays the
 * entire security decision; everything here is I/O the pure function is not
 * allowed to touch itself: reading the pin, opening a quarantine on first
 * mismatch, minting the one-time approval token, and writing the ledger
 * trail. Every storage call is wrapped so a read or write failure denies the
 * tool rather than allowing it — CLAUDE.md's fail-closed rule — and nothing
 * here decides *whether* a tool is allowed beyond calling `allow()` itself.
 */
import { randomBytes, createHash } from "node:crypto";
import { ulid } from "ulid";
import {
  allow,
  canonicalizeTool,
  describeDiff,
  type ToolDefinition as PolicyToolDefinition,
} from "@chaperone/policy";
import type { ToolDefinition as WireToolDefinition } from "@chaperone/upstream";
import * as ledger from "@chaperone/ledger";
import { childLogger } from "@chaperone/logger";

const log = childLogger({ component: "gateway-gate" });

/** Never "model" — CLAUDE.md: an advisory model is never the actor of record for a ledger event. */
const GATE_ACTOR = "system:gateway";

export interface GateDecision {
  tool: WireToolDefinition;
  upstreamId: string;
  allowed: boolean;
  reason?: "HASH_MISMATCH" | "UNPINNED";
  quarantineId?: string;
  /**
   * True only for the single caller whose gate check first discovered this
   * mismatch and created the quarantine row this request — never set on a
   * decision that found an already-open quarantine. Callers use this to
   * decide whether to fire `notifications/tools/list_changed` and whether
   * `approvalToken` is present at all.
   */
  newlyQuarantined?: boolean;
  /** Only ever set alongside `newlyQuarantined: true` — see gate.ts's module doc on why this can't be re-derived later. */
  approvalToken?: string;
  /**
   * True when this exact change (same pinned hash → same current hash) was
   * already refused by the household. `quarantineId` then names that
   * refused quarantine; no new quarantine, token, or ledger event exists.
   */
  previouslyRefused?: boolean;
}

function toPolicyTool(tool: WireToolDefinition): PolicyToolDefinition {
  return {
    name: tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function generateApprovalToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256Hex(token) };
}

/**
 * The plaintext token exists nowhere in storage — only its sha256 does — so
 * it can only ever be handed back from the exact moment it's minted. This
 * process-local map is that one moment's memory, kept alive for as long as
 * the quarantine stays open so both the request that tripped the mismatch
 * and a later `chaperone/pending_changes` poll can still surface it. A
 * gateway restart before the resident acts loses it — an accepted, honest
 * limitation of "the token is never persisted," not a bug to work around by
 * persisting it after all.
 */
const revealedTokens = new Map<string, string>();

export function peekRevealedToken(quarantineId: string): string | undefined {
  return revealedTokens.get(quarantineId);
}

export function clearRevealedToken(quarantineId: string): void {
  revealedTokens.delete(quarantineId);
}

/**
 * Single hard-coded household (CLAUDE.md: multi-tenancy is out of scope) —
 * a full scan of the (demo-scale) pending partition, filtered in process,
 * is simpler and more honest than standing up a second GSI for a lookup
 * this product will only ever run against one household's data.
 */
async function findOpenQuarantine(
  householdId: string,
  upstreamId: string,
  toolName: string,
  toHash: string,
): Promise<ledger.Quarantine | undefined> {
  const pending = await ledger.listQuarantineByStatus("pending");
  return pending.find(
    (q) =>
      q.householdId === householdId &&
      q.upstreamId === upstreamId &&
      q.toolName === toolName &&
      q.toHash === toHash,
  );
}

/**
 * A household's "Keep blocked" is final for the exact transition it was
 * shown: same tool, same pinned hash, same current hash. Without this
 * check, the next `tools/list` found no *pending* quarantine and opened a
 * fresh one with a fresh token, asking again about a change the resident
 * had already refused. A different current hash (the upstream changed
 * again) or a different pinned hash (the household re-pinned something
 * else since) is a genuinely new change and still opens a new review.
 */
async function findRefusal(
  householdId: string,
  upstreamId: string,
  toolName: string,
  fromHash: string,
  toHash: string,
): Promise<ledger.Quarantine | undefined> {
  const refused = await ledger.listQuarantineByStatus("refused");
  return refused.find(
    (q) =>
      q.householdId === householdId &&
      q.upstreamId === upstreamId &&
      q.toolName === toolName &&
      q.fromHash === fromHash &&
      q.toHash === toHash,
  );
}

interface QuarantineOutcome {
  quarantineId: string;
  newlyQuarantined: boolean;
  approvalToken?: string;
  previouslyRefused?: boolean;
}

/**
 * Idempotent: a second caller hitting the same (upstream, tool, new-hash)
 * transition reuses the quarantine the first caller opened rather than
 * minting a second token or re-appending the detection events. Returns
 * `undefined` only when storage itself failed — the tool stays withheld
 * either way (the caller already decided that from `allow()`), this only
 * governs whether a reviewable quarantine record exists.
 */
async function ensureQuarantine(
  householdId: string,
  upstreamId: string,
  pin: ledger.Pin,
  current: PolicyToolDefinition,
  currentHash: string,
): Promise<QuarantineOutcome | undefined> {
  try {
    const existing = await findOpenQuarantine(householdId, upstreamId, pin.toolName, currentHash);
    if (existing) {
      return { quarantineId: existing.quarantineId, newlyQuarantined: false };
    }

    // Checked after the open-quarantine lookup, before anything is written:
    // a refused transition writes no quarantine, no token, no ledger event.
    const refusal = await findRefusal(householdId, upstreamId, pin.toolName, pin.approvedHash, currentHash);
    if (refusal) {
      log.debug(
        { upstreamId, toolName: pin.toolName, quarantineId: refusal.quarantineId, toHash: currentHash.slice(7, 19) },
        "change already refused by the household; withholding without re-asking",
      );
      return { quarantineId: refusal.quarantineId, newlyQuarantined: false, previouslyRefused: true };
    }

    const before = JSON.parse(pin.approvedCanonicalJson) as PolicyToolDefinition;
    const diff = describeDiff(before, current);
    const { token, tokenHash } = generateApprovalToken();
    const quarantineId = ulid();
    const detectedAt = new Date().toISOString();

    await ledger.createQuarantine({
      householdId,
      quarantineId,
      upstreamId,
      toolName: pin.toolName,
      fromHash: pin.approvedHash,
      toHash: currentHash,
      fromCanonicalJson: pin.approvedCanonicalJson,
      toCanonicalJson: canonicalizeTool(current),
      diffSpans: diff.spans,
      approvalTokenHash: tokenHash,
      status: "pending",
      // From the pin, not reclassified from the (possibly adversarial)
      // current text — CLAUDE.md's "capabilityClass from the pin".
      capabilityClass: pin.capabilityClass,
      detectedAt,
    });

    await ledger.appendEvent({
      householdId,
      type: "MISMATCH_DETECTED",
      actor: GATE_ACTOR,
      payload: { upstreamId, toolName: pin.toolName, fromHash: pin.approvedHash, toHash: currentHash },
    });
    await ledger.appendEvent({
      householdId,
      type: "TOOL_QUARANTINED",
      actor: GATE_ACTOR,
      payload: { upstreamId, toolName: pin.toolName, quarantineId },
    });
    await ledger.appendEvent({
      householdId,
      type: "CONSENT_SHOWN",
      actor: GATE_ACTOR,
      payload: { upstreamId, toolName: pin.toolName, quarantineId },
    });

    revealedTokens.set(quarantineId, token);
    return { quarantineId, newlyQuarantined: true, approvalToken: token };
  } catch (error) {
    log.error(
      { error, upstreamId, toolName: pin.toolName },
      "failed to record quarantine; tool stays withheld but no reviewable token could be issued",
    );
    return undefined;
  }
}

async function gateOne(
  householdId: string,
  upstreamId: string,
  toolName: string,
  tool: WireToolDefinition,
): Promise<GateDecision> {
  let pin: ledger.Pin | undefined;
  try {
    pin = await ledger.getPin(householdId, upstreamId, toolName);
  } catch (error) {
    log.error({ error, upstreamId, toolName }, "pin read failed; failing closed");
    return { tool, upstreamId, allowed: false };
  }

  const verdict = allow(toPolicyTool(tool), pin?.approvedHash ?? null);

  if (verdict.allowed) {
    return { tool, upstreamId, allowed: true };
  }

  if (verdict.reason === "UNPINNED" || pin === undefined) {
    return { tool, upstreamId, allowed: false, reason: "UNPINNED" };
  }

  const quarantine = await ensureQuarantine(householdId, upstreamId, pin, toPolicyTool(tool), verdict.currentHash);
  if (quarantine === undefined) {
    return { tool, upstreamId, allowed: false, reason: "HASH_MISMATCH" };
  }
  return {
    tool,
    upstreamId,
    allowed: false,
    reason: "HASH_MISMATCH",
    quarantineId: quarantine.quarantineId,
    newlyQuarantined: quarantine.newlyQuarantined,
    ...(quarantine.approvalToken !== undefined ? { approvalToken: quarantine.approvalToken } : {}),
    ...(quarantine.previouslyRefused === true ? { previouslyRefused: true } : {}),
  };
}

export async function gateToolList(
  householdId: string,
  upstreamTools: Array<{ upstreamId: string; tool: WireToolDefinition }>,
): Promise<GateDecision[]> {
  const decisions: GateDecision[] = [];
  for (const { upstreamId, tool } of upstreamTools) {
    decisions.push(await gateOne(householdId, upstreamId, tool.name, tool));
  }
  return decisions;
}

export async function gateToolCall(
  householdId: string,
  upstreamId: string,
  toolName: string,
  current: WireToolDefinition,
): Promise<GateDecision> {
  return gateOne(householdId, upstreamId, toolName, current);
}
