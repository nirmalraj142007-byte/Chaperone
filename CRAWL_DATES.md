# Crawl dates

This file declares the two data-collection dates for the Chaperone corpus. It is
committed before crawl 1 runs, and its timestamp is part of the evidence chain:
pre-registration after the first observation is not pre-registration.

| Crawl | Calendar date | Purpose |
|---|---|---|
| Crawl 1 | 2026-09-15 | Baseline capture of `tools/list` output for every server in `corpus/candidates.json`. |
| Crawl 2 | 2026-10-20 | Repeat capture against the same, frozen candidate list. Drift is the diff between the two. |

**Interval: 35 days.**

All public claims use the day count, never a rounded week count. "35 days" is
correct; "five weeks" is correct only as a colloquial aside, never as the <!-- check-claims:allow: this line names the banned phrase to explain the rule, not as a claimed interval -->
number that appears next to a percentage. `pnpm check-claims` greps committed
prose for rounded-week language and fails CI if it finds any.

## Execution timestamps

The two lines below are reserved for the crawler to fill in automatically —
by writing `startedAt` into `data/crawl-1-report.json` and
`data/crawl-2-report.json` — not by hand-editing this file:

- Crawl 1 executed at: 2026-09-15T06:19:42.282Z (finished 2026-09-15T06:51:29.907Z; corpus/TAXONOMY.md blob 0c896539006dbb6f8dfacc1f02ebbf179c50eec2)
- Crawl 2 executed at: _(pending — see `data/crawl-2-report.json` → `.startedAt`)_

Do not fill these in manually. If they are blank, the crawl has not run.

The `corpus/TAXONOMY.md blob` value above (and each report's `taxonomyBlobSha`
field) is a git **blob** hash — `git rev-parse HEAD:corpus/TAXONOMY.md`, the
hash of the file's exact bytes at HEAD — not a commit hash. That's
deliberate: a blob hash is pinned to the taxonomy's literal content and is
immune to an unrelated commit that happens to also touch the file, which is
stronger evidence than "which commit last touched this path" would be.

---

## Appendix: interim crawl announced 2026-09-24 (additive; not pre-registered)

Everything above this line is unchanged. This section is appended, and
announces a crawl **before it runs**.

| | |
|---|---|
| What | An interim crawl of the same frozen `corpus/candidates.json`, no server added or removed |
| Planned for | 2026-10-02 |
| Added to the plan | 2026-09-18, after crawl 1 (2026-09-15). It is **not pre-registered**: it was not in the plan committed on 2026-09-12 |
| Capability classifier | `v2` (see `corpus/TAXONOMY-APPENDIX-classifier-v2.md`), the same version crawl 2 uses, stamped on every verdict by `crawl.ts` |
| Status when announced | Has not run. Its execution timestamp will come from the crawler's own report, not be entered by hand |

**Its role is supplementary to the headline pair.** The pre-registered
comparison is unchanged: crawl 1 against crawl 2, 2026-09-15 to 2026-10-20,
**35 days**. The interim crawl is used only to show how drift accumulates over
time and to detect changes that revert (a tool definition that changed and
then changed back, which a two-point comparison cannot see). It is never used
to choose, adjust or replace either endpoint of the headline comparison.

**Its segment rates are never headlines.** Any drift rate computed on the
interval from crawl 1 to the interim crawl, or from the interim crawl to crawl
2, is reported as a segment of the time series, labelled as such, and is not
quoted as a headline number anywhere. The headline remains the crawl 1 to
crawl 2 figure, and only `semantic-intent` changes enter it
(`corpus/TAXONOMY.md`).
