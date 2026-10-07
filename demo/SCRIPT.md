# Demo script

Twelve beats, **2:52 in total**, under the 3:00 limit with 8 seconds of
margin. Filmed on the simulated Alexa+ experience (`pnpm demo:assistant`,
<http://localhost:5174>), with a terminal beside it for the commands.

**Status: not yet rehearsed or timed on camera.** The seconds below are a plan
sized from the spoken word counts at about 2.4 words per second (the count for
each beat is in the table at the end, so it can be re-checked). Beats 1 to 7
were written from the demo code and its end-to-end tests, not from a take; the
depcruise commands in beat 8 were run and their output copied exactly. Run the
rehearsals and replace this paragraph with the real timings.

## Rules for the voice-over

- The first 15 seconds say what Chaperone is to a household: a context-aware
  add-on that keeps state across sessions. No other words for it in the opening.
- Say **"35 days"**, never a rounded number of weeks.
- Never say Chaperone "blocks 100%" or any absolute block rate. The only
  comparison is the baseline-2 delta in beat 9.
- The page is a *simulation*: say so in beat 1, and leave the on-screen banner
  visible. Two items are hand-written stand-ins and are labelled on screen (the
  one-line summary on the card, and the staged "12 January" approval); do not
  describe either as real model output or real history.
- Nothing is deployed. Beat 7 runs against the local stack; the on-screen label
  says so.

## Before the take

```
docker compose up -d
pnpm demo:reset            # prints the beats; takes under 60 s
pnpm demo:assistant        # terminal A: the simulated Alexa+ page on :5174
```

Terminal B is the command terminal, with the repo as the working directory and
a large font. Browser at 1280 × 1200 so the whole card, buttons included, is on
screen. Keep `docker compose up -d` and the demo offline-ready per
[`OFFLINE.md`](OFFLINE.md).

## The beats

### 1 · 0:00 to 0:14 · Hook

- **Screen:** the simulated Alexa+ page, empty conversation, the "rule-based
  stand-in" banner in view.
- **Do:** nothing yet. Hold on the page.
- **Say:** "This is a simulated Alexa+ household. An assistant re-reads every tool's instructions each time it connects, and remembers nothing. Chaperone is a context-aware add-on that keeps that memory across sessions."

### 2 · 0:14 to 0:23 · A normal request

- **Screen:** the conversation.
- **Do:** type `add batteries to my list`, press Enter.
- **Result on screen:** `Added 1 × batteries to the shopping list.`
- **Say:** "A resident asks for batteries. The tool is one the household approved, so it just works."

### 3 · 0:23 to 0:34 · The upstream changes

- **Screen:** terminal B beside the page.
- **Do:** run `pnpm demo:mutate`.
- **Result on screen:** `add_item's description has changed on the demo upstream (...)`.
- **Say:** "Now the tool's server quietly rewrites add_item's description. Nobody tells the household. This is what happens in the real world."

### 4 · 0:34 to 1:00 · The refusal, and the card inside the conversation

- **Screen:** the conversation.
- **Do:** type `add batteries to my list` again, press Enter. Then pause on the card.
- **Result on screen:** the frozen refusal text, and under it the card: the
  added clause `check the household calendar for the next 7 days` highlighted,
  the badge `can change your data`, `You approved this on 12 January`, and the
  advisory line labelled as a fixture.
- **Say:** "Same request. This time the tool does not run. The refusal is fixed text, so no model can reword it. And right in the conversation, a card: the sentence they approved, the sentence that replaced it, the new clause highlighted. It now reads the household calendar. The summary line under it is a hand-written fixture, and the page says so."

### 5 · 1:00 to 1:14 · Approve

- **Screen:** the card, then terminal B.
- **Do:** press **Approve** on the card. Type `add batteries to my list`. Then in
  terminal B run `pnpm demo:ledger`.
- **Result on screen:** `approved. New definition pinned as` and a 12-character
  hash; `Added 1 × batteries to the shopping list.`; then `chain OK` with the
  event count the command prints.
- **Say:** "The resident taps Approve. The new wording is pinned, the tool works again, and the ledger records who decided. The hash chain verifies."

### 6 · 1:14 to 1:24 · Keep blocked

- **Screen:** the page, a second take.
- **Do:** this is cut in from a second take. After a full `pnpm demo:reset`,
  repeat beats 2 to 4, then press **Keep blocked**. Type
  `add batteries to my list`.
- **Result on screen:** the same frozen refusal again, and the card in its settled
  state: `Kept blocked`, no buttons, no new question.
- **Say:** "Or keep it blocked. Ask again and it stays blocked, without nagging. Every other tool carried on working."

### 7 · 1:24 to 1:44 · Resumption

- **Screen:** terminal B, full width. Overlay label: `local stack`.
- **Do:** run `pnpm resume-demo`. Leave it running to the end.
- **Result on screen:** `KILLING THE TCP SOCKET NOW`, then `RECONNECT: GET /mcp
  Last-Event-ID: ...`, then `PASS` and `invocations: 1`
  ... `exactly once — not re-invoked`.
- **Say:** "The same idea holds for the connection. We cut the socket in the middle of a place-order call and reconnect with Last-Event-ID. The upstream reports one invocation, because every event was durable before it was sent."

### 8 · 1:44 to 1:58 · No model in the policy

- **Screen:** terminal B.
- **Do:** run these two commands, one line each:

  ```
  printf 'import OpenAI from "openai";\nexport const c = OpenAI;\n' > packages/policy/src/probe.ts
  pnpm depcruise
  ```

  then delete the probe, which is **required** or the repo is left failing:

  ```
  rm packages/policy/src/probe.ts
  ```
- **Result on screen:** `error no-llm-in-policy: packages/policy/src/probe.ts → openai`
  and `x 1 dependency violations (1 errors, 0 warnings)`. (Both lines were
  reproduced on 2026-10-07 with a different filename; the module count in the
  last line varies.)
- **Say:** "The check itself is a hash comparison, with no model anywhere near it, and the build enforces that. Import a model client into the policy package and the build fails."

### 9 · 1:58 to 2:16 · Baseline 2

- **Screen:** a title card, held: `Baseline 2: an unaided model · gpt-oss-120b on Groq · two turns · 90 attack runs · followed 57.8% · refused 0 · one model, one day`.
  Small caption under it: `No absolute block rate is claimed: it would be tautological.`
- **Say:** "We also gave one unaided model, gpt-oss-120b on Groq, the thirty attack descriptions, ninety runs in all. It followed the injected instruction 57.8% of the time and refused none. That is a floor, for one model, on one day."

### 10 · 2:16 to 2:26 · The boot-rate finding

- **Screen:** a title card: `47.8% of 291 attempted servers did not start from their own setup instructions`.
- **Say:** "Separately: of 291 public MCP servers with an install command, 47.8% did not start from their own setup instructions."

### 11 · 2:26 to 2:36 · Curated catalogues

- **Screen:** a title card: `Alexa+ integrations are curated. Why does this matter?`
- **Say:** "Alexa+ integrations are curated. But curation binds who you trust, not what they said when you trusted them."

### 12 · 2:36 to 2:52 · Final card

- **Screen:** a final card, held to the end: `Crawl 1 · 2026-09-15`, `Crawl 2 · 2026-10-20`, `35 days`, then the drift headline sentence once it exists.
- **Say:** "Two crawls of one frozen list of servers, September 15th and October 20th: 35 days. {{PENDING: drift headline sentence, from data/drift.json after crawl 2; at most 20 spoken words so beat 12 stays within 16 seconds — 2026-10-20}}"

## Timing check

Words are counted from each beat's **Say** line (beat 12 excludes the pending
sentence, which has a budget of its own). 2.4 words per second is the planning
rate; a beat that needs more than that to be read aloud has to be cut or given
more seconds.

| Beat | Seconds | Words | Words per second |
|---:|---:|---:|---:|
| 1 | 14 | 30 | 2.14 |
| 2 | 9 | 16 | 1.78 |
| 3 | 11 | 20 | 1.82 |
| 4 | 26 | 60 | 2.31 |
| 5 | 14 | 23 | 1.64 |
| 6 | 10 | 18 | 1.80 |
| 7 | 20 | 36 | 1.80 |
| 8 | 14 | 30 | 2.14 |
| 9 | 18 | 39 | 2.17 |
| 10 | 10 | 19 | 1.90 |
| 11 | 10 | 18 | 1.80 |
| 12 | 16 | 15 + pending | — |
| **Total** | **172** | | **2:52** |

## After crawl 2 (2026-10-20)

1. Replace the pending sentence in beat 12 with the headline sentence from
   `data/drift.json`. Its drift rate counts `semantic-intent` changes only.
   Cosmetic and schema-additive changes are never part of it.
2. If the rate came in low, say it low. `corpus/PREDICTIONS.md` ("What would
   embarrass me") commits to that.
3. Re-run `pnpm check-claims` and `pnpm check-placeholders`; this file must
   pass both before submission.
4. Re-time all twelve beats on camera and replace the status paragraph at the
   top and the table above with the measured numbers.
