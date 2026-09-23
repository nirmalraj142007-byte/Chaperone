/**
 * `pnpm demo:verify` — the demo's beats, run headlessly and asserted.
 *
 * Runs against the real stack: the gateway, demo-upstream and DynamoDB
 * Local from `docker compose up -d`, the console's production bundle
 * served by `vite preview`, and a real Chromium driven by Playwright. Each
 * beat below is one numbered step of the checklist `pnpm demo:reset` prints
 * (scripts/demo/checklist.ts). The first beat that fails stops the run.
 *
 * What this proves, in the order the resident would see it:
 *   the refusal text is the frozen constant, byte for byte; the card shows
 *   the added clause highlighted and a capability badge; approving through
 *   the console restores the tool; the ledger verifies; /corpus renders its
 *   PARTIAL state (crawl 1 only). And, as a side condition, that the browser
 *   made no request to anything but this machine.
 *
 * Every advisory line it sees is the hand-written FIXTURE from
 * demo/advisory-fixtures.json. Beat 5 asserts that it is labelled as one.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { REFUSAL_TOOL_CHANGED } from "@chaperone/policy";
import { STACK } from "./env.js";
import {
  blocks,
  cardActionOf,
  closeBrowser,
  connectGateway,
  getJson,
  isServing,
  launchBrowser,
  newOfflineContext,
  pollUntil,
  runVerifyLedgerScript,
  startConsole,
  textOf,
} from "./harness.js";
import { REPO_ROOT } from "./fixtures.js";
import { resetDemo } from "./reset.js";

export interface VerifyOptions {
  /** Never reset: neither before (even if the stack is not at its starting state) nor after. */
  skipReset?: boolean;
  /** Leave the stack in its post-beats state instead of resetting it again. */
  leaveDirty?: boolean;
}

interface State {
  client: Client;
  page: Page;
  context: BrowserContext;
  externalRequests: string[];
  quarantineId?: string;
  approvalToken?: string;
  cardText?: string;
  cardHtml?: string;
}

interface Beat {
  title: string;
  /** Returns a short detail line for the report. */
  run?: (s: State) => Promise<string>;
  /** A beat that is written but not yet enabled: reported as SKIPPED with this reason. */
  skip?: string;
}

const SCREENSHOT_DIR = path.join(REPO_ROOT, "test-results", "demo-verify");
/**
 * Is the stack exactly where `pnpm demo:reset` leaves it? Cheap read-only
 * checks, so a run straight after a reset (the usual case, and every second
 * consecutive run, which follows the reset at the end of the first) does not
 * pay for a second reset. Returns why not, or undefined.
 */
async function whyNotPristine(): Promise<string | undefined> {
  try {
    const health = await fetch(`${STACK.gatewayUrl}/healthz`);
    if (!health.ok) return `the gateway's /healthz answered ${health.status}`;
    const stats = (await (await fetch(`${STACK.demoUpstreamUrl}/control/stats`)).json()) as { mutated: boolean };
    if (stats.mutated) return "demo-upstream is still serving a changed description";
    const queue = await getJson<{ total: number }>(`${STACK.gatewayUrl}/api/quarantine`);
    if (queue.body.total !== 0) return `${queue.body.total} quarantine(s) from an earlier run remain`;
    const chain = await getJson<{ ok: boolean; count?: number }>(`${STACK.gatewayUrl}/api/ledger/verify`);
    if (!chain.body.ok || chain.body.count !== 4) return `the ledger has ${chain.body.count ?? "an unverifiable number of"} events, not the 4 staged ones`;
    return undefined;
  } catch (error) {
    return `the stack is not answering (${error instanceof Error ? error.message : String(error)})`;
  }
}

// --- the beats ---------------------------------------------------------------

function beats(): Beat[] {
  return [
    {
      title: "The stack is up, offline",
      run: async () => {
        const health = await pollUntil("the gateway's /healthz", async () => {
          const res = await fetch(`${STACK.gatewayUrl}/healthz`);
          return res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
        }, 45_000);
        assert.ok(await isServing(`${STACK.demoUpstreamUrl}/control/stats`), "demo-upstream is not answering");
        assert.ok(await isServing(`${STACK.consoleUrl}/`), "the console is not being served");
        return `/healthz ${JSON.stringify(health).slice(0, 80)}`;
      },
    },
    {
      title: "Nothing has changed yet",
      run: async ({ page }) => {
        const queue = await getJson<{ total: number }>(`${STACK.gatewayUrl}/api/quarantine`);
        assert.equal(queue.body.total, 0, "expected an empty queue right after reset");
        const verify = await getJson<{ ok: boolean; count?: number }>(`${STACK.gatewayUrl}/api/ledger/verify`);
        assert.equal(verify.body.ok, true);
        assert.equal(verify.body.count, 4, "expected the four staged approvals and nothing else");

        await page.goto(`${STACK.consoleUrl}/queue`);
        await page.getByText("Nothing has changed since you approved it.").waitFor({ timeout: 15_000 });
        return "queue empty; ledger verifies 4 events";
      },
    },
    {
      title: "An approved tool works",
      run: async ({ client }) => {
        const names = (await client.listTools()).tools.map((t) => t.name);
        for (const expected of ["grocery__add_item", "grocery__read_list", "grocery__place_order", "grocery__track_delivery"]) {
          assert.ok(names.includes(expected), `tools/list is missing ${expected}`);
        }
        const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
        assert.notEqual(result.isError, true);
        assert.match(textOf(blocks(result)[0]), /^Added 1 . batteries to the shopping list\.$/);
        return `${names.length} tools listed; add_item ran`;
      },
    },
    {
      title: "The upstream changes a tool's description",
      run: async ({ page }) => {
        await page.goto(`${STACK.consoleUrl}/upstreams`);
        await page.getByRole("button", { name: "Mutate add_item" }).click({ timeout: 15_000 });
        const stats = await pollUntil("demo-upstream to report the mutation", async () => {
          const s = (await (await fetch(`${STACK.demoUpstreamUrl}/control/stats`)).json()) as { mutated: boolean };
          return s.mutated ? s : undefined;
        });
        assert.equal(stats.mutated, true);
        return "clicked \"Mutate add_item\" on /upstreams; the upstream now serves the changed text";
      },
    },
    {
      title: "The gate refuses, in words that never change",
      run: async (s) => {
        const result = await s.client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
        const content = blocks(result);
        assert.equal(result.isError, true);

        // The frozen constant, byte for byte. Not a substring, not a regex.
        assert.equal(textOf(content[0]), REFUSAL_TOOL_CHANGED);

        const card = textOf(content[1]);
        s.cardText = card;
        assert.match(card, /^Tool changed: add_item \(Household Grocery\)$/m);
        assert.match(card, /^Capability: can change your data$/m);
        assert.match(card, /^You approved this on 12 January$/m);
        assert.match(card, /\{\+[^}]*check the household calendar for the next 7 days[^}]*\+\}/, "the added clause should be marked");
        assert.match(
          card,
          /^Advisory \(fixture: hand-written for the offline demo, not model output\): /m,
          "the advisory line must say it is a fixture",
        );
        assert.ok(!card.includes("model-generated"), "a fixture must never be labelled model-generated");

        const { quarantineId, approvalToken } = cardActionOf(card);
        s.quarantineId = quarantineId;
        s.approvalToken = approvalToken;

        const html = content[2]?.type === "resource" ? content[2].resource?.text : undefined;
        assert.ok(html !== undefined && html.includes("clause-add"), "the third block should be the HTML card, carrying the highlighted clause");
        s.cardHtml = html;

        // Excluded, not annotated: the model cannot see the tool it might be talked into calling.
        const names = (await s.client.listTools()).tools.map((t) => t.name);
        assert.ok(!names.includes("grocery__add_item"), "the changed tool must be absent from tools/list");
        assert.ok(names.includes("grocery__read_list"), "unchanged tools must stay available");
        const other = await s.client.callTool({ name: "grocery__read_list", arguments: {} });
        assert.notEqual(other.isError, true);
        return "refusal === REFUSAL_TOOL_CHANGED; add_item withheld, read_list still runs";
      },
    },
    {
      title: "The card, rendered",
      run: async ({ context, cardHtml }) => {
        assert.ok(cardHtml !== undefined);
        const card = await context.newPage();
        try {
          await card.setContent(cardHtml, { waitUntil: "domcontentloaded" });
          const added = card.locator("ins.clause-add");
          await added.first().waitFor({ state: "visible" });
          assert.match((await added.first().innerText()).toLowerCase(), /check the household calendar for the next 7 days/);
          assert.equal((await card.locator(".badge").first().innerText()).trim(), "can change your data");
          assert.match(await card.locator(".approved-on").innerText(), /You approved this on 12 January/);
          const label = await card.locator(".advisory-label").innerText();
          assert.match(label, /fixture/i);
          assert.ok(!/model-generated/i.test(label));
          assert.equal(await card.getByRole("button", { name: "Approve" }).isVisible(), true);
          assert.equal(await card.getByRole("button", { name: "Keep blocked" }).isVisible(), true);
          mkdirSync(SCREENSHOT_DIR, { recursive: true });
          await card.screenshot({ path: path.join(SCREENSHOT_DIR, "consent-card.png") });
        } finally {
          await card.close();
        }
        return "highlighted clause, capability badge, approval date, fixture label; screenshot in test-results/demo-verify/";
      },
    },
    {
      title: "The resident decides on the console",
      run: async (s) => {
        const { page, quarantineId, approvalToken } = s;
        assert.ok(quarantineId !== undefined && approvalToken !== undefined);

        await page.goto(`${STACK.consoleUrl}/queue`);
        await page.getByRole("link", { name: /add_item/ }).first().click({ timeout: 15_000 });
        await page.waitForURL(new RegExp(`/queue/${quarantineId}`));

        await page.locator("mark.add").first().waitFor({ state: "visible", timeout: 15_000 });
        const marked = (await page.locator("mark.add").allInnerTexts()).join(" ").toLowerCase();
        assert.match(marked, /check the household calendar for the next 7 days/, `highlighted text was: ${marked}`);
        const detail = await page.locator("main").innerText();
        assert.match(detail, /\bwrite\b/i, "the capability badge should be visible");
        assert.match(detail, /Approved\s+Jan(uary)?\s+12\b/, "the pinned version should read as approved on 12 January");
        assert.match(detail, /fixture, hand-written, not model output/i, "the console must label the advisory a fixture");
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "console-queue-detail.png"), fullPage: true });

        await page.getByLabel("One-time approval token").fill(approvalToken);
        await page.getByRole("button", { name: "Approve & re-pin" }).click();
        const settled = await pollUntil("the quarantine to read as approved", async () => {
          const q = await getJson<{ reviewState: string }>(`${STACK.gatewayUrl}/api/quarantine/${quarantineId}`);
          return q.body.reviewState === "approved" ? q.body : undefined;
        });
        assert.equal(settled.reviewState, "approved");
        return "highlighted clause + capability + 12 January + fixture label; approved via chaperone/approve_change";
      },
    },
    {
      title: "The tool is back",
      run: async ({ client }) => {
        const names = await pollUntil("add_item to return to tools/list", async () => {
          const listed = (await client.listTools()).tools.map((t) => t.name);
          return listed.includes("grocery__add_item") ? listed : undefined;
        });
        const result = await client.callTool({ name: "grocery__add_item", arguments: { item: "batteries" } });
        assert.notEqual(result.isError, true);
        assert.match(textOf(blocks(result)[0]), /^Added 1 . batteries to the shopping list\.$/);
        return `add_item listed and running again (${names.length} tools)`;
      },
    },
    {
      title: "The ledger vouches for it",
      run: async () => {
        // The real script `pnpm verify-ledger` runs, not a re-implementation.
        // 4 staged approvals + MISMATCH_DETECTED, TOOL_QUARANTINED, CONSENT_SHOWN + APPROVED, REPIN.
        assert.equal(runVerifyLedgerScript(), 9);
        const api = await getJson<{ ok: boolean; count?: number }>(`${STACK.gatewayUrl}/api/ledger/verify`);
        assert.deepEqual(api.body, { ok: true, count: 9 });
        return "verify-ledger: chain OK, 9 events; the gateway's /api/ledger/verify agrees";
      },
    },
    {
      title: "The evidence screen, with the network off",
      run: async ({ page }) => {
        await page.goto(`${STACK.consoleUrl}/corpus`);
        await page.getByText("Observation 1 of 2 recorded").waitFor({ timeout: 15_000 });
        const body = await page.locator("main").innerText();
        assert.match(body, /1 of 2/);
        assert.match(body, /2026-10-20/, "the crawl 2 target date should be shown");
        assert.ok(!/2 of 2/.test(body), "the complete state must not render before crawl 2");
        return "PARTIAL: observation 1 of 2, measurement due 2026-10-20";
      },
    },
    {
      title: "The drift chart",
      skip:
        "TODO(blocker: crawl 2 has not run, so data/drift.json has status \"pending\" and no drift chart exists; " +
        "resolves after crawl 2 on 2026-10-20 and `pnpm analyse:drift`): once drift.json says \"complete\", " +
        "load /corpus, assert \"Both observations recorded\", the \"Headline · semantic-intent only\" section, " +
        "and one drift mark per capability class from data/drift.json's byCapability. Write the assertions against " +
        "the real file then, not against a guess at it now.",
    },
    {
      title: "Nothing left this machine",
      run: async ({ externalRequests }) => {
        assert.deepEqual(externalRequests, [], `the browser tried to reach: ${externalRequests.join(", ")}`);
        return "every browser request went to localhost; the rest were blocked and would have been listed here";
      },
    },
  ];
}

// --- the run -----------------------------------------------------------------

export interface VerifyResult {
  passed: number;
  skipped: number;
  failed: number;
  elapsedMs: number;
}

export async function verifyDemo(options: VerifyOptions = {}, out: (line: string) => void = console.log): Promise<VerifyResult> {
  const started = Date.now();
  let preview: ChildProcess | undefined;
  let browser: Browser | undefined;
  let client: Client | undefined;
  let passed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    if (options.skipReset !== true) {
      const why = await whyNotPristine();
      if (why === undefined) {
        out("start: the stack is already at its staged starting state (run `pnpm demo:reset` to force a fresh one)");
      } else {
        out(`reset: ${why}; putting the demo back to its starting state`);
        await resetDemo({ log: (line) => out(`  ${line}`) });
      }
    }
    const setupStarted = Date.now();
    preview = await startConsole();
    browser = await launchBrowser();
    const { context, externalRequests } = await newOfflineContext(browser);
    const page = await context.newPage();

    client = await connectGateway("demo-verify");

    const state: State = { client, page, context, externalRequests };
    out(`setup: console served, browser launched, gateway session open (${Date.now() - setupStarted} ms)`);
    out("");
    for (const [index, beat] of beats().entries()) {
      const label = `${String(index + 1).padStart(2)}. ${beat.title}`;
      if (beat.skip !== undefined || beat.run === undefined) {
        skipped += 1;
        out(`  -  ${label}: SKIPPED. ${beat.skip ?? ""}`);
        continue;
      }
      const t0 = Date.now();
      try {
        const detail = await beat.run(state);
        passed += 1;
        out(`  ok ${label} (${Date.now() - t0} ms) — ${detail}`);
      } catch (error) {
        failed += 1;
        out(`  FAIL ${label} (${Date.now() - t0} ms)`);
        out(`       ${error instanceof Error ? error.message.replace(/\n/g, "\n       ") : String(error)}`);
        break;
      }
    }
  } finally {
    const teardownStarted = Date.now();
    await client?.close().catch(() => undefined);
    const closed = browser === undefined ? true : await closeBrowser(browser);
    preview?.kill();
    if (browser !== undefined) {
      out(
        `
teardown: ${closed ? "session and browser closed" : "session closed; the browser is still shutting down and is not waited for"} ` +
          `(${Date.now() - teardownStarted} ms)`,
      );
    }
    if (options.leaveDirty !== true && options.skipReset !== true) {
      out("\nreset: leaving the demo ready to film");
      await resetDemo({ log: (line) => out(`  ${line}`), skipConsole: true, skipDocker: true }).catch((error: unknown) => {
        out(`  reset after verify failed: ${error instanceof Error ? error.message : String(error)}`);
        failed += 1;
      });
    }
  }

  return { passed, skipped, failed, elapsedMs: Date.now() - started };
}
