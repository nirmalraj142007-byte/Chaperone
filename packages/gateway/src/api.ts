/**
 * Read-only JSON endpoints for packages/console, under `/api/*`. The
 * browser gets these instead of AWS credentials. Nothing in this module
 * writes — no pin, no quarantine status, no ledger event. The console's one
 * mutating action (approve/block) goes through `chaperone/approve_change`
 * over `/mcp`, the same token-checked path as the consent card, so there is
 * no second approval mechanism for this file to accidentally become.
 *
 * Every handler degrades a storage failure to 503 with a JSON error body.
 * That is a statement that the *view* is unavailable; it never implies a
 * tool is allowed — the gate in gate.ts fails closed independently of
 * anything served here.
 *
 * The plaintext approval token is never served, even though this process
 * still remembers it (gate.ts's `peekRevealedToken`). A GET that returned
 * it would turn a read endpoint into an approval capability. Only the
 * boolean `tokenHeld` is exposed, so the console can say "the gateway
 * restarted, this token is gone" rather than letting a resident paste into
 * a form that can never succeed.
 */
import { Router, type Request, type Response } from "express";
import * as ledger from "@chaperone/ledger";
import type { UpstreamConfig } from "@chaperone/upstream";
import { childLogger } from "@chaperone/logger";
import { APPROVAL_TOKEN_TTL_MS } from "./approve.js";
import { peekRevealedToken } from "./gate.js";
import { upstreamLabelFor } from "./consentCard.js";

const log = childLogger({ component: "gateway-api" });

/** `pending` split into still-actionable and past the token TTL — the same threshold approve.ts enforces. */
export type ReviewState = "pending" | "expired" | "approved" | "refused";

export interface QueueRow {
  quarantineId: string;
  toolName: string;
  upstreamId: string;
  upstreamLabel: string;
  capabilityClass: string;
  detectedAt: string;
  resolvedAt?: string;
  reviewState: ReviewState;
  /** `null` = no advisory row. Unscored is surfaced first, never treated as low risk. */
  advisory: { score: number; modelId: string } | null;
}

export interface ApiLedgerEvent {
  /** Position in the full chain — the same index verifyChain() reports on a break. */
  index: number;
  sk: string;
  ts: string;
  type: ledger.LedgerEventType;
  actor: string;
  eventHash: string;
  prevEventHash: string;
  payload: Record<string, unknown>;
}

export interface PinnedVersion {
  hash: string;
  approvedAt: string;
  approvedBy: string;
  /** The ledger event that recorded this approval, when one is found. */
  eventSk?: string;
}

const QUARANTINE_STATUSES: readonly ledger.QuarantineStatus[] = ["pending", "approved", "refused"];
const REVIEW_STATES: readonly ReviewState[] = ["pending", "expired", "approved", "refused"];

export function reviewStateOf(q: Pick<ledger.Quarantine, "status" | "detectedAt">, nowMs: number): ReviewState {
  if (q.status !== "pending") {
    return q.status;
  }
  const detectedAtMs = Date.parse(q.detectedAt);
  return Number.isFinite(detectedAtMs) && nowMs - detectedAtMs <= APPROVAL_TOKEN_TTL_MS ? "pending" : "expired";
}

/**
 * Unscored first (an unscored item is not a safe item), then advisory score
 * descending; ties, and the unscored group itself, newest detection first.
 */
export function sortQueue(rows: readonly QueueRow[]): QueueRow[] {
  return [...rows].sort((a, b) => {
    if ((a.advisory === null) !== (b.advisory === null)) {
      return a.advisory === null ? -1 : 1;
    }
    const scoreDelta = (b.advisory?.score ?? 0) - (a.advisory?.score ?? 0);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return b.detectedAt.localeCompare(a.detectedAt);
  });
}

export function toApiEvents(events: readonly ledger.StoredLedgerEvent[]): ApiLedgerEvent[] {
  return events.map((e, index) => ({
    index,
    sk: e.sk,
    ts: e.ts,
    type: e.type,
    actor: e.actor,
    eventHash: e.eventHash,
    prevEventHash: e.prevEventHash,
    payload: e.payload,
  }));
}

function sameTool(payload: Record<string, unknown>, q: ledger.Quarantine): boolean {
  return payload["upstreamId"] === q.upstreamId && payload["toolName"] === q.toolName;
}

/** The PIN_CREATED or REPIN event that approved `q.fromHash` — the version the resident originally agreed to. */
function isApprovalOfFromHash(e: ApiLedgerEvent, q: ledger.Quarantine): boolean {
  return (
    sameTool(e.payload, q) &&
    ((e.type === "PIN_CREATED" && e.payload["hash"] === q.fromHash) ||
      (e.type === "REPIN" && e.payload["approvedHash"] === q.fromHash))
  );
}

/**
 * The events that tell one quarantine's story, in chain order: the approval
 * of the version that was pinned, the mismatch that tripped the gate, and
 * every event carrying this quarantine's id.
 *
 * MISMATCH_DETECTED carries no quarantine id, and a later quarantine can
 * share an earlier one's toHash (a blocked change re-detected on the next
 * tools/list). So both the mismatch and the pin approval are anchored to
 * the last matching event *before* this quarantine's own first event —
 * never a sibling quarantine's.
 */
export function relatedEvents(events: readonly ApiLedgerEvent[], q: ledger.Quarantine): ApiLedgerEvent[] {
  const own = events.filter((e) => e.payload["quarantineId"] === q.quarantineId);
  const anchor = own[0]?.index ?? Number.POSITIVE_INFINITY;
  const before = events.filter((e) => e.index < anchor);
  const mismatch = before
    .filter((e) => e.type === "MISMATCH_DETECTED" && sameTool(e.payload, q) && e.payload["toHash"] === q.toHash)
    .at(-1);
  const pinEvent = before.filter((e) => isApprovalOfFromHash(e, q)).at(-1);
  return [pinEvent, mismatch, ...own]
    .filter((e): e is ApiLedgerEvent => e !== undefined)
    .sort((a, b) => a.index - b.index);
}

export function pinnedVersionFor(
  events: readonly ApiLedgerEvent[],
  q: ledger.Quarantine,
  pin: ledger.Pin | undefined,
): PinnedVersion | null {
  const approvals = events.filter((e) => isApprovalOfFromHash(e, q));
  const last = approvals[approvals.length - 1];
  if (last !== undefined) {
    return { hash: q.fromHash, approvedAt: last.ts, approvedBy: last.actor, eventSk: last.sk };
  }
  if (pin !== undefined && pin.approvedHash === q.fromHash) {
    return { hash: q.fromHash, approvedAt: pin.approvedAt, approvedBy: pin.approvedBy };
  }
  return null;
}

/** An advisory read failure degrades to "unscored" — which sorts first, i.e. toward more attention, not less. */
async function advisoryOrNull(quarantineId: string): Promise<ledger.Advisory | null> {
  try {
    return (await ledger.getAdvisory(quarantineId)) ?? null;
  } catch (error) {
    log.warn({ error, quarantineId }, "advisory read failed; treating as unscored");
    return null;
  }
}

async function listHouseholdQuarantines(householdId: string): Promise<ledger.Quarantine[]> {
  const byStatus = await Promise.all(QUARANTINE_STATUSES.map((s) => ledger.listQuarantineByStatus(s)));
  return byStatus.flat().filter((q) => q.householdId === householdId);
}

function storageUnavailable(res: Response, error: unknown, what: string): void {
  log.error({ error }, `api: ${what} failed`);
  res.status(503).json({ error: "storage_unavailable", message: `Could not read ${what} from storage.` });
}

export function buildApiRouter(householdId: string, upstreams: readonly UpstreamConfig[]): Router {
  const router = Router();

  router.get("/quarantine", (req: Request, res: Response) => {
    void (async () => {
      const filter = typeof req.query["status"] === "string" ? req.query["status"] : "all";
      if (filter !== "all" && !REVIEW_STATES.includes(filter as ReviewState)) {
        res.status(400).json({ error: "bad_request", message: `status must be one of all, ${REVIEW_STATES.join(", ")}` });
        return;
      }
      try {
        const now = Date.now();
        const quarantines = await listHouseholdQuarantines(householdId);
        const rows = await Promise.all(
          quarantines.map(async (q): Promise<QueueRow> => {
            const advisory = await advisoryOrNull(q.quarantineId);
            return {
              quarantineId: q.quarantineId,
              toolName: q.toolName,
              upstreamId: q.upstreamId,
              upstreamLabel: upstreamLabelFor(upstreams, q.upstreamId),
              capabilityClass: q.capabilityClass,
              detectedAt: q.detectedAt,
              ...(q.resolvedAt !== undefined ? { resolvedAt: q.resolvedAt } : {}),
              reviewState: reviewStateOf(q, now),
              advisory: advisory === null ? null : { score: advisory.score, modelId: advisory.modelId },
            };
          }),
        );
        const filtered = filter === "all" ? rows : rows.filter((r) => r.reviewState === filter);
        res.json({ items: sortQueue(filtered), total: rows.length });
      } catch (error) {
        storageUnavailable(res, error, "the quarantine list");
      }
    })();
  });

  router.get("/quarantine/:id", (req: Request, res: Response) => {
    void (async () => {
      const quarantineId = String(req.params["id"]);
      try {
        const q = await ledger.getQuarantine(householdId, quarantineId);
        if (q === undefined) {
          res.status(404).json({ error: "not_found", message: `No quarantine "${quarantineId}" for this household.` });
          return;
        }
        const [events, pin, advisory] = await Promise.all([
          ledger.listEvents(householdId).then(toApiEvents),
          ledger.getPin(householdId, q.upstreamId, q.toolName),
          advisoryOrNull(q.quarantineId),
        ]);
        res.json({
          quarantineId: q.quarantineId,
          toolName: q.toolName,
          upstreamId: q.upstreamId,
          upstreamLabel: upstreamLabelFor(upstreams, q.upstreamId),
          capabilityClass: q.capabilityClass,
          detectedAt: q.detectedAt,
          ...(q.resolvedAt !== undefined ? { resolvedAt: q.resolvedAt } : {}),
          reviewState: reviewStateOf(q, Date.now()),
          tokenExpiresAt: new Date(Date.parse(q.detectedAt) + APPROVAL_TOKEN_TTL_MS).toISOString(),
          tokenHeld: peekRevealedToken(q.quarantineId) !== undefined,
          fromHash: q.fromHash,
          toHash: q.toHash,
          before: JSON.parse(q.fromCanonicalJson) as unknown,
          after: JSON.parse(q.toCanonicalJson) as unknown,
          diffSpans: q.diffSpans,
          pinnedVersion: pinnedVersionFor(events, q, pin),
          advisory,
          events: relatedEvents(events, q),
        });
      } catch (error) {
        storageUnavailable(res, error, "the quarantine");
      }
    })();
  });

  router.get("/ledger", (req: Request, res: Response) => {
    void (async () => {
      const type = typeof req.query["type"] === "string" ? req.query["type"] : undefined;
      try {
        const events = toApiEvents(await ledger.listEvents(householdId));
        res.json({
          events: type === undefined ? events : events.filter((e) => e.type === type),
          total: events.length,
        });
      } catch (error) {
        storageUnavailable(res, error, "the ledger");
      }
    })();
  });

  router.get("/ledger/verify", (_req: Request, res: Response) => {
    void (async () => {
      try {
        res.json(await ledger.verifyChain(householdId));
      } catch (error) {
        log.error({ error }, "api: chain verification could not run");
        // Deliberately `ok: false`: a verifier that could not read the chain has not verified it.
        res.status(503).json({ ok: false, error: "storage_unavailable", message: "Could not read the ledger to verify it." });
      }
    })();
  });

  router.get("/upstreams", (_req: Request, res: Response) => {
    void (async () => {
      try {
        const [pins, quarantines] = await Promise.all([
          ledger.listPinsForHousehold(householdId),
          listHouseholdQuarantines(householdId),
        ]);
        const now = Date.now();
        res.json({
          householdId,
          upstreams: upstreams.map((u) => ({
            id: u.id,
            label: u.label,
            pinnedTools: pins.filter((p) => p.upstreamId === u.id).length,
            pendingReview: quarantines.filter((q) => q.upstreamId === u.id && reviewStateOf(q, now) === "pending").length,
          })),
        });
      } catch (error) {
        storageUnavailable(res, error, "the upstream list");
      }
    })();
  });

  // Anything else under /api is a JSON 404, not the gateway's JSON-RPC one.
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  return router;
}
