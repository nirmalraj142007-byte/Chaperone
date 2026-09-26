# CLAUDE.md

Context for every Claude Code session in this repository. Read this before writing anything.

---

## What this is

Chaperone is **cross-session state for an assistant that has none.**

An assistant re-reads the instructions for every tool it owns, every time it connects, and remembers nothing about what they said last time. Chaperone sits between the host and third-party MCP servers, content-hashes each tool definition at the moment a household approves it, and freezes any tool whose definition drifts — showing the resident the changed clause on a card before anything runs.

It is a hackathon submission for the Amazon Developer Hackathon, Alexa+ track. **Submission closes Oct 23, 2026, 12:00 PDT.** The repo is public and MIT-licensed from commit one; assume a judge will read any file you touch.

### Framing rule, and it is a scored one

In anything resident-facing — `README.md` first paragraph, Devpost copy, the demo script's first 15 seconds, the consent card — this is a **context-aware add-on that maintains state across sessions**. Not a proxy. Not a security layer. Not a guardrail. Those words are accurate and they are fine in `docs/`, in code comments, and after the third paragraph of the README. They are not fine in the opening, because theme fit is a pass/fail gate before any scoring happens.

Internally, say what you mean. Do not carry the marketing framing into variable names.

---

## Non-negotiables

These are correctness properties, not preferences. If a change would violate one, stop and say so rather than working around it.

1. **No LLM in the policy import graph.** `packages/policy` may import `@chaperone/errors`, `node:crypto`, and `canonicalize`. Nothing else. `pnpm depcruise` fails the build on violation — that check is a product claim, not lint. Do not add a dependency to that package to make a task easier.

2. **Allow is a pure hash comparison.** `allow(current, pinnedHash)` is synchronous, reads no clock, performs no I/O, consults no config. Its body is a hash and a string compare. Anything that needs a clock or a database belongs in the caller.

3. **Fail closed.** If a ledger write, a pin read, or DynamoDB itself fails, the tool stays withheld. There is no code path anywhere that allows on a storage error. `/healthz` returning 503 must never mean permissive.

4. **Refusal text is frozen.** The constants in `packages/policy/src/messages.ts` are returned verbatim. No interpolation, no model output, no rephrasing. A model that can reword a refusal is a model that can be talked into a friendly-sounding allow. `REFUSAL_UPSTREAM_UNAVAILABLE` must stay distinct from `REFUSAL_TOOL_CHANGED` — conflating "this server is down" with "this tool changed" destroys the product's story.

5. **The crawler and the gateway share one hashing implementation.** Both call `hashTool` / `canonicalizeTool` from `@chaperone/policy`. Never re-implement hashing locally, never canonicalise a different field set. If they disagree by one byte, the entire evidence chain is invalid.

6. **The ledger is append-only and hash-chained.** `appendEvent` only. No `UpdateItem`, no `DeleteItem` — IAM denies them in production and the local repo layer must not offer them either. `actor` is never the string `model`.

7. **Never claim an absolute Chaperone block rate.** It is a hash comparison against an author-written attack corpus; it cannot come out any other way. Report it only as a delta against baseline 2. There is a guard test in `packages/eval` that fails if an absolute leaks into a report object. The word "tautological" stays in the README.

8. **`corpus/TAXONOMY.md` and `corpus/PREDICTIONS.md` are frozen.** They were committed before crawl 1 and that commit timestamp is load-bearing evidence. Changes go in an additive appendix with its own commit. Never edit, never rebase over, never amend.

9. **Only `semantic-intent` enters a headline number.** Cosmetic and schema-additive changes are counted and published separately. If a stated drift rate anywhere includes them, it is wrong.

10. **Say the day count, never a rounded week count.** Crawl 1 was Sept 15; crawl 2 is Oct 20; that is **35 days**. `pnpm check-claims` greps committed prose for "six weeks" and fails CI. Do not reintroduce it in a commit message either. <!-- check-claims:allow: this line names the banned phrase to explain the rule, not as a claimed interval -->

---

## Calendar gates

Two of these have passed by the time most sessions run; the third has not.

| Gate | Date | Status check |
|---|---|---|
| Crawl 1 executed | Sept 15, 2026 | `jq .startedAt data/crawl-1-report.json` |
| MCP App go/no-go | Sept 18, 2026 | `docs/DECISIONS.md` → GO / PARTIAL / NO-GO |
| Crawl 2 executed | **Oct 20, 2026** | `jq .startedAt data/crawl-2-report.json` |
| Submission cutoff | **Oct 22, 2026, 12:00 PDT** — 24h early, deliberately | `demo/SUBMISSION.md` |

The corpus was frozen at crawl 1. **Never re-assemble it.** Crawl 2 runs against `corpus/candidates.json` exactly as committed; a server added in October cannot appear in a drift comparison and including it would be the precise error the pre-registration exists to prevent.

---

## Repo layout

```
packages/
  policy/        pure. hash, canonicalise, allow(), frozen messages, capability rules, diff spans.
                 zero network. zero aws. zero llm. THE leaf package.
  errors/        the closed error taxonomy. do not invent a new error class outside this file.
  config/        typed env via zod. throws ConfigError listing every missing key. never process.exit.
  logger/        pino, structured, redacts /token|secret|key|authorization/i.
  ledger/        DynamoDB repos. appendEvent + verifyChain. append-only.
  upstream/      MCP client pool. one StreamableHTTPClientTransport per upstream.
  gateway/       THE ENTRY POINT. src/index.ts < 120 lines, session handling visible.
  mcp-app/       consent card renderers (html + text). text renderer is the floor, html is the upgrade.
  crawler/       registry sources + Docker boot harness. real APIs, no mocks.
  analysis/      crawl pairing, taxonomy application, drift.json emission.
  eval/          attack corpus, two baselines, the absolute-block-rate guard.
  bench/         latency + boot-rate. budgets enforced by exit code.
  console/       React 19 + Vite + Tailwind. read-only. supporting surface, not the product.
  demo-upstream/ staged grocery server. control.ts holds the demo mutation trigger.
spec/            25+ conformance assertions. output gets filmed — keep it legible.
corpus/          FROZEN: TAXONOMY.md, PREDICTIONS.md, candidates.json, attacks/
data/            crawl reports, drift.json, labels.json. committed. the evidence.
infra/           CDK v2. Fargate + ALB, not App Runner (see below).
docs/            DECISIONS, QA, RUNBOOK, SCORECARD, RUBRIC-MAP, LIMITATIONS, PRODUCT-FEEDBACK
demo/            SCRIPT.md, OFFLINE.md, SUBMISSION.md
```

---

## Commands

```
pnpm install
docker compose up -d          # ddb (DynamoDB Local), demo-upstream, gateway
pnpm ddb:migrate              # idempotent table creation
pnpm demo:reset               # full staged demo state, offline, < 60s
pnpm demo:verify              # the demo beats, headless (Playwright), asserted; must pass twice in a row
pnpm demo:idempotence         # two resets, ddb:dump after each, diffed (ULIDs/timestamps normalised)
pnpm demo:call [tool k=v]     # bare MCP client for filming; no arguments lists the tools
pnpm verify-ledger            # hash chain walk; exits 1 on break
pnpm spec                     # MCP conformance suite, 25+ named assertions
pnpm test:resume              # 10-iteration kill-and-resume loop. must be 10/10
pnpm bench                    # latency + boot rate. exits 1 if added p95 > 30ms
pnpm depcruise                # no-llm-in-policy, no-circular
pnpm check-claims             # greps prose for rounded-week language
pnpm check-placeholders       # fails while any PENDING placeholder marker remains. NOT in CI: pre-submission step
pnpm demo:mutate              # make demo-upstream change add_item's description (same as the console button)
pnpm demo:ledger              # verify-ledger with the demo stack's local addresses filled in
pnpm test:all                 # everything. what a judge runs.
pnpm crawl:run --crawl-id=... # DANGEROUS. see calendar gates before touching.
pnpm analyse:drift            # crawl-1 vs crawl-2 -> data/drift.json. stops at data/labels-todo.json while labels are missing
pnpm analyse:drift --dry-run  # crawl-1 vs itself: must be 0 drift, 0 classifier artifacts. writes nothing under data/
pnpm analyse:label            # human change-class labelling (data/labels-todo.json -> data/labels.json). resumable
pnpm analyse:label --prevalence  # M14: label the committed 150-tool sample in data/prevalence.json
```

`TARGET=https://<host>/mcp` points `test:resume` and `spec` at a deployed environment. Both must pass there, not just locally.

---

## Conventions

**TypeScript.** 5.6+, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Node 24 LTS, pinned in `.nvmrc`. NodeNext modules. Project references.

**Errors.** Throw a subclass from `@chaperone/errors`. Do not throw bare `Error`, do not throw strings, do not add a new class without adding it to the taxonomy file. `isRetryable` is the only retry predicate.

**Logging.** `@chaperone/logger` only. No `console.log` outside `scripts/`. Every gateway request carries a request ID bound into a child logger and echoed in a response header. Log the allow decision at debug with both hashes truncated to 12 chars — that output is what makes the mechanism legible when the terminal is on camera.

**Storage.** Repository functions with narrow signatures, one module per entity. No generic DAO. Conditional writes for anything that must not race.

**Tests.** Vitest. `packages/policy` is gated at 100% statements and branches — it is 200 lines and it is the entire security property. Everything else 80%. Playwright for the two E2E specs. A flaky test is a failed phase, because a demo take will not be luckier than the suite.

**Fixtures and placeholders.** Allowed only where a real source is genuinely unavailable (a blocked provider, a crawl that has not happened yet). Every fixture is labelled as a fixture in the file, in the code, and anywhere it is displayed, and is never presented as real output. Every TODO names its blocker and when it will be resolved.

**Model output is untrusted input.** Parse it against a schema, repair or reject.

**UI floor.** Keyboard reachable, visible focus, labelled controls, AA contrast, `prefers-reduced-motion` respected.

**Real copy only.** No lorem ipsum, no placeholder names like "Feature One".

**External APIs.** Never mock them in the crawler. If an endpoint's shape differs from what a doc or a prompt claims, discover the real shape, use it, and append a friction-log entry.

**Known deviations from a naive reading of the scripts — do not "restore" these.**

- `typecheck` runs `tsc -b`, not `tsc -b --noEmit`. TypeScript refuses `--noEmit` on a composite project that another project references (`TS6310`) — the referenced project's `.d.ts` output is how the downstream project resolves cross-package types, so emit cannot be disabled in a project-references graph. `typecheck` and `build` therefore both run `tsc -b`; the second invocation is cheap because it's incremental via `.tsbuildinfo`.
- `depcruise` runs `dependency-cruiser packages`, not `dependency-cruiser --validate`. `--validate` is not a flag in dependency-cruiser 16.x — validation against `.dependency-cruiser.cjs` runs by default whenever a ruleset is found. `dependency-cruiser` is pinned to the exact installed `16.10.4` in `package.json` rather than left on a caret range, so this behavior doesn't shift under a minor bump.
- `typecheck` runs `tsc -b && tsc --noEmit -p packages/ledger/scripts`, a second invocation after the main build. `pnpm ddb:migrate` / `ddb:seed` / `verify-ledger` are CLI entry points under `packages/ledger/scripts/`, run directly via `tsx` (type-stripped, not type-checked at run time) rather than imported by any other package. Including them in `packages/ledger/tsconfig.json`'s own `include` would move that project's `rootDir` up to the package root and scatter its build output across `dist/src/` and `dist/scripts/`, breaking `package.json`'s `main`/`types` pointing at `dist/index.js`. `packages/ledger/scripts/tsconfig.json` is therefore a separate, non-composite, `noEmit` project that references `../` for cross-package types — it exists only so `pnpm typecheck` still catches a type error in a script, without perturbing the package's own build output.

---

## Capability classifier versioning

`classifyCapability` (`packages/policy/src/capability.ts`) assigns Axis 2
of `corpus/TAXONOMY.md` — `read`/`write`/`transact`/`communicate` — from a
hand-reviewed verb list. That list has changed once already (v1 → v2, found
2026-09-20: v1 had no verb matching "add", so `add_to_list(item)` —
TAXONOMY.md's own `write` example — defaulted to `read`/`low`; see
`corpus/TAXONOMY-APPENDIX-classifier-v2.md`) and may change again before
crawl 2. Three rules follow from that and are not optional:

1. **A rule-table fix is never applied in place.** It lands as a new
   `ClassifierVersion` (`packages/policy/src/capability.ts`), with the
   prior version's rule table left byte-identical in the source. Capability
   class is assigned once, at first observation, and is never re-derived
   for a tool that already existed at an earlier crawl (TAXONOMY.md, Axis
   2) — patching the rules in place would mean a tool whose description
   never changed could appear to have drifted in capability class purely
   because the classifier changed underneath it.
2. **Every verdict records which version produced it.** `crawl.ts` calls
   `classifyCapability(tool, CLASSIFIER_VERSION)` explicitly — never the
   bare, default-relying form — and stores the result as
   `capabilityAssignedBy`. Never hardcode a version string literal there;
   import `CLASSIFIER_VERSION`.
3. **Phase 19's drift analysis compares crawl 1 and crawl 2 under the SAME
   classifier version — never v1 against v2.** Before publishing any
   capability-class transition, it calls
   `findCapabilityClassifierArtifacts` (`@chaperone/policy`) over both
   crawls' `ToolSnapshot` rows: for any tool whose `sha256` is identical
   across the two crawls, the capability class must also be identical, or
   it is a classifier artifact — a bug to fix, never a reportable finding.
   A non-empty result from that function fails the analysis run.

The interim crawl on Oct 2 and crawl 2 on Oct 20 both stamp
`CLASSIFIER_VERSION` (currently `"v2"`) via `crawl.ts`'s explicit call —
there is no code path in `crawl.ts` that calls `classifyCapability` without
naming the version.

---

## Two things to verify rather than remember

**The MCP SDK surface.** Do not write `@modelcontextprotocol/sdk` calls from memory. Open the type definitions in `node_modules` and confirm: the `EventStore` interface shape that `StreamableHTTPServerTransport` accepts, which parts of protocol-version negotiation and session handling the SDK already owns, and the current mechanism for UI resources. Note what you found in a code comment with the SDK version. If something is unclear, say so — do not invent an API.

**Bedrock model availability.** Confirm the model ID exists in the configured region before writing the call. Record what you found.

---

## Friction log

`friction-log.md` is a **scored submission artifact**, assessed by Amazon's internal team at Stage One for up to a 10% bonus. It is not developer notes.

Every entry uses exactly these six fields in this order: task attempted · steps taken · expected versus actual · severity (blocker/major/minor) · workaround · actionable suggestion.

When you hit real friction with the MCP SDK, Bedrock, a registry API, Docker, CDK, or the deployment path, **append an entry in that session**. Do not batch them, do not reconstruct them later, do not embellish a thin one. An honest thin entry is worth more than a polished invented one, and a reader can tell the difference.

---

## Deliberate choices — do not "fix" these

- **ECS Fargate + ALB, not App Runner.** App Runner caps request duration at 120 seconds. Resumable SSE is the flagship technical claim and gets 20 seconds of the demo video. ALB idle timeout is set to 300s with stickiness enabled so a resumed stream returns to the task holding the in-flight call registry.
- **Multi-table DynamoDB, not single-table.** A solo builder on a deadline should be able to read a table and know what it is.
- **The crawler runs locally in Docker, not in the cloud.** It runs twice. There is no reason to pay for or debug cloud compute for that.
- **Denied tools are excluded from `tools/list`, not annotated.** A tool the model can see is a tool the model can be talked into calling.
- **No bulk-approve control exists.** Bulk approval is the failure this product exists to prevent. Do not add one for convenience.
- **Namespacing tools as `{upstreamId}__{toolName}` is the one place the proxy is deliberately not byte-transparent.** It is asserted in the conformance suite rather than hidden.
- **`packages/console` is a supporting surface.** It gets a five-second cutaway in the demo. Do not grow it into a dashboard.
- **The MCP App consent card targets `@modelcontextprotocol/ext-apps`, not the `@mcp-ui/server` `postMessage` convention.** They look interchangeable from older examples and blog posts, but they are different wire protocols — `ext-apps` requires a `ui/initialize` JSON-RPC handshake before any `tools/call`, and a `_meta["ui/resourceUri"]` link from the tool to the resource; `@mcp-ui/server`'s informal `{type:"tool", payload:{...}}` message is silently dropped by an `ext-apps` host. See `docs/DECISIONS.md`, "MCP App go/no-go — Phase 6 spike," before reaching for the older convention.

---

## Out of scope

Multi-tenancy. User accounts. An app store. Runtime syscall sandboxing. Any attempt to detect malicious *behaviour* rather than *changed claims*. One hard-coded household, one resident identity, no login; the only credential in the system is a single-use approval token bound to one quarantine ID.

If a task seems to require any of the above, it is out of scope — say so rather than building it.

---

## Working style for this repo

Finish each unit of work with the repo **runnable**. Never leave it broken pending a follow-up.

Run the acceptance commands yourself before declaring anything done, and paste the real output — not a description of what it would say. If a command fails, report the failure rather than adjusting the claim to match.

Any command claimed as verification must be shown doing work — a test count, an assertion list, real output — not just an exit code: two suites have silently run nothing while appearing green (`pnpm --filter <pkg> test` in Phase 2, `pnpm spec` in Phase 10), and `check-claims` was described in this file for phases before it existed at all. Exit 0 is not evidence.

When the data disappoints, report the data. This project's entire argument is evidentiary discipline, and a number that came in low, honestly stated, is worth more than a framing that survives by being vague. That applies to drift rates, baseline refusal rates, boot success, and latency equally.

Prefer boring and provable over impressive-sounding. The interesting part of this project is the protocol work; everything else should be dull enough to be obviously correct.

End every phase by committing all work and pushing to `origin main`. Then run `git status` and paste the output. A phase that is not on origin is not done.
