/**
 * Turns a stored `Quarantine` row (plus its sibling rows, its advisory row,
 * and — once resolved — its pin) into the `ConsentCardModel` render.ts
 * knows how to draw. One function, called from both the refusal path
 * (upstreamProxy.ts, so the card appears in the same turn as the refusal)
 * and the `ui://chaperone/consent/{quarantineId}` resource template
 * (registered in upstreamProxy.ts too), so the two paths can never disagree
 * about which of the seven states a given quarantine is in.
 */
import type { UpstreamConfig } from "@chaperone/upstream";
import type { CapabilityClass } from "@chaperone/policy";
import * as ledger from "@chaperone/ledger";
import type { ConsentCardItem, ConsentCardModel } from "@chaperone/mcp-app";
import { childLogger } from "@chaperone/logger";
import { advisoryUnavailableTotal } from "./metrics.js";
import { advisoryFor } from "./advisoryLookup.js";
import { APPROVAL_TOKEN_TTL_MS } from "./approve.js";
import { peekRevealedToken } from "./gate.js";

const log = childLogger({ component: "gateway-consent-card" });

/** Once an advisory row exists but not longer than this, absence still reads as "still working" (loading) rather than "given up" (advisory-unavailable). */
const ADVISORY_LOADING_WINDOW_MS = 8_000;

const TOKEN_ALREADY_SHOWN_PLACEHOLDER = "(already shown once — see the original consent message)";

export function upstreamLabelFor(upstreams: readonly UpstreamConfig[], upstreamId: string): string {
  return upstreams.find((u) => u.id === upstreamId)?.label ?? upstreamId;
}

function resolveApprovalToken(quarantineId: string, providedToken: string | undefined): string {
  return providedToken ?? peekRevealedToken(quarantineId) ?? TOKEN_ALREADY_SHOWN_PLACEHOLDER;
}

function isExpired(quarantine: ledger.Quarantine): boolean {
  const detectedAtMs = Date.parse(quarantine.detectedAt);
  return !Number.isFinite(detectedAtMs) || Date.now() - detectedAtMs > APPROVAL_TOKEN_TTL_MS;
}

interface AdvisoryForCard {
  summary: string;
  isFixture: boolean;
}

/** A failure here degrades the card to "no advisory yet," never to a thrown error — the advisory is decoration, not the security decision. */
async function loadAdvisory(quarantine: ledger.Quarantine): Promise<AdvisoryForCard | undefined> {
  try {
    const advisory = await advisoryFor(quarantine);
    if (advisory?.summary === undefined) {
      // No row yet (still scoring), or a row with no summary. Counted the
      // same as a read failure below: from the card's point of view both
      // are "this card renders without an advisory", which is what the
      // metric is named for. It is never a gate outcome.
      advisoryUnavailableTotal.inc({ reason: "absent" });
      return undefined;
    }
    return { summary: advisory.summary, isFixture: ledger.isFixtureAdvisory(advisory) };
  } catch (error) {
    log.warn({ error, quarantineId: quarantine.quarantineId }, "advisory read failed; rendering the card without one");
    advisoryUnavailableTotal.inc({ reason: "read_failed" });
    return undefined;
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * "12 January", or "12 January 2025" when that is not the current year.
 * UTC on purpose: the same stored instant must read as the same day on
 * every host, including a recorded demo replayed in another timezone.
 */
export function formatApprovedOn(approvedAt: string, now: number = Date.now()): string | undefined {
  const at = new Date(approvedAt);
  if (Number.isNaN(at.getTime())) {
    return undefined;
  }
  const day = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
  return at.getUTCFullYear() === new Date(now).getUTCFullYear() ? day : `${day} ${at.getUTCFullYear()}`;
}

/**
 * When the household approved the version that is still pinned — only
 * while that pin is still the "before" side of this quarantine. Read
 * failure or a moved pin just leaves the line off; it is context, not the
 * decision.
 */
async function loadApprovedOn(quarantine: ledger.Quarantine): Promise<string | undefined> {
  try {
    const pin = await ledger.getPin(quarantine.householdId, quarantine.upstreamId, quarantine.toolName);
    if (pin === undefined || pin.approvedHash !== quarantine.fromHash) {
      return undefined;
    }
    return formatApprovedOn(pin.approvedAt);
  } catch (error) {
    log.warn({ error, quarantineId: quarantine.quarantineId }, "pin read failed; rendering the card without an approval date");
    return undefined;
  }
}

function toItem(
  quarantine: ledger.Quarantine,
  upstreamLabel: string,
  approvalToken: string,
  advisory: AdvisoryForCard | undefined,
  approvedOn: string | undefined,
): ConsentCardItem {
  const before = JSON.parse(quarantine.fromCanonicalJson) as { description?: string };
  const after = JSON.parse(quarantine.toCanonicalJson) as { description?: string };
  return {
    quarantineId: quarantine.quarantineId,
    toolName: quarantine.toolName,
    upstreamLabel,
    capabilityClass: quarantine.capabilityClass as CapabilityClass,
    detectedAt: quarantine.detectedAt,
    beforeDescription: before.description ?? "",
    afterDescription: after.description ?? "",
    spans: quarantine.diffSpans,
    approvalToken,
    ...(advisory !== undefined ? { advisorySummary: advisory.summary } : {}),
    ...(advisory?.isFixture === true ? { advisorySource: "fixture" as const } : {}),
    ...(approvedOn !== undefined ? { approvedOn } : {}),
  };
}

/** The single-item states: "loading" while an advisory might still land, "advisory-unavailable" once that window has passed, "pending" once one has. */
function pendingStateFor(item: ConsentCardItem, quarantine: ledger.Quarantine, hasAdvisory: boolean): ConsentCardModel {
  if (hasAdvisory) {
    return { state: "pending", item };
  }
  const detectedAtMs = Date.parse(quarantine.detectedAt);
  const stillWaiting = Number.isFinite(detectedAtMs) && Date.now() - detectedAtMs < ADVISORY_LOADING_WINDOW_MS;
  return stillWaiting ? { state: "loading", item } : { state: "advisory-unavailable", item };
}

export interface LoadConsentCardOptions {
  /**
   * The plaintext token from *this* request's own gate decision, when this
   * call is rendering the card for the quarantine that decision just
   * (re)detected. Omitted for every other caller (a later `resources/read`,
   * or a sibling row in a batch) — those fall back to whatever
   * `peekRevealedToken` still remembers, or the placeholder if even that is
   * gone.
   */
  approvalToken?: string;
}

/**
 * Returns `undefined` only when the quarantine id itself doesn't exist for
 * this household — every other condition (expired, resolved, no advisory
 * yet, batched with siblings) is a real `ConsentCardModel` state, not an
 * error.
 */
export async function loadConsentCardModel(
  householdId: string,
  upstreams: readonly UpstreamConfig[],
  quarantineId: string,
  options: LoadConsentCardOptions = {},
): Promise<ConsentCardModel | undefined> {
  const quarantine = await ledger.getQuarantine(householdId, quarantineId);
  if (quarantine === undefined) {
    return undefined;
  }
  const label = upstreamLabelFor(upstreams, quarantine.upstreamId);

  if (quarantine.status === "approved") {
    const pin = await ledger.getPin(householdId, quarantine.upstreamId, quarantine.toolName);
    return {
      state: "approved",
      toolName: quarantine.toolName,
      upstreamLabel: label,
      newHashPrefix: pin?.approvedHash ?? quarantine.toHash,
    };
  }

  if (quarantine.status === "refused") {
    return { state: "refused", toolName: quarantine.toolName, upstreamLabel: label };
  }

  // status === "pending" from here on.
  if (isExpired(quarantine)) {
    return { state: "expired", toolName: quarantine.toolName, upstreamLabel: label, detectedAt: quarantine.detectedAt };
  }

  const siblings = (await ledger.listQuarantineByStatus("pending")).filter(
    (q) => q.householdId === householdId && q.upstreamId === quarantine.upstreamId,
  );

  if (siblings.length >= 2) {
    const items = await Promise.all(
      siblings.map(async (sibling) => {
        const [advisory, approvedOn] = await Promise.all([loadAdvisory(sibling), loadApprovedOn(sibling)]);
        const token = resolveApprovalToken(
          sibling.quarantineId,
          sibling.quarantineId === quarantineId ? options.approvalToken : undefined,
        );
        return toItem(sibling, label, token, advisory, approvedOn);
      }),
    );
    return { state: "batch", upstreamLabel: label, items };
  }

  const [advisory, approvedOn] = await Promise.all([loadAdvisory(quarantine), loadApprovedOn(quarantine)]);
  const item = toItem(quarantine, label, resolveApprovalToken(quarantineId, options.approvalToken), advisory, approvedOn);
  return pendingStateFor(item, quarantine, advisory !== undefined);
}
