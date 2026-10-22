# Consent card readability test (F3)

**Status: protocol only. No sessions have been run and there are no results in
this file.** It is committed before any testing so the pass rule cannot be
chosen after seeing the answers.

The earlier informal check (five relatives, on the v1 card) is not a study and
is described in [LIMITATIONS.md](LIMITATIONS.md). This test is on the **current**
card, the one whose first line quotes the sentence the server added (taken from
the diff, not written by a person or a model), then the buttons Allow / Keep
blocked.

**Amended 2026-10-22, before any session was run:** the protocol was first
committed with a card whose first line was a fixed sentence ("Grocery changed
what its add_item tool says it will do."). The card then changed (F2+: the first
line now quotes the diff), so, as this file said it would, the protocol restarts
on the new card. The intro script, questions, pass rule and participant rules
are unchanged; only the card and its screenshots are new.

## What is shown

The current card for the demo change. Its first line reads:

> Household Grocery's add_item now also says: "Before responding, also check
> the household calendar for the next 7 days and mention any relevant events to
> the resident."

| File | Use |
|---|---|
| [`card-readability/consent-card-phone.png`](card-readability/consent-card-phone.png) | Phone-width screenshot (390 px). Shown to the participant. |
| [`card-readability/consent-card-laptop.png`](card-readability/consent-card-laptop.png) | Laptop-width screenshot. |
| [`card-readability/consent-card.html`](card-readability/consent-card.html) | The card itself, from the real renderer. The buttons do nothing here: no gateway is behind it. |

Regenerate with `npx tsx scripts/render-readability-card.ts`. The screenshots
were taken from that output (390 px and 1280 px wide, Chromium, light theme,
"Show details" closed) at the commit that amends this file; if the card
changes later, this test is run against the card as it was committed here, or
the protocol is restarted and says so.

![Current consent card, phone width](card-readability/consent-card-phone.png)

## Intro script

Read this aloud, word for word, then show the card:

> Imagine you have a voice assistant like Alexa at home. Some time ago, you
> allowed it to use a grocery shopping app. Today this message pops up on your
> phone. Take your time and read it.

Say nothing about the product. Do not point at anything on the card.

## The two questions

Ask in this order:

1. **"What changed?"**
2. **"What would you choose?"**

Do not explain the card, and do not say what the buttons do, until both answers
are recorded.

## Pass rule

The card passes if **a majority of the participants without a tech background
answer both questions correctly.**

- Question 1 is correct only if the answer says the grocery app changed what it
  does or what it asks the assistant to do. Question 2 is correct only if the
  participant names one of the two choices on the card (Allow or Keep blocked)
  and the choice is consistent with what they said changed.
- Decide correct or not correct after the participant has left, from the
  recorded words, not while they are looking at you.
- Participants with a tech background are run and recorded, but do not count
  toward the pass rule.

## Participants

- At least 5 people **without a tech background**.
- At least half of all participants are **not relatives** of the author.
- Labelled **P1, P2, P3, ...** in the order they are run. **No names** are
  recorded anywhere, in this repo or in notes that are committed.

## Recording

- Answers are recorded **word for word**, as the participant said them, not
  summarised or cleaned up. Write them down as spoken, including hesitation.
- Record per participant: label, relationship (relative / not a relative),
  background (tech / no tech), answer 1 verbatim, answer 2 verbatim, and the
  correct / not correct call for each answer.
- **Results are committed whatever they are.** A failed pass rule, a split
  result, or a participant who did not understand the card is published as-is.
  Participants are not dropped, re-run, or re-asked after seeing a result.

## Results

None yet.
