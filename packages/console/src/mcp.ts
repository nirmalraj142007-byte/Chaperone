/**
 * The console's only write: `chaperone/approve_change`, called over the
 * gateway's real `/mcp` endpoint as an ordinary MCP client — the same
 * token-checked path the consent card uses (packages/gateway/src/approve.ts).
 * The console holds no credential of its own; the resident supplies the
 * one-time token from the consent card, and a consumed or expired token is
 * rejected by the gateway exactly as it would be from the card.
 *
 * SDK surface checked against the installed @modelcontextprotocol/sdk
 * 1.30.0 type definitions (client/streamableHttp.d.ts, client/index.d.ts):
 * `new StreamableHTTPClientTransport(url, { fetch })` accepts a custom
 * `FetchLike`, used here to log each HTTP hop to the wire;
 * `Client.connect()` runs initialize + notifications/initialized itself;
 * `transport.terminateSession()` sends the DELETE that ends the session.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { rpcLabel, wireFinish, wireStart } from "./wire";

export type Decision = "approve" | "block";

export interface ApproveStep {
  label: string;
  ms: number;
}

export interface ApproveOutcome {
  ok: boolean;
  /** The gateway's own result text, verbatim. */
  text: string;
}

const loggingFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const rpc = method === "POST" ? rpcLabel(init?.body) : method === "DELETE" ? "session end" : "sse stream";
  const started = performance.now();
  const id = wireStart({ channel: "mcp", method, path: url.pathname, ...(rpc !== undefined ? { rpc } : {}) });
  try {
    const res = await fetch(input, init);
    wireFinish(id, {
      status: res.status,
      ms: Math.round(performance.now() - started),
      requestId: res.headers.get("x-request-id") ?? undefined,
    });
    return res;
  } catch (error) {
    // The SDK aborts its standalone SSE GET when the session is terminated — that is the
    // stream closing on purpose, not a failure, and the wire shouldn't paint it red.
    const aborted = error instanceof DOMException && error.name === "AbortError";
    wireFinish(id, { ms: Math.round(performance.now() - started), error: aborted ? "closed" : "network error" });
    throw error;
  }
};

export async function approveChange(
  quarantineId: string,
  approvalToken: string,
  decision: Decision,
  onStep: (step: ApproveStep) => void,
): Promise<ApproveOutcome> {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", window.location.href), { fetch: loggingFetch });
  const client = new Client({ name: "chaperone-console", version: "0.0.0" });

  let t = performance.now();
  const lap = (label: string): void => {
    const now = performance.now();
    onStep({ label, ms: Math.round(now - t) });
    t = now;
  };

  try {
    // The SDK's transport classes declare `sessionId?: string` without
    // `| undefined`, which fails `Transport` under exactOptionalPropertyTypes —
    // the same SDK 1.30.0 finding as packages/gateway/src/session.ts (see
    // friction-log.md), handled the same way.
    await client.connect(transport as Transport);
    lap("initialize → session open");
    const result = await client.callTool({
      name: "chaperone/approve_change",
      arguments: { quarantineId, approvalToken, decision },
    });
    lap(`tools/call chaperone/approve_change (${decision})`);
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((c) => (typeof c === "object" && c !== null && (c as { type?: string }).type === "text" ? (c as { text: string }).text : ""))
      .join("\n");
    return { ok: result.isError !== true, text };
  } finally {
    try {
      await transport.terminateSession();
      lap("session closed");
    } catch {
      // Best effort: the gateway's session TTL reaps an unterminated session.
    }
    await client.close().catch(() => undefined);
  }
}
