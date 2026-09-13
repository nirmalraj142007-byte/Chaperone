import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { childLogger } from "@chaperone/logger";
import { buildGroceryServer } from "./server.js";
import { controlRouter } from "./control.js";

const log = childLogger({ component: "demo-upstream-http" });

// `StreamableHTTPServerTransport`'s onclose/onerror/onmessage are accessor
// properties whose setters accept `(() => void) | undefined` explicitly —
// wider than the exact-optional `() => void` the `Transport` interface
// requires under this repo's `exactOptionalPropertyTypes`. Verified against
// @modelcontextprotocol/sdk 1.30.0 (server/streamableHttp.d.ts vs
// shared/transport.d.ts); same finding as packages/mcp-app/src/spike-server.ts.
async function connectTransport(transport: StreamableHTTPServerTransport): Promise<() => void> {
  const { server, dispose } = buildGroceryServer();
  await server.connect(transport as Transport);
  return dispose;
}

function jsonRpcBadRequest(res: express.Response): void {
  res
    .status(400)
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null });
}

export function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(controlRouter());

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const disposers = new Map<string, () => void>();

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
          jsonRpcBadRequest(res);
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid !== undefined) {
            transports.delete(sid);
            disposers.get(sid)?.();
            disposers.delete(sid);
          }
        };

        const dispose = await connectTransport(transport);
        if (transport.sessionId !== undefined) {
          disposers.set(transport.sessionId, dispose);
        }
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        log.error({ error }, "failed to handle POST /mcp");
        if (!res.headersSent) {
          res
            .status(500)
            .json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
        }
      }
    })();
  });

  const handleSessionRequest = (req: express.Request, res: express.Response): void => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (transport === undefined) {
      jsonRpcBadRequest(res);
      return;
    }
    transport.handleRequest(req, res).catch((error: unknown) => {
      log.error({ error, method: req.method }, "failed to handle /mcp");
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  return app;
}
