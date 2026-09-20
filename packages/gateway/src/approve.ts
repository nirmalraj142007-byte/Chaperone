/**
 * The `chaperone/approve_change` and `chaperone/pending_changes` request
 * path — the only code in this repo that ever turns a quarantine back into
 * a pin. No path here ever re-pins without a verified, unexpired,
 * not-already-redeemed token; each failure mode returns its own typed error
 * from the closed taxonomy rather than a shared generic one, so a client
 * (or a test) can tell "wrong token" apart from "already resolved" apart
 * from "expired."
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  ApprovalTokenExpiredError,
  InvalidApprovalTokenError,
  QuarantineAlreadyResolvedError,
  QuarantineNotFoundError,
} from "@chaperone/errors";
import * as ledger from "@chaperone/ledger";
import { clearRevealedToken } from "./gate.js";

/**
 * A quarantine's approval token is only ever valid for this long after
 * `detectedAt`. Exported so consentCard.ts's "expired" rendering state uses
 * the exact same threshold this module enforces at approve time, rather
 * than a second 24h literal that could drift out of sync with this one.
 */
export const APPROVAL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export type ApprovalDecision = "approve" | "block";

export interface ApproveResult {
  quarantineId: string;
  decision: ApprovalDecision;
  status: ledger.QuarantineStatus;
  /** Only set when `decision === "approve"` — the hash the tool is now pinned under. */
  newHash?: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Both inputs are hex sha256 digests (fixed 64 chars) — equal-length by construction unless the caller sent garbage, which the length check below still catches safely. */
function constantTimeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies `quarantineId`/`approvalToken` and, on `approve`, writes the new
 * pin and re-opens the tool; on `block`, leaves it withheld permanently for
 * this hash. Token reuse, a wrong token, an expired token, and an
 * already-resolved quarantine each throw a distinct error — there is no
 * code path here that re-pins without all three checks (exists, unexpired,
 * token matches) passing first.
 */
export async function approveChange(
  householdId: string,
  quarantineId: string,
  approvalToken: string,
  decision: ApprovalDecision,
): Promise<ApproveResult> {
  const quarantine = await ledger.getQuarantine(householdId, quarantineId);
  if (quarantine === undefined) {
    throw new QuarantineNotFoundError(`no quarantine "${quarantineId}" for this household`, { quarantineId });
  }

  if (quarantine.status !== "pending") {
    throw new QuarantineAlreadyResolvedError(
      `quarantine "${quarantineId}" was already resolved as "${quarantine.status}"`,
      { quarantineId, status: quarantine.status },
    );
  }

  const detectedAtMs = Date.parse(quarantine.detectedAt);
  if (!Number.isFinite(detectedAtMs) || Date.now() - detectedAtMs > APPROVAL_TOKEN_TTL_MS) {
    throw new ApprovalTokenExpiredError(`approval token for quarantine "${quarantineId}" has expired`, {
      quarantineId,
    });
  }

  if (!constantTimeHexEqual(sha256Hex(approvalToken), quarantine.approvalTokenHash)) {
    throw new InvalidApprovalTokenError(`invalid approval token for quarantine "${quarantineId}"`, {
      quarantineId,
    });
  }

  const resolvedAt = new Date().toISOString();
  const actor = `resident:${householdId}`;
  const status: ledger.QuarantineStatus = decision === "approve" ? "approved" : "refused";

  // The actual single-use gate: ledger.resolveQuarantine is a DynamoDB
  // conditional update (pending -> resolved) that only one concurrent
  // caller can win. The `quarantine.status !== "pending"` check above is
  // just a fast, cheap rejection for the common sequential case — it reads
  // stale data under a race, so it cannot be the enforcement point itself.
  // This call must happen before any side-effecting write below: a caller
  // that loses the race throws here and never reaches putPin/appendEvent,
  // so a replayed or concurrently-redeemed token can never produce a
  // second pin or a second ledger event.
  await ledger.resolveQuarantine(householdId, quarantineId, status, resolvedAt);

  if (decision === "approve") {
    await ledger.putPin({
      householdId,
      upstreamId: quarantine.upstreamId,
      toolName: quarantine.toolName,
      approvedHash: quarantine.toHash,
      approvedCanonicalJson: quarantine.toCanonicalJson,
      approvedAt: resolvedAt,
      approvedBy: actor,
      consentEventId: quarantine.quarantineId,
      capabilityClass: quarantine.capabilityClass,
    });
    await ledger.appendEvent({
      householdId,
      type: "APPROVED",
      actor,
      payload: { quarantineId, upstreamId: quarantine.upstreamId, toolName: quarantine.toolName },
    });
    await ledger.appendEvent({
      householdId,
      type: "REPIN",
      actor,
      payload: {
        quarantineId,
        upstreamId: quarantine.upstreamId,
        toolName: quarantine.toolName,
        approvedHash: quarantine.toHash,
      },
    });
  } else {
    await ledger.appendEvent({
      householdId,
      type: "REFUSED",
      actor,
      payload: { quarantineId, upstreamId: quarantine.upstreamId, toolName: quarantine.toolName },
    });
  }

  clearRevealedToken(quarantineId);

  return { quarantineId, decision, status, ...(decision === "approve" ? { newHash: quarantine.toHash } : {}) };
}

/** Read-only: every quarantine still open for this household, for a host to surface without the console. */
export async function listPendingChanges(householdId: string): Promise<ledger.Quarantine[]> {
  const pending = await ledger.listQuarantineByStatus("pending");
  return pending.filter((q) => q.householdId === householdId);
}
