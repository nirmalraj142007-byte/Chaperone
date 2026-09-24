# Testing

One command runs everything a judge should believe:

```
pnpm test:all
```

It needs the docker-compose stack running and migrated (see "Before you run
anything"). It takes about 6.5 minutes, and most of that is one test that
holds a real stream open for three minutes on purpose.

## What `pnpm test:all` runs

In this order, stopping at the first failure:

| # | Command | What it proves | Needs | Takes |
|---|---|---|---|---|
| 1 | `pnpm test` | Every package's unit and integration tests, with **coverage gates**: `packages/policy` 100% statements, branches, functions and lines; `packages/ledger` and `packages/gateway` 80%. Below a gate, the command exits 1. | Nothing. No Docker. | ~110 s (85 files, 871 tests) |
| 2 | `pnpm spec` | The MCP conformance suite: 27 named assertions about the wire protocol (initialize, versions, sessions, progress, cancellation, error shapes, the `{upstreamId}__` namespacing that is the one deliberate non-transparency). In-process. | Nothing. | ~21 s |
| 3 | `pnpm test:stack` | The four suites that need real processes: `resumption` (10 independent kill-the-socket-and-resume iterations, `place_order` invoked exactly once each, counted by the upstream itself), `long-stream` (a live SSE stream held ~180 s with progress notifications), `ledger-tamper` (edit a type, edit an actor, delete a look-alike event: each is detected at the right index), `refusal-final` (a refused change is not asked about again). | Docker stack, migrated, pins bootstrapped. | ~196 s |
| 4 | `pnpm test:e2e` | Two Playwright specs against the real stack, below. | Docker stack; Playwright's Chromium. | ~47 s |
| 5 | `pnpm verify-ledger` | Walks the household's hash chain from genesis; exits 1 on any hash, link or missing-hash break. | Docker stack. | ~2 s |

Measured on one Windows laptop (16 threads, about 2 GB of free RAM, Docker
Desktop): `pnpm test:all` from a freshly recreated stack took 392 s. Run again on 2026-09-24 from a fresh clone of
commit `bafc5f5` (85 files, 871 tests; 27 spec assertions; 4 stack files, 16
tests; 4 e2e tests; `verify-ledger` green): exit 0 in 327 s. A CI runner
has fewer cores and more memory; expect the same order of magnitude.

### The two end-to-end specs

`e2e/consent-flow.spec.ts` (the happy path): starts from a fresh
`demo:reset`; `add_item` works; the upstream changes its description; the
gateway sends `list_changed` and drops `add_item` from `tools/list`; calling it
returns text **equal to** `REFUSAL_TOOL_CHANGED`; the card renders in a real
browser with the added clause highlighted and a "can change your data" badge;
approving with the issued token restores the tool; `verify-ledger` is green and
the ledger holds exactly `PIN_CREATED x4, MISMATCH_DETECTED, TOOL_QUARANTINED,
CONSENT_SHOWN, APPROVED, REPIN`, in that order, with the right actors and none
of them a model.

`e2e/fails-closed.spec.ts` (the failure paths), three tests:

1. **DynamoDB down.** With `add_item` quarantined, DynamoDB is stopped. The
   call is refused and never allowed; `/healthz` is 503 and says a 503 is not a
   permissive state; no HTML error page or stack trace reaches a client on any
   surface probed; DynamoDB is restarted and the gateway recovers **without
   being restarted itself** (its container start time is unchanged), still
   withholds the quarantined tool, and the chain still verifies. What the
   gateway actually does today with the store down is answer `503` with
   JSON-RPC error `-32003` "session store unreachable": the session layer
   refuses before the gate is reached. The gate's own fail-closed path (a pin
   that cannot be read is withheld under the frozen refusal text) is covered by
   the gateway's unit tests.
2. **Token replay.** Approve once, then approve again with the same token. The
   second attempt gets its own error ("already resolved as approved", not
   "invalid token", not "expired", not the frozen refusal), and the pin and the
   whole event list are byte-identical to before it.
3. **"Keep blocked" is final.** Block a change, then call `tools/list` twice
   more and call the tool again: still one quarantine, still `refused`, no new
   token in anything returned, and not one new ledger event.

Both specs reuse the helpers `pnpm demo:verify` is built from
(`scripts/demo/harness.ts`) rather than carrying their own.

`playwright.config.ts` runs one worker and **no retries**. Every spec resets
and mutates the same stack (one of them stops DynamoDB), so parallelism would
make the specs test each other; and a retry would turn "passed the second time"
into a green run.

## Other entry points

| Command | What it proves | Needs | Takes |
|---|---|---|---|
| `pnpm test:resume` | Just the 10-iteration kill-and-resume loop from `test:stack`. | Docker stack | ~50 s |
| `pnpm test:tamper` | Just the ledger tamper regression. | Docker stack | ~10 s |
| `pnpm test:refusal` | Just "a refused change stays refused". | Docker (`ddb` only) | seconds |
| `pnpm demo:verify` | The demo's twelve beats (one skipped by design), headless, ending in a reset so it can be run twice in a row. Overlaps `test:e2e` by design: this one is what to watch before filming, the e2e specs are what CI gates on. See `demo/OFFLINE.md`. | Docker stack; Playwright's Chromium | ~20 s |
| `pnpm demo:idempotence` | Two resets, `ddb:dump` after each, diffed. | Docker stack | ~15 s |
| `pnpm depcruise` | `packages/policy` imports no model client and there are no cycles. A product claim, not lint. | Nothing | seconds |
| `pnpm check-claims` | Committed prose contains no rounded interval language. | Nothing | seconds |
| `pnpm check-placeholders` | Committed prose contains no `PENDING` placeholder marker (the double-brace kind, described below). **A pre-submission step, expected to fail until 2026-10-20 and not in CI**: see below. | Nothing | seconds |
| `pnpm demo:ledger` | `pnpm verify-ledger` with the demo stack's local addresses filled in, for a shell that has not exported `DDB_ENDPOINT` and `CHAPERONE_UPSTREAMS`. Used by the README quickstart. | Docker stack | ~2 s |
| `pnpm typecheck`, `pnpm lint` | Types (including scripts, e2e and the console) and lint. | Nothing | about a minute |

## `pnpm bench` is not in `test:all`, and is red on purpose

`pnpm bench` measures the latency Chaperone adds and exits 1 when the added
p95 is over its 30 ms budget. It exits 1 **by design** until latency has been
measured against real DynamoDB in Phase 18: a figure taken against DynamoDB
Local is not one we will stand behind. A red `pnpm bench` today is the
intended state. Putting it in `test:all` would make "everything passes"
impossible to say, and loosening the budget to turn it green would be the wrong
fix. It joins `test:all` when Phase 18 lands.

## Before you submit: `pnpm check-placeholders`

Committed prose marks every number that has not been measured yet with a
placeholder of the form `{{PENDING: <what> — <when>}}` <!-- check-placeholders:allow: documents the marker syntax, is not itself a marker -->, so that a value is never invented to fill a gap. The
README, `docs/QA.md`, `docs/LIMITATIONS.md` and `docs/PRODUCT-FEEDBACK.md`
carry them today (drift rate, baseline 2, production latency, the quickstart
timing, the interim crawl, Kiro and CDK deploy feedback).

```
pnpm check-placeholders
```

It scans every committed `*.md` plus everything under `demo/` and `docs/`,
prints each remaining marker with its file and line, and exits 1 if there is
one. It exits 0 only when none remain. Run it after crawl 2 and the last
measurement have been written in, and before submission on 2026-10-22: a
green run means every marker was replaced with a measured value or an explicit
statement that the thing was not measured.

It is **not** in `test:all` and **not** in `.github/workflows/ci.yml`, on
purpose. The markers are correct and expected until 2026-10-20; a red CI for
something that cannot exist yet would teach everyone to ignore CI. Add it to
CI in the same commit that replaces the last marker, if at all. A line that
documents the marker syntax itself, like the one above, opts out with the text
`check-placeholders:allow` on that line. Its finder is unit-tested in
`scripts/test/placeholders.test.ts`.

## Before you run anything

Once, while online:

```
pnpm install
pnpm build
pnpm exec playwright install chromium     # for test:e2e and demo:verify
```

Then the stack, the same way CI starts it:

```
docker compose up -d --build
pnpm ddb:migrate
pnpm pin:bootstrap
```

`pnpm ddb:migrate` and the rest read `DDB_ENDPOINT` and `CHAPERONE_UPSTREAMS`
from the environment; the values CI uses are in `.github/workflows/ci.yml`. The
demo and e2e scripts fill in local defaults themselves.

`pnpm test` on its own needs none of this.

## CI

The `stack` job in `.github/workflows/ci.yml` runs `pnpm test:all`, then the
**flake gate**: `pnpm test:e2e --repeat-each=3 --retries=0`, both specs three
times over. If any repetition differs from the others, the build fails.
Playwright's traces and screenshots are uploaded when that job fails. The fast
`unit` job (typecheck, lint, depcruise, check-claims, build, `pnpm test`,
`pnpm spec`) needs no Docker and runs alongside it.

## Notes on the coverage gates

- Configured in `vitest.config.ts`, per package, not globally.
- `packages/policy` is at 100% because it is about 200 lines and is the entire
  security property. When a branch looked unreachable (the guard in
  `canonicalizeTool`) it got a test that forces it (`canonical-guard.test.ts`)
  rather than an exclusion or a lower gate.
- Only type-only files are excluded. `packages/gateway/src/index.ts`, the
  process entry point, is included and counts as 0% covered; the gateway still
  clears its gate with it in.
- The worker cap in `vitest.config.ts` (4 forks) exists because the suite is
  import-bound and every fork holds a full module graph; see the comment there.
