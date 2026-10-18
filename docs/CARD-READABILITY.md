# Consent card readability test

A 5-person check of whether someone who has never seen Chaperone can read the
consent card and say what changed. Nothing in this file has been filled in yet.

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

Participants: 5. Do not record names.

| # | Relationship | Age range | Tech level (low / medium / high) | Answer 1: what changed | Answer 2: Approve or Keep blocked, and why | Understood (yes/no) |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |

**Results:** ___ of 5 understood what changed.

## Reporting rule

Report the count as it came out, with the sample described as what it was:
five people the builder knows, not a usability study. If fewer than 5 understood,
say so and say which part of the card they missed.
