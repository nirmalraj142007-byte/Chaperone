/**
 * The pieces `pnpm demo:verify` and the Playwright end-to-end specs (e2e/)
 * share: polling, the gateway's JSON API, MCP result helpers, the console
 * preview server, browser launch, and the browser context that refuses to
 * leave this machine. One copy, so the two cannot drift apart on what
 * "the demo works" means.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { STACK, isLocalUrl } from "./env.js";
import { CONSOLE_DIR, viteBin } from "./console.js";
import { ASSISTANT_DIR, assistantViteBin, ensureAssistantBundle } from "./assistant.js";
import { REPO_ROOT } from "./fixtures.js";

export interface Block {
  type: string;
  text?: string;
  resource?: { uri: string; mimeType?: string; text?: string };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function pollUntil<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(200);
  }
}

/**
 * GET with one retry. The gateway (Express) closes an idle keep-alive socket
 * after 5 seconds; a fetch that reuses that socket in the instant it closes
 * fails with a bare "fetch failed". This is read-only, so retrying is safe.
 */
export async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      return { status: res.status, body: (await res.json()) as T };
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

export function blocks(result: unknown): Block[] {
  return ((result as { content?: Block[] }).content ?? []) as Block[];
}

export function textOf(block: Block | undefined): string {
  assert.ok(block !== undefined && block.type === "text" && typeof block.text === "string", "expected a text content block");
  return block.text;
}

export async function isServing(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** True if anything answers at `url` at all, whatever the status. DynamoDB Local answers `GET /` with a 400, which `isServing` would call "down". */
export async function isReachable(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

/** Serves the console's production bundle. If something already answers on 4173, that is used as is. */
export async function startConsole(): Promise<ChildProcess | undefined> {
  if (await isServing(`${STACK.consoleUrl}/`)) {
    return undefined;
  }
  const child = spawn(process.execPath, [viteBin(), "preview", "--port", "4173", "--strictPort"], {
    cwd: CONSOLE_DIR,
    stdio: "ignore",
  });
  await pollUntil("the console preview server", async () => ((await isServing(`${STACK.consoleUrl}/`)) ? true : undefined), 30_000);
  return child;
}

/**
 * Serves the simulated assistant's production bundle (building it first if stale). If something
 * already answers on 5174, that is used as is.
 */
export async function startAssistant(): Promise<ChildProcess | undefined> {
  if (await isServing(`${STACK.assistantUrl}/`)) {
    return undefined;
  }
  ensureAssistantBundle(() => {});
  const child = spawn(process.execPath, [assistantViteBin(), "preview", "--port", "5174", "--strictPort"], {
    cwd: ASSISTANT_DIR,
    stdio: "ignore",
  });
  await pollUntil("the simulated assistant preview server", async () => ((await isServing(`${STACK.assistantUrl}/`)) ? true : undefined), 30_000);
  return child;
}

/** Bundled Chromium first. On a machine where `playwright install chromium` has not run, an installed Edge or Chrome does the same job. */
export async function launchBrowser(): Promise<Browser> {
  const wanted = process.env["PW_CHANNEL"];
  const attempts: Array<{ channel?: string }> = wanted !== undefined ? [{ channel: wanted }] : [{}, { channel: "msedge" }, { channel: "chrome" }];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await chromium.launch({ headless: true, ...attempt });
    } catch (error) {
      errors.push(`${attempt.channel ?? "bundled chromium"}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new Error(`no browser could be launched. Run \`pnpm exec playwright install chromium\` once, while online.\n  ${errors.join("\n  ")}`);
}

/**
 * Chromium's shutdown is the one step in this run whose duration is not ours:
 * on a machine short of memory it has taken anywhere from 0.1 s to over a
 * minute. Wait a bounded time, then let the process exit take it down with
 * the driver (demo-verify.ts exits explicitly). Returns whether it closed.
 */
export async function closeBrowser(browser: Browser, timeoutMs = 8_000): Promise<boolean> {
  return Promise.race([
    browser.close().then(() => true, () => true),
    sleep(timeoutMs).then(() => false),
  ]);
}

/** A fresh MCP client session against the gateway. Callers close it. */
export async function connectGateway(name = "harness"): Promise<Client> {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${STACK.gatewayUrl}/mcp`)) as Transport);
  return client;
}

/** POST to demo-upstream's scripted control surface. */
export async function demoUpstreamControl(action: "mutate" | "reset"): Promise<void> {
  const res = await fetch(`${STACK.demoUpstreamUrl}/control/${action}`, { method: "POST" });
  assert.equal(res.status, 200, `demo-upstream /control/${action} answered ${res.status}`);
}

/**
 * The quarantine id and one-time token the text card carries in its
 * `chaperone/approve_change` action lines. The token exists nowhere else.
 */
export function cardActionOf(cardText: string): { quarantineId: string; approvalToken: string } {
  const match = /quarantineId=(\S+) approvalToken=(\S+) decision=approve/.exec(cardText);
  assert.ok(match, "the card should carry the quarantine id and one-time token");
  const [, quarantineId, approvalToken] = match;
  assert.ok(quarantineId !== undefined && approvalToken !== undefined);
  return { quarantineId, approvalToken };
}

/**
 * A browser context pinned to UTC and reduced motion that refuses every
 * request to anything but this machine, recording what it refused.
 */
export async function newOfflineContext(browser: Browser): Promise<{ context: BrowserContext; externalRequests: string[] }> {
  const context = await browser.newContext({ timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
  const externalRequests: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (isLocalUrl(url) || url.startsWith("data:") || url.startsWith("about:") || url.startsWith("blob:")) {
      return route.continue();
    }
    externalRequests.push(url);
    return route.abort();
  });
  return { context, externalRequests };
}

/**
 * Runs the real script `pnpm verify-ledger` runs (package.json:
 * `tsx packages/ledger/scripts/verify-ledger.ts`), launched directly so the
 * pnpm shim's start-up is not counted. Throws with the script's own output
 * unless it reports a verified chain; returns the event count it verified.
 */
export function runVerifyLedgerScript(): number {
  let out: string;
  try {
    out = execFileSync(process.execPath, ["--import", "tsx", path.join("packages", "ledger", "scripts", "verify-ledger.ts")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    throw new Error(`verify-ledger exited non-zero:
${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
  const match = /chain OK — (\d+) events verified/.exec(out);
  assert.ok(match, `verify-ledger did not report a verified chain:
${out}`);
  return Number(match[1]);
}
