import { loadConfig } from "@chaperone/config";

export const TABLE_LOGICAL_NAMES = [
  "corpus-server",
  "tool-snapshot",
  "drift-record",
  "pin",
  "ledger-event",
  "quarantine",
  "session",
  "sse-event",
  "advisory",
] as const;

export type TableLogicalName = (typeof TABLE_LOGICAL_NAMES)[number];

export function tableName(logical: TableLogicalName): string {
  const { ddbTablePrefix } = loadConfig();
  return `${ddbTablePrefix}-${logical}`;
}
