import { describe, expect, it } from "vitest";
import type { CandidateRecord } from "../src/assemble.js";
import { seedFromString, seededSample, sortForCrawl } from "../src/crawl.js";

function candidate(serverId: string, installMethod: CandidateRecord["installMethod"]): CandidateRecord {
  return {
    serverId,
    displayName: serverId,
    sources: ["awesome"],
    repoUrl: null,
    repoOwner: null,
    repoName: null,
    installMethod,
    installSpec: installMethod ? "some-spec" : null,
    requiresCredentials: false,
    bootStatus: "not_attempted",
    firstSeenAt: "2026-09-13T00:00:00.000Z",
  };
}

describe("sortForCrawl", () => {
  it("puts npx/uvx/pip candidates before everything else, preserving relative order within each group", () => {
    const records = [
      candidate("a-no-install", null),
      candidate("b-npx", "npx"),
      candidate("c-manual", "manual"),
      candidate("d-uvx", "uvx"),
      candidate("e-docker", "docker"),
      candidate("f-pip", "pip"),
    ];

    const sorted = sortForCrawl(records).map((r) => r.serverId);

    expect(sorted).toEqual(["b-npx", "d-uvx", "f-pip", "a-no-install", "c-manual", "e-docker"]);
  });

  it("is a no-op reordering when every candidate is already automatable", () => {
    const records = [candidate("a", "npx"), candidate("b", "uvx"), candidate("c", "pip")];
    expect(sortForCrawl(records).map((r) => r.serverId)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op reordering when nothing is automatable", () => {
    const records = [candidate("a", null), candidate("b", "manual"), candidate("c", "docker")];
    expect(sortForCrawl(records).map((r) => r.serverId)).toEqual(["a", "b", "c"]);
  });
});

describe("seedFromString", () => {
  it("is deterministic — the same string always yields the same seed", () => {
    expect(seedFromString("crawl-1")).toBe(seedFromString("crawl-1"));
  });

  it("distinguishes different crawl ids", () => {
    expect(seedFromString("crawl-1")).not.toBe(seedFromString("crawl-2"));
  });

  it("returns a non-negative uint32", () => {
    const seed = seedFromString("crawl-1");
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("seededSample", () => {
  const population = Array.from({ length: 1000 }, (_, i) => i);

  it("is deterministic — same items, same seed, same sample every time", () => {
    const a = seededSample(population, 150, 42);
    const b = seededSample(population, 150, 42);
    expect(a).toEqual(b);
  });

  it("a different seed produces a different sample", () => {
    const a = seededSample(population, 150, 42);
    const b = seededSample(population, 150, 43);
    expect(a).not.toEqual(b);
  });

  it("samples without replacement — no duplicates, and every item drawn from the population", () => {
    const sample = seededSample(population, 150, 42);
    expect(new Set(sample).size).toBe(150);
    for (const item of sample) {
      expect(population).toContain(item);
    }
  });

  it("caps at the population size rather than padding or erroring when size exceeds it", () => {
    const small = [1, 2, 3];
    const sample = seededSample(small, 150, 42);
    expect(sample).toHaveLength(3);
    expect(new Set(sample)).toEqual(new Set(small));
  });

  it("does not mutate the input array", () => {
    const original = [...population];
    seededSample(population, 150, 42);
    expect(population).toEqual(original);
  });
});
