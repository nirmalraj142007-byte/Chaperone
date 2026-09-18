import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@chaperone/ledger", () => ({
  listQuarantineByStatus: vi.fn(),
  getAdvisory: vi.fn(),
  putAdvisory: vi.fn(),
}));

const ledger = await import("@chaperone/ledger");
const { runLocalAdvisoryPipeline } = await import("../src/localRunner.js");
const { MockModelProvider } = await import("../src/providers/mock.js");

const HOUSEHOLD_ID = "household-test";

function quarantine(overrides: Record<string, unknown> = {}) {
  return {
    householdId: HOUSEHOLD_ID,
    quarantineId: "q1",
    upstreamId: "grocery",
    toolName: "add_item",
    fromHash: "fromhash",
    toHash: "tohash",
    fromCanonicalJson: JSON.stringify({ name: "add_item", description: "Adds an item to the list." }),
    toCanonicalJson: JSON.stringify({ name: "add_item", description: "Adds an item to the list. Also reads the calendar." }),
    diffSpans: [],
    approvalTokenHash: "irrelevant",
    status: "pending",
    capabilityClass: "write",
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([]);
  vi.mocked(ledger.getAdvisory).mockResolvedValue(undefined);
  vi.mocked(ledger.putAdvisory).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runLocalAdvisoryPipeline", () => {
  it("does nothing when there are no pending quarantines", async () => {
    const result = await runLocalAdvisoryPipeline(HOUSEHOLD_ID, new MockModelProvider());
    expect(result).toEqual({ candidates: 0, scored: 0, unavailable: 0, skippedAlreadyScored: 0, errored: 0 });
    expect(ledger.putAdvisory).not.toHaveBeenCalled();
  });

  it("filters pending quarantines down to this household", async () => {
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([
      quarantine({ quarantineId: "q1", householdId: HOUSEHOLD_ID }),
      quarantine({ quarantineId: "q2", householdId: "other-household" }),
    ] as never);

    const result = await runLocalAdvisoryPipeline(HOUSEHOLD_ID, new MockModelProvider());
    expect(result.candidates).toBe(1);
    expect(result.scored).toBe(1);
  });

  it("scores a pending quarantine and writes it via putAdvisory", async () => {
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([quarantine()] as never);
    const provider = new MockModelProvider({
      respond: () => ({ text: JSON.stringify({ score: 70, summary: "Now also reads the calendar." }), modelId: "mock-x" }),
    });

    const result = await runLocalAdvisoryPipeline(HOUSEHOLD_ID, provider);

    expect(result).toEqual({ candidates: 1, scored: 1, unavailable: 0, skippedAlreadyScored: 0, errored: 0 });
    expect(ledger.putAdvisory).toHaveBeenCalledWith(
      expect.objectContaining({ quarantineId: "q1", score: 70, summary: "Now also reads the calendar.", modelId: "mock-x" }),
    );
  });

  it("skips a quarantine that already has an advisory row, without calling the provider", async () => {
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([quarantine()] as never);
    vi.mocked(ledger.getAdvisory).mockResolvedValue({
      quarantineId: "q1",
      score: 5,
      summary: "already scored",
      modelId: "m",
      generatedAt: new Date().toISOString(),
      promptSha: "sha",
    });
    const provider = new MockModelProvider();
    const invokeSpy = vi.spyOn(provider, "invoke");

    const result = await runLocalAdvisoryPipeline(HOUSEHOLD_ID, provider);

    expect(result).toEqual({ candidates: 1, scored: 0, unavailable: 0, skippedAlreadyScored: 1, errored: 0 });
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(ledger.putAdvisory).not.toHaveBeenCalled();
  });

  it("counts an unavailable score and does not call putAdvisory for it", async () => {
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([quarantine()] as never);
    const provider = new MockModelProvider({ respond: () => ({ text: "not json", modelId: "mock-x" }) });

    const result = await runLocalAdvisoryPipeline(HOUSEHOLD_ID, provider);

    expect(result).toEqual({ candidates: 1, scored: 0, unavailable: 1, skippedAlreadyScored: 0, errored: 0 });
    expect(ledger.putAdvisory).not.toHaveBeenCalled();
  });

  it("counts a per-item error (e.g. a ledger write failure) without aborting the rest of the batch", async () => {
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([
      quarantine({ quarantineId: "q1" }),
      quarantine({ quarantineId: "q2" }),
    ] as never);
    vi.mocked(ledger.putAdvisory).mockRejectedValueOnce(new Error("ledger write failed")).mockResolvedValueOnce(undefined);

    const result = await runLocalAdvisoryPipeline(HOUSEHOLD_ID, new MockModelProvider());

    expect(result).toEqual({ candidates: 2, scored: 1, unavailable: 0, skippedAlreadyScored: 0, errored: 1 });
  });

  it("derives changedFields from name/description differences between the pinned and current canonical JSON", async () => {
    vi.mocked(ledger.listQuarantineByStatus).mockResolvedValue([
      quarantine({
        fromCanonicalJson: JSON.stringify({ name: "add_item", description: "same" }),
        toCanonicalJson: JSON.stringify({ name: "add_item", description: "same" }),
      }),
    ] as never);
    let seenPrompt = "";
    const provider = new MockModelProvider({
      respond: (req) => {
        seenPrompt = req.prompt;
        return { text: JSON.stringify({ score: 1, summary: "ok" }), modelId: "m" };
      },
    });

    await runLocalAdvisoryPipeline(HOUSEHOLD_ID, provider);
    expect(seenPrompt).toContain("Changed fields: none");
  });
});
