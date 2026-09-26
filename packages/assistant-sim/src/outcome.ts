/**
 * Reads a tool result the way the resident's screen needs it: did the tool
 * run, was it held with a review card, or did something else go wrong.
 *
 * This only looks at the *shape* of what the gateway returned. It does not
 * compare the refusal text to the frozen constant: `@chaperone/policy` pulls
 * in `node:crypto`, which has no business in a browser bundle. The refusal
 * text itself is always shown verbatim, never reworded (CLAUDE.md,
 * non-negotiable 4); the specs assert it byte for byte against the constant.
 */
import type { Block, CallOutcome } from "./gateway";

/** The ui:// scheme for one quarantine's card. Also exported by @chaperone/mcp-app; test/protocol.test.ts asserts the two agree. */
export const CONSENT_URI_PREFIX = "ui://chaperone/consent/";

export interface HeldCard {
  /** The interactive MCP App: `text/html;profile=mcp-app`, present when the gateway thought this client could host it. */
  html: string | undefined;
  resourceUri: string | undefined;
  /** The text card, the floor every host can show. */
  text: string | undefined;
}

export type Classified =
  | { kind: "ok"; text: string }
  | { kind: "held"; refusal: string; card: HeldCard }
  | { kind: "error"; text: string };

const ACTION_LINE = /quarantineId=(\S+) approvalToken=(\S+) decision=approve/;

/** The quarantine id and one-time token the text card carries in its action line, or undefined if this text is not a card. */
export function parseTextCardAction(cardText: string): { quarantineId: string; approvalToken: string } | undefined {
  const match = ACTION_LINE.exec(cardText);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { quarantineId: match[1], approvalToken: match[2] };
}

export function textBlocks(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

export function classify(outcome: Pick<CallOutcome, "isError" | "blocks">): Classified {
  const texts = textBlocks(outcome.blocks);
  if (!outcome.isError) {
    return { kind: "ok", text: texts.join("\n") };
  }
  const resource = outcome.blocks.find(
    (block): block is Extract<Block, { type: "resource" }> => block.type === "resource" && block.uri.startsWith(CONSENT_URI_PREFIX),
  );
  const cardText = texts.slice(1).find((text) => parseTextCardAction(text) !== undefined);
  const first = texts[0];
  if ((resource !== undefined || cardText !== undefined) && first !== undefined) {
    return {
      kind: "held",
      refusal: first,
      card: { html: resource?.text, resourceUri: resource?.uri, text: cardText },
    };
  }
  return { kind: "error", text: texts.join("\n") };
}
