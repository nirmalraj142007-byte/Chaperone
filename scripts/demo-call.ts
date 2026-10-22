/**
 * `pnpm demo:call [tool] [key=value ...]` — a bare MCP client for the demo.
 * With no arguments it lists the tools the gateway currently offers; with a
 * tool name it calls it and prints what came back, block by block.
 *
 *   pnpm demo:call
 *   pnpm demo:call grocery__add_item item=batteries quantity=2
 *   pnpm demo:call grocery__add_item item=batteries --press=approve
 *
 * `--press=approve` (or `=block`) plays the part of the resident's card
 * host: if the call comes back held, it takes the quarantine id and
 * one-time token from the HTML card (the only place a token appears; the
 * text card is model-visible and carries none) and calls
 * `chaperone/approve_change` with them, as the card's button would. It
 * never prints the token.
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
import { approvalsFromCardHtml } from "@chaperone/mcp-app";

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
  const argv = process.argv.slice(2);
  const pressFlag = argv.find((a) => a.startsWith("--press="));
  const press = pressFlag?.slice("--press=".length);
  if (press !== undefined && press !== "approve" && press !== "block") {
    throw new Error(`--press must be "approve" or "block", got "${press}"`);
  }
  const [tool, ...pairs] = argv.filter((a) => a !== pressFlag);
  const client = new Client({ name: "demo-call", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(TARGET)) as Transport);
  try {
    if (tool === undefined) {
      for (const t of (await client.listTools()).tools) {
        // `_meta.ui.visibility: ["app"]` (ext-apps): a host shows this tool to the card, not to its model.
        const visibility = (t._meta?.["ui"] as { visibility?: unknown } | undefined)?.visibility;
        const appOnly = Array.isArray(visibility) && visibility.length === 1 && visibility[0] === "app";
        console.log(`${t.name}${appOnly ? "    [app-only: the consent card calls it; a host hides it from its model]" : ""}\n    ${t.description ?? "(no description)"}`);
      }
      return;
    }
    const result = await client.callTool({ name: tool, arguments: parseArgs(pairs) });
    console.log(result.isError === true ? "isError: true" : "isError: false");
    const content = (result.content as Array<{ type: string; text?: string; resource?: { uri: string; mimeType?: string; text?: string } }>) ?? [];
    for (const block of content) {
      if (block.type === "text") {
        console.log(`\n${block.text ?? ""}`);
      } else if (block.type === "resource" && block.resource !== undefined) {
        console.log(`\n[resource ${block.resource.uri} (${block.resource.mimeType ?? "unknown type"}) — the HTML card, for a host that renders it]`);
      }
    }
    if (press !== undefined) {
      const html = content.find((b) => b.type === "resource")?.resource?.text ?? "";
      const [approval] = approvalsFromCardHtml(html);
      if (approval === undefined) {
        throw new Error("--press: the result carried no undecided HTML card to press a button on");
      }
      const decided = await client.callTool({
        name: "chaperone/approve_change",
        arguments: { quarantineId: approval.quarantineId, approvalToken: approval.approvalToken, decision: press },
      });
      console.log(`\n[pressed ${press === "approve" ? "Approve" : "Keep blocked"} on the card — chaperone/approve_change]`);
      for (const block of (decided.content as Array<{ type: string; text?: string }>) ?? []) {
        if (block.type === "text") console.log(block.text ?? "");
      }
      if (decided.isError === true) process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error("demo:call: failed —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
