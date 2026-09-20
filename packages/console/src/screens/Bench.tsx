/**
 * /bench — the latency Chaperone adds, and the rate at which real public
 * MCP servers start at all.
 *
 * Two numbers with very different provenance, deliberately on one screen
 * and deliberately labelled apart: the latency is measured against this
 * repo at a named commit, and the boot rate is measured against other
 * people's servers at a named crawl. Both are read from committed files at
 * build time (evidence.load.ts) — no fetch, no database, no live probe.
 *
 * `benchmarks/latency.json` does not exist yet: the bench harness is not
 * built. So the ready state renders whatever a real run wrote, and the
 * default today is the empty state, which says what would produce the
 * file. It does not show a zero, an estimate, or a number from anywhere
 * else — an invented p95 is worse than an honest blank.
 */
import type { ReactNode } from "react";
import { benchState, staleness, useEvidence, type Latency } from "../evidence";
import { EmptyState, ErrorBox, SkeletonBlock, SkeletonRows } from "../components/marks";
import { useOverride } from "../screenState";
import { short } from "../lib";

const int = (n: number): string => n.toLocaleString("en-US");

function Frame({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="grid gap-6">
      <div>
        <div className="label">{subtitle}</div>
        <h1 className="title mt-1">Bench</h1>
      </div>
      {children}
    </div>
  );
}

/**
 * One percentile. The budget is drawn as a rule on the same scale as the
 * bar, so "inside budget" is a spatial fact rather than a colour that has
 * to be decoded from a legend.
 */
function Percentile({ label, ms, budgetMs, scaleMs }: { label: string; ms: number; budgetMs: number; scaleMs: number }) {
  const over = ms > budgetMs;
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="label">{label}</span>
        <span className={`num text-5 ${over ? "text-blocked" : "text-n-900"}`}>
          {ms.toFixed(1)}
          <span className="text-2 text-n-600"> ms</span>
        </span>
      </div>
      <div className="relative h-6 border-[length:var(--rule)] border-accent bg-n-0">
        <span
          className="absolute inset-y-0 left-0"
          style={{ width: `${Math.min(100, (ms / scaleMs) * 100)}%`, background: over ? "var(--blocked)" : "var(--accent)" }}
        />
        <span
          className="absolute inset-y-[-4px] border-l-[length:var(--rule-heavy)] border-dashed border-warn"
          style={{ left: `${Math.min(100, (budgetMs / scaleMs) * 100)}%` }}
          title={`Budget: ${budgetMs}ms`}
        />
      </div>
    </div>
  );
}

function StaleBanner({ recorded, head }: { recorded: string; head: string }) {
  return (
    <aside
      role="alert"
      className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 rounded-form border-l-[length:var(--rule-heavy)] border-blocked bg-blocked-wash px-4 py-3"
    >
      <span className="max-w-[56rem] text-n-900">
        <span className="label mr-2 text-blocked">Stale</span>
        These numbers were recorded against a different commit than the one checked out. Treat them as history, not as a
        measurement of this code.
      </span>
      <span className="hash shrink-0 text-n-800">
        recorded {short(recorded)} · HEAD {short(head)}
      </span>
    </aside>
  );
}

function Latencies({ latency, stale }: { latency: Latency; stale: boolean }) {
  const scale = Math.max(latency.budgetP95Ms, latency.addedP99Ms) * 1.25;
  return (
    <section aria-labelledby="lat-h" className={`box p-4 sm:p-6 ${stale ? "border-n-200" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id="lat-h" className="label">
          Added latency · gateway versus the same call direct to the upstream
        </h2>
        <span className="text-1 text-n-600">
          <span className="num text-2 text-n-900">{int(latency.samples)}</span> samples · budget p95{" "}
          <span className="num text-2 text-n-900">{latency.budgetP95Ms}</span> ms
        </span>
      </div>
      <div className="mt-4 grid gap-6 sm:grid-cols-3">
        <Percentile label="p50" ms={latency.addedP50Ms} budgetMs={latency.budgetP95Ms} scaleMs={scale} />
        <Percentile label="p95" ms={latency.addedP95Ms} budgetMs={latency.budgetP95Ms} scaleMs={scale} />
        <Percentile label="p99" ms={latency.addedP99Ms} budgetMs={latency.budgetP95Ms} scaleMs={scale} />
      </div>
      <dl className="mt-6 grid gap-x-8 gap-y-1 text-1 sm:grid-cols-2">
        {(
          [
            ["Commit", latency.commitSha],
            ["Recorded", latency.recordedAt],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-baseline gap-x-3 border-b-[length:var(--rule)] border-n-100 py-1">
            <dt className="label w-24 shrink-0 text-n-600">{k}</dt>
            <dd className="hash min-w-0 flex-1 break-all text-n-800">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Boot rate. Shown on /bench as well as /corpus because it is the other half of "what does this cost" — a gateway is fast is not interesting if the servers behind it do not start. */
function BootRate() {
  const { bootRate } = useEvidence();
  if (bootRate === null) {
    return (
      <EmptyState label="No boot rate recorded">
        <p>
          <span className="hash text-n-900">pnpm crawl:boot-rate</span> derives this from{" "}
          <span className="hash text-n-900">data/crawl-1-report.json</span> and writes{" "}
          <span className="hash text-n-900">data/boot-rate.json</span>.
        </p>
      </EmptyState>
    );
  }
  return (
    <section aria-labelledby="boot-h" className="box p-4 sm:p-6">
      <h2 id="boot-h" className="label">
        Boot success · {bootRate.crawlId} · other people&rsquo;s servers, not this one
      </h2>
      <p className="num mt-2 max-w-[48rem] text-finding text-n-900">{bootRate.findingSentence}</p>
      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2">
        {(
          [
            ["booted", bootRate.booted],
            ["attempted", bootRate.attempted],
            ["no install path", bootRate.noInstallPath],
            ["candidates", bootRate.candidatesConsidered],
          ] as const
        ).map(([k, v]) => (
          <span key={k} className="flex items-baseline gap-2">
            <span className="num text-4 text-n-900">{int(v)}</span>
            <span className="label text-n-600">{k}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

export function Bench() {
  const ev = useEvidence();
  const override = useOverride();

  if (override === "loading") {
    return (
      <Frame subtitle="Reading committed benchmark files">
        <SkeletonBlock label="Added latency" height="360px" />
        <SkeletonRows rows={1} label="Boot success" height="216px" />
      </Frame>
    );
  }
  if (override === "error") {
    return (
      <Frame subtitle="Benchmark files could not be read">
        <ErrorBox
          error={new Error("The benchmark file bundled into this build could not be parsed.")}
          what="the benchmark results"
          alsoIn="benchmarks/latency.json and data/boot-rate.json"
          onRetry={() => window.location.reload()}
        />
      </Frame>
    );
  }

  // `partial` on this screen means what it means everywhere else here: some
  // of the evidence is recorded and some is not. That is literally today —
  // the boot rate is committed, the latency file is not — so partial and
  // the real default render the same thing rather than a special case.
  const state = override === "empty" ? "empty" : override === "partial" ? "empty" : benchState(ev);
  const stale = staleness(ev.latency, ev.headSha);

  return (
    <Frame subtitle={state === "empty" ? "Latency not yet recorded · boot rate recorded" : "Measured against a named commit"}>
      {state === "empty" ? (
        <EmptyState label="No latency run recorded">
          <p>
            Nothing has written <span className="hash text-n-900">benchmarks/latency.json</span> yet, so there is no p50, p95
            or p99 to show. The gap is real and this screen leaves it blank on purpose: a placeholder zero here would be a
            claim that Chaperone adds no latency, which nobody has measured.
          </p>
          <p className="mt-3">
            <span className="hash text-n-900">pnpm bench</span> runs the same MCP call through the gateway and direct to the
            upstream, records the difference at three percentiles against the HEAD commit, and exits non-zero if the added
            p95 is over its 30 ms budget.
          </p>
          {ev.headSha !== null && (
            <p className="mt-3 text-1 text-n-600">
              This build was made at <span className="hash text-n-900">{short(ev.headSha, 12)}</span>; a run recorded against
              any other commit will be flagged stale here.
            </p>
          )}
        </EmptyState>
      ) : (
        ev.latency !== null && (
          <>
            {stale.stale && stale.recorded !== null && stale.head !== null && (
              <StaleBanner recorded={stale.recorded} head={stale.head} />
            )}
            {stale.reason === "unknown" && (
              <aside className="rounded-form border-l-[length:var(--rule-heavy)] border-n-400 bg-n-100 px-4 py-3 text-n-800">
                <span className="label mr-2 text-n-600">Unverified</span>
                HEAD could not be read at build time, so whether these numbers describe the checked-out code is unknown. It
                is not treated as a match.
              </aside>
            )}
            <Latencies latency={ev.latency} stale={stale.stale} />
          </>
        )
      )}
      <BootRate />
    </Frame>
  );
}
