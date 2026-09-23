/**
 * The happy path, end to end, against the real stack:
 *
 *   fresh demo:reset -> add_item works -> upstream changes it -> the gateway
 *   notices (list_changed), withholds it from tools/list -> calling it returns
 *   the frozen refusal -> the card renders with the added clause highlighted
 *   and a capability badge -> approving with the issued token restores the tool
 *   -> verify-ledger is green and the ledger holds the whole story, in order.
 */
import { expect, test } from "@playwright/test";
import type { Browser } from "playwright";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { REFUSAL_TOOL_CHANGED } from "@chaperone/policy";
import {
  blocks,
  cardActionOf,
  closeBrowser,
  demoUpstreamControl,
  getJson,
  launchBrowser,
  newOfflineContext,
  pollUntil,
  runVerifyLedgerScript,
  textOf,
} from "../scripts/demo/harness.js";
import { HOUSEHOLD_ID, STACK, freshDemo, freshSession, householdEvents, ledger, ledgerTypes } from "./support.js";

let browser: Browser;

test.beforeAll(async () => {
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await closeBrowser(browser);
  await freshDemo();
});

test("a changed tool is withheld, refused in frozen words, reviewed on the card, and restored by approval", async () => {
  await freshDemo();
  const client = await freshSession("e2e-consent-flow");
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged += 1;
  });

  try {
    await test.step("add_item works against the pinned definition", async () => {
      const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
      expect(result.isError).not.toBe(true);
      expect(textOf(blocks(result)[0])).toMatch(/^Added 1 . batteries to the shopping list\.$/);
    });

    await test.step("the upstream changes add_item's description", async () => {
      await demoUpstreamControl("mutate");
    });

    await test.step("the gateway notices: list_changed is sent, and add_item is absent from tools/list", async () => {
      // The upstream's own list_changed reaches the gateway; the one this client
      // sees is the gateway's, sent when its gate quarantines the tool during
      // this tools/list. Excluded, not annotated: the model never sees the tool.
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("grocery__add_item");
      expect(names).toContain("grocery__read_list");
      await pollUntil("notifications/tools/list_changed", async () => (listChanged >= 1 ? listChanged : undefined), 10_000);
    });

    let card!: { text: string; html: string; quarantineId: string; approvalToken: string };
    await test.step("calling it returns the frozen refusal text, byte for byte", async () => {
      const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
      const content = blocks(result);
      expect(result.isError).toBe(true);
      expect(textOf(content[0])).toBe(REFUSAL_TOOL_CHANGED);
      const text = textOf(content[1]);
      const html = content[2]?.type === "resource" ? content[2].resource?.text : undefined;
      expect(html).toBeDefined();
      card = { text, html: html ?? "", ...cardActionOf(text) };
    });

    await test.step("the card renders with the added clause highlighted and a capability badge", async () => {
      const { context } = await newOfflineContext(browser);
      try {
        const page = await context.newPage();
        await page.setContent(card.html, { waitUntil: "domcontentloaded" });
        const added = page.locator("ins.clause-add").first();
        await expect(added).toBeVisible();
        await expect(added).toContainText(/check the household calendar for the next 7 days/i);
        await expect(page.locator(".badge").first()).toHaveText("can change your data");
        await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Keep blocked" })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    await test.step("approving with the issued token re-pins the tool", async () => {
      const before = listChanged;
      const approval = await client.callTool({
        name: "chaperone/approve_change",
        arguments: { quarantineId: card.quarantineId, approvalToken: card.approvalToken, decision: "approve" },
      });
      expect(approval.isError).not.toBe(true);
      expect(textOf(blocks(approval)[0])).toMatch(/approved\. New definition pinned as [0-9a-f]{12}\./);
      await pollUntil("list_changed after the approval", async () => (listChanged > before ? true : undefined), 10_000);
    });

    await test.step("the tool is restored", async () => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("grocery__add_item");
      const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
      expect(result.isError).not.toBe(true);
      expect(textOf(blocks(result)[0])).toMatch(/^Added 1 . batteries to the shopping list\.$/);
    });

    await test.step("verify-ledger is green and the ledger holds the full event sequence, in order", async () => {
      const events = await householdEvents();
      expect(runVerifyLedgerScript()).toBe(events.length);
      const chain = await getJson<{ ok: boolean; count: number }>(`${STACK.gatewayUrl}/api/ledger/verify`);
      expect(chain.body).toEqual({ ok: true, count: events.length });

      expect(ledgerTypes(events)).toEqual([
        // the staged household's four approvals
        "PIN_CREATED",
        "PIN_CREATED",
        "PIN_CREATED",
        "PIN_CREATED",
        // what the gate wrote when it caught the change
        "MISMATCH_DETECTED",
        "TOOL_QUARANTINED",
        "CONSENT_SHOWN",
        // what the approval wrote
        "APPROVED",
        "REPIN",
      ]);
      // In order means the chain agrees with the clock: nothing was inserted behind a later event.
      const stamps = events.map((e) => Date.parse(e.ts));
      expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
      // The live events are about the tool that changed, and were written by the gateway or the resident, never a model.
      const live = events.slice(4);
      for (const e of live) {
        expect(e.actor).not.toBe("model");
        expect(e.payload["toolName"]).toBe("add_item");
      }
      expect(live.map((e) => e.actor)).toEqual([
        "system:gateway",
        "system:gateway",
        "system:gateway",
        `resident:${HOUSEHOLD_ID}`,
        `resident:${HOUSEHOLD_ID}`,
      ]);
      const pin = await ledger.getPin(HOUSEHOLD_ID, "grocery", "add_item");
      expect(pin?.approvedBy).toBe(`resident:${HOUSEHOLD_ID}`);
      expect(pin?.approvedHash).toBe(String(live[4]?.payload["approvedHash"]));
    });
  } finally {
    await client.close();
  }
});
