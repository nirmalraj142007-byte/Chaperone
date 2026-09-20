import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  ApprovalTokenExpiredError,
  InvalidApprovalTokenError,
  QuarantineAlreadyResolvedError,
  QuarantineNotFoundError,
} from "@chaperone/errors";

vi.mock("@chaperone/ledger", () => ({
  getQuarantine: vi.fn(),
  putPin: vi.fn(),
  appendEvent: vi.fn(),
  resolveQuarantine: vi.fn(),
  listQuarantineByStatus: vi.fn(),
}));

const ledger = await import("@chaperone/ledger");
const { approveChange, listPendingChanges } = await import("../src/approve.js");

const HOUSEHOLD_ID = "household-demo";
const QUARANTINE_ID = "01JQUARANTINE00000000000";
const TOKEN = "correct-token";
const TOKEN_HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");

function baseQuarantine(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    householdId: HOUSEHOLD_ID,
    quarantineId: QUARANTINE_ID,
    upstreamId: "grocery",
    toolName: "add_item",
    fromHash: "sha256:before",
    toHash: "sha256:after",
    fromCanonicalJson: JSON.stringify({ name: "add_item", description: "before", inputSchema: {} }),
    toCanonicalJson: JSON.stringify({ name: "add_item", description: "after", inputSchema: {} }),
    diffSpans: [],
    approvalTokenHash: TOKEN_HASH,
    status: "pending",
    capabilityClass: "write",
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

let pins: Array<Record<string, unknown>>;
let events: Array<{ type: string; actor: string; payload: unknown }>;
let resolveCalls: Array<[string, string, string, string]>;

beforeEach(() => {
  pins = [];
  events = [];
  resolveCalls = [];

  vi.mocked(ledger.putPin).mockImplementation(async (pin) => {
    pins.push(pin as never);
  });
  vi.mocked(ledger.appendEvent).mockImplementation(async ({ type, actor, payload }) => {
    events.push({ type, actor, payload });
    return { eventId: `evt-${events.length}`, eventHash: "hash", prevEventHash: "prev" };
  });
  vi.mocked(ledger.resolveQuarantine).mockImplementation(async (householdId, quarantineId, status, resolvedAt) => {
    resolveCalls.push([householdId, quarantineId, status, resolvedAt]);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("approveChange: the only path that ever re-pins", () => {
  it("throws QuarantineNotFoundError for an unknown quarantineId", async () => {
    vi.mocked(ledger.getQuarantine).mockResolvedValue(undefined);
    await expect(approveChange(HOUSEHOLD_ID, "nope", TOKEN, "approve")).rejects.toBeInstanceOf(
      QuarantineNotFoundError,
    );
  });

  it("throws QuarantineAlreadyResolvedError for a quarantine that isn't pending", async () => {
    vi.mocked(ledger.getQuarantine).mockResolvedValue(baseQuarantine({ status: "approved" }) as never);
    await expect(approveChange(HOUSEHOLD_ID, QUARANTINE_ID, TOKEN, "approve")).rejects.toBeInstanceOf(
      QuarantineAlreadyResolvedError,
    );
  });

  it("throws ApprovalTokenExpiredError more than 24h after detectedAt", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    vi.mocked(ledger.getQuarantine).mockResolvedValue(baseQuarantine({ detectedAt: old }) as never);
    await expect(approveChange(HOUSEHOLD_ID, QUARANTINE_ID, TOKEN, "approve")).rejects.toBeInstanceOf(
      ApprovalTokenExpiredError,
    );
  });

  it("throws InvalidApprovalTokenError for a wrong token", async () => {
    vi.mocked(ledger.getQuarantine).mockResolvedValue(baseQuarantine() as never);
    await expect(approveChange(HOUSEHOLD_ID, QUARANTINE_ID, "wrong-token", "approve")).rejects.toBeInstanceOf(
      InvalidApprovalTokenError,
    );
    expect(ledger.putPin).not.toHaveBeenCalled();
  });

  it("a token minted for quarantine A is rejected against quarantine B, even for the same household", async () => {
    const QUARANTINE_A = "01JQUARANTINEAAAAAAAAAAAA";
    const QUARANTINE_B = "01JQUARANTINEBBBBBBBBBBBB";
    const TOKEN_A = "token-for-quarantine-a";
    const TOKEN_A_HASH = createHash("sha256").update(TOKEN_A, "utf8").digest("hex");
    const TOKEN_B_HASH = createHash("sha256").update("token-for-quarantine-b", "utf8").digest("hex");

    vi.mocked(ledger.getQuarantine).mockImplementation(async (_householdId, quarantineId) => {
      if (quarantineId === QUARANTINE_A) {
        return baseQuarantine({ quarantineId: QUARANTINE_A, approvalTokenHash: TOKEN_A_HASH }) as never;
      }
      if (quarantineId === QUARANTINE_B) {
        return baseQuarantine({ quarantineId: QUARANTINE_B, approvalTokenHash: TOKEN_B_HASH }) as never;
      }
      return undefined;
    });

    // The plaintext that hashes correctly for A, submitted against B.
    await expect(approveChange(HOUSEHOLD_ID, QUARANTINE_B, TOKEN_A, "approve")).rejects.toBeInstanceOf(
      InvalidApprovalTokenError,
    );
    expect(ledger.putPin).not.toHaveBeenCalled();

    // The same plaintext against the quarantine it actually belongs to still works.
    await expect(approveChange(HOUSEHOLD_ID, QUARANTINE_A, TOKEN_A, "approve")).resolves.toMatchObject({
      quarantineId: QUARANTINE_A,
      decision: "approve",
    });
  });

  it("ApproveResult never carries the plaintext token — only a hash prefix is exposed downstream", async () => {
    vi.mocked(ledger.getQuarantine).mockResolvedValue(baseQuarantine() as never);
    const result = await approveChange(HOUSEHOLD_ID, QUARANTINE_ID, TOKEN, "approve");
    expect(Object.keys(result).sort()).toEqual(["decision", "newHash", "quarantineId", "status"].sort());
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("on approve: writes the new pin, appends APPROVED then REPIN, and resolves the quarantine", async () => {
    const quarantine = baseQuarantine();
    vi.mocked(ledger.getQuarantine).mockResolvedValue(quarantine as never);

    const result = await approveChange(HOUSEHOLD_ID, QUARANTINE_ID, TOKEN, "approve");

    expect(result).toMatchObject({ quarantineId: QUARANTINE_ID, decision: "approve", status: "approved" });
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      householdId: HOUSEHOLD_ID,
      upstreamId: "grocery",
      toolName: "add_item",
      approvedHash: quarantine["toHash"],
      approvedCanonicalJson: quarantine["toCanonicalJson"],
      approvedBy: `resident:${HOUSEHOLD_ID}`,
    });
    expect(events.map((e) => e.type)).toEqual(["APPROVED", "REPIN"]);
    expect(events.every((e) => e.actor === `resident:${HOUSEHOLD_ID}`)).toBe(true);
    expect(resolveCalls).toEqual([[HOUSEHOLD_ID, QUARANTINE_ID, "approved", resolveCalls[0]?.[3]]]);
  });

  it("on block: appends REFUSED, resolves as refused, and never writes a pin", async () => {
    vi.mocked(ledger.getQuarantine).mockResolvedValue(baseQuarantine() as never);
    const result = await approveChange(HOUSEHOLD_ID, QUARANTINE_ID, TOKEN, "block");

    expect(result).toMatchObject({ decision: "block", status: "refused" });
    expect(pins).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["REFUSED"]);
    expect(resolveCalls[0]?.[2]).toBe("refused");
  });

  it("replaying the same token after it was already redeemed fails distinctly, not silently", async () => {
    const quarantine = baseQuarantine();
    vi.mocked(ledger.getQuarantine).mockResolvedValueOnce(quarantine as never);
    await approveChange(HOUSEHOLD_ID, QUARANTINE_ID, TOKEN, "approve");

    // The real ledger would now report "approved" on a re-read; simulate that.
    vi.mocked(ledger.getQuarantine).mockResolvedValueOnce(baseQuarantine({ status: "approved" }) as never);
    await expect(approveChange(HOUSEHOLD_ID, QUARANTINE_ID, TOKEN, "approve")).rejects.toBeInstanceOf(
      QuarantineAlreadyResolvedError,
    );
    // Still exactly one pin from the original, successful redemption.
    expect(pins).toHaveLength(1);
  });

  it("two concurrent redemptions racing on a stale 'pending' read: only the conditional-write winner writes a pin or ledger event", async () => {
    // Both racers' getQuarantine call returns "pending" — neither sees the
    // other's write, exactly like two requests that both read before either
    // writes. The only thing that can tell them apart is the real
    // ledger.resolveQuarantine's DynamoDB ConditionExpression, so here the
    // mock plays that role directly: first call wins, second call throws
    // the same error the real conditional check would produce.
    vi.mocked(ledger.getQuarantine).mockResolvedValue(baseQuarantine() as never);
    vi.mocked(ledger.resolveQuarantine)
      .mockImplementationOnce(async (householdId, quarantineId, status, resolvedAt) => {
        resolveCalls.push([householdId, quarantineId, status, resolvedAt]);
      })
      .mockImplementationOnce(() => {
        throw new QuarantineAlreadyResolvedError(`quarantine "${QUARANTINE_ID}" was already resolved`, {
          quarantineId: QUARANTINE_ID,
        });
      });

    const [first, second] = await Promise.allSettled([
      approveChange(HOUSEHOLD_ID, QUARANTINE_ID, TOKEN, "approve"),
      approveChange(HOUSEHOLD_ID, QUARANTINE_ID, TOKEN, "approve"),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toBeInstanceOf(QuarantineAlreadyResolvedError);
    }
    // The loser must never have reached putPin or appendEvent: exactly one
    // pin and one APPROVED/REPIN pair, not two.
    expect(pins).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(["APPROVED", "REPIN"]);
  });
});

describe("listPendingChanges", () => {
  it("returns only this household's pending quarantines", async () => {
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([
      baseQuarantine() as never,
      baseQuarantine({ householdId: "someone-else" }) as never,
    ]);
    const pending = await listPendingChanges(HOUSEHOLD_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.householdId).toBe(HOUSEHOLD_ID);
  });
});
