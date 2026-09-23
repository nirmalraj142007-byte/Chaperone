# Taxonomy appendix — capability classifier v2

Additive to `corpus/TAXONOMY.md`, which is frozen as of its first commit and
is not edited by this file. **Axis 2's definitions (`read`, `write`,
`transact`, `communicate`, and the transact > communicate > write > read
precedence) are unchanged.** What changed is `classifyCapability`'s
*implementation* of those definitions — specifically, its list of verbs
recognised as `write` — not the definitions themselves.

## What was wrong

Found 2026-09-20. `classifyCapability`'s v1 write-verb list
(`create`, `update`, `delete`, `set`, `write`, `upload`, `move`, `rename`,
`install`) had no entry matching "add" in any inflection. TAXONOMY.md's own
Axis 2 `write` example is, verbatim: `add_to_list(item)`. A tool matching
its own frozen example — "add an item to your list" phrasing — defaulted
to `read`/`low` under v1, not `write`/`high`. This under-counted `write` in
crawl 1's capability distribution.

## Why a version number, not an in-place fix

`corpus/TAXONOMY.md`, Axis 2: "Capability class is not re-derived at crawl
2 for tools that already existed at crawl 1." Crawl 1's records are frozen
evidence of what the *v1* classifier said. Patching the rule list in place
would mean crawl 1's stored labels silently stop matching what the code
would now produce for the same input — a tool whose description never
changed could appear to have "drifted" in capability class purely because
the CLASSIFIER changed underneath it, contaminating the stratified
headline. `@chaperone/policy` now records `ClassifierVersion` (`"v1"` |
`"v2"`) alongside every verdict; `crawl.ts` stamps
`capabilityAssignedBy: CLASSIFIER_VERSION` explicitly, and Phase 19's
drift analysis must compare crawl 1 and crawl 2 under the SAME version —
v2 on both, never v1 against v2 — enforced by
`findCapabilityClassifierArtifacts` (`@chaperone/policy`), which treats any
capability-class disagreement between two identical-`sha256` tool
snapshots as a classifier bug, not a reportable finding.

## The v2 write-verb table

Unrestricted stems match their bare form plus `-s`/`-es`/`-ed`/`-ing`
(dropping a trailing silent `e` first, e.g. `write` + `ing` → `writing`).
A restricted stem's allowed suffixes are listed; its bare form always
matches regardless.

| Stem | Suffixes | Since | Notes |
|---|---|---|---|
| `create` | `s`/`es`/`ed`/`ing` | v1 | |
| `update` | `s`/`es`/`ed`/`ing` | v1 | |
| `delete` | `s`/`es`/`ed`/`ing` | v1 | |
| `set` | `s`/`es`/`ed`/`ing` | v1 | |
| `write` | `s`/`es`/`ed`/`ing` | v1 | |
| `upload` | `s`/`es`/`ed`/`ing` | v1 | |
| `move` | `s`/`es`/`ed`/`ing` | v1 | |
| `rename` | `s`/`es`/`ed`/`ing` | v1 | |
| `install` | `s`/`es`/`ed`/`ing` | v1 | |
| `add` | `s`/`es`/`ed`/`ing` | **v2** | the motivating fix — see above |
| `insert` | `s`/`es`/`ed`/`ing` | **v2** | |
| `append` | `s`/`es`/`ed`/`ing` | **v2** | |
| `clear` | `s`/`es`/`ed`/`ing` | **v2** | |
| `save` | `s` only | **v2** | restricted — see below |
| `edit` | `ed`/`ing` only | **v2** | restricted — see below |
| `remove` | `s` only | **v2** | restricted — see below |

`transact` (`purchase`, `order`, `checkout`, `pay`, `charge`, `refund`,
`invoice`, `subscribe`, `bid`) and `communicate` (`send`, `email`,
`message`, `post`, `notify`, `sms`, `slack`, `tweet`, `publish`) are
unchanged from v1.

## Evidence review method

Every crawl-1 tool that v1 left as `read`/`low` confidence (4,381 of 6,058
tools, `data/raw/crawl-1/`) was scanned for the candidate stems `add`,
`insert`, `append`, `save`, `edit`, `modify`, `remove`, `clear` — the set
named in the fix request as plausibly matching TAXONOMY.md's `write`
definition ("mutates state that belongs to the user"). Each match was read
in context, not just counted, the same way `order`/`message`/`post`'s v1
suffix restrictions were derived. **No crawl 2 exists yet at the time of
this review, so no restriction below was, or could have been, tuned toward
a drift result** — every judgment call is justified only against
TAXONOMY.md's frozen definition and the crawl-1 text itself.

- **`add`, `insert`, `append`, `clear` — unrestricted.** True positives
  dominated (`add_link`, `add_search_shortcut`, `insert_operator_at_selection`,
  `component_changelog_trail`'s "append a new revision entry", `clear_shortcut`,
  `reset_emulation`'s "Clear every emulation override"). The residual false
  positives found (e.g. a read tool's optional parameter described as
  "adds a comparison block" to its own output; "a clear error message" as
  an adjective) are a scope- or part-of-speech ambiguity that no fixed
  suffix restriction resolves — the same category of irreducible noise `set`
  (v1) already carries as a noun ("returns a set of results"). Documented
  in `docs/LIMITATIONS.md`, not engineered around.
- **`save` → `s` only.** "saved" is overwhelmingly an adjective in crawl-1
  text describing data a *read* tool then lists (`list_library`: "Browse
  your saved icons"; `browserless_profiles`: "authentication profiles
  saved for the current token"), not this tool's own action. The bare form
  ("Save a new link") and third-person-singular ("Saves the PDF to disk")
  are unambiguous and stay — matching `order`'s v1 restriction shape.
- **`edit` → `ed`/`ing` only.** "edits" is a plural noun in crawl-1 text
  (`split_condition`: "edits to the original stop reaching it"), the exact
  same collision `message`/`post` were restricted for in v1. The bare form
  ("Edit an existing image") and the unambiguous inflections ("Edited",
  "Editing") stay — matching `message`/`post`'s v1 restriction shape.
- **`remove` → `s` only.** Across crawl-1 matches, the bare and
  third-person-singular forms were reliably this tool's own action
  (`kg_remove_service`: "Remove a service and all dependencies";
  `anilist_favourite`: "Calling again... removes it from favourites"),
  while `-ed`/`-ing` was dominated by describing some *other* fact: a
  regulatory status (`medical.device-recall`: "devices removed... from the
  market"), a diff output label ("added / removed / changed"), or a read
  tool's own internal text processing (`read_page`: "removing navigation,
  ads, and clutter"). None of those describe this tool mutating the user's
  state.
- **`modify` — deliberately not added.** Every crawl-1 true positive it
  matched was already caught by `edit` (the same handful of image-editing
  tools describe themselves with both words). Its false positives were
  disproportionate for a small sample: two explicit negations
  (`firecrawl_check_crawl_status`: "does not... modify the crawl";
  `photopea_clear_selection`: "Does not modify any pixel data"), one
  instance of a read tool's description naming a *different* tool by name
  (`get_diagram_info`: "Call this BEFORE modify_diagram"), and one instance
  of the *user's* action rather than the tool's
  (`snapdiff_verify_ui_change`: "whenever you modify a route... [and use
  this tool to] confirm"). Zero unique true-positive value against real
  false-positive cost — the same judgment call v1 already made in
  declining to list `bill`/`billing` as a `transact` verb at all.

## v1 → v2 transition table (crawl 1, reclassified)

Produced by `pnpm crawl:reclassify-v2`
(`packages/crawler/scripts/reclassify-crawl-1-v2.ts`), which re-runs v2
over the exact tool text archived in `data/raw/crawl-1/` — never the live
network — and writes `data/crawl-1-capabilities-v2.json` as a file
separate from v1's frozen `data/crawl-1-capabilities.json`. Deterministic
and reproducible: re-running it against the same frozen archives always
reproduces the same table.

| v1 class | v2 class | count |
|---|---|---|
| communicate | communicate | 371 |
| read | read | 4,185 |
| read | **write** | **196** |
| transact | transact | 202 |
| write | write | 1,104 |

6,058 tools total; 196 moved class (all `read` → `write`; none moved into
or out of `transact`/`communicate`, since neither verb list changed).
`write`'s share of crawl 1 rises from 1,104/6,058 (18.2%) under v1 to
1,300/6,058 (21.5%) under v2 — the under-count this fix corrects.
