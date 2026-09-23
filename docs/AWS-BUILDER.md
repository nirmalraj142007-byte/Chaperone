# AWS Builder — the advisory pipeline

Phase 12, completed in a later Phase 12/13 session. Before Phase 12, `putAdvisory`
existed in `packages/ledger` (the storage shape) but nothing in the repo ever
called it — no producer. Phase 12's first session built that producer:
everything that turns one quarantined tool's before/after description into
an `Advisory` row, up to but not including the one real Bedrock call, which
stayed out of scope that night. This completion session adds: the real
Bedrock model call (attempted; see "Bedrock model availability" below for
why it's still not confirmed), AWS-01 (the Step Functions pipeline, `cdk
synth`-only), and baseline 2's real classifier/runner (Phase 13 — see
`docs/LIMITATIONS.md` for its current status).

Internally this is a risk-scoring pipeline sitting downstream of
`gate.ts`'s quarantine detection, not a resident-facing surface in its own
right — the resident-facing framing rules in `CLAUDE.md` (context-aware
add-on, not a security layer) apply to the consent card and the README, not
to this document.

---

## Architecture

```
 gate.ts (Phase 2-9, unchanged this phase)
   │  a tool's live hash != its pinned hash
   ▼
 ledger.createQuarantine()            [DynamoDB: chaperone-quarantine]
   │  status: "pending", no advisory row yet
   │
   │  (AWS-01, not built: a Step Functions pipeline would pick this up
   │   automatically via a stream/EventBridge trigger. Tonight's stand-in:)
   ▼
 pnpm advisory:run-local              [packages/advisory/scripts/run-local.ts]
   │  loadConfig() → householdId, ADVISORY_MODEL_ID, AWS_REGION
   │  resolveProvider() → MockModelProvider (default) | BedrockModelProvider
   ▼
 runLocalAdvisoryPipeline()           [packages/advisory/src/localRunner.ts]
   │  ledger.listQuarantineByStatus("pending"), filtered to this household
   │  skip any quarantineId that already has an advisory row (idempotent)
   ▼
 scoreDiff()                          [packages/advisory/src/scoreDiff.ts]
   │  buildAdvisoryPrompt()  — truncate + hash → promptSha
   │  exceedsPromptBudget()  — reject over 4000 est. tokens, no call made
   │  withRetry(provider.invoke, …)  — 250/1000/4000ms + jitter, 20s budget
   │  parseAdvisoryResponse() — fence-strip + AdvisorySchema, retry once
   │  NEVER THROWS — returns {status:"scored"|"unavailable"}
   ▼
 ledger.putAdvisory()                 [DynamoDB: chaperone-advisory]
   │
   ▼
 gateway/consentCard.ts's loadAdvisorySummary()   (Phase 11, unchanged)
   reads the row back; a missing/unavailable row renders the card without
   one — the advisory is decoration, never the security decision.
```

`ModelProvider` (`packages/advisory/src/provider.ts`) is the one seam in
this diagram that a config change, not a rewrite, can move: a single
`{ prompt, maxTokens, timeoutMs } → { text, modelId }` contract, implemented
today by `MockModelProvider` (deterministic, no network) and
`BedrockModelProvider` (real, using the Bedrock Converse API — see
"Verifying the SDK surface" below). A direct Anthropic Messages API
provider would implement the same interface; see "What's left."

**`packages/advisory` cannot import `@chaperone/policy`, by design** (and
vice versa — `pnpm depcruise` only forbids policy importing an LLM client,
but this repo's own instruction for this phase is stricter: no edge between
the two packages at all). That's why `DiffSummaryInput`
(`packages/advisory/src/prompt.ts`) is built from plain strings rather than
policy's `ToolDefinition`/`CapabilityClass` types, and why
`localRunner.ts` parses `Quarantine.fromCanonicalJson`/`toCanonicalJson`
itself instead of calling `describeDiff`.

---

## Why Bedrock's Converse API, not `InvokeModel`

`InvokeModel` needs a model-family-specific request/response body (the
Anthropic Messages shape, Titan's own shape, Llama's own shape, ...).
Converse is the one request/response shape Bedrock exposes across every
model family it hosts, so `BedrockModelProvider` never hard-codes an
Anthropic-specific envelope — the same reason CLAUDE.md asks for a provider
interface that "either Bedrock or the Anthropic API can back... with a
config change rather than a rewrite." A direct (non-Bedrock) Anthropic
provider would still use the Messages API's own shape, which is why the
interface in `provider.ts` is a single prompt string in, a single text
string out, rather than either vendor's message-array shape.

### Verifying the SDK surface (CLAUDE.md: verify, don't remember)

Read directly out of the installed
`@aws-sdk/client-bedrock-runtime@3.1134.0`'s `dist-types` on 2026-09-18,
not recalled from training data:

- `dist-types/commands/ConverseCommand.d.ts` — request shape
  `{ modelId, messages: [{ role, content: [{ text }] }], inferenceConfig:
  { maxTokens, temperature, ... } }`; response shape `{ output: { message:
  { content: [{ text }] } }, stopReason, usage, ... }`.
- `dist-types/BedrockRuntimeClient.d.ts` — the client extends
  `@smithy/core/client`'s `Client<HttpHandlerOptions, ...>`.
- `@smithy/types@4.18.0`'s `dist-types/http.d.ts` — `HttpHandlerOptions`
  carries `abortSignal` and `requestTimeout`, confirming
  `client.send(command, { abortSignal })` is the real mechanism for
  bounding one call, which is what `BedrockModelProvider.invoke` uses to
  turn `timeoutMs` into `UpstreamTimeoutError`.
- `dist-types/models/errors.d.ts` — the exact exception class names this
  provider maps: `ThrottlingException`, `ModelTimeoutException`,
  `ServiceUnavailableException`, `ModelNotReadyException`,
  `ValidationException`, `AccessDeniedException`, `ResourceNotFoundException`,
  `ModelErrorException`.

## Model choice (Phase 12/13, decided)

Two separate Bedrock models, both via the Converse API and the same
`BedrockModelProvider` — the model id, not the provider class, is what
differs (see "Why Bedrock's Converse API" above):

| Use | Env var | Model | Why |
|---|---|---|---|
| Advisory diff scoring (`scoreDiff`) | `ADVISORY_MODEL_ID` | Amazon Nova Lite (`us.amazon.nova-lite-v1:0`) | Cheap, fast, adequate for a one-or-two-sentence resident-facing summary. |
| Eval baseline 2 (`packages/eval/src/baseline-model.ts`) | `BASELINE_MODEL_ID` | Amazon Nova Pro (`us.amazon.nova-pro-v1:0`) | Amazon's own production model — baseline 2 answers "does Amazon's own model resist these attacks without Chaperone?", so it should be Amazon's strongest generally-available model, not their cheapest. |

Both are Amazon's own models, specifically because Anthropic's models on
Bedrock remain gated behind Anthropic's separate use-case verification for
this account (unresolved as of this phase). Claude Haiku 4.5 via Bedrock
remains a documented, swappable-by-config alternative for either use — set
the corresponding env var to its Bedrock model id, no code change needed —
but is not wired as either default.

## Bedrock model availability (CLAUDE.md's separate verification rule)

**Attempted this phase, blocked on a different gate than expected.** A
`ConverseCommand` call to both `us.amazon.nova-lite-v1:0` and
`us.amazon.nova-pro-v1:0` from this account's IAM user (`chaperone-dev`,
`us-east-1`) returned `AccessDeniedException` on both — but the message was
`"Your account is currently being verified. Verification normally takes
less than 2 hours."`, an account-wide AWS KYC/fraud-verification hold, not
an IAM permissions gap and not the per-model Anthropic use-case-review gate
this project already knew about. See friction-log.md Entry 037 for the
full investigation. Nothing in this repo hard-codes a model ID string
anywhere — `ADVISORY_MODEL_ID`/`BASELINE_MODEL_ID` stay unset, optional env
vars (`packages/config/src/index.ts`) until a real call actually succeeds.
This section is updated with the confirmed-working call and its real output
once the account clears — see "Verified this phase" below for whichever of
that evidence exists as of the last edit to this file.

---

## What each piece enforces

| Requirement (from the phase brief) | Where |
|---|---|
| `AdvisorySchema` + validation | `src/schema.ts` — zod, 0-100 score, 1-480 char summary |
| Fence-stripping | `src/parse.ts`'s `stripCodeFence` |
| Retry-once-on-parse-failure | `src/scoreDiff.ts`'s `MAX_PARSE_ATTEMPTS = 2` loop |
| Token budget in code | `src/tokenBudget.ts` — 1500-char truncation per side (`src/prompt.ts`), 300 max response tokens, reject >4000 estimated prompt tokens |
| Retries: 250/1000/4000ms + jitter, throttling/timeouts only, 20s wall-clock | `src/retry.ts` (generic) + `src/scoreDiff.ts`'s `isRetryableProviderError` |
| `scoreDiff` never throws | `src/scoreDiff.ts` — outer try/catch, every branch returns `{status:"unavailable", reason}` |
| `changelog.ts` in full | `src/changelog.ts` + `src/githubClient.ts` (token bucket, disk cache, degrade to `none` on non-200) |
| `local-runner.ts` against DynamoDB Local | `src/localRunner.ts` + `scripts/run-local.ts` |
| Full test coverage against a mocked provider | `test/` — 11 files, 81 tests, all against `MockModelProvider` (`BedrockModelProvider` is tested with `aws-sdk-client-mock` at the SDK boundary, never a live call) |

### The changelog cross-check isn't wired into `local-runner.ts` yet

`checkChangelog(owner, repo, sinceIso, githubToken)` is fully built and
tested (`test/changelog.test.ts`, real loopback server standing in for
`api.github.com`, matching `packages/crawler`'s own never-mock-external-APIs
test convention), but nothing calls it from the live pipeline. The reason:
a household's own `Quarantine` row only carries `upstreamId` — an id into
`CHAPERONE_UPSTREAMS` — never a GitHub `owner`/`repo`. There is nothing to
cross-check yet for the gateway's own connected upstreams.

`checkChangelog`'s actual intended caller is the corpus-wide drift analysis
(`packages/analysis` in `CLAUDE.md`'s repo layout, not built as of this
phase, targeted for Phase 19 against crawl 2 on 2026-10-20). This is a
flagged assumption, not a silent gap: the proposal's metric C ("of the
servers that changed, how many said so anywhere") is a corpus-level
finding, and `checkChangelog` was built to answer it once `packages/analysis`
exists to call it.

**The data path Phase 19 needs — verified 2026-09-19, so Phase 19 doesn't
have to rediscover it:** a `DriftRecord` row (`packages/ledger/src/repos/driftRecord.ts`)
only carries `serverId`, not a GitHub `owner`/`repo`. Resolving that
`serverId` to `repoOwner`/`repoName` must go through **`corpus/candidates.json`**
(the frozen, git-committed corpus — every entry already carries `serverId`,
`repoOwner`, `repoName`), **not** the DynamoDB `corpus-server` table via
`@chaperone/ledger`'s `getCorpusServer`, even though `CorpusServer` has the
same fields and looks like the obvious join target. Checked directly
against the running local stack: `pnpm run ddb:dump` shows `dumped
corpus-server: 0 item(s)` — a `docker compose down -v` during Phase 10
dropped the volume, and nothing since has refilled it. Read
`packages/crawler/src/crawl.ts`'s `runCrawl` to confirm crawl 2 (Oct 20)
won't refill it either: its one `putCorpusServer` call is gated behind `if
(existing)` (line ~290) — a crawl run only *updates* a corpus-server row
that's already there, it never creates one from scratch. `assemble.ts` is
the only code path that ever creates a fresh `corpus-server` row
(`putCorpusServer` unconditionally, `src/assemble.ts` line ~159), and
re-running it is exactly what the freeze rule forbids (CLAUDE.md: "The
corpus was frozen at crawl 1. Never re-assemble it."). So: **Phase 19
should parse `corpus/candidates.json` once, build an in-memory
`serverId → {repoOwner, repoName}` map from it, and join `DriftRecord` rows
against that map — never `getCorpusServer`.** The same note is on
`checkChangelog`'s own doc comment in `packages/advisory/src/changelog.ts`.

**Follow-up confirmed the same day: the empty `corpus-server` table is not a
crawl-2 blocker.** `runCrawl`'s `getCorpusServer`/`putCorpusServer` block is
the *only* place in that function touching the corpus-server table, and
it's already `if (existing)`-guarded — an empty table just makes it no-op
for every candidate. Traced the surrounding control flow line by line: the
boot-status tally that becomes `data/crawl-N-report.json`'s
`bootSuccessRate`/`booted`/`noInstallPath`/etc. runs *before* that block and
reads only `result.status` (from the fresh boot or the crawl-scoped
`data/raw/{crawlId}/{serverId}.json` archive); `bootedServerIds` and every
`putToolSnapshot` call run *after* that block but read only `record` (from
`corpus/candidates.json`) and `result` — never `existing`. None of the
three depend on the corpus-server table being populated. Commented in
`crawl.ts` at the exact block, so nobody tries to "fix" the empty table in
October by re-running `crawl:assemble`.

---

## AWS-01: the Step Functions pipeline (Phase 12/13, built — `cdk synth` only)

`infra/` (a new pnpm workspace package, `@chaperone/infra` — added to
`pnpm-workspace.yaml` this phase) now has a real CDK v2 app,
`infra/lib/advisory-pipeline-stack.ts`, replacing the "not built" gap this
section used to describe:

```
 DynamoDB Stream (chaperone-quarantine, NEW_IMAGE)
   │  filtered: eventName=INSERT, NewImage.status.S=pending
   ▼
 EventBridge Pipe (chaperone-advisory-quarantine-pipe)
   │  InputTemplate -> {householdId, quarantineId}
   │  target invocation: FIRE_AND_FORGET
   ▼
 Step Functions (chaperone-advisory-pipeline, STANDARD)
   │
   ├─ ScoreAdvisoryTask (Lambda: chaperone-advisory-score)
   │    getQuarantine(householdId, quarantineId) -> scoreDiff() -> Bedrock
   │    IAM: bedrock:Converse/InvokeModel + GetItem/Query on
   │    chaperone-quarantine ONLY. Zero DynamoDB write verbs anywhere on
   │    this role — verified by packages/ledger/test/iam-advisory.test.ts
   │    against infra/iam-advisory.json's "chaperone-bedrock-advisory-role".
   │
   ├─ Choice: $.status == "scored"?
   │    no  -> Succeed (AdvisoryUnavailable) — never a pipeline failure,
   │           matches scoreDiff's own "caller renders without one" contract
   │    yes ↓
   │
   └─ WriteAdvisoryTask (Lambda: chaperone-advisory-write)
        getAdvisory() idempotency check, then putAdvisory()
        IAM: GetItem/PutItem on chaperone-advisory ONLY — no Bedrock
        permission, no ledger-event/pin access, no quarantine access.
        infra/iam-advisory.json's new "chaperone-advisory-writer-role".
```

Splitting scoring and writing into two Lambdas under two separate IAM roles
is what makes "the Bedrock-calling Lambda has zero DynamoDB write
permission" (this phase's own instruction) true without also meaning the
pipeline can never write its own result — a single combined function would
have forced a choice between those two.

**Table ownership, a real change this phase:** `chaperone-quarantine` and
`chaperone-advisory` are now also defined as CDK-managed `dynamodb.Table`
constructs inside this stack, built from `packages/ledger/src/schema.ts`'s
`TABLE_SCHEMAS` directly (never hand-duplicated) so the two can never drift.
This is new — every table was previously only ever created imperatively by
`packages/ledger/scripts/migrate.ts`. That script, and every
`DDB_ENDPOINT`-pointed local/DynamoDB-Local run (`docker compose`, this
project's whole existing dev loop), is completely unaffected: `migrate.ts`'s
own `tableExists` guard makes it a harmless no-op against an environment
where this stack already created the table. This is the Phase 18 migration
path for a real deployed copy of these two specific tables — a stream (what
this pipeline needs) can only exist on a table something actually
provisions and owns, and CDK is that something once deployed.

**Verified this phase — `cdk synth`, never `cdk deploy` (explicitly out of
scope; that is Phase 18):**

```
$ cd infra && pnpm exec cdk synth
```

Synthesizes cleanly to a full CloudFormation template (`infra/cdk.out/`,
gitignored): both tables (with the quarantine table's stream), both
Lambdas (esbuild-bundled via `NodejsFunction`, confirmed
`aws:asset:is-bundled: true` in the synthesized template), the Step
Functions state machine and its own execution role, the EventBridge Pipe
and its execution role, and the CDK bootstrap metadata. Inspected the
synthesized `ScoreAdvisoryFunctionServiceRoleDefaultPolicy` and
`WriteAdvisoryFunctionServiceRoleDefaultPolicy` statements directly: the
Bedrock-calling role's statements are exactly `bedrock:InvokeModel` /
`bedrock:Converse` plus `dynamodb:{BatchGetItem,Query,GetItem,Scan,
ConditionCheckItem,DescribeTable,GetRecords,GetShardIterator}` scoped to
`chaperone-quarantine` and its indexes only — no `PutItem`/`UpdateItem`/
`DeleteItem`/`BatchWriteItem` anywhere; the writer role's statements are
exactly `dynamodb:GetItem`/`dynamodb:PutItem` scoped to `chaperone-advisory`
only. `infra/iam-advisory.json` was updated to add the new
`chaperone-advisory-writer-role` entry, and
`packages/ledger/test/iam-advisory.test.ts` (7 assertions) still passes
unmodified against it.

**What's left for Phase 18 (deployment), not this phase:** `cdk bootstrap`
+ `cdk deploy` against a real AWS environment; wiring `CDK_DEFAULT_ACCOUNT`;
deciding whether the Fargate/ALB gateway stack (CLAUDE.md's other `infra/`
scope) imports these two tables cross-stack or the reverse.

## Other remaining TODOs (explicit, not silently deferred)

1. **Wiring `checkChangelog` into a real caller** once `packages/analysis`
   exists (see above).
2. **A direct (non-Bedrock) Anthropic provider.** The interface
   (`provider.ts`) is already shaped for it; no implementation exists yet
   because nothing in this phase's scope calls for one. Claude Haiku 4.5
   remains documented as the swappable alternative (see "Model choice"
   above) without a concrete provider class of its own.

---

## Verified in Phase 12's first session (mock provider, before this completion pass)

Real run against a real, local DynamoDB (not a description of what it
would do):

```
$ docker compose up -d ddb
$ pnpm run ddb:migrate
$ pnpm run advisory:run-local
advisory:run-local — provider=mock household=household-demo
{
  "candidates": 1,
  "scored": 1,
  "unavailable": 0,
  "skippedAlreadyScored": 0,
  "errored": 0
}

$ pnpm run advisory:run-local   # second run against the same quarantine
{
  "candidates": 1,
  "scored": 0,
  "unavailable": 0,
  "skippedAlreadyScored": 1,   # idempotent: the existing advisory row is not re-scored
  "errored": 0
}

$ pnpm run ddb:dump
dumped advisory: 1 item(s)
```

The written row (`ddb-dump.json`, from the run above):

```json
{
  "quarantineId": "5dd4aeb5-44eb-45bb-9c51-131a45eabc24",
  "summary": "Mock advisory: wording changed but no elevated-risk capability detected.",
  "score": 15,
  "promptSha": "c8da76d19467fe3981212436115c6487c4c596c4b005653d01b50ba615d28248",
  "modelId": "mock-advisory-v1",
  "generatedAt": "2026-09-18T18:31:27.470Z",
  "pk": "QUAR#5dd4aeb5-44eb-45bb-9c51-131a45eabc24"
}
```

Also run this phase, all against real output (not exit codes alone):

- `pnpm --filter @chaperone/advisory build` — clean.
- `pnpm run typecheck` — clean across all 12 workspace packages.
- `pnpm run depcruise` — `no dependency violations found (333 modules, 944 dependencies cruised)`.
- `pnpm run lint` — clean.
- `pnpm test` — **415 passed (51 test files)**, up from the pre-phase
  count by the 81 new tests in `packages/advisory/test/` (11 files:
  `schema`, `tokenBudget`, `prompt`, `parse`, `retry`, `providers/mock`,
  `providers/bedrock`, `scoreDiff`, `githubClient`, `changelog`,
  `localRunner`).
