/**
 * Phase 9 — the early-warning system for the ALB idle-timeout risk noted in
 * infra/ (CLAUDE.md: "ECS Fargate + ALB, not App Runner... ALB idle timeout
 * is set to 300s"). Holds one real SSE stream open for ~180s against a real,
 * already-running gateway (`docker compose up -d`; `TARGET=https://<host>/mcp`
 * points this at a deployed environment instead) with periodic progress
 * notifications, and asserts it never disconnects. Run via
 * `pnpm test -- spec/long-stream.test.ts` (see CLAUDE.md's VERIFY commands) —
 * deliberately not part of the default `pnpm spec` run, which is
 * in-process and has no ALB in front of it to test against.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const GATEWAY_URL = process.env["TARGET"] ?? "http://localhost:3000/mcp";

// 36 checkpoints × 5s = 180s of a single held-open SSE stream, each
// checkpoint a real `notifications/progress` — real time, not simulated,
// because the ALB idle-timeout risk this test guards against is itself a
// real-time behaviour (a proxy silently dropping an SSE connection after N
// seconds of it looking idle) that a compressed or mocked clock can't
// exercise.
const CHECKPOINTS = 36;
const TICK_MS = 5_000;
const TOTAL_DURATION_MS = CHECKPOINTS * TICK_MS;

describe("long-lived SSE stream", () => {
  it(
    "stays open for ~180s of periodic progress notifications without disconnecting",
    async () => {
      const transport = new StreamableHTTPClientTransport(new URL(GATEWAY_URL));
      const client = new Client({ name: "long-stream-test", version: "0.0.0" });
      try {
        await client.connect(transport as Transport);
      } catch (error) {
        throw new Error(`could not reach the gateway at ${GATEWAY_URL} — is "docker compose up -d" running? (${String(error)})`);
      }

      const progress: number[] = [];
      const startedAt = Date.now();
      let result: CallToolResult;
      try {
        result = (await client.callTool(
          { name: "grocery__track_delivery", arguments: { checkpoints: CHECKPOINTS, tickMs: TICK_MS } },
          CallToolResultSchema,
          {
            onprogress: (p) => progress.push(p.progress),
            // The SDK client's own request timeout defaults to 60s
            // (`DEFAULT_REQUEST_TIMEOUT_MSEC`, shared/protocol.js) — far
            // short of this test's ~180s call. `resetTimeoutOnProgress`
            // means each of the 36 checkpoints (one every 5s) re-arms it,
            // so what's actually under test is the transport/ALB path, not
            // this client-side ceiling; `timeout` is still raised well
            // past the nominal duration as a backstop.
            timeout: TOTAL_DURATION_MS + 30_000,
            resetTimeoutOnProgress: true,
          },
        )) as CallToolResult;
      } finally {
        await client.close();
      }
      const elapsedMs = Date.now() - startedAt;

      expect(result.isError).toBeUndefined();
      expect(progress).toEqual(Array.from({ length: CHECKPOINTS }, (_, i) => i + 1));
      // Real elapsed time should track the real work done — a generous
      // ±20% band around the nominal duration, not an exact match, since
      // this is asserting "the connection survived the whole thing," not
      // timing precision.
      expect(elapsedMs).toBeGreaterThan(TOTAL_DURATION_MS * 0.8);
      expect(elapsedMs).toBeLessThan(TOTAL_DURATION_MS * 1.5);
    },
    { timeout: TOTAL_DURATION_MS + 60_000 },
  );
});
