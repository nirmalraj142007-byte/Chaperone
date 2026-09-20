# UI states

Every route in `packages/console` has four designed states, and every one
of them is reachable from a URL.

That is not a convenience. A state you cannot reach is a state nobody
designed, and the states that matter most here are the ones that are hard
to produce on demand: a gateway that is down, a queue that is empty, a
corpus with one of two crawls taken. Those are exactly the frames a judge
is most likely to see, and exactly the frames that would otherwise be
verified by squinting.

## The override

Append `?state=` to any route:

| value | what it forces |
|---|---|
| `empty` | the screen with nothing in it, as designed |
| `loading` | skeletons, at the dimensions of the content they stand in for |
| `error` | a real 503 (`{"error":"storage_unavailable"}`), the shape the gateway sends when DynamoDB is unreachable |
| `partial` | some evidence present, some not — see the table below |

```
http://localhost:5173/queue?state=empty
http://localhost:5173/queue/any-id?state=partial
http://localhost:5173/ledger?state=error
http://localhost:5173/corpus?state=loading
http://localhost:5173/bench?state=empty
http://localhost:5173/upstreams?state=partial
```

An unrecognised value is ignored and the screen renders live
(`readOverride` in `src/state.ts`). The override survives an in-screen
navigation — clicking a queue filter chip under `?state=empty` keeps the
override rather than silently dropping back to live data.

### How it is applied

At the **view boundary**, not inside the render path:

```
TanStack Query result ──viewOf()──▶ View<T> ──applyOverride()──▶ View<T> ──▶ the same JSX
```

`applyOverride` (`src/state.ts`) swaps the *data*, never the components.
An overridden screen therefore goes through exactly the same JSX as a live
one, which is what makes a screenshot taken this way worth anything: if it
looks right under `?state=error`, it looks right when the gateway is
actually down.

The top-of-page chain (`Perforation`) obeys the override too, so
`?state=loading` is the whole page loading rather than the body only.

### Fixtures

`src/fixtures.ts`. They ship in the bundle, on purpose — the overrides are
a documented surface, so their data has to be there. Every id is prefixed
`fixture-`, so a fixture row cannot be mistaken for a real quarantine in a
screenshot or a bug report, and nothing here is reachable without an
explicit `?state=` in the URL. The one write the console can make goes
through the gateway's token-checked approve path, which rejects a fixture
id outright because no such quarantine exists.

## What each state means per route

| route | empty | loading | error | partial |
|---|---|---|---|---|
| `/queue` | **the healthy state.** "Nothing has changed since you approved it." Ledger green, not grey | rows at `--row-queue` | 503 + retry | list served, advisory scores not generated yet — unscored rows sort first |
| `/queue/:id` | no quarantine with that id | the loaded two-column layout, as skeletons | 503 + retry | **the normal case:** the advisory is missing. It is generated asynchronously and the decision never waits on it |
| `/ledger` | no events; names `pnpm pin:bootstrap` | rows at `--row-ledger` | 503 + retry | events listed, verifier has not answered — nothing is inked, nothing is claimed verified |
| `/corpus` | pre-crawl-1; names both committed target dates | five blocks matching the five sections | build-time file unparseable; points at the committed JSON | **the 35-day state.** See below |
| `/bench` | no `benchmarks/latency.json`; names `pnpm bench` | two blocks | build-time file unparseable | same as empty — latency missing, boot rate present, which is literally today |
| `/upstreams` | no `CHAPERONE_UPSTREAMS` configured | rows at `--row-upstream` | 503 + retry | one connected, one not yet dialled |

## `/corpus`, and why partial is the important one

Crawl 1 ran 2026-09-15. Crawl 2 runs 2026-10-20. For those **35 days**
there is exactly one observation, so the partial state is not an edge case
— it is what the screen shows for most of the project's life, and it has to
look intentional rather than broken.

It is built so that it does:

- **The prediction track is the signature and it needs no data.** The
  20–40% band from `corpus/PREDICTIONS.md` went into git on 2026-09-12,
  before either crawl. Drawing it is showing a finished artifact, not
  reserving space for a missing one. The pending measurement is a dashed
  plumb line with a date on it.
- **The chart plots a different, finished measure on the same four
  strata.** Partial shows the crawl-1 capability population — the frame
  crawl 2 is measured against. Complete shows semantic-intent drift rate
  per class. Sharing the four rows is the point: the partial chart is the
  sampling frame, not a placeholder for the drift chart.
- **No placeholder zeros, nothing greyed out.** There is no dimmed axis, no
  `0%`, no empty bar. A test asserts this: `states.test.tsx` fails if the
  partial render contains `>0<` or `>0.0%<`, or the words "no data".
- **The banner states the schedule** rather than apologising for it, with a
  live day count to 2026-10-20.

State resolution is `corpusState()` in `src/evidence.ts` and is driven by
`data/drift.json`'s own `status` field, **not** by the file existing. The
file is committed in `pending` form before crawl 2 precisely so the shape
is pre-registered too. A drift file that exists but says `pending` is still
the partial state; a file that says `complete` but carries no
`byCapability` breakdown is also still partial, because a headline without
its strata is what a half-finished analysis produces.

## Where the numbers come from

`/corpus` and `/bench` never fetch. `evidence.load.ts` reads the committed
files at **build time** and the `chaperone-evidence` Vite plugin inlines
them:

```
data/crawl-1-report.json ─┐
data/crawl-2-report.json  │
data/boot-rate.json       ├─▶ virtual:chaperone-evidence ─▶ bundle
data/drift.json           │
benchmarks/latency.json  ─┘        + git rev-parse HEAD
```

This is Risk R5: the demo renders these two screens with the network off,
and a judge can diff what is on screen against what is in git. A missing
file becomes `null` and the screen renders its designed empty state — it is
never an error and never a zero. The files are watched in dev, so editing
`data/drift.json` reloads the page.

## Layout shift

Skeletons and the rows they stand in for take their height from the **same**
custom property — `--row-queue`, `--row-ledger`, `--row-upstream`,
`--row-detail` in `src/tokens.css` — rather than from two literals that
happen to match today.

`states.test.tsx` asserts that both the loading and loaded markup reference
the token, so a skeleton that hard-coded a matching number would fail the
first time a row grew, instead of passing a screenshot diff and drifting
silently.

## Tests

```
pnpm --filter @chaperone/console test
```

24 route × state snapshots, plus `/corpus`'s three real data-driven states,
`/bench`'s stale and unverified-HEAD cases, and `/upstreams` with and
without the rehearsal control. Snapshots are HTML files under
`packages/console/test/__snapshots__/`, so a diff is readable in a pull
request.

The clock is frozen at `2026-09-20T12:00:00Z` and `fetch` is stubbed to
never settle, so every query stays pending and the override is the only
thing deciding what renders. A snapshot that passed because a request
happened to fail fast would not be a test.

## Demo controls

The rehearsal control on `/upstreams` — which fires demo-upstream's
scripted `add_item` mutation — is compiled out unless the build sets
`VITE_DEMO_CONTROLS=true`:

```bash
VITE_DEMO_CONTROLS=true pnpm --filter @chaperone/console build
```

It is absent by default. A button that changes what a tool claims is the
one thing this product exists to catch, and it has no business existing in
a household build.
