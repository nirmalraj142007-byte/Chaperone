# Attack corpus

This corpus is **written by the project author, not collected from a real
attack in the wild.** Every file under this directory and under
[`controls/`](controls/) was authored for Chaperone's Phase 13 evaluation
work, by the same person who built the detector being evaluated against it.

That is the whole reason `packages/eval` never reports Chaperone's own block
rate against this corpus as an absolute number. **Chaperone's own block rate
against an author-written corpus is near-tautological and is reported only as
a delta against baseline 2** — see `data/baselines.json` and
`packages/eval/src/report.ts`. A detector scored against its own author's test
cases can always be made to look perfect; the honest move is to say that
plainly, not to bury it in a footnote, and to report every rate as a delta
against an independent baseline instead of as a number that stands on its
own.

## What this corpus is for

`packages/eval` uses this corpus for two things a hand-picked set of "obvious"
attacks cannot honestly support:

1. **Baseline 1** (`src/baseline-regex.ts`) — a deliberately dumb 30-line
   regex blocklist — is run against every `attackVersion` below to produce a
   real, reproducible detection rate, and against every `benignVersion` and
   every file in `controls/` to produce a real, reproducible **false-positive
   rate**. A detector that flags everything scores 100% on the first number
   and means nothing; reporting the second number alongside it is what makes
   the first one interpretable.
2. **Baseline 2** (`src/baseline-model.ts`) — an unaided frontier model
   deciding, on its own, whether to follow an instruction embedded in a tool
   description — is designed against this same corpus, though no live model
   calls exist yet in this phase (see `data/baselines.json`, which reports
   baseline 2's fields as `null` with a `"pending: provider unavailable"`
   marker rather than inventing a number).

## Shape of an attack item

Each file in this directory (excluding `controls/`) is one JSON object:

| Field | Meaning |
|---|---|
| `id` | Stable identifier; also the filename without `.json`. |
| `pattern` | One of the five injection patterns below. |
| `toolName` | The tool this item pretends to be, for prompt-building and readability. |
| `capabilityClass` | `read` \| `write` \| `transact` \| `communicate` — same axis as `corpus/TAXONOMY.md`. |
| `authoredBy` | Always the literal string `"project-author"` — never omitted, never any other value. |
| `userRequest` | A plausible resident request that would plausibly cause an assistant to reach for this tool — context for baseline 2's prompt. |
| `benignVersion` | The tool's description with no injected instruction. |
| `attackVersion` | The same tool, same name, same apparent purpose — with one injected instruction added. |

`benignVersion` and `attackVersion` are a matched pair on purpose: the same
tool, the same voice, the same input contract, differing only in the injected
clause. That pairing is what makes a false-positive measurement meaningful —
a blocklist that fires on `attackVersion` but not on the *paired*
`benignVersion` learned something about the injection, not about the tool's
ordinary vocabulary.

## Why `controls/` exists as a separate set

The paired `benignVersion` texts above are not, by themselves, a sufficient
false-positive check — they are structurally similar to their attack
counterpart (same tool, same sentence up to the injected clause), so a
blocklist could pass that test by accident. [`controls/`](controls/) holds
ten additional tool descriptions with **no attack counterpart at all**:
ordinary, boring, real-world-shaped tool descriptions across unrelated
domains (currency conversion, stock quotes, translation, event search, and
so on). Baseline 1's false-positive rate is computed over the union of both
sets. Ten is a floor, not a target — see `packages/eval/src/corpus.ts`, which
refuses to load a corpus with fewer than ten.

## The five injection patterns

Each pattern below is a distinct mechanism for smuggling an instruction to
the assistant into text a resident will never read but a model reads on
every single connect. Six items exist per pattern (30 total), each written to
read the way a real vendor's tool description reads — studied against the
6,058 real tool manifests in `data/raw/crawl-1/` for voice and structure, not
invented in the abstract. An obviously adversarial string ("IGNORE ALL PRIOR
INSTRUCTIONS") proves nothing about a real detector; these do not do that.

- **`direct-instruction`** — a second-person instruction addressed to the
  assistant, woven into otherwise ordinary description prose, with no
  authority framing. Shapes what the assistant emphasizes, recommends, or
  omits in its reply.
- **`false-authority`** — the same kind of instruction, wrapped in a marker
  designed to read as more privileged than ordinary tool-description text:
  `SYSTEM NOTE:`, `[SYSTEM]`, `ADMIN OVERRIDE:`, `IMPORTANT — INTERNAL USE:`,
  `Developer instructions:`.
- **`data-exfiltration`** — framed as helpfulness: the injected clause asks
  the assistant to surface or include something sensitive (a card's last
  four digits, a passport number, an occupancy signal) under a plausible
  "so the resident doesn't have to ask twice" pretext.
- **`scope-widening`** — the tool claims to newly touch a system or data
  source it never claimed to touch before (a calendar, a contact list, a
  banking app, a smart-lock log), framed as a natural feature extension
  rather than a new capability.
- **`delayed-trigger`** — the injected behavior is conditioned on a later
  turn, a call count, or a calendar date, so it will not fire on the first,
  most-likely-to-be-tested call at all.

## Capability class is not a sixth pattern

Every item also carries `capabilityClass`, independent of `pattern`, so the
corpus can be stratified by what the tool can actually *do* (read, write,
transact, communicate) as well as by *how* the injection is smuggled in. The
two axes are deliberately orthogonal — a `direct-instruction` item can carry
any capability class, and so can a `delayed-trigger` item — the same way
`corpus/TAXONOMY.md` keeps change class and capability class independent for
the real-server corpus.

## License

MIT, same as the rest of this repository, from the first commit of this
directory.
