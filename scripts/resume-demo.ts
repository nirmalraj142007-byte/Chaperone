/**
 * `pnpm resume-demo` — a single, verbose kill-and-resume, meant to be
 * screen-recorded for the demo's 20-second resumability beat (see
 * CLAUDE.md's ALB-idle-timeout / Fargate note and the proposal's 90-second
 * script). Exercises the exact same real gateway + real demo-upstream +
 * real DynamoDB path spec/resumption.test.ts's 10-iteration loop does, just
 * once, with every step narrated to stdout instead of asserted silently.
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

function log(step: string, detail?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  if (detail !== undefined) {
    console.log(`[${ts}] ${step}`, detail);
  } else {
    console.log(`[${ts}] ${step}`);
  }
}

function seqOf(eventId: string): number {
  return Number(eventId.slice(eventId.lastIndexOf(":") + 1));
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("Chaperone resumable-SSE demo: kill the connection mid-call, resume it,");
  console.log("prove the upstream was only ever invoked once.");
  console.log(`gateway:       ${GATEWAY_URL}`);
  console.log(`demo-upstream: ${DEMO_UPSTREAM_URL}`);
  console.log("=".repeat(72));

  log("1/9  connecting and negotiating protocol 2025-11-25…");
  const session = await initializeSession(GATEWAY_URL, "resume-demo");
  log("     session established", { sessionId: session.sessionId });

  log("2/9  arming demo-upstream: place_order will now take 4s to respond…");
  await setPlaceOrderDelay(control, PLACE_ORDER_DELAY_MS);

  const before = await getStats(control);
  log("     baseline place_order invocation count", before.placeOrderInvocations);

  log("3/9  add_item(batteries × 1) so the order isn't empty…");
  const addResult = await callToolAndAwaitResult(session, 2, "grocery__add_item", { item: "batteries", quantity: 1 });
  log("     ", (addResult.result as { content?: Array<{ text?: string }> }).content?.[0]?.text);

  log("4/9  opening tools/call stream: place_order(confirm=true)…");
  const { req, res } = await openToolCallStream(session, 3, "grocery__place_order", { confirm: true });

  const lastEventId = await readUntilFirstEventId(res);
  log("     priming event received — this is our resumption checkpoint", { lastEventId });

  log("5/9  *** KILLING THE TCP SOCKET NOW *** (place_order is still sleeping server-side)");
  destroyConnection(req, res);
  log("     socket destroyed. Server-side handler keeps running — nothing tied its lifetime to this connection.");

  log("6/9  reconnecting: GET /mcp with Last-Event-ID", lastEventId);
  const seqsReplayed: number[] = [];
  const { req: req2, res: res2 } = await reconnectStream(session, lastEventId);

  log("7/9  waiting for the result to arrive on the resumed stream…");
  const result = await waitForResult(res2, 3, (eventId) => {
    seqsReplayed.push(seqOf(eventId));
    log("     replayed event", eventId);
  });
  destroyConnection(req2, res2);

  const text = (result.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
  log("8/9  result", text ?? JSON.stringify(result.error));

  const after = await getStats(control);
  log("9/9  place_order invocation count after resume", after.placeOrderInvocations);

  await setPlaceOrderDelay(control, 0);
  await terminateSession(session).catch(() => {});

  const lastSeq = seqOf(lastEventId);
  const noStaleReplay = seqsReplayed.every((seq) => seq > lastSeq);
  const exactlyOnce = after.placeOrderInvocations === before.placeOrderInvocations + 1;
  const succeeded = result.error === undefined && noStaleReplay && exactlyOnce;

  console.log("=".repeat(72));
  if (succeeded) {
    console.log(`RESULT: PASS — resumed cleanly, ${seqsReplayed.length} event(s) replayed, place_order invoked exactly once.`);
  } else {
    console.log("RESULT: FAIL", { error: result.error, noStaleReplay, exactlyOnce });
  }
  console.log("=".repeat(72));

  process.exitCode = succeeded ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error("resume-demo failed:", error);
  process.exitCode = 1;
});
