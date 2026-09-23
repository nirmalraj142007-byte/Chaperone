# The offline demo

Chaperone keeps a record of what a household approved, and checks every
later version of a tool against it. This file is about running that whole
story on one machine with no network: what you will see, what is real, and
what is not.

The short version for anyone re-running it: **two things in this run are
hand-written stand-ins, and both are labelled on screen.** Everything else
is the real code doing the real thing. The stand-ins are listed first
because they are what a reader could be misled by.

---

## What is a fixture

### 1. The advisory line on the consent card and in the console

The card has a short summary line under the before/after text, and the
console's queue detail has the same line with a 0-100 score. In a normal
run a language model writes them. **No model wrote the ones in this demo.**
Real Bedrock output does not exist yet: the AWS account is restricted and a
support case is open (friction-log Entries 037 and 038).

| | |
|---|---|
| Where it lives | `demo/advisory-fixtures.json`, one row, written by hand on 2026-09-23 |
| How it is loaded | `pnpm demo:reset` writes it to the `advisory` table under `FIXTURE#<hash of the changed tool definition>` |
| How it is found | the gateway looks for a real advisory row first; only if there is none does it fall back to the fixture for that exact definition hash |
| Model ID stored | `fixture:hand-written-not-model-output` |
| How it is labelled where you see it | Card (text): `Advisory (fixture: hand-written for the offline demo, not model output): ...`. Card (HTML): the same words as the section label. Console detail: `Advisory · fixture, hand-written, not model output · not the decision`. Console queue: a `fixture` tag beside the score. |
| What it cannot do | It cannot decide anything. The gate never reads an advisory. The card and console say so, and `packages/policy` has no import path to any of this. |
| Its TODO | Blocker: Bedrock calls unavailable (AWS restriction, support case open). Resolves once live calls work, before the 2026-10-22 cutoff: run `pnpm advisory:run-local` on the demo mutation and either replace the row with the real output or delete the file and let the card show its no-advisory state. The same text is in the file. |

The fixture is attached to a hash, not to a quarantine, and the hash is read
from the running upstream after it has really been mutated (see "how reset
works"). The fixture cannot claim to describe a change it was not written
for; if `demo-upstream`'s text changes, `demo:reset` refuses to run until the
fixture is updated.

### 2. The household's approval history: "You approved this on 12 January"

A household that has used these tools since January does not exist. The demo
needs one, so `demo:reset` writes it.

| | |
|---|---|
| What is staged | the four `grocery` tools' pins, and the four `PIN_CREATED` ledger events behind them, all dated **2026-01-12T10:30 UTC** (one second apart) |
| How it is labelled | every one of those four ledger events carries `"staged": true` and a note beginning `STAGED FIXTURE` in its payload, and the console's ledger screen prints payloads |
| What is real about them | the hashes (computed from what `demo-upstream` actually serves), the capability class (from the real classifier), and the hash chain: the events are chained with the ledger's own `hashEvent`, and `verify-ledger` checks them like any other |
| What is not real | that anyone approved them on that date |
| Where the date shows | the consent card (`You approved this on 12 January`) and the console's queue detail (`Approved Jan 12 ...`) |

This is the only place in the repo that writes a ledger event with a time
other than now (`scripts/demo/stage.ts`, deliberately outside
`packages/ledger`). Every event after those four, the mismatch, the
quarantine, the approval, is written by the running gateway, stamped with the
real time.

There is no other fixture in the demo path. If you see something on screen
that looks like one and is not in this list, that is a bug; please say so.

---

## What is real

| | In the offline run |
|---|---|
| **The gate** | `allow(current, pinnedHash)`: a synchronous hash comparison in `packages/policy`. Nothing about it is staged. |
| **The refusal text** | the frozen constant `REFUSAL_TOOL_CHANGED`. `demo:verify` asserts the tool result's first block is byte-for-byte equal to it. |
| **The hashes** | computed from the tool definitions the running `demo-upstream` serves, by the same `hashTool` the crawler uses. |
| **The change** | a real `notifications/tools/list_changed` from a real MCP server, after a real description change (`POST /control/mutate`). |
| **The quarantine and the token** | created by the gateway at the moment of the mismatch; the one-time token exists only in the card and is checked (constant-time, single use, 24h) by `chaperone/approve_change`. The console's approve button calls that same function. |
| **The ledger** | append-only, hash-chained, in DynamoDB Local. `pnpm verify-ledger` walks it; the run above ends with 9 events verified (4 staged + 5 live). |
| **Resumption** | real: `pnpm resume-demo` and `pnpm test:resume` kill a real connection mid-call against the real gateway and count the upstream's own invocation counter. `demo:verify` does not repeat it; the 10-iteration loop is the evidence. |
| **`/corpus` and `/bench`** | committed files only (`data/crawl-1-report.json`, `data/boot-rate.json`, `data/drift.json`), inlined into the console bundle at build time. |

### `/corpus` shows its PARTIAL state, and that is correct

`data/drift.json` is committed, but in `pending` form (its shape was
pre-registered before crawl 2). It has no drift numbers, and `demo:reset`
does not write any. The console decides which state to draw from that file's
`status`, not from whether it exists, so today `/corpus` shows crawl 1 only:
"Observation 1 of 2 recorded", measurement due 2026-10-20. The chart of drift
by capability class does not exist yet and is not drawn.

After crawl 2 and `pnpm analyse:drift`, `status` becomes `complete` and the
same screen draws the drift chart. The matching assertion in `demo:verify` is
written down as a TODO (blocker: crawl 2 has not run; resolves after
2026-10-20), and the run prints it as `SKIPPED`.

---

## Running it

Once, while online:

```
pnpm install
pnpm build
docker compose build                       # builds the gateway and demo-upstream images
docker pull alpine/socat                   # only for the no-egress overlay below
pnpm exec playwright install chromium      # only for demo:verify
```

Then, with the network off if you like:

```
pnpm demo:reset            # drops and recreates every table, seeds the household, prints the beats
docker compose up -d
pnpm demo:verify           # walks the beats headlessly; run it twice
```

`demo:reset` starts the stack itself (`docker compose up -d`), so the order
above works from cold.

### What `demo:reset` does

1. `docker compose up -d`, then waits for DynamoDB Local and `demo-upstream`.
2. Refuses to continue unless `DDB_ENDPOINT` is a loopback address. It drops
   tables.
3. Drops and recreates all nine DynamoDB Local tables.
4. Resets `demo-upstream` to its benign descriptions.
5. Connects to `demo-upstream`, lists its tools, pins all four, dated 12 January
   (fixture 2 above).
6. Mutates `demo-upstream` for an instant, hashes the changed `add_item`
   definition it really serves, attaches the advisory fixture to that hash
   (fixture 1 above), and resets it. It then re-lists the tools and checks
   every one hashes to its pin again.
7. Verifies the ledger chain.
8. Makes sure the console bundle in `packages/console/dist` was built from the
   committed data files at the current commit, with the rehearsal controls
   compiled in, and rebuilds it if not.
9. Prints the numbered beats with the exact commands and clicks.

It is idempotent: `pnpm demo:idempotence` runs it twice, runs `ddb:dump`
after each, and diffs the dumps. ULIDs and wall-clock timestamps are
normalised. The staged 12 January instants and every hash are **not**, so a
reset that drifted the date or a hash would fail the diff.

### What `demo:verify` asserts

Each beat is one step of the printed checklist. The first failure stops the
run.

| # | Beat | Asserted |
|---|---|---|
| 1 | The stack is up, offline | gateway `/healthz` 200; demo-upstream and the console answering |
| 2 | Nothing has changed yet | empty queue; ledger verifies exactly the 4 staged events; console shows "Nothing has changed since you approved it." |
| 3 | An approved tool works | all four tools listed; `add_item` runs |
| 4 | The upstream changes a description | clicks **Mutate add_item** on `/upstreams`; the upstream reports the change |
| 5 | The gate refuses | first block **equals** `REFUSAL_TOOL_CHANGED`; the card text has the changed clause marked, `Capability: can change your data`, `You approved this on 12 January`, and the advisory line labelled a fixture (and never "model-generated"); the changed tool is absent from `tools/list` while `read_list` still runs |
| 6 | The card, rendered | the HTML card in Chromium: highlighted `<ins>` clause, capability badge, approval date, fixture label, both buttons; screenshot to `test-results/demo-verify/` |
| 7 | The resident decides | console queue detail: highlighted clause, capability, `Approved Jan 12`, fixture label; pastes the token, clicks **Approve & re-pin**; the quarantine reads `approved` |
| 8 | The tool is back | `add_item` is listed and runs again |
| 9 | The ledger vouches | runs `packages/ledger/scripts/verify-ledger.ts` (what `pnpm verify-ledger` runs): chain OK, exactly 9 events; the gateway's `/api/ledger/verify` agrees |
| 10 | The evidence screen | `/corpus` renders "Observation 1 of 2 recorded", the 2026-10-20 target, and not "2 of 2" |
| 11 | The drift chart | **SKIPPED**, with its TODO (see above) |
| 12 | Nothing left this machine | every browser request went to localhost |

`demo:verify` starts from the state `demo:reset` leaves. If the stack is not
in that state it resets first, and it resets again when it finishes, so a
second run starts clean and the demo is ready to film.

---

## How "offline" is enforced, and what is not covered

Not just "we did not point it anywhere":

| Layer | Enforcement |
|---|---|
| The three containers | `docker compose -f docker-compose.yml -f docker/compose.offline.yml up -d` puts them on a Docker `internal` network. From inside the gateway and demo-upstream containers, `https://example.com`, `https://1.1.1.1` and `https://registry.npmjs.org` all fail (`EAI_AGAIN`, `ENETUNREACH`); in-stack names still work. A small socat container (`edge`) carries ports 3000, 4000 and 8000 to the host; it is the only container with a route out and it is only told to connect to those three in-stack targets. |
| The script processes (`demo:reset`, `demo:verify`, `demo:idempotence`) | `scripts/demo/loopback-guard.ts` wraps `net.Socket.prototype.connect`; any connection to a non-loopback host is destroyed before a packet is sent. Unit-tested. |
| The browser | Playwright routes every request; non-local ones are aborted and recorded, and beat 12 fails if there are any. |

Not covered, so that nobody assumes otherwise: the `docker` CLI and `vite
build` child processes are separate programs the guard cannot see (neither
is asked to reach out, and `docker compose up` uses only images that already
exist); nothing here disables the host machine's network adapter; and the
plain `docker compose up -d` (no overlay) gives the containers ordinary
internet access, they simply are not asked to use it.

The overlay is opt-in because it adds a fourth container and a second
network. It is the version to use when the claim is "this touched nothing
outside docker compose" rather than "this happens not to".

---

## What was measured

Machine: a 15.7 GB Windows 11 laptop that had about 1.7 GB free during these
runs (Docker Desktop, Chromium, an IDE). Slower than a clean machine.

| Run | Result |
|---|---|
| `demo:reset`, stack already up | about 6 s of script time (about 12 s wall from the shell, most of it `pnpm` and `tsx` start-up) |
| `demo:reset` when the console bundle needs building | about 22 s wall |
| `demo:verify`, beats only | about 8-10 s |
| `demo:reset` + `docker compose up -d` + `demo:verify`, cold stack, no-egress overlay | 43 s wall (target: under 60 s) |
| `demo:verify` twice in a row | pass, pass (21.3 s and 20.7 s reported by the script) |

One number is not ours: Chromium's shutdown took anywhere from 0.1 s to over
a minute on this machine depending on memory pressure, so `demo:verify` waits
a bounded 8 s for it and then lets the process exit take it down. When that
happens the run says so.

---

## Acceptance record

Taken on 2026-09-23 from a cold stack (`docker compose down` first), with
`COMPOSE_FILE=docker-compose.yml;docker/compose.offline.yml` so every
`docker compose` call used the no-egress overlay:

```
pnpm demo:reset && docker compose up -d && pnpm demo:verify
  -> demo:reset: done in 6.6s (4 tools pinned, 4 ledger events)
  -> demo:verify: PASS - 11 beats passed, 1 skipped, 0 failed, 21.3s
  -> wall clock for the three commands: 43 s

pnpm demo:verify    (second consecutive run)
  -> PASS - 11 beats passed, 1 skipped, 0 failed, 20.7s

pnpm demo:idempotence
  -> PASS - two resets left identical state; 8 ULIDs normalised, 0 wall-clock
     timestamps needed normalising (the staged instants are fixed)

From inside chaperone-gateway:  https://example.com -> EAI_AGAIN,  https://1.1.1.1 -> ENETUNREACH
From inside chaperone-ddb:      curl https://example.com -> could not resolve host
```

The one skipped beat is the drift chart, by design (see above). Also run
in the same session: `pnpm spec` 27 passed; `pnpm test:stack` 4 files, 16
tests passed, including `test:resume` 10/10 with `place_order` invoked
exactly once each time.
