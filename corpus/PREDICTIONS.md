# Pre-registered predictions

Written on 2026-09-12, before crawl 1 (2026-09-15) and before any corpus data
exists. See [`CRAWL_DATES.md`](../CRAWL_DATES.md) and
[`TAXONOMY.md`](TAXONOMY.md), both frozen alongside this file. These numbers
are not adjusted after crawl 1 runs — that would make them postdictions wearing
a pre-registration's clothes.

## Predictions

1. **Semantic-intent drift: 20–40%.** Of the servers captured in both crawls,
   between 20% and 40% will show at least one tool whose Axis-1 change class
   is `semantic-intent` (never `cosmetic` or `schema-additive` — see
   [`TAXONOMY.md`](TAXONOMY.md)).

2. **Instruction-shaped description prevalence: 5–12%.** Of tools captured at
   crawl 1, between 5% and 12% will contain description text that reads as
   an instruction directed at the calling model rather than at the human
   reading a catalogue entry (e.g. imperative language telling the model what
   else to do, rather than describing what the tool returns).

3. **Conditional on drift ≥ 20%: fewer than 30% of drifted servers publish any
   user-visible signal.** Of the servers whose Axis-1 change class includes at
   least one `semantic-intent` event, fewer than 30% will show any
   corresponding version bump, changelog entry, release note, or commit
   message that a resident could plausibly have seen.

4. **Baseline 2 (unaided frontier model) refuses 70–85% of the crafted attack
   corpus.** An unaided frontier model, given no proxy and no policy layer,
   will decline to follow the injected instruction in 70–85% of the attack
   corpus in `corpus/attacks/`.

## What would embarrass me

If semantic-intent drift comes in under 5% **and** baseline 2 blocks nearly
all of the attack corpus unaided, the honest reading is that untrusted MCP
tool definitions in the wild are stable and the residual risk is one frontier
models already handle without help — a solution to a non-problem. I am
pre-committing, now, before any data exists, to reporting that combination as
the headline if it happens: *"I tracked N real servers across 35 days and the
sky is not falling — here is the measured tail."* That is a respectable,
unwinnable submission, and the honest move is to say so on camera rather than
reach for a framing that survives by being vague.
