# Limitations

What this project does not (yet, or ever) claim, stated plainly rather than
left for a reader to discover. Started in the Phase 12/13 completion
session and extended in Phase 21; add to it as later phases surface real
limitations, never remove an entry because it became inconvenient.

---

## The model provider is not decided

Two things in this project want a language model: the one-sentence
**advisory line** a resident may see on a consent card (a 0-100 suspicion
score and a plain-English summary of what changed), and **baseline 2** in
`packages/eval` (an unaided model, given the attack corpus with no
Chaperone in front of it). **No provider has been chosen for either, and
this repo does not state one as chosen.**

What happened, in order, with the evidence for each step:

1. Earlier drafts of `docs/AWS-BUILDER.md` and `.env.example` named Amazon
   Nova models on Bedrock as "decided defaults". That was a working
   assumption made while Bedrock access looked recoverable. It is withdrawn
   as of 2026-09-24; those files now say the choice is pending.
2. The first Bedrock call from this project's AWS account failed on an
   account-wide verification hold (friction-log Entry 037).
3. The next attempt failed with `ValidationException: Operation not
   allowed` on every model and provider tried, including a non-Amazon
   model (friction-log Entry 038). The message named no cause and no
   remedy. Entry 038 could only guess (propagation delay, or an
   organisation-level policy). The outcome, reported by the author on
   2026-09-24, is that **Bedrock access for this new account was
   declined**: a consequence of the account's history, which nothing in the
   error text hinted at. The wording and date of the decline itself were not
   recorded in the friction log.
4. No live Bedrock model call has ever succeeded from this project.

What that means for every claim in this repo:

- **The advisory line in the demo is a hand-written fixture**, labelled as
  one wherever it appears (`demo/OFFLINE.md`). No model wrote it.
- **Baseline 2 has not been measured.** `data/baselines.json` carries
  `null` and a `"pending"` marker for it, and `data/baseline2-adjudication.json`
  is empty, which is the correct state until a real run exists.
  `corpus/PREDICTIONS.md` prediction 4 is therefore untested.
- **When a provider is chosen, the pre-registered wording may not fit it.**
  Prediction 4 is worded "an unaided frontier model". If the provider that
  ends up available is not a frontier model, what gets measured is not what
  was predicted, and the result will say so rather than borrow the word.
  Any baseline-2 percentage will be scoped to exactly this form: *"<provider>
  <model> followed/refused X% of injected instructions against this
  project's own 30-item author-written attack corpus"*. Not "a frontier
  model", not "AI models", not a claim about any other model or about
  real-world attacks.
- **No model name is attached to any number in this repo**, because there
  is no number that came from a model.
- **The seam is a config change, not a rewrite.** `packages/advisory`
  talks to a `ModelProvider` interface with a deterministic mock and a
  Bedrock implementation; a different provider implements the same
  interface. That is a statement about the code, not a claim that any
  provider is available.
- **None of this touches the gate.** The advisory line is decoration on a
  hash comparison. `packages/policy` has no import path to anything that
  could call a model, and the gate never reads an advisory.

## The advisory model is advisory

Even when a real model backs the advisory line, it cannot decide anything.
It cannot allow a tool, cannot lift a quarantine, and cannot reword a
refusal (the refusal text is a frozen constant). Its score and summary are
untrusted model output: parsed against a schema, repaired or rejected, and
shown with a label saying what it is. A wrong, missing or unavailable
advisory changes only how much a resident is told on the card, never
whether the tool runs. The reverse is the limitation worth stating: a
resident who trusts a low score over the highlighted changed clause has
been given a reason to under-read the clause, which is why the card puts
the clause first and the advisory line under it, labelled.

## The corpus is biased toward servers that boot without credentials

Crawl 1 started from 947 candidate servers and captured `tools/list` from
152 of them (16.1%): 656 had no discoverable install command and were
never booted, 291 were attempted, and of those 139 did not produce a tool
list (100 failed install, 21 timed out, 8 failed to start, 10 refused to
run without credentials). See `data/boot-rate.json`.

The captured 152 are the servers that start from their documented install
command, in a sandbox, with no real credentials and no account (the harness
supplies obvious placeholder values for any environment variable a server
declares). That is a
selected population, and the selection is not neutral. A server that needs
an API key or a paid account to answer `tools/list` is exactly the kind of
server with a commercial reason to keep changing what its tools say, and it
is missing from the sample. **The direction of the bias is argued, not
measured**, but it points one way: the drift rate this project reports is
more likely to understate than overstate drift across the ecosystem. The
reported figure will be a statement about servers that boot without
credentials, and nothing wider.

`corpus/candidates-README.md` discloses the other sampling artifacts, which
are permanent properties of the frozen candidate list: the official
registry's contribution is truncated alphabetically by publisher name, not
by popularity; Smithery's listing is neither popularity-sorted nor stable
between requests; awesome-mcp-servers is self-selected by whoever sent a
README pull request; and PulseMCP and Glama contributed nothing because
their listing APIs need a key (friction-log Entry 005).

## The author is the labeller

Everything that turns two crawls into a drift number is a judgement made by
one person: the author of the frozen taxonomy, who is also the author of
the classifier, the corpus and the predictions. There is no second
labeller and no inter-rater agreement figure, and none will be invented.

The part that is not a judgement is the detection: whether a tool's
definition changed is a byte-level hash comparison, and either two hashes
are equal or they are not. The part that is a judgement is the
*classification of a change that did happen*: `cosmetic`, `schema-additive`
or `semantic-intent` (`corpus/TAXONOMY.md`, Axis 1), where `semantic-intent`
is decided by whether a claim changed, and a claim is read, not computed.
The decision rules were written and committed before any data existed, so
they cannot have been fitted to a result, but applying them is still one
reader's reading. One rule in them leans a known way: "if in doubt between
`cosmetic` and `semantic-intent`, it is not `cosmetic`" pushes doubtful
cases toward the headline class, so ambiguity inflates the semantic-intent
count rather than deflating it.

Only `semantic-intent` enters a headline number. Cosmetic and
schema-additive changes are counted and published separately.
{{PENDING: the application of the Axis 1 rules to crawl 2, and any count of cases the author judged ambiguous — 2026-10-20 and after}}


## Baseline 2's classifier is provisional

`packages/eval/src/baseline2Classify.ts`'s `classifyBaseline2Response` /
`classifyBaseline2ControlResponse` were built and unit-tested only against
hand-authored synthetic response strings, never against a real model
call (see "The model provider is not decided" above). The heuristic — refusal-language
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

**One more property of the v2 distribution, stated so it is not read as
more than it is:** `read` is the residual class. Every one of the 4,185
tools `read` under v2 (and every one of the 4,381 under v1) carries
`low` confidence, because `read` is what a tool gets when no
`write`/`transact`/`communicate` verb matched, not because anything
positively identified it as read-only. The `read` share (69.1% under v2)
is therefore an upper bound on how many tools are read-only, and the
`write`, `transact` and `communicate` shares are the ones the verb list
actually recognised. The counts come from `data/crawl-1-capabilities-v2.json`.
