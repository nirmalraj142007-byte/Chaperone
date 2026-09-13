import { describe, expect, it } from "vitest";
import type { CandidateRecord } from "../src/assemble.js";
import { sortForCrawl } from "../src/crawl.js";

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
