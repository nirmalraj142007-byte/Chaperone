# Corpus provenance — `corpus/candidates.json`

This document explains where the 947 servers in `corpus/candidates.json` came
from, what was left out and why, and what a reader should and shouldn't
conclude from the corpus as assembled. It was written on 2026-09-13, after a
pre-crawl-1 composition check and a full commit-recency and capability pass
against the corpus as it stands today — three days before crawl 1
(2026-09-15, see [`CRAWL_DATES.md`](../CRAWL_DATES.md)).

---

## 1. What each source contributed

| Source | Raw entries fetched | Unique servers contributed | Cap applied |
|---|---|---|---|
| Official MCP registry | 400 | 355 | `CRAWLER_REGISTRY_LIMIT=400` |
| Smithery | 400 | 243 | `CRAWLER_SMITHERY_LIMIT=400` |
| awesome-mcp-servers | 350 | 350 | `CRAWLER_AWESOME_LIMIT=350` |
| PulseMCP | 0 | 0 | — (see §2) |
| Glama | 0 | 0 | — (see §2) |
| **Total after dedup** | **1150** | **947** | |

Smithery's own pagination returned 400 raw entries but only 243 distinct
`qualifiedName`s — roughly 157 of the 400 were internal duplicates (the same
server appearing under more than one page number; see §3 for why). The
dedup pass in [`dedupe.ts`](../packages/crawler/src/dedupe.ts) collapses
those correctly by normalised slug.

Across all three live sources, dedup found exactly **one** genuine
cross-source match — `DiagramZu` (`yenchieh/diagramzu-mcp`), listed both by
the official registry and by awesome-mcp-servers on the same GitHub repo.
Every other one of the 947 servers was found by only one source. That's
worth being direct about: three directories of "the same ecosystem" agreeing
on only one entry out of 947 says these are three largely non-overlapping
populations, not three views of the same population — the corpus's real
diversity comes from combining disjoint sources, not from cross-validating
a shared one.

Of the 947, **569 carry a resolvable `repoUrl`** (161 from the registry, 58
from Smithery — only set when a server's `homepage` field is itself a
`github.com` URL — and all 350 from awesome-mcp-servers, which by
construction only lists servers with a GitHub repo).

## 2. The two sources that contributed zero, and exactly why

- **PulseMCP.** Its `v0beta` API — the one a naive reading of "a paginated
  public PulseMCP server API" would reach for — is fully sunset: a live
  request returns `HTTP 410 Gone` with body
  `{"error":{"code":"API_SUNSET","message":"...Fully sunset (100%)..."}}`.
  Its replacement, `v0.1`, requires an `X-API-Key` header — confirmed with a
  live `HTTP 401 {"error":"Invalid or missing API key",...}` — which this
  project does not hold. See `pulsemcp.ts` and friction-log.md Entry 005.
- **Glama.** `glama.ai/api/mcp/v1/servers` requires an API key on *every*
  call, with no free tier observed — confirmed with a live `HTTP 401` whose
  body reads "This endpoint requires an API key. Create one at
  https://glama.ai/settings/api-keys." See `glama.ts` and the same
  friction-log entry.

Both degrade to contributing 0 with a logged reason rather than failing the
assembly run. Neither is a code bug; both are documented, verified facts
about the live services as of 2026-09-12/13.

## 3. The sampling rule — what was capped, at what number, and in what order

**Defaults changed once already.** The crawler originally shipped with
`CRAWLER_REGISTRY_LIMIT=150` and `CRAWLER_SMITHERY_LIMIT=150`
(`CRAWLER_AWESOME_LIMIT=350` unchanged throughout). A composition check on
2026-09-13 found that pair of defaults left the registry and Smithery each
sampled from well under 3% of what they actually list — the registry has
well over 500 servers as of exploration on 2026-09-12 and keeps going past
that; Smithery's own pagination metadata reports 14,502 total — while
awesome-mcp-servers ended up contributing 350 of 610 (57%) with zero
cross-source overlap. Both were raised to 400 the same day and the corpus
re-assembled to the 947 committed here.

**Registry order: alphabetical by publisher-qualified name, not popularity.**
The registry's `/v0/servers` endpoint is cursor-paginated with no sort
parameter exposed; verified live, consecutive pages return names in strict
alphabetical order (`ac.inference.sh/mcp`, `ac.snag/snag`,
`ac.tandem/docs-mcp`, `ad.inside/inside-ads`, ... continuing through
`io.github.moelayyan90/...` by our cap). Capping at the first 400 therefore
means the registry's contribution is **truncated alphabetically by
reverse-DNS publisher name** — every registered server whose name sorts
after roughly the `io.github.mo*` range is entirely absent from this corpus,
for no reason connected to that server's activity, quality, or capability.
This is a real, disclosed sampling artifact, not a curation choice.

**Smithery order: not popularity-sorted, and not a stable order.** The
prompt that specified this source described it as plausibly needing
auth-gating; it turned out to need none (see friction-log.md Entry 005), but
its *ordering* also isn't what a first guess would assume. Verified live
against `useCount` (Smithery's own popularity signal): page 1 shows counts
in the tens of thousands, but page 4 shows *higher* counts (up to 60,881)
than page 1, and page 40 shows counts back down in the low thousands —
non-monotonic, so the listing is not sorted by popularity. It also isn't a
guaranteed-stable order: the ~157 internal duplicates in §1 are consistent
with page boundaries shifting under a live, changing dataset between our
paginated requests, not with a bug in this project's pagination logic
(each request asked for the next page number in sequence, per the API's own
documented contract).

**awesome-mcp-servers order: the file's own top-to-bottom order.** This
source does one fetch (the whole README) and takes the first 350
repo-linked list items in the order they appear in the file — an order set
by whatever sequence community PRs landed in, not by any signal this project
controls or that correlates with popularity. Every entry here has a GitHub
repo by construction (it's the only source that reliably yields an install
path — see `awesome.ts`), which is also why this source alone accounts for
100% of its own repoUrl coverage.

**Net effect:** none of the three sampling rules favours "popular" or
"well-maintained" servers over obscure ones — if anything, Smithery's
apparent lack of any sort and the registry's alphabetical truncation are
closer to arbitrary with respect to quality than to biased toward it. The
one source that *is* selection-biased in a meaningful way is
awesome-mcp-servers, which is biased toward servers a human bothered to
submit a README PR for — self-selected publicity-seeking, not popularity.

## 4. 90-day activity rate

Checked live against GitHub's REST API (`GET /repos/{owner}/{repo}`,
`pushed_at`), authenticated, for all **569** repo-identified candidates —
not a sample. Run: 2026-09-13, `pnpm crawl:commit-recency`.

| | N | % of 569 |
|---|---|---|
| Active (pushed ≤90 days ago) | 395 | 69.4% |
| Dormant (pushed >90 days ago) | 119 | 20.9% |
| Not found (404 — repo renamed or deleted since listing) | 55 | 9.7% |

Active rate among servers that still resolve (395 / 514): **76.8%**.

By source (active-rate excludes 404s from the denominator):

| Source | N with repo | Active | Dormant | 404 | Active rate (resolved) |
|---|---|---|---|---|---|
| Registry | 161 | 100 | 16 | 45 | 86.2% |
| awesome-mcp-servers | 350 | 242 | 98 | 10 | 71.2% |
| Smithery | 58 | 53 | 5 | 0 | 91.4% |

Two things worth naming plainly. First, the corpus is **not**
predominantly dormant — a large majority of repo-identified servers were
pushed to within the last quarter, which is the reassuring answer to "can
this corpus even show drift." Second, the registry's **45/161 (28.0%) 404
rate** is itself a finding, not noise: over a quarter of the official
registry's own `repository.url` fields point at GitHub repos that no longer
exist at that path. That's a data-quality fact about the official registry,
worth carrying into the eventual boot-success-rate reporting in its own
right.

Recency data is time-sensitive in a way the frozen candidate list isn't —
re-running this check later (e.g. ahead of crawl 2, 2026-10-20) will get
different numbers as repos age, and that's expected; it uses its own cache
directory (`packages/crawler/.cache/http-github-activity/`), separate from
the main crawl cache, for exactly that reason.

## 5. Capability distribution (rough estimate)

Computed by `pnpm crawl:capability-report`, which recovers each server's
own name and top-line description and applies
[`estimateServerCapability`](../packages/crawler/src/capabilityEstimate.ts)
— a **server-level, keyword-based proxy** for `TAXONOMY.md`'s Axis 2, built
from prose a publisher wrote about their own server. This is **not** the
taxonomy-grade Axis-2 label, which is assigned per *tool* against real
`tools/list` output at boot time (Phase 5) — it exists only as an early,
order-of-magnitude sanity check of corpus composition before the candidate
list freezes.

| Class | N | % of 947 |
|---|---|---|
| read | 544 | 57.4% |
| write | 217 | 22.9% |
| transact | 143 | 15.1% |
| communicate | 43 | 4.5% |
| **transact + communicate** | **186** | **19.6%** |

Nearly a fifth of the corpus, by this rough measure, claims to be able to
spend money or talk to a third party — comfortably enough for the
stratified drift-by-capability headline (see the judge-evaluation
Q&A prep in the project's planning notes) to have something to say if drift
concentrates there.

## 6. The candidate list is frozen as of crawl 1

`corpus/candidates.json` as committed here is what crawl 1
(2026-09-15) captures `tools/list` output for, and it is what crawl 2
(2026-10-20) re-captures against, unmodified. **No server can be added to
this list after crawl 1 runs.** A server that launches, gets popular, or
gets fixed after 2026-09-15 cannot enter the drift comparison, no matter how
interesting it would be — adding it would be indistinguishable from picking
the corpus after seeing which servers were going to drift, which is the
exact failure pre-registration exists to prevent. Every disclosure in this
document — the alphabetical registry truncation, Smithery's unstable order,
awesome's self-selection bias, the registry's 404 rate — is therefore a
permanent, disclosed property of the evidence, not a draft to be quietly
improved later. If it needs to change, that has to happen today, before
2026-09-15, in the open, as a new commit — not as a silent edit to this file
or to `candidates.json` itself.
