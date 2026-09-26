# Appendix — additions to the shape of `data/drift.json`

Additive. `corpus/TAXONOMY.md` and `corpus/PREDICTIONS.md` are frozen and are
not edited by this file, and neither is `data/drift.json`. Its `$comment`
says a field that is not in the file "cannot be added later without an
additive appendix commit". This is that commit, for five fields the analysis
needs and the pending file does not have: `attempted`, `capturedBothCrawls`,
`headlineEligible` (with `headlineSuppressedReason`), `riderC` and
`timeToFirstChange`.

**Added 2026-09-26.** That is after crawl 1 (2026-09-15) and before the
interim crawl (planned 2026-10-02, not pre-registered; see the appendix in
`CRAWL_DATES.md`) and before crawl 2 (2026-10-20), so no drift between two
crawls has been observed when these definitions are fixed. The original shape
was committed on 2026-09-20 (`e7a453b`), also after crawl 1, so its `$comment`
calling that shape "pre-registered" overstates it; "fixed before crawl 2" is
the accurate description of the original shape and of this appendix. Only
`corpus/PREDICTIONS.md`, `corpus/TAXONOMY.md` and `CRAWL_DATES.md` were
committed before crawl 1.

Nothing here changes what counts as drift. The headline is still crawl 1
against crawl 2, 2026-09-15 to 2026-10-20, **35 days**, and only
`semantic-intent` changes enter it.

## What is added

```jsonc
{
  "attempted": { "crawl1": 291, "interim": null, "crawl2": null },
  "capturedBothCrawls": { "count": null, "serverIds": null },
  "headlineEligible": null,
  "headlineSuppressedReason": null,
  "riderC": {
    "status": "not-evaluated",
    "gate": "semanticDriftRate >= 0.20 && n >= 100",
    "gateMet": null,
    "predictionSource": "corpus/PREDICTIONS.md, prediction 3",
    "predictedShareBelow": 0.3,
    "windowStart": null,
    "windowEnd": null,
    "driftedServers": null,
    "checkable": null,
    "unverifiable": null,
    "withPublishedSignal": null,
    "evidenceCounts": { "release": null, "tag": null, "commit-message": null, "none": null },
    "shareWithSignalOfCheckable": null
  },
  "timeToFirstChange": {
    "headline": false,
    "basis": "interval-censored; see below",
    "observedAtInterim": null,
    "firstObservedOnlyAtCrawl2": null,
    "changedThenRevertedByCrawl2": null,
    "daysCrawl1ToInterim": null,
    "daysInterimToCrawl2": null
  }
}
```

Every value is `null` until the analysis fills it, except
`attempted.crawl1`, which is copied from `data/crawl-1-report.json`
(`attempted`: 291; the same report has 152 servers booted with at least one
tool captured). `pnpm analyse:drift` must fail, not omit, if it cannot
produce a field.

## Definitions

**`attempted`** is each crawl report's own `attempted` field: candidates
considered minus those with no discoverable install path, i.e. the servers a
boot was actually tried for. It is the denominator behind each crawl's boot
rate, carried here so the drift file states how many servers each crawl tried
and not only how many succeeded. `interim` is the interim crawl's figure
(`data/crawl-interim-1-report.json`); it is context only.

**`capturedBothCrawls`** is the set of servers that booted and returned at
least one tool in **both** crawl 1 and crawl 2: the intersection of
`bootedServerIds` in `data/crawl-1-report.json` and `data/crawl-2-report.json`.
`serverIds` is that list, sorted, written out in full for the reason
`bootedServerIds` is: the comparison is a diff over an explicit set, not over
something rebuilt from table rows later. The top-level `n` must equal `count`,
and the analysis fails if it does not. Crawl 1 alone bounds it above at 152.
The interim crawl never adds or removes a server here.

**`headlineEligible`** is `true` when `capturedBothCrawls.count >= 100` and
`false` otherwise; it is `null` until crawl 2. The floor is the plan's
minimum N for a rate to be quoted. When it is `false`,
`headlineSuppressedReason` states the count and the floor (for example
`"n = 87 servers captured in both crawls; the floor is 100"`), and no
document, page or script states a semantic-intent drift *rate* as the
headline. The counts are still emitted and published with their n. When it is
`true`, `headlineSuppressedReason` is `null`. A low rate is reported as a
low rate, and a rate that fails the gate is not rounded up into a headline by
a hopeful reading of a smaller denominator.

**`riderC`** is the test of `corpus/PREDICTIONS.md` prediction 3: *conditional
on drift of at least 20%, fewer than 30% of the servers with a
`semantic-intent` change publish any signal of it.*

- `gateMet` is `true` only if the semantic-intent drift rate is at least
  0.20 **and** `headlineEligible` is `true`. If it is `false`, `status` is
  `"gate-not-met"`, every count below stays `null`, and the prediction is
  reported as untested. It is not reported as confirmed or refuted.
- `windowStart` and `windowEnd` are `crawl1StartedAt` and `crawl2StartedAt`.
  A signal only counts if it falls inside that window.
- `driftedServers` is the number of servers in `capturedBothCrawls` with at
  least one `semantic-intent` event.
- A drifted server is `checkable` if `corpus/candidates.json` gives it a
  `repoOwner` and `repoName`, and `unverifiable` if not. The join reads the
  committed `corpus/candidates.json`, not the DynamoDB `corpus-server` table.
  `checkable + unverifiable = driftedServers`.
- `withPublishedSignal` counts checkable servers for which
  `checkChangelog` (`packages/advisory/src/changelog.ts`) returns anything but
  `"none"` for the window. `evidenceCounts` breaks that down by the strongest
  evidence found: `release`, then `tag`, then `commit-message`, then `none`.
  A commit counts as a signal, which is generous to the "publishes a signal"
  side; the breakdown lets a reader discount it.
- `shareWithSignalOfCheckable` is `withPublishedSignal / checkable`. Because
  unverifiable servers cannot be shown to have published anything, the
  analysis also reports the share with them counted as **not** signalling
  (`withPublishedSignal / driftedServers`) in prose beside this one. The
  prediction is judged against both bounds, and if they straddle 0.30 the
  result is reported as inconclusive.

**`timeToFirstChange`** is a supplementary time-series field. Its purpose is
to show *when*, inside the 35 days, semantic-intent changes first became
observable, so a low or zero headline rate is not the only thing the drift
file can say. **Nothing under it is a headline**, and any rate derived from it
is labelled a segment, as `CRAWL_DATES.md`'s appendix already requires.

Servers are only observed on three dates, so the field is interval-censored
and does not carry a per-server number of days or a median:

- `observedAtInterim` counts servers in `capturedBothCrawls` that already show
  a `semantic-intent` change at the interim crawl against crawl 1. The change
  happened between day 0 and the interim crawl.
- `firstObservedOnlyAtCrawl2` counts servers with a `semantic-intent` change
  at crawl 2 that were unchanged at the interim crawl. The change happened
  after the interim crawl.
- `changedThenRevertedByCrawl2` counts servers whose definition differed at the
  interim crawl and matches crawl 1 again at crawl 2 (same `sha256`). A
  two-point comparison cannot see these; they are why the interim crawl is
  kept. They are **not** in the headline, because at crawl 2 the definition
  is unchanged from crawl 1.
- `daysCrawl1ToInterim` and `daysInterimToCrawl2` are the whole days between
  each report's `startedAt`. They must add to the interval measured between
  `crawl1StartedAt` and `crawl2StartedAt`. If the interim crawl runs on
  2026-10-02 they are 17 and 18, and 35 in total.

A server counts in `observedAtInterim` or `firstObservedOnlyAtCrawl2` only if
it also has a `semantic-intent` change at crawl 2. The interim crawl can add
context to a server that appears in the headline, but it cannot put one there.
If the interim crawl does not run, or captures too few servers to be
useful, these fields stay `null` and the headline is unaffected.

## What this appendix does not settle

- The `checkChangelog` window and the 30% bound are read off prediction 3's
  own wording. The 100-server floor and the 0.20 gate come from the plan, not
  from `corpus/PREDICTIONS.md`, and are stated here so they are written down
  before crawl 2 exists.
- Whether `checkChangelog` is a good measure of "a signal a resident could
  plausibly have seen" is a limitation to be listed in `docs/LIMITATIONS.md`
  with the result, not a definition to be adjusted after seeing it.
