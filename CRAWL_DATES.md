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
correct; "five weeks" is correct only as a colloquial aside, never as the
number that appears next to a percentage. `pnpm check-claims` greps committed
prose for rounded-week language and fails CI if it finds any.

## Execution timestamps

The two lines below are reserved for the crawler to fill in automatically —
by writing `startedAt` into `data/crawl-1-report.json` and
`data/crawl-2-report.json` — not by hand-editing this file:

- Crawl 1 executed at: 2026-09-15T06:19:42.282Z (finished 2026-09-15T06:51:29.907Z; corpus/TAXONOMY.md at commit 0c896539006dbb6f8dfacc1f02ebbf179c50eec2)
- Crawl 2 executed at: _(pending — see `data/crawl-2-report.json` → `.startedAt`)_

Do not fill these in manually. If they are blank, the crawl has not run.
