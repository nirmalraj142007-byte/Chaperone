# Consent card readability test

**Informal 5-person check with the author's relatives. Not a study, and not
evidence that the card is readable.**

A 5-person check of whether someone who has never seen Chaperone can read the
consent card and say what changed. Results are filled in below.

## What to show

The card for the demo mutation: `add_item` on the Grocery server gains a
sentence telling the assistant to check the household calendar for the next
7 days.

| File | Use |
|---|---|
| [`card-readability/consent-card-phone.png`](card-readability/consent-card-phone.png) | Phone-width screenshot (390 px). Send it to the participant's phone or show yours. |
| [`card-readability/consent-card-laptop.png`](card-readability/consent-card-laptop.png) | Laptop-width screenshot. |
| [`card-readability/consent-card.html`](card-readability/consent-card.html) | The live card. Open in any browser. The buttons do nothing here: there is no gateway behind it. |

Regenerate with `npx tsx scripts/render-readability-card.ts`. It uses the real
renderer and the real diff. The wording is the demo upstream's own
before/after text (`packages/demo-upstream/src/control.ts`).

**One thing on the card is a stand-in.** The "Advisory" line is the hand-written
fixture from `demo/advisory-fixtures.json`, and the card says so on screen. No
model wrote it. A participant is reading the card exactly as the offline demo
shows it.

## How to run it

- Show the card, say nothing about the product, and do not point at anything.
- Ask the two questions in order. Write the answer down in the participant's
  own words, not yours.
- Do not explain the card until both answers are recorded.
- "Understood" is yes only if answer 1 mentions the calendar (or reading their
  schedule) and answer 2 is a real choice that matches what they said they
  understood. Otherwise no. Decide this after they leave, not while they are
  looking at you.

## The two questions

1. **"In your own words, what changed?"**
2. **"Would you tap Approve or Keep blocked, and why?"**

## Results sheet

Participants: 5, labelled P1 to P5. No names are recorded. All five are
relatives of the author.

| # | Relationship | Age | Background | Understood |
|---|---|---|---|---|
| P1 | Relative | 56 | No tech background | No: did not understand the card |
| P2 | Relative | 35 | Tech background | Partly: understood, but not well |
| P3 | Relative | 26 | Tech background, uses AI agents | Yes |
| P4 | Relative | 23 | Tech background, uses AI agents | Yes |
| P5 | Relative | 26 | Tech background, uses AI agents | Yes |

**How these were recorded.** The author summarised each outcome from what the
person said. The participants' answers to the two questions were **not
transcribed verbatim**, so this file has no answer columns and the verdicts
were not re-derived from the "understood" rule above. They are the author's
judgement, stated as given.

**Results (informal check, not a study):** 3 of 5 understood, 1 partly, 1 did not. The one participant
without a tech background did not understand the card.

## Caveats

- **This is not a study and does not show the card is readable.** It must not
  be cited as support for "a resident can read the card". Five relatives, no
  controls, summarised outcomes.
- **P3 to P5 regularly approve permissions for AI coding agents.** That is
  close to the decision the card asks for, and it likely helped them.
- **All five participants are the author's relatives**, which may bias the
  results in either direction.
- The only participant without a tech background (P1) is the one who did not
  understand, so the group the product is meant for is the one it served
  worst. One person cannot show a pattern, but it is the direction of the
  concern.

## Next step

Plainer wording on the card for non-technical residents, then a re-run with
people outside the author's family. The card has **not** been changed as a
result of this test.

## Reporting rule

Report the count as it came out, with the sample described as what it was:
five people the builder knows, not a usability study. If fewer than 5 understood,
say so and say which part of the card they missed.
