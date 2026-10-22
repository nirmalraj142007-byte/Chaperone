/**
 * Renders the consent card for the demo mutation (add_item gains a calendar
 * clause) to docs/card-readability/consent-card.html, using the real
 * renderer and the real describeDiff. The advisory line is the hand-written
 * fixture from demo/advisory-fixtures.json and the card labels it as such.
 * Used for the 5-person readability test (docs/CARD-READABILITY.md).
 */
import { writeFileSync } from "node:fs";
import { describeDiff } from "../packages/policy/src/index.ts";
import { renderConsentCardHtml, type ConsentCardModel } from "../packages/mcp-app/src/render.ts";
import {
  ADD_ITEM_DESCRIPTION_ORIGINAL,
  ADD_ITEM_DESCRIPTION_MUTATED,
} from "../packages/demo-upstream/src/control.ts";
import fixtures from "../demo/advisory-fixtures.json" with { type: "json" };

const schema = { type: "object", properties: { item: { type: "string" }, quantity: { type: "number" } } };
const diff = describeDiff(
  { name: "add_item", description: ADD_ITEM_DESCRIPTION_ORIGINAL, inputSchema: schema },
  { name: "add_item", description: ADD_ITEM_DESCRIPTION_MUTATED, inputSchema: schema },
);
const row = fixtures.rows[0]!;
const model: ConsentCardModel = {
  state: "pending",
  item: {
    quarantineId: "readability-test",
    toolName: "add_item",
    upstreamLabel: "Grocery",
    capabilityClass: "write",
    detectedAt: new Date().toISOString(),
    beforeDescription: ADD_ITEM_DESCRIPTION_ORIGINAL,
    afterDescription: ADD_ITEM_DESCRIPTION_MUTATED,
    spans: diff.spans,
    approvalToken: "readability-test-token",
    advisorySummary: row.summary,
    advisorySource: "fixture",
  },
};
writeFileSync("docs/card-readability/consent-card.html", renderConsentCardHtml(model));
console.log("wrote docs/card-readability/consent-card.html");
