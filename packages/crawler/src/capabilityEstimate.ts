export type CapabilityEstimate = "read" | "write" | "transact" | "communicate";

// Keyword lists chosen against corpus/TAXONOMY.md's Axis 2 definitions.
// transact: moves money, places an order, commits to a purchase/transfer.
const TRANSACT_WORDS =
  /\b(buy|purchas(e|es|ing)|checkout|plac(e|es|ing) (a|the|your|an) order|pay(ment|ments)?|invoic(e|es|ing)|billing|subscri(be|bes|ption|ptions)|refunds?|charges?|wire transfers?|transfer funds|book(ing)? (a|your) (flight|hotel|ride|reservation)|reorders?|add to cart|stripe|paypal|usdc|crypto payment|x402)\b/i;
// communicate: sends a message/notification to a third party. "send" is
// checked with a same-sentence lookahead rather than strict adjacency, since
// real prose puts a subject between the verb and the object ("send Gmail
// messages", not just "send a message").
const COMMUNICATE_WORDS =
  /\b(send[^.]{0,30}(texts?|sms|emails?|messages?|notifications?|alerts?)|emails?|messages?|notif(y|ies|ication|ications)|slack|discord|telegram|whatsapp|post (a|to)|tweets?|publish(es)? (a|to)|broadcast(s|ing)?|shares? (with|to)|invit(e|es|ation)|repl(y|ies)|reach out|contact(s|ing)?)\b/i;
// write: mutates the user's own state, no money, no message to a third party.
const WRITE_WORDS =
  /\b(adds?|creat(e|es|ing)|updat(e|es|ing)|delet(e|es|ing)|remov(e|es|ing)|edit(s|ing)?|sets?|manag(e|es|ing)|modif(y|ies|ying)|sav(e|es|ing)|uploads?|writ(e|es|ing)|inserts?|schedul(e|es|ing)|configur(e|es|ing)|controls?|toggl(e|es|ing)|syncs?|mov(e|es|ing)|renam(e|es|ing)|archiv(e|es|ing)|locks?|unlocks?|generat(e|es|ing)|builds?|deploys?|installs?|runs?)\b/i;

/**
 * A ROUGH, server-level proxy for corpus/TAXONOMY.md's Axis 2 (capability
 * class), built from only a server's own display name and top-line
 * description — not the real per-TOOL classification against actual
 * `tools/list` output that Phase 5's boot phase produces per the taxonomy's
 * own decision rule ("assigned per tool at first observation"). This exists
 * for an early, order-of-magnitude sanity check of corpus composition before
 * crawl 1 freezes the candidate list. It is not, and must never be cited as,
 * the taxonomy-grade Axis-2 label — that label is per-tool, this is
 * per-server; that label comes from a real manifest, this comes from prose a
 * publisher wrote about their own server. Applies the same priority order
 * the taxonomy specifies (transact > communicate > write > read).
 */
export function estimateServerCapability(name: string, description: string): CapabilityEstimate {
  const text = `${name} ${description}`;
  if (TRANSACT_WORDS.test(text)) {
    return "transact";
  }
  if (COMMUNICATE_WORDS.test(text)) {
    return "communicate";
  }
  if (WRITE_WORDS.test(text)) {
    return "write";
  }
  return "read";
}
