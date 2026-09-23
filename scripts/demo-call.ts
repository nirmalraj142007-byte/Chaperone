/**
 * `pnpm demo:call [tool] [key=value ...]` — a bare MCP client for the demo.
 * With no arguments it lists the tools the gateway currently offers; with a
 * tool name it calls it and prints what came back, block by block.
 *
 *   pnpm demo:call
 *   pnpm demo:call grocery__add_item item=batteries quantity=2
 *
 * key=value rather than JSON because a JSON argument's quotes do not survive
 * every shell it might be typed into on camera. A value that parses as a
 * number or boolean is sent as one.
 *
 * `TARGET=https://<host>/mcp` points it at a deployed gateway.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const TARGET = process.env["TARGET"] ?? "http://localhost:3000/mcp";

function parseArgs(pairs: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) {
      throw new Error(`expected key=value, got "${pair}"`);
    }
    const raw = pair.slice(at + 1);
    args[pair.slice(0, at)] = /^(-?\d+(\.\d+)?|true|false)$/.test(raw) ? (JSON.parse(raw) as unknown) : raw;
  }
  return args;
}

async function main(): Promise<void> {
  const [tool, ...pairs] = process.argv.slice(2);
  const client = new Client({ name: "demo-call", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(TARGET)) as Transport);
  try {
    if (tool === undefined) {
      for (const t of (await client.listTools()).tools) {
        console.log(`${t.name}\n    ${t.description ?? "(no description)"}`);
      }
      return;
    }
    const result = await client.callTool({ name: tool, arguments: parseArgs(pairs) });
    console.log(result.isError === true ? "isError: true" : "isError: false");
    for (const block of (result.content as Array<{ type: string; text?: string; resource?: { uri: string; mimeType?: string } }>) ?? []) {
      if (block.type === "text") {
        console.log(`\n${block.text ?? ""}`);
      } else if (block.type === "resource" && block.resource !== undefined) {
        console.log(`\n[resource ${block.resource.uri} (${block.resource.mimeType ?? "unknown type"}) — the HTML card, for a host that renders it]`);
      }
    }
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error("demo:call: failed —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
