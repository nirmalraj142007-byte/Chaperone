/**
 * The simulated Alexa+ experience (packages/assistant-sim), end to end, in a
 * real browser, against the real docker-compose stack:
 *
 *   fresh demo:reset -> "add batteries" succeeds -> `pnpm demo:mutate` ->
 *   "add batteries" is refused in the frozen words with the consent card
 *   INSIDE the conversation -> the resident presses Allow (or Keep blocked)
 *   on the card, which round-trips for real through chaperone/approve_change
 *   -> the next request succeeds (or stays blocked).
 *
 * The card is hosted as an MCP App: the assertions reach into its sandboxed
 * frame through Playwright's frameLocator, and `data-phase="live"` is only
 * set once the ui/initialize handshake has really completed.
 *
 * The assistant on this page has no model, so nothing here can be flaky in
 * the way a model would make it: the same words always make the same call.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import type { Browser } from "playwright";
import { REFUSAL_TOOL_CHANGED } from "@chaperone/policy";
import { closeBrowser, getJson, launchBrowser, newOfflineContext, runVerifyLedgerScript, startAssistant } from "../scripts/demo/harness.js";
import { REPO_ROOT } from "../scripts/demo/fixtures.js";
import { DEMO_PLAIN_SENTENCE, HOUSEHOLD_ID, expectPlainTopThenDetails, STACK, freshDemo, householdEvents, ledger, ledgerTypes } from "./support.js";
import { PLAIN_SENTENCE_FIXTURE_LABEL, TEXT_CARD_DECISION_LINE } from "@chaperone/mcp-app";

let browser: Browser;
let assistant: ChildProcess | undefined;

test.beforeAll(async () => {
  browser = await launchBrowser();
  assistant = await startAssistant();
});

test.afterAll(async () => {
  await closeBrowser(browser);
  assistant?.kill();
  await freshDemo();
});

/** The same script `pnpm demo:mutate` runs, launched directly so no pnpm shim is in the way. */
function demoMutate(): void {
  execFileSync(process.execPath, ["--import", "tsx", path.join("scripts", "demo-mutate.ts")], { cwd: REPO_ROOT, stdio: "ignore" });
}

async function openAssistant(page: Page, query = ""): Promise<void> {
  await page.goto(`${STACK.assistantUrl}/${query}`);
  await expect(page.getByRole("heading", { name: "Simulated Alexa+ experience" })).toBeVisible();
  // Ready means the MCP session is open: the session ID is on the panel and the composer is enabled.
  await expect(page.getByTestId("session-id")).not.toHaveText("(none)");
  await expect(page.getByRole("textbox", { name: "Ask the household assistant" })).toBeEnabled();
}

async function say(page: Page, words: string): Promise<void> {
  const box = page.getByRole("textbox", { name: "Ask the household assistant" });
  await box.fill(words);
  await box.press("Enter");
}

/** The newest card in the conversation. */
const cardFrame = (page: Page) => page.frameLocator('iframe[title^="Chaperone review card"]').last();

async function lastToolText(page: Page): Promise<string> {
  return (await page.getByTestId("tool-text").last().textContent()) ?? "";
}

/** Everything up to and including the card: the shared opening of both decisions. */
async function reachTheCard(page: Page): Promise<void> {
  await test.step('"add batteries to my list" runs against the pinned definition', async () => {
    await say(page, "add batteries to my list");
    await expect(page.getByTestId("tool-text").last()).toHaveText(/^Added 1 . batteries to the shopping list\.$/);
    await expect(page.getByRole("textbox", { name: "Ask the household assistant" })).toBeEnabled();
  });

  await test.step("the upstream changes add_item's description (pnpm demo:mutate)", async () => {
    demoMutate();
  });

  await test.step("asking again is refused in the frozen words, with the card inline", async () => {
    await say(page, "add batteries to my list");
    // Byte for byte: the gateway's constant, never reworded by this page.
    await expect(page.getByTestId("refusal")).toHaveCount(1);
    expect(await page.getByTestId("refusal").textContent()).toBe(REFUSAL_TOOL_CHANGED);
    await expect(page.locator('[data-testid="consent-card"][data-phase="live"]')).toBeVisible();
    await expectPlainTopThenDetails(cardFrame(page));
  });
}

test("approving on the inline card restores the tool, and the next request runs", async () => {
  await freshDemo();
  const { context, externalRequests } = await newOfflineContext(browser);
  const page = await context.newPage();
  try {
    // Tall enough that the whole card, buttons included, is on screen in the screenshots.
    await page.setViewportSize({ width: 1280, height: 1200 });
    await openAssistant(page);
    // Labelled as what it is, before anything happens.
    await expect(page.getByTestId("simulation-banner")).toContainText("rule-based stand-in for the assistant’s model — not part of Chaperone");

    await test.step("chaperone/approve_change is not in the assistant's tool list: it is app-only, for the card", async () => {
      const modelTools = page.getByTestId("model-tools");
      await expect(modelTools).toContainText("grocery__add_item");
      await expect(modelTools).toContainText("chaperone/pending_changes");
      await expect(modelTools).not.toContainText("chaperone/approve_change");
      await expect(page.getByTestId("app-only-tools")).toContainText("chaperone/approve_change");
    });

    await reachTheCard(page);
    await page.screenshot({ path: test.info().outputPath("1-refusal-with-card.png") });

    await test.step("asking the assistant to approve does not reach approve_change", async () => {
      const callsBefore = await page.getByTestId("calls").locator("li").count();
      await say(page, "approve the change");
      // Wait for the stand-in's answer, so the count below is taken after it acted.
      await expect(page.getByText("I only understand a few phrases").last()).toBeVisible();
      await expect(page.getByTestId("calls").locator("li")).toHaveCount(callsBefore);
      await expect(page.getByTestId("calls")).not.toContainText("chaperone/approve_change");
    });

    await test.step("Approve on the card round-trips through chaperone/approve_change", async () => {
      await cardFrame(page).getByRole("button", { name: "Allow" }).click();
      const outcome = cardFrame(page).locator(".outcome.approved");
      await expect(outcome).toContainText(/approved\. New definition pinned as [0-9a-f]{12}\./);
      await expect(page.getByText("Chaperone recorded your approval.")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("2-approved-on-card.png") });
    });

    await test.step("the card closes itself with the MCP Apps teardown, leaving a plain record", async () => {
      await expect(page.getByTestId("card-closed")).toContainText("You approved the change.");
    });

    await test.step("the next request succeeds", async () => {
      await say(page, "add batteries to my list");
      // Two results now: the one before the change, and this one.
      await expect(page.getByTestId("tool-text")).toHaveCount(2);
      await expect(page.getByTestId("tool-text").last()).toHaveText(/^Added 1 . batteries to the shopping list\.$/);
      expect(await lastToolText(page)).toMatch(/batteries/);
      await page.screenshot({ path: test.info().outputPath("3-approved-result.png") });
    });

    await test.step('"What just happened" names the tool, session, protocol and a latency for every call', async () => {
      await expect(page.getByTestId("protocol-version")).toHaveText("2025-11-25");
      await expect(page.getByTestId("session-id")).toHaveText(/^[0-9A-Z]{20,}$/);
      const calls = page.getByTestId("calls").locator("li");
      await expect(calls).toHaveCount(4);
      // newest first
      for (const [index, result] of ["ran", "approved", "held", "ran"].entries()) {
        await expect(calls.nth(index)).toHaveAttribute("data-result", result);
      }
      for (const latency of await page.getByTestId("latency").allTextContents()) {
        expect(latency).toMatch(/^\d+ ms$/);
      }
      await expect(page.getByTestId("happened")).toContainText("no model involved");
    });

    await test.step("the ledger holds the story, written by the gateway and the resident, never a model", async () => {
      const events = await householdEvents();
      expect(runVerifyLedgerScript()).toBe(events.length);
      const chain = await getJson<{ ok: boolean; count: number }>(`${STACK.gatewayUrl}/api/ledger/verify`);
      expect(chain.body).toEqual({ ok: true, count: events.length });
      expect(ledgerTypes(events)).toEqual([
        "PIN_CREATED",
        "PIN_CREATED",
        "PIN_CREATED",
        "PIN_CREATED",
        "MISMATCH_DETECTED",
        "TOOL_QUARANTINED",
        "CONSENT_SHOWN",
        "APPROVED",
        "REPIN",
      ]);
      // The card's buttons say which surface decided: the MCP App.
      expect(events.slice(-2).map((e) => e.actor)).toEqual([`resident:${HOUSEHOLD_ID}:mcp-app`, `resident:${HOUSEHOLD_ID}:mcp-app`]);
      expect(events.every((e) => e.actor !== "model")).toBe(true);
    });

    // Nothing on this page reached past this machine.
    expect(externalRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Keep blocked on the inline card records the refusal, and the tool stays blocked", async () => {
  await freshDemo();
  const pinBefore = await ledger.getPin(HOUSEHOLD_ID, "grocery", "add_item");
  const { context } = await newOfflineContext(browser);
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await openAssistant(page);
    await reachTheCard(page);

    await test.step("Keep blocked round-trips through chaperone/approve_change", async () => {
      await cardFrame(page).getByRole("button", { name: "Keep blocked" }).click();
      await expect(cardFrame(page).locator(".outcome.refused")).toContainText("Kept blocked");
      await expect(page.getByText("Okay, it stays blocked.")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("4-kept-blocked-on-card.png") });
    });

    await test.step("the next request is refused again, in the same words, and nothing runs", async () => {
      await say(page, "add batteries to my list");
      await expect(page.getByTestId("refusal")).toHaveCount(2);
      const refusals = await page.getByTestId("refusal").allTextContents();
      expect(refusals).toEqual([REFUSAL_TOOL_CHANGED, REFUSAL_TOOL_CHANGED]);
      // The gateway shows the same review, now in its settled state: no buttons, no new question.
      await expect(cardFrame(page).locator(".outcome.refused")).toContainText("Kept blocked");
      await expect(page.getByTestId("tool-text")).toHaveCount(1); // only the first, pre-change add
      await page.screenshot({ path: test.info().outputPath("5-still-blocked.png") });
    });

    await test.step("the ledger has the refusal, no approval, and the pin has not moved", async () => {
      const events = await householdEvents();
      expect(runVerifyLedgerScript()).toBe(events.length);
      const types = ledgerTypes(events);
      expect(types).toContain("REFUSED");
      expect(types).not.toContain("APPROVED");
      expect(types).not.toContain("REPIN");
      const pinAfter = await ledger.getPin(HOUSEHOLD_ID, "grocery", "add_item");
      expect(pinAfter?.approvedHash).toBe(pinBefore?.approvedHash);
    });
  } finally {
    await context.close();
  }
});

test("the text card is the floor: ?card=text shows it, and its Allow button works the same way", async () => {
  await freshDemo();
  const { context } = await newOfflineContext(browser);
  const page = await context.newPage();
  try {
    await openAssistant(page, "?card=text");
    await say(page, "add batteries to my list");
    await expect(page.getByTestId("tool-text").last()).toHaveText(/^Added 1 . batteries to the shopping list\.$/);
    demoMutate();
    await say(page, "add batteries to my list");

    expect(await page.getByTestId("refusal").textContent()).toBe(REFUSAL_TOOL_CHANGED);
    const text = page.getByTestId("consent-card-text");
    await expect(text).toContainText("You asked for the text version of this card");
    await expect(text).toContainText("can change your data");
    await expect(page.locator("iframe")).toHaveCount(0);
    // The text card is what a model reads: no token, no approve call. The
    // buttons below take the token from the HTML card the gateway also sent.
    await expect(text).not.toContainText(/approvalToken|approve_change/);
    await expect(text).toContainText("Allow or keep blocked from the card on your phone, or in the Chaperone console.");

    // The plain sentence and its fixture label come first, ahead of the diff.
    const cardLines = ((await text.locator("pre").textContent()) ?? "").split("\n");
    expect(cardLines.slice(0, 3)).toEqual([DEMO_PLAIN_SENTENCE, `(${PLAIN_SENTENCE_FIXTURE_LABEL})`, TEXT_CARD_DECISION_LINE]);
    await text.getByRole("button", { name: "Allow" }).click();
    await expect(text.getByRole("status")).toContainText(/Approved\. .*approved\. New definition pinned as [0-9a-f]{12}\./);
    await say(page, "add batteries to my list");
    await expect(page.getByTestId("tool-text").last()).toHaveText(/^Added 1 . batteries to the shopping list\.$/);
    expect(ledgerTypes(await householdEvents()).slice(-2)).toEqual(["APPROVED", "REPIN"]);
  } finally {
    await context.close();
  }
});

test("an unreachable gateway is a clear state with a way back, and nothing is sent", async () => {
  await freshDemo();
  const { context } = await newOfflineContext(browser);
  const page = await context.newPage();
  try {
    let down = true;
    await context.route("**/mcp", (route) => (down ? route.abort() : route.continue()));
    await page.goto(`${STACK.assistantUrl}/`);
    const alert = page.getByTestId("gateway-unreachable");
    await expect(alert).toContainText("The gateway can’t be reached");
    await expect(alert).toContainText("no tool was run");
    await expect(page.getByRole("textbox", { name: "Ask the household assistant" })).toBeDisabled();

    down = false;
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("session-id")).not.toHaveText("(none)");
    await expect(page.getByRole("textbox", { name: "Ask the household assistant" })).toBeEnabled();
    await expect(page.getByTestId("empty-state")).toBeVisible();
  } finally {
    await context.close();
  }
});
