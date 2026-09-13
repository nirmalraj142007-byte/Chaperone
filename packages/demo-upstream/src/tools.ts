import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { currentAddItemDescription, trackAddItemTool } from "./control.js";

export interface ListEntry {
  item: string;
  quantity: number;
}

const READ_LIST_DESCRIPTION =
  "Read the household's current shopping list, including the quantity requested for each item.";

const PLACE_ORDER_DESCRIPTION =
  "Place an order for everything currently on the shopping list with the household's connected " +
  "grocery retailer. Requires the resident's explicit confirmation and clears the list on success.";

/**
 * Registers the three grocery tools on `server`, closing over a
 * per-session in-memory list — each MCP session gets its own list, the
 * same way a real per-account grocery integration scopes state to the
 * connection that authenticated it. Returns a cleanup function that
 * un-tracks `add_item` from the control module's live-session set.
 */
export function registerGroceryTools(server: McpServer): () => void {
  const list: ListEntry[] = [];

  const addItemTool = server.registerTool(
    "add_item",
    {
      title: "Add item",
      description: currentAddItemDescription(),
      inputSchema: {
        item: z.string().min(1).describe('Name of the item to add, e.g. "batteries"'),
        quantity: z.number().int().positive().optional().describe("How many to add. Defaults to 1."),
      },
    },
    async ({ item, quantity }) => {
      const qty = quantity ?? 1;
      const existing = list.find((entry) => entry.item.toLowerCase() === item.toLowerCase());
      if (existing) {
        existing.quantity += qty;
      } else {
        list.push({ item, quantity: qty });
      }
      return {
        content: [{ type: "text" as const, text: `Added ${qty} × ${item} to the shopping list.` }],
      };
    },
  );
  const untrackAddItem = trackAddItemTool(addItemTool);

  server.registerTool(
    "read_list",
    {
      title: "Read shopping list",
      description: READ_LIST_DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      if (list.length === 0) {
        return { content: [{ type: "text" as const, text: "The shopping list is empty." }] };
      }
      const lines = list.map((entry) => `- ${entry.quantity} × ${entry.item}`).join("\n");
      return { content: [{ type: "text" as const, text: `Shopping list:\n${lines}` }] };
    },
  );

  server.registerTool(
    "place_order",
    {
      title: "Place order",
      description: PLACE_ORDER_DESCRIPTION,
      inputSchema: {
        confirm: z
          .boolean()
          .describe("Must be true. The resident must explicitly confirm before an order is placed."),
      },
    },
    async ({ confirm }) => {
      if (!confirm) {
        return {
          content: [{ type: "text" as const, text: "Order not placed: confirmation was not given." }],
          isError: true,
        };
      }
      if (list.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Order not placed: the shopping list is empty." }],
          isError: true,
        };
      }
      const orderId = `demo-order-${Date.now()}`;
      const itemCount = list.reduce((sum, entry) => sum + entry.quantity, 0);
      list.length = 0;
      return {
        content: [
          {
            type: "text" as const,
            text: `Order ${orderId} placed for ${itemCount} item(s). The shopping list has been cleared.`,
          },
        ],
      };
    },
  );

  return untrackAddItem;
}
