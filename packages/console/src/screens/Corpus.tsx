/**
 * /corpus — what two crawls of the public MCP registry actually found.
 *
 * Three designed states, and the one that matters is the middle one. From
 * crawl 1 (2026-09-15) to crawl 2 (2026-10-20) there is exactly one
 * observation, and this screen holds the partial state for all 35 of those
 * days. So partial is not "the complete screen with the numbers missing":
 * it plots a *finished* result (the crawl-1 sampling frame and the boot
 * rate) on the same four strata crawl 2 will be measured against, under a
 * prediction band that was on the record before either crawl ran. There
 * are no placeholder zeros and nothing is greyed out, because nothing is
 * broken — one of two scheduled observations has been taken.
 *
 * Every number here is read from a committed file at build time
 * (evidence.load.ts). No fetch, no database: the demo renders this screen
 * with the network off, and a judge can diff it against git.
 */
import type { CSSProperties, ReactNode } from "react";
import { bandVerdict, corpusState, daysUntil, intervalDays, strata, useEvidence, type Drift, type Evidence } from "../evidence";
import { PredictionTrack, type TrackMark } from "../components/Track";
import { Strata } from "../components/Strata";
import { EmptyState, ErrorBox, SkeletonBlock, SkeletonRows } from "../components/marks";
import { useOverride } from "../screenState";
import { useSearch } from "../router";
import { CORPUS_SPECIMEN_DRIFT } from "../fixtures";

const int = (n: number): string => n.toLocaleString("en-US");

/**
 * The provenance block: N, both ISO timestamps verbatim, the day count and
 * the taxonomy blob. Set like a form's filing stamp rather than as four
 * stat tiles — these are provenance, not metrics, and a KPI row would say
 * the opposite.
 */
function Filed({ ev, drift }: { ev: Evidence; drift: Drift | null }) {
  const days = intervalDays(drift);
  const bothCrawlN = drift?.n ?? null;
  const rows: Array<[string, ReactNode]> = [
    [
      "N",
      bothCrawlN !== null ? (
        <>
          <span className="num text-3 text-n-900">{int(bothCrawlN)}</span> servers captured in both crawls
        </>
      ) : ev.crawl1 !== null ? (
        <>
          <span className="num text-3 text-n-900">{int(ev.crawl1.capturedServers)}</span> servers captured at crawl 1 — the
          both-crawl N is not known until crawl 2 runs, and is not inferred from crawl 1
        </>
      ) : (
        "not yet observed"
      ),
    ],
    ["Crawl 1 started", ev.crawl1?.startedAt ?? drift?.crawl1StartedAt ?? "not yet run"],
    [
      "Crawl 2 started",
      drift?.crawl2StartedAt ?? ev.crawl2?.startedAt ?? `pending — scheduled ${drift?.crawl2ScheduledFor ?? "in CRAWL_DATES.md"}`,
    ],
    [
      "Interval",
      days === null ? (
        "not yet fixed"
      ) : (
        <>
          <span className="num text-3 text-n-900">{days}</span> days
          {drift?.crawl2StartedAt == null && " — pre-registered; re-derived from the two recorded timestamps once crawl 2 runs"}
        </>
      ),
    ],
    ["Taxonomy blob", ev.crawl1?.taxonomyBlobSha ?? drift?.taxonomyBlobSha ?? "not yet recorded"],
  ];
  return (
    <section aria-labelledby="filed-h" className="filed px-4 pt-3 pb-4">
      <h2 id="filed-h" className="label">
        Evidence · read from committed files, not from a database
      </h2>
      <dl className="mt-2 grid gap-x-8 gap-y-1 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-baseline gap-x-3 border-b-[length:var(--rule)] border-n-100 py-1">
            <dt className="label w-32 shrink-0 text-n-600">{k}</dt>
            <dd className="hash min-w-0 flex-1 break-all text-n-800">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 max-w-[60rem] text-1 text-n-600">
        The taxonomy value is a git <em>blob</em> hash — the hash of{" "}
        <span className="hash text-n-800">corpus/TAXONOMY.md</span>&rsquo;s exact bytes, not of the commit that last touched
        it, so an unrelated commit cannot move it. Check it with{" "}
        <span className="hash text-n-900">git rev-parse HEAD:corpus/TAXONOMY.md</span>.
      </p>
    </section>
  );
}

/** The boot-rate finding, printed verbatim from data/boot-rate.json. A published sentence is never recomputed here. */
function Finding({ sentence, detail }: { sentence: string; detail: string }) {
  return (
    <section aria-labelledby="finding-h" className="box p-4 sm:p-6">
      <h2 id="finding-h" className="label">
        Finding · crawl 1 · boot rate
      </h2>
      <p className="num mt-2 max-w-[48rem] text-finding text-n-900">{sentence}</p>
      <p className="mt-3 max-w-[60rem] text-1 text-n-600">{detail}</p>
    </section>
  );
}

function ScheduleBanner({ drift }: { drift: Drift }) {
  const days = daysUntil(drift.crawl2ScheduledFor, Date.now());
  return (
    <aside
      aria-label="Crawl 2 schedule"
      className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 rounded-form border-l-[length:var(--rule-heavy)] border-warn bg-warn-wash px-4 py-3"
    >
      <span className="max-w-[56rem] text-n-900">
        <span className="label mr-2 text-warn-ink">Observation 2 of 2</span>
        Crawl 2 is scheduled for <span className="num text-3">{drift.crawl2ScheduledFor}</span>, and runs against{" "}
        <span className="hash">corpus/candidates.json</span> exactly as frozen at crawl 1. A server added since then cannot
        appear in a drift comparison.
      </span>
      <span className="label shrink-0 text-warn-ink">
        {days > 0 ? (
          <>
            in <span className="num text-3 normal-case tracking-normal">{days}</span> days
          </>
        ) : days === 0 ? (
          "scheduled today"
        ) : (
          "date passed · not yet recorded"
        )}
      </span>
    </aside>
  );
}

function Frame({ subtitle, counter, children }: { subtitle: string; counter?: string; children: ReactNode }) {
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="label">{subtitle}</div>
          <h1 className="title mt-1">Corpus</h1>
        </div>
        {counter !== undefined && (
          <div className="text-right">
            <div className="num text-5 text-n-900">{counter}</div>
            <div className="label mt-1">Scheduled observations</div>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * Unmistakable, undismissable, and crimson. Whenever the complete layout is
 * on screen with numbers that were not measured, this is above it.
 */
function SpecimenBanner() {
  return (
    <aside
      role="alert"
      className="rounded-form border-[length:var(--rule-heavy)] border-blocked bg-blocked-wash px-4 py-3"
    >
      <span className="label text-blocked">Specimen · not a measurement</span>
      <p className="mt-1 max-w-[60rem] text-n-900">
        Every drift number below is <strong>invented</strong>, shown so the post-crawl-2 layout can be rehearsed and
        screenshotted before crawl 2 runs on <span className="num text-3">2026-10-20</span>. It is reachable only by
        typing <span className="hash text-n-900">?state=complete</span> into the URL. The real result will come from{" "}
        <span className="hash text-n-900">data/drift.json</span> and will render with no banner.
      </p>
    </aside>
  );
}

export function Corpus() {
  const ev = useEvidence();
  const override = useOverride();
  // `complete` is deliberately not one of the four documented overrides in
  // state.ts: it is /corpus-only, because it is the only screen with a
  // fourth state that cannot yet occur. readOverride() ignores it, so it
  // falls through to here.
  const specimen = new URLSearchParams(useSearch()).get("state") === "complete";

  if (override === "loading") {
    // Heights match the real sections so the page does not reflow when the
    // build-time data renders. See docs/UI-STATES.md.
    return (
      <Frame subtitle="Reading committed crawl reports">
        <SkeletonBlock label="Pre-registered prediction" height="124px" />
        <SkeletonBlock label="Crawl 2 schedule" height="64px" />
        <SkeletonBlock label="Finding · crawl 1 · boot rate" height="172px" />
        <SkeletonBlock label="Capability strata captured at crawl 1" height="300px" />
        <SkeletonRows rows={1} label="Evidence" height="200px" />
      </Frame>
    );
  }
  if (override === "error") {
    return (
      <Frame subtitle="Crawl reports could not be read">
        <ErrorBox
          error={new Error("The crawl report bundled into this build could not be parsed.")}
          what="the crawl reports"
          alsoIn="data/crawl-1-report.json and data/drift.json"
          onRetry={() => window.location.reload()}
        />
      </Frame>
    );
  }

  const evidence: Evidence = specimen ? { ...ev, drift: CORPUS_SPECIMEN_DRIFT } : ev;
  const state = override === "empty" ? "empty" : override === "partial" ? "partial" : corpusState(evidence);
  const drift = evidence.drift;

  if (state === "empty") {
    return (
      <Frame subtitle="No crawl data yet">
        <EmptyState label="No crawl data yet">
          <p>
            Neither crawl has been recorded. Both collection dates were committed to{" "}
            <span className="hash text-n-900">CRAWL_DATES.md</span> before any data existed — that commit timestamp is what
            makes them a pre-registration rather than a description of what already happened.
          </p>
          <dl className="mt-4 grid max-w-[40rem] gap-1">
            {(
              [
                ["Crawl 1", drift?.crawl1ScheduledFor, "baseline capture of every candidate's tools/list"],
                ["Crawl 2", drift?.crawl2ScheduledFor, "repeat capture against the same, frozen candidate list"],
              ] as const
            ).map(([k, date, why]) => (
              <div key={k} className="flex flex-wrap items-baseline gap-x-3 border-b-[length:var(--rule)] border-n-200 py-1">
                <dt className="label w-20 shrink-0">{k}</dt>
                <dd className="num text-3 w-28 text-n-900">{date ?? "see CRAWL_DATES.md"}</dd>
                <dd className="min-w-0 flex-1 text-1 text-n-600">{why}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-1 text-n-600">
            <span className="hash text-n-900">pnpm crawl:run --crawl-id=crawl-1</span> writes{" "}
            <span className="hash text-n-900">data/crawl-1-report.json</span>, which is what fills this screen.
          </p>
        </EmptyState>
        {drift !== null && <PredictionTrack drift={drift} marks={null} pendingLabel="no observation taken yet" />}
      </Frame>
    );
  }

  const complete = state === "complete" && drift !== null && drift.byCapability !== null;
  const rows = strata(evidence);
  const marks: TrackMark[] | null =
    complete && drift !== null && drift.byCapability !== null
      ? drift.byCapability.map((s) => ({ label: s.capabilityClass, ratePct: s.ratePct, verdict: bandVerdict(s.ratePct, drift) }))
      : null;

  return (
    <Frame
      subtitle={specimen ? "Specimen layout \u2014 numbers are invented" : complete ? "Both observations recorded" : "Observation 1 of 2 recorded"}
      counter={complete ? "2 of 2" : "1 of 2"}
    >
      {specimen && <SpecimenBanner />}
      {drift !== null && (
        <PredictionTrack drift={drift} marks={marks} pendingLabel={`measurement due ${drift.crawl2ScheduledFor}`} />
      )}

      {!complete && drift !== null && <ScheduleBanner drift={drift} />}

      {complete && drift?.semanticIntent != null && (
        <section aria-labelledby="head-h" className="box p-4 sm:p-6">
          <h2 id="head-h" className="label">
            Headline · semantic-intent only
          </h2>
          <p className="num mt-2 max-w-[48rem] text-finding text-n-900">
            {drift.semanticIntent.ratePct.toFixed(1)}% of the {int(drift.semanticIntent.servers)} servers captured in both
            crawls changed at least one tool&rsquo;s stated intent across {intervalDays(drift)} days.
          </p>
          <p className="mt-3 max-w-[60rem] text-1 text-n-600">
            {int(drift.semanticIntent.drifted)} of {int(drift.semanticIntent.servers)} servers. Only{" "}
            <span className="hash text-n-800">semantic-intent</span> changes are in this number; cosmetic and
            schema-additive changes are counted below and never folded in.
          </p>
        </section>
      )}

      {ev.bootRate !== null && (
        <Finding
          sentence={ev.bootRate.findingSentence}
          detail={`Verbatim from data/boot-rate.json. ${int(ev.bootRate.candidatesConsidered)} candidates were considered; ${int(
            ev.bootRate.noInstallPath,
          )} had no discoverable install command and were never attempted, so the rate is over the ${int(
            ev.bootRate.attempted,
          )} that were.`}
        />
      )}

      <Strata
        rows={rows}
        measure={complete ? "rate" : "count"}
        caption={
          complete
            ? "Share of servers in each class with at least one semantic-intent change between the two crawls. Cosmetic and schema-additive changes are excluded from these bars."
            : `The frame crawl 2 is measured against: ${int(ev.crawl1?.totalToolsCaptured ?? 0)} tools from ${int(
                ev.crawl1?.capturedServers ?? 0,
              )} servers, classed at first observation and never re-derived. A population, not a drift rate.`
        }
      />

      {complete && drift !== null && (
        <section aria-labelledby="sep-h" className="rounded-form border-[length:var(--rule)] border-dashed border-n-200 bg-n-50 p-4">
          <h2 id="sep-h" className="label text-n-600">
            Counted separately · never inside a headline number
          </h2>
          <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-1">
            {/* Printed with the Axis-1 names corpus/TAXONOMY.md uses, not the JSON key spelling. */}
            {(
              [
                ["cosmetic", "cosmetic"],
                ["schemaAdditive", "schema-additive"],
                ["toolAdded", "tool-added"],
                ["toolRemoved", "tool-removed"],
              ] as const
            ).map(([k, label]) => {
              const v = drift.countedSeparately[k];
              return typeof v !== "number" ? null : (
                <div key={k} className="flex items-baseline gap-2">
                  <dt className="text-n-600">{label}</dt>
                  <dd className="num text-3 text-n-900">{int(v)}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}

      <Filed ev={evidence} drift={drift} />
    </Frame>
  );
}

/** Exported for the snapshot suite, which pins the band geometry independently of the screen. */
export const bandStyleFor = (drift: Drift): CSSProperties =>
  ({ "--from": `${drift.prediction.lowPct}%`, "--to": `${drift.prediction.highPct}%` }) as CSSProperties;
