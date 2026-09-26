/**
 * The demo beats, in order, with the exact command or click for each.
 * Printed at the end of `pnpm demo:reset` so whoever is about to film has
 * it on screen. `pnpm demo:verify` walks these same beats headlessly
 * (scripts/demo/verify.ts), and its beat titles are the ones below.
 */

export interface ChecklistContext {
  consoleUrl: string;
  assistantUrl: string;
  gatewayUrl: string;
  corpusState: "PARTIAL" | "COMPLETE" | "EMPTY";
}

export interface Beat {
  title: string;
  steps: string[];
}

export function demoBeats(ctx: ChecklistContext): Beat[] {
  return [
    {
      title: "The stack is up, offline",
      steps: [
        "docker compose up -d",
        `curl -s ${ctx.gatewayUrl}/healthz`,
        `pnpm demo:assistant     (serves ${ctx.assistantUrl}: the simulated Alexa+ experience, the primary demo surface)`,
        `pnpm --filter @chaperone/console exec vite preview     (serves ${ctx.consoleUrl}: the supporting console)`,
      ],
    },
    {
      title: "Nothing has changed yet",
      steps: [
        `open ${ctx.consoleUrl}/queue      -> "Nothing has changed since you approved it."`,
        `open ${ctx.consoleUrl}/ledger     -> the chain across the top is inked: every link verified`,
      ],
    },
    {
      title: "An approved tool works",
      steps: [
        `open ${ctx.assistantUrl}, say "add batteries to my list"      -> Added 1 x batteries to the shopping list.`,
        "  (or, in a terminal: pnpm demo:call grocery__add_item item=batteries)",
      ],
    },
    {
      title: "The upstream changes a tool's description",
      steps: [
        `open ${ctx.consoleUrl}/upstreams  -> click "Mutate add_item"      (or: pnpm demo:mutate)`,
      ],
    },
    {
      title: "The gate refuses, in words that never change",
      steps: [
        `in the assistant, say "add batteries to my list" again`,
        "  -> the frozen refusal, then the card INSIDE the conversation: the added clause highlighted, 'can change your data',",
        "     'You approved this on 12 January', and the advisory line labelled as a FIXTURE",
        "  (or, in a terminal: pnpm demo:call grocery__add_item item=batteries, then copy the approvalToken from the text card)",
      ],
    },
    {
      title: "The resident decides on the console",
      steps: [
        "in the assistant, press Approve on the card (Keep blocked is the other button)",
        `  (or on the console: open ${ctx.consoleUrl}/queue, open the held change, paste the token, click "Approve & re-pin")`,
      ],
    },
    {
      title: "The tool is back, and the ledger vouches for it",
      steps: [
        `say "add batteries to my list" once more      -> Added again   (or: pnpm demo:call grocery__add_item item=batteries)`,
        "pnpm demo:ledger                                     -> chain OK   (pnpm verify-ledger is the same walk, once DDB_ENDPOINT and CHAPERONE_UPSTREAMS are exported)",
      ],
    },
    {
      title: "The evidence screen, with the network off",
      steps: [
        `open ${ctx.consoleUrl}/corpus     -> state ${ctx.corpusState}: ` +
          (ctx.corpusState === "PARTIAL"
            ? "'Observation 1 of 2 recorded', crawl 1 only, measurement due 2026-10-20. No drift chart exists yet."
            : "see docs/UI-STATES.md"),
      ],
    },
    {
      title: "Resumption",
      steps: ["pnpm resume-demo      -> kill the connection mid-call, resume, place_order invoked exactly once"],
    },
    {
      title: "Go again",
      steps: ["pnpm demo:reset"],
    },
  ];
}

export function printChecklist(ctx: ChecklistContext, out: (line: string) => void = console.log): void {
  out("\nDemo beats");
  out("──────────");
  for (const [index, beat] of demoBeats(ctx).entries()) {
    out(`${index + 1}. ${beat.title}`);
    for (const step of beat.steps) {
      out(`     ${step}`);
    }
  }
  out("\nAnything shown as an advisory line in this run is a hand-written FIXTURE, not model output. See demo/OFFLINE.md.");
}
