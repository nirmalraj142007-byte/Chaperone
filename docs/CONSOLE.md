# Console

`packages/console` is a read-only supporting surface: React 19, Vite 6,
Tailwind 4, TanStack Query 5. It gets a five-second cutaway in the demo, so
this doc covers the design decisions and the data path. No feature list.

## Data path

```
browser ──GET /api/*──▶ vite proxy ──▶ gateway (packages/gateway/src/api.ts) ──▶ DynamoDB
browser ──POST /mcp───▶ vite proxy ──▶ gateway chaperone/approve_change (approve.ts)
```

- The browser has no AWS credentials. `/api/*` is five read-only GET routes.
  Nothing under `/api` writes a pin, a quarantine status or a ledger event.
- The console makes exactly one write: it calls `chaperone/approve_change`
  over `/mcp` as an ordinary MCP client. This is the same token-checked
  function the consent card reaches. The resident pastes the one-time token
  from the card. `/api` never serves the plaintext token or its hash; it
  only serves `tokenHeld: boolean`. If a token was already consumed (by the
  card or by the console) or has expired, the gateway rejects it with its
  own typed error, and the page falls back to the resolved or expired state.
  There is no second approval mechanism.
- Storage failures come back from `/api` as 503. `/api/ledger/verify`
  returns `ok: false` on 503, because a verifier that couldn't read the
  chain hasn't verified it.

## Design plan (written before any component code)

**Subject.** Chaperone keeps a copy of what the household agreed to and
compares every later version against it. The physical analogue is a
carbonless triplicate form: a white original, a canary copy and a pink
copy, printed in one ink and filled in by typewriter.

| token | hex | from |
|---|---|---|
| `--n-50` form stock | `#F3F5F8` | cool paper; deliberately not cream |
| `--accent` carbon | `#23308F` | the one ink every rule and label is printed in |
| `--n-*` graphite | `#0F1320` → `#FFFFFF` | typed data |
| `--ok` | `#17714A` | ledger green: verified, pinned |
| `--warn` | `#C99A00` | the canary copy: awaiting a decision; highlighter on the added clause |
| `--blocked` | `#B0103A` | the VOID rubber stamp: chain broken, change refused |

**Type.** One UI sans (system stack), with labels set like printed form
fields: 12px, 600 weight, uppercase, +0.1em tracking, in carbon ink. One
serif (Charter/Cambria/Georgia stack) for numerals only: counts, times,
scores. `ui-monospace` is used for hashes and ULIDs only. The scale has
five steps: 12 / 14 / 16 / 22 / 40. There are no CDN fonts.

**Layout.** Every screen is a filled-in form, with the ledger chain running
across the top like the perforated edge of the pad.

**Signature.** The perforation chain. Each ledger event is a square link,
filled with carbon ink when `GET /api/ledger/verify` vouches for it. On a
break, the ink stops at the broken link, which turns crimson. Links after
it stay grey ("unverified") because the verifier stops at the first break.
A rotated VOID stamp names the index and sort key.

**Motion.** There is one orchestrated sequence: when a verify result lands,
the links ink in left to right (a 700ms stagger overall, each link taking
240ms), then the stamp lands. Every other transition is a 120ms colour
change on hover or focus. Motion is disabled under `prefers-reduced-motion`.

**Visible work.** The wire strip logs every request the console makes:
channel, verb, path or JSON-RPC method, status, latency, and the gateway's
`X-Request-Id`, which matches the gateway's own log line. The approve path
logs each MCP hop (`initialize`, `notifications/initialized`,
`tools/call chaperone/approve_change`, session `DELETE`) as it completes.

### Self-critique: what changed and why

1. **The badge.** The first idea was a green "verified" pill in the header.
   It would look the same on any product, so it became the chain itself:
   geometry that only makes sense for a hash chain.
2. **Grey hairline table rules** would drift into the broadsheet look. Rules
   are now 1.5px carbon-ink form boxes with corner labels.
3. **UI-kit green and amber** would be generic. Canary and void-crimson come
   from the carbon copies and the stamp. Green stays, because "verified"
   has to read instantly on a projector.
4. **Tokens and cost.** The brief asked for token and cost numbers, but the
   advisory row doesn't persist them. The console shows what is stored
   (model ID, prompt SHA, score, generation time) and invents nothing.
5. **Light only.** The form metaphor is paper, and paper projects better.

## Enforcement

`src/index.css` clears Tailwind's default colour, font, text, radius and
shadow themes and re-points them at `src/tokens.css`. It also sets
`--spacing` to the 4px unit. A utility that doesn't derive from a token
fails to generate.
