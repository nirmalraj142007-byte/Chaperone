/**
 * `pnpm resume-demo` — a single, verbose kill-and-resume, meant to be
 * screen-recorded for the demo's 20-second resumability beat (see
 * CLAUDE.md's ALB-idle-timeout / Fargate note and the proposal's 90-second
 * script). Exercises the exact same real gateway + real demo-upstream +
 * real DynamoDB path spec/resumption.test.ts's 10 independent iterations
 * do, just once, with every step narrated to stdout instead of asserted
 * silently — and the one number a viewer needs ("invocations: 1") printed
 * as an explicit delta rather than two raw counters they'd have to
 * subtract themselves off screen.
 *
 * `console.log` is deliberate here — CLAUDE.md's "no console.log outside
 * scripts/" convention exists precisely for entry points like this one,
 * whose whole job is to be legible on camera in a terminal.
 *
 * Requires `docker compose up -d` (ddb, demo-upstream, gateway) already
 * running. `TARGET=https://<host>/mcp` points this at a deployed
 * environment instead of localhost, same as spec/resumption.test.ts.
 */
import {
  callToolAndAwaitResult,
  destroyConnection,
  getStats,
  initializeSession,
  openToolCallStream,
  readUntilFirstEventId,
  reconnectStream,
  setPlaceOrderDelay,
  terminateSession,
  waitForResult,
  type DemoUpstreamControl,
} from "../spec/lib/rawMcpClient.js";

const GATEWAY_URL = process.env["TARGET"] ?? "http://localhost:3000/mcp";
const DEMO_UPSTREAM_URL = process.env["DEMO_UPSTREAM_URL"] ?? "http://localhost:4000";
const PLACE_ORDER_DELAY_MS = 4_000;
const control: DemoUpstreamControl = { baseUrl: DEMO_UPSTREAM_URL };

// Plain ANSI, no dependency — off entirely when stdout isn't a TTY (e.g.
// piped to a file) or NO_COLOR is set, so the plain-text transcript never
// carries escape codes.
const useColor = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
function paint(code: string, text: string): string {
  return useColor ? `[${code}m${text}[0m` : text;
}
const bold = (s: string): string => paint("1", s);
const red = (s: string): string => paint("1;31", s);
const green = (s: string): string => paint("1;32", s);
const dim = (s: string): string => paint("2", s);

const RULE = "=".repeat(70);
const t0 = Date.now();

/** Relative elapsed time, T+seconds — what matters on camera is the gap between steps, not the wall-clock time of day. */
function elapsed(): string {
  return `T+${((Date.now() - t0) / 1000).toFixed(3)}s`;
}

function step(n: number, total: number, text: string): void {
  console.log(`${dim(`[${elapsed()}]`)} ${bold(`STEP ${n}/${total}`)}  ${text}`);
}

function detail(text: string): void {
  console.log(`${dim(`[${elapsed()}]`)}          ${text}`);
}

const TOTAL_STEPS = 9;

async function main(): Promise<void> {
  console.log(RULE);
  console.log(bold("  CHAPERONE — resumable SSE demo"));
  console.log("  Kill the TCP connection mid-call. Reconnect. Prove the upstream");
  console.log("  tool was invoked exactly once.");
  console.log(RULE);
  console.log(`  gateway:        ${GATEWAY_URL}`);
  console.log(`  demo-upstream:  ${DEMO_UPSTREAM_URL}`);
  console.log(RULE);
  console.log();

  step(1, TOTAL_STEPS, "connect + initialize (protocol 2025-11-25)");
  const session = await initializeSession(GATEWAY_URL, "resume-demo");
  detail(`session: ${session.sessionId}`);

  step(2, TOTAL_STEPS, `arm demo-upstream — place_order will now sleep ${PLACE_ORDER_DELAY_MS}ms`);
  await setPlaceOrderDelay(control, PLACE_ORDER_DELAY_MS);
  const before = await getStats(control);
  detail(`baseline place_order invocations (this demo-upstream process): ${before.placeOrderInvocations}`);

  step(3, TOTAL_STEPS, 'add_item("batteries" × 1) so the order is not empty');
  const addResult = await callToolAndAwaitResult(session, 2, "grocery__add_item", { item: "batteries", quantity: 1 });
  detail(`-> ${(addResult.result as { content?: Array<{ text?: string }> }).content?.[0]?.text}`);

  step(4, TOTAL_STEPS, "open SSE stream: tools/call place_order(confirm=true)");
  const { req, res } = await openToolCallStream(session, 3, "grocery__place_order", { confirm: true });
  const lastEventId = await readUntilFirstEventId(res);
  detail(`priming event received: ${lastEventId}  <- our resumption checkpoint`);

  console.log();
  console.log(red(RULE));
  step(5, TOTAL_STEPS, red("***  KILLING THE TCP SOCKET NOW  ***"));
  destroyConnection(req, res);
  detail("place_order is still asleep server-side — nothing tied its lifetime to this connection.");
  console.log(red(RULE));
  console.log();

  step(6, TOTAL_STEPS, `RECONNECT: GET /mcp  Last-Event-ID: ${lastEventId}`);
  const seqsReplayed: string[] = [];
  const { req: req2, res: res2 } = await reconnectStream(session, lastEventId);

  step(7, TOTAL_STEPS, "waiting for the result on the resumed stream…");
  const result = await waitForResult(res2, 3, (eventId) => {
    seqsReplayed.push(eventId);
    detail(`replayed event: ${eventId}`);
  });
  destroyConnection(req2, res2);

  const text = (result.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
  step(8, TOTAL_STEPS, `result: ${text ?? `ERROR ${JSON.stringify(result.error)}`}`);

  const after = await getStats(control);
  const delta = after.placeOrderInvocations - before.placeOrderInvocations;
  step(9, TOTAL_STEPS, `place_order invocations after resume: ${after.placeOrderInvocations}`);

  await setPlaceOrderDelay(control, 0);
  await terminateSession(session).catch(() => {});

  const lastSeq = Number(lastEventId.slice(lastEventId.lastIndexOf(":") + 1));
  const noStaleReplay = seqsReplayed.every((id) => Number(id.slice(id.lastIndexOf(":") + 1)) > lastSeq);
  const exactlyOnce = delta === 1;
  const succeeded = result.error === undefined && noStaleReplay && exactlyOnce;

  console.log();
  console.log(RULE);
  console.log(`  ${succeeded ? green(bold("PASS")) : red(bold("FAIL"))}`);
  console.log(
    `  invocations: ${bold(String(delta))}` +
      `  (${before.placeOrderInvocations} → ${after.placeOrderInvocations}` +
      `${exactlyOnce ? ", exactly once — not re-invoked" : ", EXPECTED EXACTLY 1"})`,
  );
  console.log(
    `  replayed events: ${seqsReplayed.length}  ` +
      `(${noStaleReplay ? "all newer than the checkpoint — nothing stale re-delivered" : "STALE EVENT RE-DELIVERED"})`,
  );
  console.log(
    `  elapsed: ${elapsed()}  ` +
      `(kill + resume + a real ${(PLACE_ORDER_DELAY_MS / 1000).toFixed(0)}s server-side wait — ` +
      "nothing was lost)",
  );
  console.log(RULE);

  process.exitCode = succeeded ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(red("resume-demo failed:"), error);
  process.exitCode = 1;
});
