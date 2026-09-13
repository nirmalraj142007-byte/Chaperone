import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGroceryTools } from "./tools.js";

export interface GroceryServer {
  server: McpServer;
  /** Un-tracks this session's `add_item` tool from control.ts's live-session set. */
  dispose: () => void;
}

/**
 * Same `version` on every call — control.ts's mutation never touches it.
 * The scenario this demo exists to show is a tool description changing
 * with nothing else about the connection signalling it.
 */
export function buildGroceryServer(): GroceryServer {
  const server = new McpServer({ name: "chaperone-demo-grocery-upstream", version: "1.0.0" });
  const dispose = registerGroceryTools(server);
  return { server, dispose };
}
