import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstreamConfig } from "@chaperone/upstream";

vi.mock("@chaperone/ledger", () => ({
  getQuarantine: vi.fn(),
  getPin: vi.fn(),
  listQuarantineByStatus: vi.fn(),
  getAdvisory: vi.fn(),
}));

const ledger = await import("@chaperone/ledger");
const { loadConsentCardModel } = await import("../src/consentCard.js");

const HOUSEHOLD_ID = "household-test";
const UPSTREAMS: UpstreamConfig[] = [{ id: "grocery", url: "http://127.0.0.1/mcp", label: "Household Grocery" }];

function quarantine(overrides: Record<string, unknown> = {}) {
  return {
    householdId: HOUSEHOLD_ID,
    quarantineId: "q1",
    upstreamId: "grocery",
    toolName: "add_item",
    fromHash: "fromhash",
    toHash: "tohash0123456789abcdef",
    fromCanonicalJson: JSON.stringify({ description: "Adds an item to the list." }),
    toCanonicalJson: JSON.stringify({ description: "Adds an item to the list. Also reads the calendar." }),
    diffSpans: [],
    approvalTokenHash: "irrelevant-here",
    status: "pending",
    capabilityClass: "write",
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([]);
  vi.mocked(ledger.getAdvisory).mockResolvedValue(undefined);
  vi.mocked(ledger.getPin).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("loadConsentCardModel — state selection", () => {
  it("returns undefined for a quarantine id that doesn't exist", async () => {
    vi.mocked(ledger.getQuarantine).mockResolvedValue(undefined);
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "no-such-id");
    expect(model).toBeUndefined();
  });

  it("loading: no advisory row yet, still inside the loading window", async () => {
    const q = quarantine();
    vi.mocked(ledger.getQuarantine).mockResolvedValue(q as never);
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([q] as never);
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "q1", { approvalToken: "tok" });
    expect(model?.state).toBe("loading");
    if (model?.state === "loading") {
      expect(model.item.advisorySummary).toBeUndefined();
      expect(model.item.approvalToken).toBe("tok");
      expect(model.item.upstreamLabel).toBe("Household Grocery");
    }
  });

  it("pending: an advisory row exists", async () => {
    const q = quarantine();
    vi.mocked(ledger.getQuarantine).mockResolvedValue(q as never);
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([q] as never);
    vi.mocked(ledger.getAdvisory).mockResolvedValue({
      quarantineId: "q1",
      score: 80,
      summary: "Adds calendar access.",
      modelId: "test-model",
      generatedAt: new Date().toISOString(),
      promptSha: "sha",
    });
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "q1", { approvalToken: "tok" });
    expect(model?.state).toBe("pending");
    if (model?.state === "pending") {
      expect(model.item.advisorySummary).toBe("Adds calendar access.");
    }
  });

  it("advisory-unavailable: the loading window has passed with still no advisory", async () => {
    vi.useFakeTimers();
    const detectedAt = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(new Date(detectedAt.getTime() + 9_000)); // past the 8s loading window
    const q = quarantine({ detectedAt: detectedAt.toISOString() });
    vi.mocked(ledger.getQuarantine).mockResolvedValue(q as never);
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([q] as never);
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "q1");
    expect(model?.state).toBe("advisory-unavailable");
  });

  it("a failed advisory read degrades to no-advisory rather than throwing", async () => {
    const q = quarantine();
    vi.mocked(ledger.getQuarantine).mockResolvedValue(q as never);
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([q] as never);
    vi.mocked(ledger.getAdvisory).mockRejectedValue(new Error("DynamoDB unreachable"));
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "q1");
    expect(["loading", "advisory-unavailable"]).toContain(model?.state);
  });

  it("expired: still pending, but older than the 24h approval-token TTL, regardless of advisory", async () => {
    const detectedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const q = quarantine({ detectedAt });
    vi.mocked(ledger.getQuarantine).mockResolvedValue(q as never);
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([q] as never);
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "q1");
    expect(model).toEqual({
      state: "expired",
      toolName: "add_item",
      upstreamLabel: "Household Grocery",
      detectedAt,
    });
  });

  it("approved: resolved status renders the pin's own hash", async () => {
    const q = quarantine({ status: "approved" });
    vi.mocked(ledger.getQuarantine).mockResolvedValue(q as never);
    vi.mocked(ledger.getPin).mockResolvedValue({
      householdId: HOUSEHOLD_ID,
      upstreamId: "grocery",
      toolName: "add_item",
      approvedHash: "brandnewhash0123456789",
      approvedCanonicalJson: q.toCanonicalJson,
      approvedAt: new Date().toISOString(),
      approvedBy: `resident:${HOUSEHOLD_ID}`,
      consentEventId: "q1",
      capabilityClass: "write",
    } as never);
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "q1");
    expect(model).toEqual({
      state: "approved",
      toolName: "add_item",
      upstreamLabel: "Household Grocery",
      newHashPrefix: "brandnewhash0123456789",
    });
  });

  it("approved: falls back to the quarantine's own toHash when the pin read comes back empty", async () => {
    const q = quarantine({ status: "approved" });
    vi.mocked(ledger.getQuarantine).mockResolvedValue(q as never);
    vi.mocked(ledger.getPin).mockResolvedValue(undefined);
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "q1");
    expect(model?.state).toBe("approved");
    if (model?.state === "approved") {
      expect(model.newHashPrefix).toBe(q.toHash);
    }
  });

  it("refused: resolved status renders the refused state", async () => {
    const q = quarantine({ status: "refused" });
    vi.mocked(ledger.getQuarantine).mockResolvedValue(q as never);
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "q1");
    expect(model).toEqual({ state: "refused", toolName: "add_item", upstreamLabel: "Household Grocery" });
  });

  it("batch: 2+ pending quarantines on the same upstream collapse into one batch card", async () => {
    const q1 = quarantine({ quarantineId: "q1", toolName: "add_item" });
    const q2 = quarantine({ quarantineId: "q2", toolName: "place_order" });
    vi.mocked(ledger.getQuarantine).mockImplementation(async (_h, id) =>
      ([q1, q2].find((q) => q.quarantineId === id) as never) ?? undefined,
    );
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([q1, q2] as never);
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "q1", { approvalToken: "tok-for-q1" });
    expect(model?.state).toBe("batch");
    if (model?.state === "batch") {
      expect(model.items.map((i) => i.quarantineId).sort()).toEqual(["q1", "q2"]);
      expect(model.upstreamLabel).toBe("Household Grocery");
      const item1 = model.items.find((i) => i.quarantineId === "q1");
      expect(item1?.approvalToken).toBe("tok-for-q1");
    }
  });

  it("batch is scoped per upstream — a sibling pending quarantine on a different upstream never joins the batch", async () => {
    const q1 = quarantine({ quarantineId: "q1", upstreamId: "grocery" });
    const q2 = quarantine({ quarantineId: "q2", upstreamId: "pharmacy" });
    vi.mocked(ledger.getQuarantine).mockResolvedValue(q1 as never);
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([q1, q2] as never);
    const model = await loadConsentCardModel(HOUSEHOLD_ID, UPSTREAMS, "q1");
    expect(model?.state).not.toBe("batch");
  });
});
