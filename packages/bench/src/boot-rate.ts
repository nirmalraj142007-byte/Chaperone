/**
 * The boot-success finding, derived from a crawl report.
 *
 * This is the project's other free, externally verifiable number, and the
 * one it spent a while apologising for: servers that would not start were
 * treated as a gap in the corpus rather than as a result. They are a
 * result. "X% of public MCP servers with a discoverable install command
 * did not start from their own documented setup instructions" is a
 * measurement of the developer ecosystem, taken against other people's
 * repositories, and nothing about it is self-graded.
 *
 * This module is the *single* implementation of that sentence and its
 * counts. Two files hold the output — `data/boot-rate.json` next to the
 * crawl evidence it comes from, and `benchmarks/boot-rate.json` next to
 * the other reproducible number — and `packages/crawler/scripts/boot-rate.ts`
 * writes the first by calling `deriveBootRate` here, exactly as the bench
 * runner writes the second. The same rule as the crawler and the gateway
 * sharing one `hashTool`: two derivations of one published number that can
 * disagree by a rounding step is a broken evidence chain, and the fix is
 * one function, not two careful copies.
 *
 * Never hand-edit either output file. Regenerate from the crawl report.
 */
import { BenchError } from "@chaperone/errors";

/**
 * The fields of a crawl report this derivation reads. Declared structurally
 * rather than imported from `@chaperone/crawler`, so the bench package does
 * not take a dependency on the crawler's registry clients and Docker
 * harness to do arithmetic on nine numbers. The crawler's own `CrawlReport`
 * is assignable to this.
 */
export interface BootRateSource {
  crawlId: string;
  candidatesConsidered: number;
  noInstallPath: number;
  attempted: number;
  booted: number;
  refusedNoCreds: number;
  failedInstall: number;
  failedStart: number;
  failedTimeout: number;
  bootSuccessRate: number;
}

export interface BootRateFinding {
  /** The report this was derived from, as a repo-relative POSIX path. */
  source: string;
  crawlId: string;
  candidatesConsidered: number;
  noInstallPath: number;
  attempted: number;
  booted: number;
  refusedNoCreds: number;
  failedInstall: number;
  failedStart: number;
  failedTimeout: number;
  bootSuccessRate: number;
  didNotStartRate: number;
  findingSentence: string;
}

export function deriveBootRate(report: BootRateSource, source: string): BootRateFinding {
  if (report.attempted <= 0) {
    throw new BenchError("crawl report attempted 0 servers; there is no boot rate to derive", {
      source,
      crawlId: report.crawlId,
    });
  }

  // `bootSuccessRate` is booted/attempted — a SUCCESS rate. The published
  // framing is the failure ("did not start"), so the reported percentage is
  // 100 minus that, never the success-rate number relabelled with failure
  // language. That exact bug was caught before it shipped; see
  // friction-log.md.
  const didNotStartRate = 100 - report.bootSuccessRate;

  const findingSentence =
    `${didNotStartRate.toFixed(1)}% of public MCP servers with a discoverable install command did not start ` +
    `from their own documented setup instructions (${report.booted} booted of ${report.attempted} attempted; ` +
    `${report.noInstallPath} had no discoverable install path at all).`;

  return {
    source,
    crawlId: report.crawlId,
    candidatesConsidered: report.candidatesConsidered,
    noInstallPath: report.noInstallPath,
    attempted: report.attempted,
    booted: report.booted,
    refusedNoCreds: report.refusedNoCreds,
    failedInstall: report.failedInstall,
    failedStart: report.failedStart,
    failedTimeout: report.failedTimeout,
    bootSuccessRate: report.bootSuccessRate,
    didNotStartRate,
    findingSentence,
  };
}
