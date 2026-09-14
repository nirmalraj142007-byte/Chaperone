/**
 * Phase 9 — resumable SSE, run by root script `pnpm test:resume`.
 *
 * Unlike spec/conformance.spec.test.ts (which builds the gateway and
 * demo-upstream in-process, with @chaperone/ledger mocked), this suite
 * talks to a *real* gateway, a real demo-upstream, and real DynamoDB over
 * the network — event-store.ts's exactly-once and replay guarantees are
 * only meaningful proven against real, independent processes: an
 * in-process mock can't demonstrate that a TCP-level socket kill leaves the
 * server-side `tools/call` running, only that our own mock behaves how we
 * told it to. Requires `docker compose up -d` (ddb, demo-upstream, gateway)
 * already running — `TARGET=https://<host>/mcp` (see CLAUDE.md) points this
 * at a deployed environment instead of localhost.
 *
 * The raw HTTP client in spec/lib/rawMcpClient.ts exists specifically
 * because @modelcontextprotocol/sdk's own `StreamableHTTPClientTransport`
 * reconnects over `fetch()`, which never exposes the underlying socket —
 * there is no supported way to kill it "at the TCP level" through the SDK
 * client.
 *
 * Deliberately 10 *independent* `it()` cases, not one test with a `for`
 * loop inside it. A single test that loops internally reports one pass/
 * fail for the whole run — a reader has to trust the loop actually
 * executed 10 times and can't see individual iteration results without
 * re-running with extra instrumentation. Ten separate cases give ten
 * separate, independently-scored results in the reporter output, and each
 * one prints its own invocation-count evidence (`--reporter=verbose` on
 * the `test:resume` script) regardless of whether it passes or fails, so a
 * reader never has to take "10/10" on faith.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
} from "./lib/rawMcpClient.js";

const GATEWAY_URL = process.env["TARGET"] ?? "http://localhost:3000/mcp";
const DEMO_UPSTREAM_URL = process.env["DEMO_UPSTREAM_URL"] ?? "http://localhost:4000";
const control: DemoUpstreamControl = { baseUrl: DEMO_UPSTREAM_URL };
const PLACE_ORDER_DELAY_MS = 4_000;
const ITERATIONS = 10;

function seqOf(eventId: string): number {
  const idx = eventId.lastIndexOf(":");
  const seq = Number(eventId.slice(idx + 1));
  if (idx === -1 || !Number.isFinite(seq)) {
    throw new Error(`event ID "${eventId}" is not in the {streamId}:{seq} shape event-store.ts mints`);
  }
  return seq;
}

beforeAll(async () => {
  await setPlaceOrderDelay(control, 0);
});

afterAll(async () => {
  await setPlaceOrderDelay(control, 0);
});

describe("resumable SSE: kill-and-resume, 10 independent iterations", () => {
  for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
    it(
      `iteration ${iteration}/${ITERATIONS}: TCP-level socket kill mid-call, resume, place_order invoked exactly once`,
      async () => {
        const session = await initializeSession(GATEWAY_URL, `resumption-test-${iteration}`);
        try {
          await setPlaceOrderDelay(control, PLACE_ORDER_DELAY_MS);
          const before = await getStats(control);

          await callToolAndAwaitResult(session, 2, "grocery__add_item", { item: "batteries", quantity: 1 });

          const { req, res } = await openToolCallStream(session, 3, "grocery__place_order", { confirm: true });
          const lastEventId = await readUntilFirstEventId(res);
          const lastSeq = seqOf(lastEventId);

          // Kill the connection carrying this call's SSE stream at the TCP
          // level, mid-call — the 4s delay set above guarantees the
          // handler is still awaiting `sleep(delayMs)` server-side.
          destroyConnection(req, res);

          const seqsSeenOnReplay: number[] = [];
          const { req: req2, res: res2 } = await reconnectStream(session, lastEventId);
          const result = await waitForResult(res2, 3, (eventId) => {
            seqsSeenOnReplay.push(seqOf(eventId));
          });
          destroyConnection(req2, res2);

          const after = await getStats(control);
          const delta = after.placeOrderInvocations - before.placeOrderInvocations;

          // Printed unconditionally — pass or fail — so the evidence this
          // task asked for ("the actual iteration count and the
          // invocation counter reading for each") is in the transcript
          // without needing to re-run anything, and a failure doesn't have
          // to be reproduced just to see what actually happened.
          console.log(
            `[resumption ${iteration}/${ITERATIONS}] lastEventId=${lastEventId} ` +
              `replayedSeqs=[${seqsSeenOnReplay.join(",")}] ` +
              `placeOrderInvocations: before=${before.placeOrderInvocations} after=${after.placeOrderInvocations} delta=${delta}`,
          );

          expect(result.error, `iteration ${iteration}: place_order returned an error: ${JSON.stringify(result.error)}`).toBeUndefined();
          const content = (result.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
          expect(content?.[0]?.text).toMatch(/Order demo-order-\d+ placed/);

          // No event with seq <= N was re-delivered on the resumed stream.
          for (const seq of seqsSeenOnReplay) {
            expect(seq, `iteration ${iteration}: replayed a stale event (seq ${seq} <= last-seen seq ${lastSeq})`).toBeGreaterThan(lastSeq);
          }

          expect(delta, `iteration ${iteration}: expected exactly one place_order invocation`).toBe(1);
        } finally {
          await terminateSession(session).catch(() => {});
        }
      },
      { timeout: 20_000 },
    );
  }
});
