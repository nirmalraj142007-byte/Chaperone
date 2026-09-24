# Questions a judge will ask

Written answers, in the order a reviewer tends to reach them. Every number
names the file that holds it. Where a number does not exist yet, the answer
says so with a `{{PENDING: ...}}` marker rather than a guess <!-- check-placeholders:allow -->, and
`pnpm check-placeholders` (see [`TESTING.md`](TESTING.md)) fails until each
marker is replaced.

The short version of the soft joints, before the long one: **the
classification is the soft joint, and the detection is not.** Whether a
tool's definition changed is a hash comparison and cannot be argued with.
Deciding what kind of change it was is a reading, made by one person. Every
answer below that involves a percentage says which side of that line it is on.

---

## 1. What is the interval, and what are its two timestamps?

**35 days: 2026-09-15 to 2026-10-20.** The day count is the claim; nowhere in
this repo is it restated as a rounded number of weeks, and `pnpm check-claims`
fails the build if anyone tries.

| | When | Where it is recorded |
|---|---|---|
| Pre-registration | 2026-09-12T17:08:55+05:30, commit `ab49dbb` | `CRAWL_DATES.md`, `corpus/TAXONOMY.md`, `corpus/PREDICTIONS.md`, all in that one commit. The taxonomy and the predictions have not been edited since (`git log` on those two paths shows only that commit); the blob hash of the taxonomy at crawl 1 was `0c896539006dbb6f8dfacc1f02ebbf179c50eec2`. |
| Crawl 1 | started 2026-09-15T06:19:42.282Z, finished 06:51:29.907Z | `data/crawl-1-report.json` (`startedAt`, `finishedAt`) |
| Crawl 2 | scheduled 2026-10-20 | {{PENDING: crawl 2 `startedAt` timestamp, and the measured day count between the two crawls — 2026-10-20}} |

`data/drift.json` is committed now in a "pending" shape. Its fields were
fixed before crawl 2, so the analysis can fill them but cannot add new ones
without an additive appendix commit.

**The interim crawl.** A third capture is planned for 2026-10-02, between the
two. It was added on 2026-09-18, after crawl 1, so it is **not
pre-registered**, and it is announced in `CRAWL_DATES.md` (an appended
section; the pre-registered lines above it are untouched) before it runs. It
has not run as of this writing (2026-09-24). It is supplementary to the
headline pair: it runs under the same capability classifier as crawl 2
(classifier `v2`, see [`LIMITATIONS.md`](LIMITATIONS.md)), it is used only to
show drift over time and to detect changes that revert, and its segment rates
are never headlines. The pre-registered comparison is crawl 1 against crawl 2,
2026-09-15 to 2026-10-20, 35 days.
{{PENDING: the 2026-10-02 interim crawl's timestamp and what it showed about drift over time and reverted changes — 2026-10-02}}

The candidate list is the one committed before crawl 1 and is used unchanged
for crawl 2. A server that appeared in October cannot enter the comparison,
because adding it would be choosing the corpus after seeing which servers
drifted (`corpus/candidates-README.md`, section 6).

## 2. What counts as "semantic-intent", how is it different from "schema-additive", and who decided?

There are five change classes, checked in this order (`corpus/TAXONOMY.md`,
Axis 1): `tool-removed`, `tool-added`, `semantic-intent`, `schema-additive`,
then `cosmetic` as the default.

- **cosmetic**: bytes differ, but no reasonable reading changes what the tool
  claims to do, access or talk to. Punctuation, capitalisation, reflowing.
- **schema-additive**: the input schema gained an optional field or an enum
  widened, nothing was removed, nothing new is required. Every previously
  valid call behaves the same. (`add_to_list(item)` gaining `quantity?`.)
- **semantic-intent**: the description, or a new required field, changes what
  the tool claims to do, what data or systems it says it will touch, or which
  third party it says it will talk to. It is judged on the claim, not on
  whether the vendor's code changed, because the claim is the assistant's
  entire basis for calling the tool and the code is not observable.

Only `semantic-intent` enters a headline number. Cosmetic and schema-additive
changes are counted and published separately, and a drift rate that included
them would be wrong. That rule is enforced in the shape of `data/drift.json`
(`countedSeparately` is a different object from the headline fields).

**Who decided.** The author wrote these rules, alone, on 2026-09-12, before
any data existed. The author will apply them to crawl 2, alone. There is no
second labeller and no agreement statistic, and none will be invented. This is
the soft joint, and it has two known properties:

1. The rules cannot have been fitted to the result, because they predate it.
2. They contain one deliberate lean: "if in doubt between `cosmetic` and
   `semantic-intent`, it is not `cosmetic`". Ambiguity therefore pushes
   toward the headline class, so it inflates the reported drift rate rather
   than shrinking it.

What is not soft: that a definition changed at all. That is `allow(current,
pinnedHash)`, a synchronous hash comparison in `packages/policy`. Two hashes
are equal or they are not, and no reading is involved.

{{PENDING: the semantic-intent drift rate with its denominator, the count of cosmetic and schema-additive changes reported separately, and the number of cases the author judged ambiguous — 2026-10-20 and after}}

## 3. Attempted versus captured: what happened to the rest?

Crawl 1 (2026-09-15), from `data/crawl-1-report.json` and `data/boot-rate.json`:

| | Servers |
|---|---:|
| Candidates in `corpus/candidates.json` | 947 |
| No discoverable install command, never booted | 656 |
| Attempted | 291 |
| **Captured** (booted, `tools/list` read) | **152** |
| Failed to install | 100 |
| Timed out | 21 |
| Failed to start | 8 |
| Refused to run without credentials | 10 |

152 of 947 is 16.1%. Of the 291 that had an install command, 139 (47.8%) did
not start from their own documented setup instructions. The 152 that did
yielded 6,058 tools.

What "the rest" means for the drift claim:

- **They are not in it.** The drift denominator is servers captured in *both*
  crawls (`data/drift.json`, field `n`, currently `null`; it is never
  inferred from crawl 1 alone).
- **A server that fails to boot at crawl 2 is not a `tool-removed` event.**
  The taxonomy is explicit: it is a boot failure and is reported as one.
- **They are a bias, not just a loss.** The captured population is servers
  that start with no real credentials and no account. That likely
  understates drift. See [`LIMITATIONS.md`](LIMITATIONS.md), "The corpus is
  biased toward servers that boot without credentials".
- **The candidate list itself has sampling artifacts**, disclosed before
  crawl 1 in `corpus/candidates-README.md`: the registry contribution is
  truncated alphabetically, Smithery's order is unstable, awesome-mcp-servers
  is self-selected, and two directories contributed nothing.

## 4. Why does drift in the open ecosystem matter for a curated catalogue?

Because **curation binds who you trust, not what they said when you trusted
them.**

A catalogue reviews a tool at one moment: the listing. What the assistant
reads is the tool's definition, served by the publisher, every time it
connects. Nothing in the protocol ties the second to the first. A publisher
who was vetted in January can serve different words in March, and no listing
event marks the difference. The approval was a moment; the definition is a
stream.

The open-ecosystem measurement is a base rate for that gap: how often
definitions change with no listing event to mark it. It can be observed from
outside, in the open, without access to any catalogue's internals.

Two things this argument does not say. It does not say a curated catalogue
drifts as often as the open ecosystem; that is unmeasured. The author's
expectation is that it drifts less, and it is only an expectation. Nor does
the argument depend on the rate being high. The mechanism (keeping what each
tool claimed at approval and comparing on every connect) costs one hash per
tool. What happens if the measured rate comes in low is written down in
`corpus/PREDICTIONS.md`, "What would embarrass me", which commits to
publishing that result as the headline.

## 5. Where is the customer?

The customer is a household member with an assistant that connects to
third-party tools, and who has no way to know that a tool they approved in
January now says something different. What they see is one card, in ordinary
words, showing the sentence that changed beside the one they approved.

What exists to support that, and what does not:

- **Exists:** a working end-to-end flow (`pnpm demo:verify` asserts it), a
  measured base rate for how often the ecosystem's tool definitions could be
  changing (pending crawl 2), and a boot-rate finding about the ecosystem
  (47.8%) that is independent of this product.
- **Does not exist:** any household that has used it. There are no users, no
  interviews and no demand data in this repository. The scope is one
  hard-coded household with no accounts, deliberately. The "you approved this
  on 12 January" line in the demo is a staged fixture, labelled as one on
  screen and in the ledger (`demo/OFFLINE.md`).

The case for the customer is structural: any assistant that re-reads tool
instructions on every connect has this gap, whoever the customer turns out to
be. That is an argument, not evidence of demand, and it is the weakest answer
on this page.

---

## Other questions that come up

**Why is there no "Chaperone blocked 100%" number?** Because it is a
correctness property and not a result. The attack corpus is written by the
author and the mechanism is a hash comparison: a changed definition always
hashes differently, so the block rate against a corpus of changed definitions
cannot come out any other way. It is **tautological**, so it is cut from every
claim, and `packages/eval` has a test that fails if an absolute block rate
appears in a report. The meaningful comparison is the delta against baseline 2
(an unaided model), which is unmeasured. See the README, "What this does not
prove".

**Which model does the advisory line use?** None. No model provider is chosen,
and Bedrock access for this AWS account was declined. The advisory line in
the demo is a hand-written fixture, labelled as such. The gate never reads an
advisory. See [`LIMITATIONS.md`](LIMITATIONS.md), "The model provider is not
decided".

**What is the latency cost?** Every gated call performs four DynamoDB writes.
Measured against DynamoDB Local it added a median of 480.53 ms, which is a
statement about that backend and not about the gateway. The 30 ms budget is
unverified against real DynamoDB and `pnpm bench` fails on purpose until it
is. {{PENDING: added p50/p95/p99 against DynamoDB on AWS — after the AWS deployment (Phase 18)}}

**Is this a security product?** It is a memory. It records what a household
approved and compares later versions against it. It does not try to detect
malicious behaviour, only changed claims, and that limit is deliberate and
written into the project's scope.
