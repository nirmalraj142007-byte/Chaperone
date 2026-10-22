/**
 * Shared setup for the end-to-end specs. The pieces that also make up
 * `pnpm demo:verify` live in scripts/demo/harness.ts and are imported, not
 * copied, so the two cannot disagree about what "the demo works" means.
 *
 * Import order matters: scripts/demo/env.ts fills in the compose stack's
 * addresses and installs the loopback guard before anything reads config.
 */
import "../scripts/demo/env.js";
import { execFileSync } from "node:child_process";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { PLAIN_SENTENCE_FIXTURE_LABEL } from "@chaperone/mcp-app";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadConfig } from "@chaperone/config";
import * as ledger from "@chaperone/ledger";
import { STACK } from "../scripts/demo/env.js";
import { DEMO_PLAIN_SENTENCE, REPO_ROOT } from "../scripts/demo/fixtures.js";
import { connectGateway, isServing, pollUntil } from "../scripts/demo/harness.js";
import { resetDemo } from "../scripts/demo/reset.js";

export { STACK };

export const HOUSEHOLD_ID = loadConfig().householdId;

/** Every spec starts from the same staged household, so a spec's result never depends on the one before it. */
export async function freshDemo(): Promise<void> {
  // The stack is expected to be up already (`docker compose up -d`, or CI's
  // start step); the console bundle is not needed by these specs.
  await resetDemo({ log: () => {}, skipDocker: true, skipConsole: true });
}

export async function freshSession(name: string): Promise<Client> {
  await pollUntil("the gateway to answer /healthz", async () => ((await isServing(`${STACK.gatewayUrl}/healthz`)) ? true : undefined), 60_000);
  return connectGateway(name);
}

export function ledgerTypes(events: ReadonlyArray<{ type: string }>): string[] {
  return events.map((e) => e.type);
}

export async function householdEvents(): Promise<ledger.StoredLedgerEvent[]> {
  return ledger.listEvents(HOUSEHOLD_ID);
}

/** `docker compose <args>` in the repo root; honours COMPOSE_FILE, so the offline overlay applies when it is set. */
export function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", ...args], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export { ledger };

export { DEMO_PLAIN_SENTENCE };

/**
 * F2: the card a resident opens. Above the fold, the plain sentence (labelled
 * a fixture), the capability badge and two buttons, with no technical word;
 * the diff appears only once "Show details" is opened.
 */
export async function expectPlainTopThenDetails(card: Page | FrameLocator): Promise<void> {
  await expect(card.locator(".plain").first()).toHaveText(DEMO_PLAIN_SENTENCE);
  await expect(card.locator(".plain-source").first()).toHaveText(PLAIN_SENTENCE_FIXTURE_LABEL);
  await expect(card.locator(".badge").first()).toHaveText("can change your data");
  await expect(card.getByRole("button", { name: "Allow" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Keep blocked" })).toBeVisible();
  const added = card.locator("ins.clause-add").first();
  await expect(added).toBeHidden();
  // innerText leaves out a closed <details> body: this is exactly what is on screen.
  const aboveTheFold = await card.locator(".pending-content").first().innerText();
  expect(aboveTheFold).not.toMatch(/quarantine|hash|schema/i);
  expect(aboveTheFold).not.toContain("check the household calendar");
  await card.getByText("Show details").first().click();
  await expect(added).toBeVisible();
  await expect(added).toContainText(/check the household calendar for the next 7 days/i);
}
