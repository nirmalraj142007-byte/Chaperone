# @chaperone/analysis

The drift analysis: crawl 1 against crawl 2, `semantic-intent` only. The
rules it follows are in `corpus/TAXONOMY.md` and
`corpus/DRIFT-JSON-APPENDIX-report-shape.md`, both committed before any
two-crawl data existed.

It reads only committed files: `data/{crawlId}-report.json`,
`data/raw/{crawlId}/*.json`, the v2 capability rows and
`corpus/candidates.json`. It never reads DynamoDB.

## What runs, in order

1. **Gates.** It refuses to run if the `corpus/TAXONOMY.md` blob named in
   crawl 1's report was first committed after crawl 1 started, or if any
   later report or the working tree names a different blob. The interval is
   the difference in UTC calendar dates between the reports' `startedAt`
   values.
2. **Load and verify.** It rebuilds every snapshot from the raw archives and
   recomputes each `sha256` with `hashTool`. It fails if a report's
   `bootedServerIds` disagrees with its archives, if a capability row is not
   stamped v2, or if a recorded class does not reproduce under
   `classifyCapability(tool, "v2")`.
3. **Pair.** It joins on `(serverId, toolName)`, starting from crawl 1's
   `bootedServerIds`, into four buckets: present-in-both, tool-added,
   tool-removed and server-absent.
4. **Classifier artifacts.** It runs `findCapabilityClassifierArtifacts`
   between every two snapshots. A non-empty result fails the run.
5. **Change class.** Only two cases are mechanical: formatting-only text
   (`cosmetic`) and a purely additive schema (`schema-additive`). Every other
   changed pair needs a human label. While any label is missing, the run
   writes `data/labels-todo.json` and stops.
6. **Counts.** It computes the headline, the capability strata, segments,
   the two time-to-first-change bins and reversions. Below n = 100 there
   are counts only and every rate is `null`.
7. **Rider C.** It runs only when drift is at least 0.20 and n is at least
   100. It calls `checkChangelog` with `GITHUB_TOKEN` from `.env`.

## Oct 2: interim crawl rehearsal

```
pnpm crawl:run --crawl-id=crawl-interim-1
pnpm analyse:drift --later=crawl-interim-1   # a segment, never a headline; writes data/labels-todo.json
pnpm analyse:label                           # start labelling now; labels carry over to crawl 2 when the bytes match
```

## Oct 20: crawl 2

```
pnpm crawl:run --crawl-id=crawl-2
pnpm analyse:drift                           # stops at data/labels-todo.json if labels are missing
pnpm analyse:label                           # q quits at any point; re-run to resume
pnpm analyse:drift                           # writes data/drift.json and prints both sentences
```

## Any time

```
pnpm analyse:drift --dry-run                 # crawl-1 vs crawl-1: must be 0 drift, 0 artifacts
pnpm analyse:label --prevalence              # M14: label the committed 150-tool sample
pnpm analyse:label --data-dir=<scratch dir>  # rehearse on a copy, not data/
```

`data/drift.json` is written only by the crawl-1 against crawl-2 run. The
dry run, the interim rehearsal and the tests all refuse that path.
