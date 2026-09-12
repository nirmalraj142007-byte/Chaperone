# Corpus taxonomy

Pre-registered before crawl 1 (2026-09-15, see [`CRAWL_DATES.md`](../CRAWL_DATES.md)).
Two independent axes are applied to every tool captured in the corpus:
**change class** (assigned at crawl 2, by diffing against crawl 1) and
**capability class** (assigned once, at first observation).

**This file is frozen as of its first commit.** Any later change to the
classification scheme is an additive appendix in a new file
(`corpus/TAXONOMY-APPENDIX-<n>.md`) with its own commit — never an edit to the
sections below, never a rebase over this commit, never an amend.

---

## Axis 1 — change class

Exactly five values, mutually exclusive. A tool's change class is decided by
walking the diff between its crawl-1 and crawl-2 manifest in this order —
`tool-removed` and `tool-added` are checked first (presence/absence), then
`semantic-intent`, then `schema-additive`, then `cosmetic` as the default when
nothing else applies.

**Only `semantic-intent` enters any headline claim.** `cosmetic` and
`schema-additive` changes are counted and published separately; a stated drift
rate that includes them is wrong. This is a correctness property enforced
outside this file, not a suggestion.

### cosmetic

**Decision rule:** the tool's name, description text, and input schema are
byte-different from crawl 1, but no reasonable reading of the new text changes
what the tool claims to do, what it claims to access, or who it claims to talk
to. Whitespace, punctuation, typo fixes, capitalisation, and reformatting
(e.g. reflowing a paragraph) all fall here. If in doubt between `cosmetic` and
`semantic-intent`, it is not `cosmetic`.

- **Example 1:** `"Adds an item to your shopping list."` →
  `"Adds an item to your shopping list"` (trailing period removed). No claim
  changed.
- **Example 2:** `"Fetches the current weather for a city"` →
  `"Fetches the current weather for a city."` with a markdown code span added
  around `city` in the parameter description. No claim changed.

### schema-additive

**Decision rule:** the input schema gained a new field that is optional (not
in `required`), or an existing enum widened to include new values, and nothing
was removed and nothing new was made required. The tool's stated behaviour for
every input that was previously valid is unchanged.

- **Example 1:** `add_to_list(item: string)` becomes
  `add_to_list(item: string, quantity?: number)` — new optional field, old
  calls still work identically.
- **Example 2:** `set_theme(mode: "light" | "dark")` becomes
  `set_theme(mode: "light" | "dark" | "system")` — enum widened, no existing
  value's meaning changed, nothing required.

### semantic-intent

**Decision rule:** the description text (or a required-field addition) changes
what the tool claims to do, what data or systems it claims it will access, or
what third party it claims it will talk to — regardless of whether the
underlying implementation actually changed. This class is judged on the
*claim*, because the claim is the model's entire basis for deciding whether to
call the tool; whether the vendor's server-side code changed at all is not
observable from the manifest and is not part of the decision rule.

- **Example 1:** `"Adds an item to your shopping list."` →
  `"Adds an item to your shopping list. Also checks your calendar for
  upcoming events and includes relevant items."` — the tool now claims to read
  the calendar. `semantic-intent`, capability class raised from `write` to
  `write` with a new `read` side-claim (see Axis 2 disambiguation below, which
  resolves this to whichever is higher of the two claimed capabilities).
  Regardless of the capability re-classification, the change to stated access
  is `semantic-intent` on Axis 1.
- **Example 2:** `"Sends a text summary to yourself."` →
  `"Sends a text summary to yourself and to your emergency contact."` — the
  tool now claims to talk to a third party it did not claim to talk to before.
  `semantic-intent`.

### tool-added

**Decision rule:** the tool name does not appear in the server's crawl-1
`tools/list` output and does appear in its crawl-2 output. Capability class is
assigned at this first observation (crawl 2, for this tool).

- **Example 1:** a grocery server's crawl-2 manifest includes
  `reorder_last_purchase`, absent at crawl 1.
- **Example 2:** a smart-home server adds `lock_front_door`, absent at crawl 1.

### tool-removed

**Decision rule:** the tool name appears in the server's crawl-1 `tools/list`
output and does not appear in its crawl-2 output, and the server itself is
still reachable (a server that fails to boot at crawl 2 is a boot-failure, not
a `tool-removed` event, and is reported under boot success rate instead).

- **Example 1:** a server drops a deprecated `legacy_add_item` tool between
  crawls.
- **Example 2:** a server removes `share_location` entirely rather than
  changing what it does.

---

## Axis 2 — capability class

Exactly four values, assigned per tool at first observation (crawl 1 if the
tool exists there, otherwise crawl 2 for a `tool-added` tool). Capability
class is not re-derived at crawl 2 for tools that already existed at crawl 1 —
a capability re-classification triggered by a description change is itself
evidence of `semantic-intent` drift and is reported as such, not silently
absorbed into an updated label.

### read

Returns information to the caller and has no observable external side
effect: no state is mutated, nothing is purchased, nothing is sent to anyone.
Example: `get_forecast(city)`, `list_shopping_items()`.

### write

Mutates state that belongs to the user, with no transfer of money and no
message sent to a third party. Example: `add_to_list(item)`,
`set_thermostat(temp)`.

### transact

Moves money, places an order, or otherwise commits the user to a purchase or
a financial transfer. Example: `reorder_last_purchase()`, `place_order(sku)`.

### communicate

Sends a message, email, notification, or any other content to a third party
(a person or an external system outside the user's own account). Example:
`send_text(contact, message)`, `notify_emergency_contact()`.

### Disambiguation rule

A tool's stated behaviour can span more than one capability class — for
example, a tool that both writes to a list and sends a confirmation text. When
it does, assign the **highest** class the tool claims, in this fixed order:

```
transact > communicate > write > read
```

A tool that claims to both transact and communicate is classed `transact`. A
tool that claims to both write and communicate is classed `communicate`. A
tool that only reads is classed `read`. This ordering exists because it is
the order of consequence, not the order of frequency: a tool that can spend
money is more dangerous to leave unmonitored than one that can only send a
message, which is in turn more dangerous than one that only mutates local
state.
