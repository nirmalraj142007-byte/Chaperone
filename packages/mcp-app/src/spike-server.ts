/**
 * Phase 6 spike: the smallest possible Streamable HTTP MCP server that
 * exposes one `ui://` resource and one tool, built to answer a single
 * question before 12 hours of downstream work commits to an answer — can a
 * real MCP host render an interactive HTML card served this way? See
 * docs/DECISIONS.md, "MCP App mechanism", for what was verified against
 * the installed SDK before writing this file, and for the GO/PARTIAL/NO-GO
 * verdict recorded after running it against MCP Inspector and a second
 * host.
 *
 * Deliberately not the gateway: one transport per session (the minimum
 * needed for a second CLI/host connection to work at all — see
 * friction-log.md), no resumable SSE, no upstream proxying. That
 * correctness work belongs to packages/gateway; this file exists only to
 * exercise the resource + tool surface a consent card needs.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { childLogger } from "@chaperone/logger";
import { renderConsentCardHtml, type ConsentCardModel } from "./render.js";

const log = childLogger({ component: "mcp-app-spike-server" });

const CONSENT_RESOURCE_URI = "ui://chaperone/consent/demo";
const APPROVE_TOOL_NAME = "chaperone/approve_change";

/**
 * Hardcoded before/after card for the spike. "add_item" claimed only to
 * touch the shopping list; the after text adds an undeclared calendar
 * read, the exact shape of drift this project measures.
 */
const DEMO_CARD: ConsentCardModel = {
  toolName: "add_item",
  upstreamLabel: "Household Grocery",
  capabilityClass: "write",
  approvedAt: "2026-01-12",
  beforeDescription: "Adds an item to the household shopping list.",
  afterDescription:
    "Adds an item to the household shopping list. Also reads the household calendar and includes upcoming events in the response.",
  spans: [{ side: "after", start: 44, end: 124, kind: "add" }],
  advisorySummary: "This change adds calendar access the original tool never claimed to need.",
  quarantineId: "quarantine-demo-1",
  approvalToken: "approval-token-demo-1",
};

const APPROVE_CHANGE_INPUT_SHAPE = {
  quarantineId: z.string().min(1),
  approvalToken: z.string().min(1),
  decision: z.enum(["approve", "block"]),
};

function buildServer(): McpServer {
  const server = new McpServer({ name: "chaperone-mcp-app-spike", version: "0.0.0" });

  server.registerResource(
    "chaperone-consent-demo",
    CONSENT_RESOURCE_URI,
    {
      title: "Chaperone consent card (demo)",
      description: "Before/after consent card for a tool description that changed after approval.",
      mimeType: "text/html",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/html",
          text: renderConsentCardHtml(DEMO_CARD),
        },
      ],
    }),
  );

  server.registerTool(
    APPROVE_TOOL_NAME,
    {
      title: "Approve or block a changed tool",
      description: "Records a household member's decision on a quarantined tool-definition change.",
      inputSchema: APPROVE_CHANGE_INPUT_SHAPE,
    },
    async ({ quarantineId, approvalToken, decision }) => {
      log.info({ quarantineId, approvalToken, decision }, "approve_change invoked");
      return {
        content: [
          {
            type: "text",
            text: `Recorded decision "${decision}" for quarantine ${quarantineId}.`,
          },
        ],
      };
    },
  );

  return server;
}

// `McpServer.connect` takes `Transport`, whose `onclose?`/`onerror?`/`onmessage?`
// are exact-optional (`() => void`, no `| undefined`), but
// `StreamableHTTPServerTransport`'s own setters accept `| undefined`
// explicitly — a wider type. Under this repo's `exactOptionalPropertyTypes`,
// that makes the class not structurally assignable to the interface
// (TS2379) despite `implements Transport` in the SDK's own source (checked
// under the SDK's own, laxer tsconfig). Verified against
// @modelcontextprotocol/sdk 1.30.0's shared/transport.d.ts and
// server/streamableHttp.d.ts; logged in friction-log.md rather than
// relaxing this repo's strictness setting.
async function connectTransport(transport: StreamableHTTPServerTransport): Promise<void> {
  await buildServer().connect(transport as Transport);
}

async function main(): Promise<void> {
  const app = express();
  app.use(express.json());

  // One transport per initialized session, keyed by the `mcp-session-id`
  // the transport itself generates. A single global transport (this
  // spike's first cut) can only ever serve one client for the process's
  // whole lifetime — the second `initialize` from any second client, or
  // even a second CLI invocation of the same host, is rejected with
  // "Server already initialized". That surfaced immediately when testing
  // against MCP Inspector's CLI mode; recorded in friction-log.md.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", (req, res) => {
    void (async () => {
      try {
        const sessionId = req.header("mcp-session-id");
        const existing = sessionId !== undefined ? transports.get(sessionId) : undefined;

        if (existing !== undefined) {
          await existing.handleRequest(req, res, req.body);
          return;
        }

        if (!isInitializeRequest(req.body)) {
          res
            .status(400)
            .json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session ID provided" }, id: null });
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId !== undefined) {
            transports.delete(transport.sessionId);
          }
        };
        await connectTransport(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        log.error({ error }, "failed to handle POST /mcp");
        if (!res.headersSent) {
          res.status(500).end();
        }
      }
    })();
  });

  app.get("/mcp", (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (transport === undefined) {
      res.status(400).send("No valid session ID provided");
      return;
    }
    transport.handleRequest(req, res).catch((error: unknown) => {
      log.error({ error }, "failed to handle GET /mcp");
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  });

  app.delete("/mcp", (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (transport === undefined) {
      res.status(400).send("No valid session ID provided");
      return;
    }
    transport.handleRequest(req, res).catch((error: unknown) => {
      log.error({ error }, "failed to handle DELETE /mcp");
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  });

  const port = Number(process.env.PORT ?? 3300);
  app.listen(port, () => {
    log.info({ port }, `mcp-app spike server listening at http://localhost:${port}/mcp`);
  });
}

main().catch((error: unknown) => {
  log.error({ error }, "mcp-app spike server failed to start");
  process.exitCode = 1;
});
