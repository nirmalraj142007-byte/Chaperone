# Submission checklist

**Hard cutoff: 2026-10-22, 12:00 PDT** (19:00 UTC; **00:30 IST on 2026-10-23**).
That is deliberately 24 hours before the hackathon's own close
(2026-10-23, 12:00 PDT, per `CLAUDE.md`), so a failed upload or a Devpost outage
costs a retry and not the submission. Treat 2026-10-22 12:00 PDT as the deadline.

Every box is unchecked on purpose. A box is ticked by the person submitting, at
the moment they have seen the thing work, with the output pasted next to it.
"Known state" is where the repository stands as of **2026-10-07**; it will
change, so re-check rather than trust it.

## Order of work from crawl 2

| When | What |
|---|---|
| 2026-10-20 | Run crawl 2 (`pnpm crawl:run --crawl-id=crawl-2`; read `CLAUDE.md`'s calendar gates first). The crawler writes the Crawl 2 line of `CRAWL_DATES.md`; it is never typed by hand |
| 2026-10-20 to 2026-10-21 | `pnpm analyse:drift`, then `pnpm analyse:label` for every `semantic-intent` proposal, then `pnpm analyse:drift` again to emit `data/drift.json` |
| 2026-10-21 | Fill every pending marker; write the drift headline into `demo/SCRIPT.md` beat 12; record and cut the video |
| 2026-10-22, morning | Final checks below, in the order given; submit with time to spare |

## 1. The video

- [ ] Under **3:00** by the player's own clock (the script plans 2:52)
- [ ] Uploaded, and the link plays when opened logged out and in a private window
- [ ] The first 15 seconds say "context-aware add-on that keeps state across sessions", name Alexa+ and say the page is simulated
- [ ] Beat 12 shows both crawl dates and says **35 days**, and nothing in the video says a rounded number of weeks
- [ ] No absolute Chaperone block rate anywhere, spoken or on a card
- [ ] The drift sentence in beat 12 is the one in `data/drift.json`, and counts `semantic-intent` changes only
- [ ] Beat 7 is labelled as a local stack unless a deployment exists (see section 5)

## 2. The repository

- [ ] Public, with the MIT licence showing in the GitHub About sidebar: `gh api repos/nirmalraj142007-byte/Chaperone --jq '.license.spdx_id, .private'` prints `MIT` and `false`
- [ ] `git status` clean and `git log origin/main..HEAD` empty: everything is pushed
- [ ] `README.md` opens with the resident-facing sentence (Alexa+, simulated demo, state across sessions), and its numbers match the data files they cite
- [ ] `docs/RUBRIC-MAP.md` is current. Its Agent Skills row says **Not delivered** unless a skill has since been added; do not change the wording to hide a gap
- [ ] `LICENSE` present, and `corpus/TAXONOMY.md` and `corpus/PREDICTIONS.md` unchanged since 2026-09-12: `git log --follow --oneline corpus/TAXONOMY.md corpus/PREDICTIONS.md` shows only the original commit
- [ ] Dataset repository (a separate MIT repo for the crawl data): decided and recorded in `docs/DECISIONS.md`, including whether third-party descriptions are republished verbatim or as hashes plus a fetch script. Known state: **not decided, no repo exists**

## 3. Devpost

- [ ] **Product Feedback field completed for every tool used**, drawn from `docs/PRODUCT-FEEDBACK.md`: MCP TypeScript SDK, MCP Apps (`ext-apps`) and Inspector, DynamoDB and DynamoDB Local, Bedrock, Groq, CDK, Docker, Kiro, the registry APIs. Known state: the CDK-deploy section and the Kiro section still carry pending markers (nothing was deployed; the repository records no Kiro usage). If Kiro was not used, the section says so in one plain sentence rather than being padded
- [ ] **Friction log attached**: `friction-log.md`, every entry in the six-field form
- [ ] The description opens with the add-on framing, not with "proxy", "security layer" or "guardrail"
- [ ] The description repeats no number that is not in a committed file, and no absolute block rate
- [ ] The video link, the repository link and (if any) the deployed URL are filled in

## 4. The evidence

- [ ] `CRAWL_DATES.md` is accurate: the Crawl 2 line is machine-written (it matches `jq .startedAt data/crawl-2-report.json`), the Crawl 1 line is unchanged, and the stated interval is still **35 days** (a crawl that ran late would make it 36 or more, and the prose would have to say so)
- [ ] `pnpm check-claims` passes (no rounded-week language)
- [ ] `pnpm check-placeholders` passes: no pending marker left in any committed prose. This is the last gate that cannot be satisfied early; it fails today by design (drift rate, production latency, CDK and Kiro feedback)
- [ ] `data/drift.json`, `data/labels.json` and `data/labels-todo.json` are committed and agree; the headline counts `semantic-intent` only, and cosmetic and schema-additive changes are published separately
- [ ] `pnpm analyse:drift --dry-run` still reports 0 drift and 0 classifier artifacts
- [ ] The prevalence sample (`data/prevalence.json`) is labelled or its absence is stated. `corpus/PREDICTIONS.md` committed to testing it

## 5. The deployed URL

Known state: **not deployed.** `infra/` has the advisory pipeline stack only;
there is no ECS, ALB or domain stack, so there is no URL.

- [ ] Either: a deployed gateway whose `/healthz` returns 200, with `TARGET=https://<host>/mcp pnpm spec` and `TARGET=https://<host>/mcp pnpm test:resume` both passing against it (pasted output)
- [ ] Or: the README, the Devpost description and the video all say plainly that it is not deployed and the demo runs on the local stack, and the production-latency marker is replaced by a sentence saying it was not measured against DynamoDB on AWS. Do not leave a dangling pending marker, and do not state a number that came from DynamoDB Local as if it were production

## 6. Last, in this order

1. [ ] `pnpm typecheck`, `pnpm lint`, `pnpm depcruise`, `pnpm check-claims`, `pnpm check-placeholders`
2. [ ] `pnpm test:all` (exit 0, with `verify-ledger` green at the end; read the counts, not the exit code)
3. [ ] `pnpm demo:verify` twice in a row, and `pnpm demo:idempotence`
4. [ ] `pnpm bench` **re-run last**, after the final code change, so `benchmarks/latency.json` and the README's cost table describe the submitted commit and its backend. It exits 1 against DynamoDB Local; that is the recorded result, not something to hide. Commit the new file
5. [ ] Commit, push to `origin main`, paste `git status`
6. [ ] Submit on Devpost, then open the submission page logged out and screenshot it as the receipt

If anything in 1 to 6 fails, report the failure; do not adjust a claim to match
a result.
