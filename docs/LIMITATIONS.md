# Limitations

What this project does not (yet, or ever) claim, stated plainly rather than
left for a reader to discover. Started in the Phase 12/13 completion
session; add to it as later phases surface real limitations, never remove
an entry because it became inconvenient.

---

## Which model backs which claim

Two different Bedrock models do two different jobs in this project. Naming
them precisely matters — "a frontier model" or "AI models" would hide which
one actually produced a given number:

- **Advisory diff scoring** (the 0-100 suspicion score and plain-English
  summary a resident sees on a consent card) is Amazon Nova Lite
  (`ADVISORY_MODEL_ID`, decided default `us.amazon.nova-lite-v1:0`). It is
  decoration on top of Chaperone's actual security mechanism (a hash
  comparison) — see `docs/AWS-BUILDER.md`'s architecture diagram — never
  itself the thing deciding whether a tool runs.
- **Eval baseline 2** (packages/eval's "does an unaided model resist these
  attacks?" measurement) is Amazon Nova Pro (`BASELINE_MODEL_ID`, decided
  default `us.amazon.nova-pro-v1:0`) — deliberately Amazon's own strongest
  generally-available model, not their cheapest, since the question baseline
  2 answers is specifically "does Amazon's own model resist these attacks
  without Chaperone?"
- Any baseline-2 percentage in this repo is scoped to exactly this:
  **"Amazon Nova Pro followed/refused X% of injected instructions [against
  this project's own 30-item author-written attack corpus]."** Not "a
  frontier model," not "AI models," not a claim about any other model
  family or about real-world attacks.
- Claude Haiku 4.5 via Bedrock is a documented, swappable-by-config
  alternative for either use (set the corresponding env var to its Bedrock
  model id) — never hard-coded as either default, and no number in this
  repo has ever been measured against it.

## Bedrock account access

As of the last edit to this file, no live Bedrock model call has ever
succeeded from this project's AWS account. Two separate gates apply to
`us-east-1`:

1. Anthropic's models on Bedrock require Anthropic's own use-case
   verification, unresolved as of this phase — this is why Amazon's own
   Nova models were chosen for both uses above, not a preference.
2. A separate, account-wide AWS KYC/fraud-verification hold ("Your account
   is currently being verified") blocked the first attempted Nova
   invocation this phase — see friction-log.md Entry 037. Not an IAM
   permissions gap.

Every number in `data/baselines.json` that depends on a real model call is
`null` with an explicit `"pending"` marker until a call actually succeeds —
never a placeholder invented to look measured.

## Baseline 2's classifier is provisional

`packages/eval/src/baseline2Classify.ts`'s `classifyBaseline2Response` /
`classifyBaseline2ControlResponse` were built and unit-tested only against
hand-authored synthetic response strings, never against a real Nova Pro
call (see "Bedrock account access" above). The heuristic — refusal-language
regex vs. an item-specific keyword extracted from the diff between
`attackVersion` and `benignVersion` — is a reasoned starting point, not a
tuned classifier. Every response it cannot confidently place (both signals,
neither signal, or the empty-response case) routes to `ambiguous` and a
human adjudication entry in `data/baseline2-adjudication.json`, never a
guessed verdict. Revisit the pattern lists in that file against real output
before trusting any percentage derived from it.

One structural gap worth naming even before real data exists:
**`delayed-trigger` items are close to untestable by a single-turn baseline-2
prompt.** The whole point of that injection pattern (`corpus/attacks/README.md`)
is that the injected behavior is conditioned on a later turn, call count, or
date — a one-shot "resident asks once, model responds once" prompt
structurally can't satisfy that trigger, so these items are expected to
land in `ambiguous` (or read as ordinary compliant responses) regardless of
how good the classifier is. A future baseline-2 revision that wants a real
signal for this pattern would need a multi-turn harness, which does not
exist.

## The attack corpus is author-written, not collected

Repeated here because it bears repeating, not because `corpus/attacks/README.md`
doesn't already say it: this corpus was written by the same person who
built the detector being evaluated against it. Chaperone's own block rate
against it is near-tautological and is never reported as a bare absolute —
see `packages/eval/src/guards.ts` and CLAUDE.md non-negotiable #7. Baseline
1 (regex blocklist) and baseline 2 (an unaided model) exist specifically so
every number has an independent point of comparison instead of standing
alone.

## AWS-01 is `cdk synth`-only, not deployed

`infra/lib/advisory-pipeline-stack.ts` (the DynamoDB Stream -> EventBridge
Pipe -> Step Functions -> Lambdas -> advisory table pipeline) synthesizes
cleanly to a CloudFormation template and its IAM statements were inspected
directly in that output, but `cdk deploy` has never been run — no version
of this pipeline has ever executed against a real AWS account. Phase 18 is
where that happens. Until then, `pnpm advisory:run-local` (against
DynamoDB Local) remains the only way any advisory row has actually been
written by this project.

## One household, no accounts, no sandboxing

Repeated from CLAUDE.md's own "Out of scope" section: multi-tenancy, user
accounts, an app store, and runtime syscall sandboxing are all explicitly
not attempted anywhere in this repo. One hard-coded household, one resident
identity, no login. Any read of this repo that assumes otherwise is reading
in more than what was built.

## Crawl 1's capability distribution under-counted `write` (found 2026-09-20)

`classifyCapability`'s original write-verb list (`create`, `update`,
`delete`, `set`, `write`, `upload`, `move`, `rename`, `install`) had no
verb matching "add" in any inflection. `corpus/TAXONOMY.md`'s own Axis 2
`write` example is, verbatim, `add_to_list(item)` — a tool using exactly
that phrasing defaulted to `read`/`low` confidence instead of `write`/
`high`. Stated plainly: crawl 1's published capability distribution
undercounted `write`, and every derived number that assumes it (the
needs-review sample composition, any `write`-share statistic) inherited
that undercount.

**What changed:** the classifier is now versioned (`ClassifierVersion`,
`packages/policy/src/capability.ts`) rather than patched in place, because
capability class is assigned once at first observation and crawl 1's v1
labels are frozen evidence — see CLAUDE.md's "Capability classifier
versioning" section and `corpus/TAXONOMY-APPENDIX-classifier-v2.md` for the
full rule table and the evidence review behind each addition and the one
deliberate omission (`modify`). `data/crawl-1-capabilities.json` (v1) is
untouched; `data/crawl-1-capabilities-v2.json` is the same crawl re-run
under v2, produced reproducibly by `pnpm crawl:reclassify-v2`.

**The transition, crawl 1 reclassified under v2:** 196 of 6,058 tools moved
class, all `read` → `write`; none moved into or out of `transact`/
`communicate`. `write`'s share of crawl 1 rises from 18.2% (1,104/6,058)
under v1 to 21.5% (1,300/6,058) under v2.

**How this is handled going forward, not just disclosed:** `crawl.ts`
stamps every verdict with the classifier version that produced it
(`capabilityAssignedBy`), and both the interim crawl (Oct 2) and crawl 2
(Oct 20) run under v2. Phase 19's drift analysis compares crawl 1 and
crawl 2 under the SAME classifier version only — v2 on both, never v1
against v2 — and calls `findCapabilityClassifierArtifacts`
(`@chaperone/policy`) as a hard-failure guard: any tool whose canonical
bytes (`sha256`) are identical across the two crawls but whose capability
class disagrees is treated as a classifier bug, never as reported drift.

**What is not claimed:** the v2 rule list is not asserted to be complete.
It was derived by reading crawl 1's `read`/low-confidence tools against
TAXONOMY.md's frozen definitions, not against any drift result (none
existed yet when this fix was made), and a residual false-positive class
remains for verbs used in a scope- or part-of-speech sense unrelated to
the tool's own action (an optional parameter described as "adding" a
field to a read tool's output; "clear" used as an adjective) — the same
category of irreducible noise the v1 `set` stem already carried as a
noun. This is a structural limitation of keyword-based classification, not
something v2 introduced or something a longer verb list can fully close.
