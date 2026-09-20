/**
 * The evidence loader and the pure state resolution on top of it. These
 * assertions are about the committed files themselves, so a crawl report
 * that changes shape breaks the test rather than the screen.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadEvidence } from "../evidence.load";
import {
  EMPTY_EVIDENCE,
  bandVerdict,
  benchState,
  corpusState,
  daysUntil,
  intervalDays,
  staleness,
  strata,
  type Drift,
  type Evidence,
} from "../src/evidence";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const real = loadEvidence(repoRoot);

describe("loadEvidence", () => {
  it("reads the committed crawl-1 report", () => {
    expect(real.crawl1).not.toBeNull();
    expect(real.crawl1?.crawlId).toBe("crawl-1");
    expect(real.crawl1?.startedAt).toBe("2026-09-15T06:19:42.282Z");
    expect(real.crawl1?.capturedServers).toBe(152);
  });

  it("reads the committed boot rate and does not recompute its published sentence", () => {
    expect(real.bootRate?.findingSentence).toContain("did not start from their own documented setup instructions");
  });

  it("reads drift.json in its pre-registered pending form", () => {
    expect(real.drift?.status).toBe("pending");
    expect(real.drift?.interval).toBe(35);
    expect(real.drift?.n).toBeNull();
    expect(real.drift?.byCapability).toBeNull();
    expect(real.drift?.prediction).toEqual(
      expect.objectContaining({ lowPct: 20, highPct: 40, registeredOn: "2026-09-12" }),
    );
  });

  it("returns null for a file that does not exist rather than throwing", () => {
    // crawl-2 has not run and the bench harness has not been built.
    expect(real.crawl2).toBeNull();
    expect(loadEvidence(path.join(repoRoot, "does-not-exist"))).toEqual(
      expect.objectContaining({ crawl1: null, drift: null, latency: null }),
    );
  });

  it("agrees with CRAWL_DATES.md on the taxonomy blob", () => {
    expect(real.crawl1?.taxonomyBlobSha).toBe("0c896539006dbb6f8dfacc1f02ebbf179c50eec2");
  });
});

describe("corpusState", () => {
  it("is empty with no crawl report", () => {
    expect(corpusState(EMPTY_EVIDENCE)).toBe("empty");
  });

  it("is partial today — crawl 1 recorded, drift still pending", () => {
    expect(corpusState(real)).toBe("partial");
  });

  it("stays partial when drift.json exists but says pending", () => {
    expect(real.drift).not.toBeNull();
    expect(corpusState({ ...real, drift: { ...(real.drift as Drift), status: "pending" } })).toBe("partial");
  });

  it("is complete only when drift.json is complete AND carries the strata", () => {
    const base = real.drift as Drift;
    // status complete but no strata: not complete. A headline without its
    // breakdown is the shape a half-finished analysis would produce.
    expect(corpusState({ ...real, drift: { ...base, status: "complete", byCapability: null } })).toBe("partial");
    expect(
      corpusState({
        ...real,
        drift: {
          ...base,
          status: "complete",
          byCapability: [{ capabilityClass: "read", servers: 10, drifted: 1, ratePct: 10 }],
        },
      }),
    ).toBe("complete");
  });
});

describe("strata", () => {
  it("returns the four classes in order of consequence, not by size", () => {
    expect(strata(real).map((s) => s.capabilityClass)).toEqual(["transact", "communicate", "write", "read"]);
  });

  it("marks read low-confidence, because it is the classifier's unmatched-verb default", () => {
    const rows = strata(real);
    expect(rows.filter((r) => r.lowConfidence).map((r) => r.capabilityClass)).toEqual(["read"]);
    // The crawl report's own low-confidence count equals the read population, which is why.
    expect(real.crawl1?.lowConfidenceCount).toBe(real.crawl1?.capabilityDistribution["read"]);
  });

  it("sums to the tools actually captured", () => {
    const total = strata(real).reduce((n, s) => n + s.value, 0);
    expect(total).toBe(real.crawl1?.totalToolsCaptured);
  });

  it("switches to drift rates once the analysis is complete", () => {
    const drift: Drift = {
      ...(real.drift as Drift),
      status: "complete",
      byCapability: [
        { capabilityClass: "transact", servers: 18, drifted: 9, ratePct: 50 },
        { capabilityClass: "read", servers: 36, drifted: 6, ratePct: 16.7 },
      ],
    };
    const rows = strata({ ...real, drift });
    expect(rows.map((r) => r.capabilityClass)).toEqual(["transact", "read"]);
    expect(rows[0]?.display).toBe("50.0%");
    expect(rows[0]?.note).toBe("9 of 18 servers");
    // A rate is never low-confidence-hatched: the hatch is about the crawl-1 classifier only.
    expect(rows.every((r) => !r.lowConfidence)).toBe(true);
  });
});

describe("intervalDays", () => {
  it("falls back to the pre-registered interval while crawl 2 is pending", () => {
    expect(intervalDays(real.drift)).toBe(35);
  });

  it("re-derives from the two recorded timestamps once both exist", () => {
    const drift: Drift = {
      ...(real.drift as Drift),
      crawl1StartedAt: "2026-09-15T06:19:42.282Z",
      crawl2StartedAt: "2026-10-20T06:11:03.900Z",
      // A stale pre-registered value must not win over what was measured.
      interval: 99,
    };
    expect(intervalDays(drift)).toBe(35);
  });

  it("reports the day it actually ran when a crawl slips", () => {
    const drift: Drift = {
      ...(real.drift as Drift),
      crawl1StartedAt: "2026-09-15T06:19:42.282Z",
      crawl2StartedAt: "2026-10-22T06:11:03.900Z",
    };
    expect(intervalDays(drift)).toBe(37);
  });

  it("is null with no drift file at all", () => {
    expect(intervalDays(null)).toBeNull();
  });
});

describe("daysUntil", () => {
  it("counts whole days to the scheduled crawl", () => {
    expect(daysUntil("2026-10-20", Date.parse("2026-09-20T12:00:00.000Z"))).toBe(30);
  });

  it("goes negative once the date has passed", () => {
    expect(daysUntil("2026-10-20", Date.parse("2026-10-22T00:00:00.000Z"))).toBe(-2);
  });
});

describe("bandVerdict", () => {
  const drift = real.drift as Drift;
  it("places a rate relative to the pre-registered band", () => {
    expect(bandVerdict(28.2, drift)).toBe("inside");
    expect(bandVerdict(20, drift)).toBe("inside");
    expect(bandVerdict(40, drift)).toBe("inside");
    expect(bandVerdict(19.9, drift)).toBe("below");
    expect(bandVerdict(40.1, drift)).toBe("above");
  });
});

describe("benchState and staleness", () => {
  it("reads the committed latency file a bench run wrote", () => {
    // Phase 15 asserted this file was absent, because the harness did not
    // exist yet. Phase 16 built it, so the assertion is now the opposite
    // one: the screen has real numbers to render.
    expect(real.latency).not.toBeNull();
    expect(benchState(real)).toBe("ready");
  });

  it("carries the fields /bench renders, from a real run", () => {
    expect(real.latency?.samples).toBe(1000);
    expect(real.latency?.budgetP95Ms).toBe(30);
    expect(real.latency?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    for (const value of [real.latency?.addedP50Ms, real.latency?.addedP95Ms, real.latency?.addedP99Ms]) {
      expect(typeof value).toBe("number");
    }
  });

  it("still reports empty when no run has been recorded", () => {
    // The designed empty state has to keep working — a fresh clone that
    // has never run the harness must not render a zero.
    expect(benchState({ ...real, latency: null })).toBe("empty");
  });

  const latency = {
    recordedAt: "2026-09-19T21:03:00.000Z",
    commitSha: "a".repeat(40),
    samples: 400,
    addedP50Ms: 6.2,
    addedP95Ms: 21.4,
    addedP99Ms: 34.8,
    budgetP95Ms: 30,
  };

  it("matches when the recorded commit is HEAD", () => {
    expect(staleness(latency, "a".repeat(40))).toEqual(
      expect.objectContaining({ stale: false, reason: "match" }),
    );
  });

  it("is stale when it is not", () => {
    expect(staleness(latency, "b".repeat(40))).toEqual(expect.objectContaining({ stale: true, reason: "mismatch" }));
  });

  it("reports unknown rather than fresh when HEAD could not be read", () => {
    const s = staleness(latency, null);
    expect(s.reason).toBe("unknown");
    // Not asserted as stale, and — the part that matters — never asserted as a match.
    expect(s.reason).not.toBe("match");
  });
});

describe("EMPTY_EVIDENCE", () => {
  it("renders every screen's empty state without a provider", () => {
    const ev: Evidence = EMPTY_EVIDENCE;
    expect(corpusState(ev)).toBe("empty");
    expect(benchState(ev)).toBe("empty");
    expect(strata(ev)).toEqual([]);
  });
});
