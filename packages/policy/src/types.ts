export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export type CapabilityClass = "read" | "write" | "transact" | "communicate";

export type ChangeClass =
  | "cosmetic"
  | "schema-additive"
  | "semantic-intent"
  | "tool-added"
  | "tool-removed";
