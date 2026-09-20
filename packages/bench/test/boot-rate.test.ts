import { describe, expect, it } from "vitest";
import { BenchError } from "@chaperone/errors";
import { deriveBootRate, type BootRateSource } from "../src/boot-rate.js";

const report: BootRateSource = {
  crawlId: "crawl-1",
  candidatesConsidered: 250,
  noInstallPath: 80,
  attempted: 100,
  booted: 37,
  refusedNoCreds: 21,
  failedInstall: 18,
  failedStart: 14,
  failedTimeout: 10,
  bootSuccessRate: 37,
};

describe("deriveBootRate", () => {
  it("reports the failure rate, not the success rate relabelled", () => {
    // The bug this exists to prevent: publishing bootSuccessRate under
    // failure language, which would have claimed 37% did not start when
    // 37% is the share that did.
    const finding = deriveBootRate(report, "data/crawl-1-report.json");
    expect(finding.didNotStartRate).toBe(63);
    expect(finding.findingSentence).toContain("63.0% of public MCP servers");
    expect(finding.findingSentence).toContain("did not start");
  });

  it("puts the underlying counts in the sentence, so a rate never appears without its denominator", () => {
    const finding = deriveBootRate(report, "data/crawl-1-report.json");
    expect(finding.findingSentence).toContain("37 booted of 100 attempted");
    expect(finding.findingSentence).toContain("80 had no discoverable install path");
  });

  it("carries every count through unchanged for independent recomputation", () => {
    const finding = deriveBootRate(report, "data/crawl-1-report.json");
    expect(finding).toMatchObject({
      crawlId: "crawl-1",
      candidatesConsidered: 250,
      noInstallPath: 80,
      attempted: 100,
      booted: 37,
      refusedNoCreds: 21,
      failedInstall: 18,
      failedStart: 14,
      failedTimeout: 10,
      bootSuccessRate: 37,
    });
  });

  it("names the report it was derived from", () => {
    expect(deriveBootRate(report, "data/crawl-2-report.json").source).toBe("data/crawl-2-report.json");
  });

  it("refuses to derive a rate from a crawl that attempted nothing", () => {
    // 0 attempted would otherwise divide into a NaN or a confident-looking
    // 100%, both of which are publishable-looking nonsense.
    expect(() => deriveBootRate({ ...report, attempted: 0 }, "data/crawl-1-report.json")).toThrow(BenchError);
  });

  it("is the single derivation both published files use", async () => {
    // data/boot-rate.json is written by pnpm crawl:boot-rate and
    // benchmarks/boot-rate.json by pnpm bench. Both call this function, so
    // the committed file must equal what this function produces from the
    // same report — if it does not, one of the two writers has drifted.
    const { readFile } = await import("node:fs/promises");
    const committed = JSON.parse(await readFile("data/boot-rate.json", "utf8")) as { crawlId: string };
    const crawl = JSON.parse(await readFile(`data/${committed.crawlId}-report.json`, "utf8")) as BootRateSource;
    expect(deriveBootRate(crawl, `data/${committed.crawlId}-report.json`)).toEqual(committed);
  });
});
