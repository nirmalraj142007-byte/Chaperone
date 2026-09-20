# Console

`packages/console` is a read-only supporting surface: React 19, Vite 6,
Tailwind 4, TanStack Query 5. It gets a five-second cutaway in the demo, so
this doc covers the design decisions and the data path. No feature list.

## Data path

```
browser ──GET /api/*──▶ vite proxy ──▶ gateway (packages/gateway/src/api.ts) ──▶ DynamoDB
browser ──POST /mcp───▶ vite proxy ──▶ gateway chaperone/approve_change (approve.ts)
```

- The browser has no AWS credentials. `/api/*` is five read-only GET routes.
  Nothing under `/api` writes a pin, a quarantine status or a ledger event.
- The console makes exactly one write: it calls `chaperone/approve_change`
  over `/mcp` as an ordinary MCP client. This is the same token-checked
  function the consent card reaches. The resident pastes the one-time token
  from the card. `/api` never serves the plaintext token or its hash; it
  only serves `tokenHeld: boolean`. If a token was already consumed (by the
  card or by the console) or has expired, the gateway rejects it with its
  own typed error, and the page falls back to the resolved or expired state.
  There is no second approval mechanism.
- Storage failures come back from `/api` as 503. `/api/ledger/verify`
  returns `ok: false` on 503, because a verifier that couldn't read the
  chain hasn't verified it.

## Design plan (written before any component code)

**Subject.** Chaperone keeps a copy of what the household agreed to and
compares every later version against it. The physical analogue is a
carbonless triplicate form: a white original, a canary copy and a pink
copy, printed in one ink and filled in by typewriter.

| token | hex | from |
|---|---|---|
| `--n-50` form stock | `#F3F5F8` | cool paper; deliberately not cream |
| `--accent` carbon | `#23308F` | the one ink every rule and label is printed in |
| `--n-*` graphite | `#0F1320` → `#FFFFFF` | typed data |
| `--ok` | `#17714A` | ledger green: verified, pinned |
| `--warn` | `#C99A00` | the canary copy: awaiting a decision; highlighter on the added clause |
| `--blocked` | `#B0103A` | the VOID rubber stamp: chain broken, change refused |

**Type.** One UI sans (system stack), with labels set like printed form
fields: 12px, 600 weight, uppercase, +0.1em tracking, in carbon ink. One
serif (Charter/Cambria/Georgia stack) for numerals only: counts, times,
scores. `ui-monospace` is used for hashes and ULIDs only. The scale has
five steps: 12 / 14 / 16 / 22 / 40. There are no CDN fonts.

**Layout.** Every screen is a filled-in form, with the ledger chain running
across the top like the perforated edge of the pad.

**Signature.** The perforation chain. Each ledger event is a square link,
filled with carbon ink when `GET /api/ledger/verify` vouches for it. On a
break, the ink stops at the broken link, which turns crimson. Links after
it stay grey ("unverified") because the verifier stops at the first break.
A rotated VOID stamp names the index and sort key.

**Motion.** There is one orchestrated sequence: when a verify result lands,
the links ink in left to right (a 700ms stagger overall, each link taking
240ms), then the stamp lands. Every other transition is a 120ms colour
change on hover or focus. Motion is disabled under `prefers-reduced-motion`.

**Visible work.** The wire strip logs every request the console makes:
channel, verb, path or JSON-RPC method, status, latency, and the gateway's
`X-Request-Id`, which matches the gateway's own log line. The approve path
logs each MCP hop (`initialize`, `notifications/initialized`,
`tools/call chaperone/approve_change`, session `DELETE`) as it completes.

### Self-critique: what changed and why

1. **The badge.** The first idea was a green "verified" pill in the header.
   It would look the same on any product, so it became the chain itself:
   geometry that only makes sense for a hash chain.
2. **Grey hairline table rules** would drift into the broadsheet look. Rules
   are now 1.5px carbon-ink form boxes with corner labels.
3. **UI-kit green and amber** would be generic. Canary and void-crimson come
   from the carbon copies and the stamp. Green stays, because "verified"
   has to read instantly on a projector.
4. **Tokens and cost.** The brief asked for token and cost numbers, but the
   advisory row doesn't persist them. The console shows what is stored
   (model ID, prompt SHA, score, generation time) and invents nothing.
5. **Light only.** The form metaphor is paper, and paper projects better.

## Enforcement

`src/index.css` clears Tailwind's default colour, font, text, radius and
shadow themes and re-points them at `src/tokens.css`. It also sets
`--spacing` to the 4px unit. A utility that doesn't derive from a token
fails to generate.

---

# Phase 15 — the evidence screens

`/corpus`, `/bench` and `/upstreams`, plus a designed state pass across all
six routes. The design plan below was written before the components, in the
same order as the Phase 14 plan above, and extends that system rather than
starting a second one.

## Why there is no second palette

Three new screens with their own colours would fracture a product that is
six screens long. Everything on the evidence screens is derived from tokens
already in `tokens.css`:

| token | value | derived from | job |
|---|---|---|---|
| `--band` | `color-mix(--warn 34%, --n-0)` | `--warn` | the pre-registered prediction band, as a *region* rather than a mark |
| `--band-edge` | `color-mix(--warn 60%, --n-600)` | `--warn` | the band's dashed boundary at 20% and 40% |
| `#hatch-lowconf` | SVG pattern of `--accent` / `--accent-wash` | `--accent` | the `read` bar |

No new hue enters the palette. `--ok` marks a measurement that landed
inside the predicted band and `--blocked` one that landed outside, which is
the same thing those two mean everywhere else: vouched for, or not.

The hatch is an accuracy device, not decoration. `data/crawl-1-report.json`
records `lowConfidenceCount: 4381`, exactly equal to the `read` population,
and `packages/crawler/src/crawl.ts` says why: `read` **is** the capability
classifier's unmatched-verb default. A solid bar there would claim a
confidence the classifier never made, so it is hatched and the caveat is
printed beside it.

## Type: one new step

`--text-finding: 1.75rem / 2.3rem`, weight 400, set in the serif. The
boot-rate finding is prose carrying a number, and it is the loudest thing
on `/corpus` in the state that screen holds for 35 days. Neither the 22px
sans title step nor the 40px serif numeral step sets a 20-word sentence;
without this step the most important sentence on the screen would be at
body size.

## Signature: the prediction track

A 0–100% rule carrying the 20–40% band that `corpus/PREDICTIONS.md` put on
the record on 2026-09-12, before either crawl.

The property that matters is that it is **complete and legible with zero
measurements**. That is what makes the partial state read as awaiting
rather than broken: the prediction is a finished artifact and the
measurement is the thing that is scheduled, so the empty half of the track
is content, not a hole. On crawl 2, four marks land on the same rule —
green inside the band, crimson outside.

It cannot be lifted onto an unrelated project, because it is a
pre-registration artifact rather than a chart type.

## Layout

```
┌──────────────────────────────────────────────────────────┐
│ OBSERVATION 1 OF 2 RECORDED                              │
│ Corpus                                          [1 of 2] │
├──────────────────────────────────────────────────────────┤
│               20–40% PREDICTED                           │
│ ├──────────┤▚▚▚▚▚▚▚▚▚▚▚▚┊├────────────────────────┤      │
│ 0%                      ┊ 50%                     100%   │
│            MEASUREMENT DUE 2026-10-20                    │
├──────────────────────────────────────────────────────────┤
│ "47.8% of public MCP servers … did not start …"          │
├──────────────────────────────────────────────────────────┤
│  transact    ██ 202                                      │
│  communicate ███ 371                                     │
│  write       ████████ 1,104                              │
│  read        ▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨ 4,381  low confidence    │
├──────────────────────────────────────────────────────────┤
│ N · crawl 1 · crawl 2 · interval · taxonomy blob         │
└──────────────────────────────────────────────────────────┘
```

The four capability rows are the **same four rows in both populated
states**. Partial plots the crawl-1 population — the frame crawl 2 is
measured against. Complete plots the semantic-intent drift rate per class.
Sharing the rows is the point: it is what makes the partial chart a
finished result rather than a stand-in for the drift chart.

## Motion

One orchestrated sequence, in the same grammar as the ledger chain's ink:
the band wipes in over 300ms, then the four bars extend in sequence
(4 × 90ms), then — in the complete state only — the measured marks drop
onto the track. In partial, **the sequence stops after the bars**, which is
why an empty track reads as awaiting. Everything else stays at the
committed 120ms, and all of it is disabled under `prefers-reduced-motion`.

## Self-critique: what changed, and why

1. **Four KPI stat tiles** for N / both timestamps / day count / taxonomy
   SHA. That is the twenty-dashboards look and would be identical on any
   project. Changed to a ruled **evidence footer** set like a form's filing
   stamp: those values are provenance, not metrics, and a KPI row says the
   opposite.
2. **The partial state as "the complete chart minus data"** — axis present,
   bars greyed, nothing plotted. That is exactly the "looks broken" failure
   this screen had to avoid for 35 days. Changed so partial plots a
   different, *finished* measure on the same strata, with the prediction
   track carrying the pending half.
3. **A dark analytics theme** to separate evidence screens from form
   screens. Rejected: it breaks the paper metaphor, contradicts the
   committed light-only decision, and near-black-plus-one-accent is the
   most common AI-design default there is.
4. **`?state=complete` originally just rendered the complete layout.** It
   shows drift rates that have not been measured, which on a screen whose
   whole argument is pre-registration is the most dangerous thing in this
   repository. It now renders behind a permanent, undismissable crimson
   **SPECIMEN** banner and a "numbers are invented" page subtitle. The real
   complete state, driven by `data/drift.json`, renders with no banner.
5. **`/bench` was going to show an estimated p95.** It shows nothing
   instead. `benchmarks/latency.json` does not exist, because the bench
   harness has not been built; a placeholder zero there would be a claim
   that Chaperone adds no latency, which nobody has measured. The empty
   state names `pnpm bench` and says so plainly.

## Three defects the acceptance run caught

Recorded because they say something about the checks, not only the code.

- **The rehearsal control was not compiled out.** It was gated on
  `import.meta.env["VITE_DEMO_CONTROLS"]`, and Vite only statically
  replaces the *dotted* form — with bracket notation the branch stays a
  runtime lookup, never folds, and the component ships in every build. No
  warning, no type error, and dev and the test suite behave identically
  either way. Found by grepping the built bundle for a string only that
  component renders, which is now part of the acceptance run
  (friction-log.md Entry 033).

- **The chart was not responsive, only clipped.** At 375px the Recharts
  wrapper stayed at its 720px fallback and was hidden by the shell's
  `overflow-x-clip`, so `document.scrollWidth === clientWidth` reported no
  overflow and the page looked correct. The measured container was a grid
  item, so its `min-width: auto` let the chart inside widen it and the
  ResizeObserver fed that width straight back. `min-w-0` on the measured
  box fixes it; the chart is now 343px at a 375px viewport.
- **Two row-height tokens were wrong.** `states.test.tsx` asserts that a
  skeleton and its row reference the same `--row-*` token, and that test
  passed — while the ledger skeleton measured 44px against a 55px row, and
  the upstream skeleton 108px against a 192px card. A structural assertion
  cannot see a value that is merely too small. The tokens are now the
  measured heights (56px, 192px), applied as `min-height` and verified in
  a browser: 72/72, 56/56, 192/192.

## Where the evidence screens get their numbers

Not from the gateway. `evidence.load.ts` reads the committed files at build
time and a small Vite plugin inlines them as `virtual:chaperone-evidence`,
together with `git rev-parse HEAD` for `/bench`'s stale-data check.
`/corpus` and `/bench` therefore render with the network off (Risk R5), and
what is on screen can be diffed against what is in git. A missing file
becomes `null` and the screen shows its designed empty state — never an
error, never a zero.

## `/upstreams` and the read-only API

`/api/upstreams` gained `state`, `connectedAt`, `sessionOpen` and
`consecutiveFailures`, from the pool's own new `describe()`. That method is
synchronous and dials nothing: a status screen that connected to every
upstream in order to render itself would turn opening a tab into traffic
against other people's servers, and would make a dead upstream slow rather
than visibly dead. A router built without a pool reports `state: "unknown"`
rather than defaulting to `"ready"`.

The rehearsal control that fires demo-upstream's scripted mutation is
compiled out unless `VITE_DEMO_CONTROLS=true`. A button that changes what a
tool claims is the one thing this product exists to catch, and it has no
business in a household build.

See `docs/UI-STATES.md` for the four states of each route, the `?state=`
overrides, and the layout-shift guarantee.
