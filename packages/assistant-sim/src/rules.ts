/**
 * The whole "assistant" of this simulation, in one file.
 *
 * There is no model here. A real assistant would hand the resident's words
 * to a language model and let it pick a tool. No model provider has been
 * chosen for this project (docs/LIMITATIONS.md), so this stand-in matches a
 * small, fixed list of phrasings with regular expressions and maps each to
 * exactly one tool call. Nothing here is learned, nothing is probabilistic,
 * and the same words always produce the same call.
 *
 * What this file does NOT do, on purpose: it never decides whether a tool
 * may run. It names the tool and the arguments; the gateway decides, by a
 * hash comparison, and the answer comes back over MCP. A rule matching does
 * not mean the tool ran, and this file has no way to find out.
 *
 * Adding a phrase: add a `Rule` to RULES, in the position you want it tried.
 * Rules are tried top to bottom; the first that returns something wins.
 */

/** Tool names as the gateway lists them: `{upstreamId}__{toolName}` for the grocery upstream, unnamespaced for the gateway's own. */
export const TOOLS = {
  addItem: "grocery__add_item",
  readList: "grocery__read_list",
  placeOrder: "grocery__place_order",
  trackDelivery: "grocery__track_delivery",
  pendingChanges: "chaperone/pending_changes",
  approveChange: "chaperone/approve_change",
} as const;

export type RuleId = "add-item" | "read-list" | "place-order" | "track-delivery" | "pending-changes" | "help" | "greeting" | "unmatched";

/** A phrase that maps to a tool call. `intro` is what the assistant says while the call is in flight. */
export interface CallInterpretation {
  kind: "call";
  ruleId: RuleId;
  tool: string;
  args: Record<string, unknown>;
  intro: string;
  /** Said after a result that was not an error. Omitted where the tool's own result already says everything. */
  done?: string;
}

/** Words only: no tool is called. */
export interface ReplyInterpretation {
  kind: "reply";
  ruleId: RuleId;
  text: string;
}

export type Interpretation = CallInterpretation | ReplyInterpretation;

/** Shown in the empty state, in the help reply, and when nothing matched. */
export const EXAMPLE_PHRASES: ReadonlyArray<{ phrase: string; effect: string }> = [
  { phrase: "Add batteries to my list", effect: "calls add_item" },
  { phrase: "Add 3 bananas", effect: "calls add_item with a quantity" },
  { phrase: "What's on my list?", effect: "calls read_list" },
  { phrase: "Place my order", effect: "calls place_order" },
  { phrase: "Where's my delivery?", effect: "calls track_delivery" },
  { phrase: "Is anything waiting for my review?", effect: "calls chaperone/pending_changes" },
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const MAX_QUANTITY = 99;

/** Lower-cases, drops filler ("hey, could you ... please") and end punctuation, so the rules below can be short. */
export function normalise(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:hey|hi|hello|ok|okay)(?:\s+assistant)?\s*,\s*/, "")
    .replace(/^(?:please[\s,]+|(?:can|could|would|will) you (?:please )?|i(?:'d| would) like (?:you )?to |i need you to |i want you to )+/, "")
    .replace(/(?:[\s,]+(?:please|for me|thanks|thank you))*[\s.!?]*$/, "")
    .trim();
}

/** "3 bananas" -> {3, "bananas"}; "a jar of jam" -> {1, "jar of jam"}; "batteries" -> {undefined, "batteries"}. */
function splitQuantity(phrase: string): { quantity: number | undefined; item: string } {
  const digits = /^(\d{1,3})\s*(?:x\s+)?(.+)$/.exec(phrase);
  if (digits?.[1] !== undefined && digits[2] !== undefined) {
    const quantity = Number(digits[1]);
    if (quantity >= 1 && quantity <= MAX_QUANTITY) {
      return { quantity, item: digits[2].trim() };
    }
  }
  const word = /^([a-z]+)\s+(.+)$/.exec(phrase);
  const wordValue = word?.[1] !== undefined ? NUMBER_WORDS[word[1]] : undefined;
  if (word?.[2] !== undefined && wordValue !== undefined) {
    return { quantity: wordValue, item: word[2].trim() };
  }
  const article = /^(?:a|an|some|another)\s+(.+)$/.exec(phrase);
  if (article?.[1] !== undefined) {
    return { quantity: undefined, item: article[1].trim() };
  }
  return { quantity: undefined, item: phrase.trim() };
}

const DESTINATION = /\s+(?:to|on|onto|in|into)\s+(?:my|the|our)\s+(?:shopping\s+|grocery\s+)?(?:list|cart)$/;

function addItemInterpretation(rest: string): Interpretation {
  const { quantity, item } = splitQuantity(rest.replace(DESTINATION, "").replace(/^me\s+/, ""));
  if (item.length === 0 || /^(?:it|that|this|something|stuff)$/.test(item)) {
    return { kind: "reply", ruleId: "add-item", text: 'What should I add? For example: "Add batteries to my list".' };
  }
  const listed = quantity === undefined ? item : `${quantity} × ${item}`;
  return {
    kind: "call",
    ruleId: "add-item",
    tool: TOOLS.addItem,
    args: { item, ...(quantity !== undefined ? { quantity } : {}) },
    intro: `Adding ${listed} to your shopping list.`,
    done: "Done.",
  };
}

interface Rule {
  id: RuleId;
  /** Returns an interpretation, or undefined to let the next rule try. `text` is already normalised. */
  match: (text: string) => Interpretation | undefined;
}

const RULES: readonly Rule[] = [
  {
    id: "help",
    match: (text) =>
      /^(?:help|what can you do|what can i (?:say|ask)|examples?|commands?|what do you understand)\b/.test(text)
        ? { kind: "reply", ruleId: "help", text: helpText("Here's what I understand.") }
        : undefined,
  },
  {
    id: "greeting",
    match: (text) =>
      /^(?:hi|hello|hey|good (?:morning|afternoon|evening))\b/.test(text)
        ? { kind: "reply", ruleId: "greeting", text: "Hello. Ask me to add something to your list, read it back, or place your order." }
        : undefined,
  },
  {
    // Before add-item, so "buy everything on my list" is an order and not an item called "everything on my list".
    id: "place-order",
    match: (text) =>
      /\b(?:place|submit|complete|finish|send|confirm|make)\b.*\border\b|\bcheck ?out\b|^order\b|^(?:buy|purchase)\s+(?:everything|it all|all of it)\b/.test(text)
        ? {
            kind: "call",
            ruleId: "place-order",
            tool: TOOLS.placeOrder,
            // The resident just asked for this in words, so the confirmation the tool requires is theirs.
            args: { confirm: true },
            intro: "Placing your order, since you asked me to.",
          }
        : undefined,
  },
  {
    id: "track-delivery",
    match: (text) =>
      /\b(?:track|where(?:'s| is)|status of|how far)\b.*\b(?:deliver\w*|order|groceries|driver|package)\b/.test(text)
        ? { kind: "call", ruleId: "track-delivery", tool: TOOLS.trackDelivery, args: {}, intro: "Checking on your delivery." }
        : undefined,
  },
  {
    id: "pending-changes",
    match: (text) =>
      /\b(?:pending|withheld|held)\b|\bwaiting for (?:my )?(?:review|approval)\b|\b(?:anything|what|any)\b.*\bchang(?:ed|es)\b/.test(text)
        ? { kind: "call", ruleId: "pending-changes", tool: TOOLS.pendingChanges, args: {}, intro: "Checking whether any tool changes are waiting for you." }
        : undefined,
  },
  {
    id: "read-list",
    match: (text) =>
      /\b(?:what(?:'s| is| do i have| have i got)?|show|read|check|see|tell me|list)\b.*\b(?:list|cart)\b/.test(text)
        ? { kind: "call", ruleId: "read-list", tool: TOOLS.readList, args: {}, intro: "Reading your shopping list." }
        : undefined,
  },
  {
    id: "add-item",
    match: (text) => {
      const verb = /^(?:add|put|get|grab|pick up|buy)\s+(.+)$/.exec(text);
      if (verb?.[1] !== undefined) return addItemInterpretation(verb[1]);
      const need = /^(?:i|we)\s+(?:need|want)\s+(.+)$/.exec(text);
      if (need?.[1] !== undefined) return addItemInterpretation(need[1]);
      const out = /^(?:we(?:'re| are)|i(?:'m| am)) (?:out of|low on|running low on)\s+(.+)$/.exec(text);
      if (out?.[1] !== undefined) return addItemInterpretation(out[1]);
      return undefined;
    },
  },
];

function helpText(lead: string): string {
  return `${lead} Try one of these:\n${EXAMPLE_PHRASES.map((e) => `• "${e.phrase}"`).join("\n")}`;
}

/**
 * The one entry point. Unmatched input gets a reply that lists what does
 * work, never a guess: a stand-in that guessed would be pretending to be a
 * model.
 */
export function interpret(utterance: string): Interpretation {
  const text = normalise(utterance);
  if (text.length === 0) {
    return { kind: "reply", ruleId: "unmatched", text: helpText("I didn't catch anything.") };
  }
  for (const rule of RULES) {
    const result = rule.match(text);
    if (result !== undefined) return result;
  }
  return { kind: "reply", ruleId: "unmatched", text: helpText("I only understand a few phrases, because I'm a rule-based stand-in and not a model.") };
}
