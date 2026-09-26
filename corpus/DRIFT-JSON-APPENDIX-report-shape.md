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

---

## Addendum: three snapshots, pairing, labels (added 2026-09-26; additive)

Everything above this line is unchanged. This section is appended before the
interim crawl (planned 2026-10-02) and before crawl 2 (2026-10-20), in the
same commit-before-code order as the section above: it is committed on its
own, and `packages/analysis` is written against it afterwards. No drift
between two crawls has been observed when it is written. The only comparison
the analysis has been run on is crawl 1 against itself, which must show zero
change.

The headline is unchanged: crawl 1 against crawl 2 only, `semantic-intent`
only. The interim crawl (`crawl-interim-1`) is used for three things and
nothing else: segment drift counts (structure, never a headline), the two
time-to-first-change bins, and reversions.

### Inputs, fixed

- Tool definitions come from the committed raw archives,
  `data/raw/{crawlId}/{serverId}.json`, one per server, read only for the
  servers in that crawl report's `bootedServerIds`. Hashes are recomputed
  from them with `hashTool` from `@chaperone/policy`. The DynamoDB
  `tool-snapshot` and `corpus-server` tables are not read.
- Crawl 1's capability classes come from `data/crawl-1-capabilities-v2.json`.
  The interim crawl's and crawl 2's come from `data/{crawlId}-capabilities.json`,
  and every row there must say `"classifierVersion": "v2"`. For every tool in
  every snapshot, the analysis also re-runs `classifyCapability(tool, "v2")`
  on the archived text and fails if the recomputed class differs from the
  recorded one. It then runs `findCapabilityClassifierArtifacts` between
  crawl 1 and each later snapshot and fails if the result is non-empty.
- The repository join for rider C reads `corpus/candidates.json`.
- If a report's `bootedServerIds` disagrees with the set of `BOOTED` archives
  that have at least one tool, the analysis fails. If a later crawl captured a
  server that is not in `corpus/candidates.json`, the analysis fails.

### Pre-registration gates, enforced before any number is computed

- **Taxonomy date.** The analysis finds the earliest commit that contains the
  `corpus/TAXONOMY.md` blob named in crawl 1's report (`taxonomyBlobSha`, a
  blob hash, not a commit hash) and refuses to run if that commit's committer
  timestamp is later than crawl 1's `startedAt`. It also refuses if a later
  crawl's report, or the file in the working tree, names a different blob.
- **Interval.** `interval`, `daysCrawl1ToInterim` and `daysInterimToCrawl2`
  are the difference in UTC calendar dates between the two reports'
  `startedAt` values. They are computed from the timestamps every time, never
  copied from a constant. If crawl 2 runs on a date other than 2026-10-20, the
  interval is whatever the timestamps say, and it is reported as such.
- **Floor.** Unchanged from above: `headlineEligible` is `capturedBothCrawls.count >= 100`.
  When it is `false`, every `ratePct` in the file is `null`, including the
  segment and per-capability ones, and only counts are emitted.
- **Rider C gate.** Unchanged from above.

### Fields added

```jsonc
{
  "pairing": {
    "basis": "crawl 1 bootedServerIds, joined on (serverId, toolName)",
    "presentInBoth":            { "servers": null, "tools": null },
    "toolAdded":                { "servers": null, "tools": null },
    "toolRemoved":              { "servers": null, "tools": null },
    "serverAbsentInLaterCrawl": { "servers": null, "tools": null, "serverIds": null }
  },
  "toolEvents": {
    "unchanged": null, "cosmetic": null, "schemaAdditive": null,
    "semanticIntent": null, "toolAdded": null, "toolRemoved": null
  },
  "classifier": {
    "version": "v2",
    "crawl1Source": "data/crawl-1-capabilities-v2.json",
    "laterSources": null,
    "recomputedMismatches": 0,
    "artifacts": []
  },
  "labels": {
    "required": null, "human": null, "mechanical": null, "humanOverrodeProposal": null,
    "labelsFile": "data/labels.json", "taxonomyBlobSha": null
  },
  "segments": {
    "headline": false,
    "crawl1ToInterim": { "n": null, "semanticIntentServers": null, "ratePct": null, "toolEvents": null },
    "interimToCrawl2": { "n": null, "semanticIntentServers": null, "ratePct": null, "toolEvents": null }
  },
  "timeToFirstChange": {
    "driftedNotCapturedAtInterim": null,
    "reversions": null
  },
  "riderC": {
    "gateReason": null,
    "shareWithSignalOfDrifted": null,
    "verdict": null,
    "windowEndEnforced": false,
    "checkedAt": null,
    "perServer": null
  },
  "sentences": { "flat": null, "stratified": null }
}
```

`timeToFirstChange` and `riderC` above list only the keys they gain; the keys
defined in the section above stay as they are.

### Definitions

**`pairing`** has the four buckets, all computed over crawl 1's
`bootedServerIds`:

- `presentInBoth`: servers in `capturedBothCrawls`, and the
  `(serverId, toolName)` pairs present in both crawls for those servers. The
  pair count is the denominator for every tool-level count below.
- `toolAdded` / `toolRemoved`: tools present only in the later / only in the
  earlier crawl, for a server in `capturedBothCrawls`. `servers` is how many
  servers have at least one.
- `serverAbsentInLaterCrawl`: servers booted with tools at crawl 1 that did
  not at the later crawl, for any reason. This is a boot outcome, not a
  `tool-removed` event (TAXONOMY.md), so their tools are counted here and
  nowhere else.

A server that booted at the later crawl but not at crawl 1 cannot enter the
comparison. It is counted in the console output and nowhere in the file.

Duplicate tool names inside one server's `tools/list` make the join
ambiguous, so the analysis fails on one rather than picking a pair.

**`toolEvents`** counts tool pairs by final change class, plus added and
removed tools. `countedSeparately`'s four values, whose unit the original
shape did not state, are these same tool counts.

**Change class** is proposed mechanically, then confirmed by a person
wherever the mechanism is not certain:

| Description change | Schema change | Proposal | Needs a human label |
|---|---|---|---|
| none, or formatting only | none | `cosmetic` | no |
| none, or formatting only | additive only (`describeDiff(...).schemaAdditiveOnly`) | `schema-additive` | no |
| any | not additive (a new required field, a removed property, a narrowed enum, a type change) | `semantic-intent` | yes |
| words changed | any | `semantic-intent` | yes |

"Formatting only" means the two descriptions are equal after lower-casing and
removing every character that is not a letter or a digit: whitespace,
punctuation, capitalisation and markdown markers. A changed, added or removed
word, typo fixes included, is not formatting only, so it goes to a person,
because TAXONOMY.md says "If in doubt between `cosmetic` and
`semantic-intent`, it is not `cosmetic`". A human label can be any of
`cosmetic`, `schema-additive` or `semantic-intent`, and it replaces the
proposal. Only a final class of `semantic-intent` enters the headline.

**Labels** live in `data/labels.json`, keyed by
`serverId | toolName | beforeSha256 | afterSha256`. Each records `label`,
`proposed`, `labeledBy`, `labeledAt` and the git blob hash of
`corpus/TAXONOMY.md` read at labelling time. `labeledBy` is a person and is
never `model`. A label made on the interim comparison is reused for crawl 2
only when the key is identical, which is when crawl 2's definition is
byte-identical to the interim one. The analysis refuses a label whose
taxonomy blob differs from crawl 1's, and it fails, writing
`data/labels-todo.json` and not `data/drift.json`, while any required label
is missing or recorded as `skip`. `labels.required` counts pairs needing a
label across the headline and both segments, `human` and `mechanical` count
final classes by source, and `humanOverrodeProposal` counts human labels that
differ from the proposal.

**`semanticIntent`** is `{ servers, drifted, ratePct }`: `servers` is `n`,
`drifted` is how many of them have at least one tool pair whose final class
is `semantic-intent`, and `ratePct` is `100 * drifted / servers` to one
decimal, or `null` when `headlineEligible` is `false`.

**`byCapability`** has one entry per capability class, always four, in
TAXONOMY.md's order of consequence (`transact`, `communicate`, `write`,
`read`). Each server in `capturedBothCrawls` is placed in exactly one stratum:
the highest v2 class among its crawl-1 tools, by TAXONOMY.md's disambiguation
order. The class is assigned at crawl 1 and never re-derived. Each entry is
`{ capabilityClass, servers, drifted, ratePct }`, the strata's `servers` sum
to `n`, and their `drifted` values sum to `semanticIntent.drifted`.

**`segments`** is `null` when the interim crawl has no report. Otherwise both
segments are computed over the servers in `capturedBothCrawls` that also
booted with tools at the interim crawl. That count is `n` for both segments,
and each segment has its own `toolEvents` and `semanticIntentServers`.
`ratePct` is `null` when that `n` is below 100. Segment figures are never a
headline, and wherever they are printed they are labelled as a segment.

**`timeToFirstChange`**'s two bins are the ones defined above, over
`semanticIntent.drifted`, and `driftedNotCapturedAtInterim` counts the rest.
The analysis fails unless
`observedAtInterim + firstObservedOnlyAtCrawl2 + driftedNotCapturedAtInterim = semanticIntent.drifted`.
No finer resolution than these two bins is claimed. `reversions` lists every
tool, for servers in the segment population, whose interim `sha256` differs
from crawl 1's and whose crawl-2 `sha256` equals crawl 1's again, as
`{ serverId, toolName, crawl1Sha256, interimSha256, interimClass }`.
`changedThenRevertedByCrawl2` is the number of distinct servers in that list.
A tool absent at the interim crawl and present again at crawl 2 is not a
reversion under this definition.

**`riderC`**'s `status` is one of `not-evaluated`, `gate-not-met` or
`evaluated`, and `gateReason` states why in words. When the gate is met,
`shareWithSignalOfDrifted` is `withPublishedSignal / driftedServers`. That is
the lower bound, with unverifiable servers counted as not signalling.
`verdict` is `confirmed` if both it and `shareWithSignalOfCheckable` are
below 0.30, `refuted` if both are at or above 0.30, and `inconclusive`
otherwise, including when `checkable` is 0. `checkChangelog` takes a start
date and no end date, so a signal published after `crawl2StartedAt` but
before the check runs is counted. `windowEndEnforced: false` records that.
Any such leak can only push the result toward "publishes a signal", which is
against the prediction. `perServer` lists
`{ serverId, repoOwner, repoName, evidence, evidenceUrl }` for each checkable
drifted server.

**`sentences`** holds the two sentences `pnpm analyse:drift` prints: the flat
headline and the capability-stratified one, both built from the numbers in
the file. When `headlineEligible` is `false`, neither contains a percentage.

### Where the file may be written

`data/drift.json` is written only by `pnpm analyse:drift` comparing
`crawl-1` with `crawl-2`, and it is then `status: "complete"`. Every other
comparison (crawl 1 against itself, crawl 1 against the interim crawl, and
any test fixture) writes nothing to `data/drift.json`, and the code refuses
the path.

### Prevalence sample (PREDICTIONS.md prediction 2), fixed before any label

- **Frame:** every tool captured at crawl 1 (6,058 tools), sorted by
  `(serverId, toolName)`.
- **Strata:** v2 capability class from `data/crawl-1-capabilities-v2.json`.
- **Allocation:** proportional to stratum size, 150 in total, rounded by
  largest remainder. The sample is then self-weighting, so the prevalence
  estimate is the plain share of `yes`, with no weights.
- **Draw:** within each stratum, a seeded partial Fisher-Yates using the
  crawler's own `seedFromString` / mulberry32 construction, seed
  `seedFromString("prevalence-crawl-1")`, so anyone can redraw the same 150.
- **Question:** "Is this description instruction-shaped: does it read as an
  instruction directed at the calling model, rather than a description for a
  person reading a catalogue?" The answer is `yes` or `no`, recorded with
  `labeledBy`, `labeledAt` and the taxonomy blob hash, in
  `data/prevalence.json`.
- **Reporting:** a share is stated only once all 150 are answered, with its
  n, against the 5–12% range. Until then only counts are reported.
