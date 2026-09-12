import type { TableLogicalName } from "./tables.js";

export interface KeyAttribute {
  name: string;
  type: "S" | "N";
  keyType: "HASH" | "RANGE";
}

export interface GsiDefinition {
  indexName: string;
  keys: [KeyAttribute, KeyAttribute];
}

export interface TableSchema {
  logicalName: TableLogicalName;
  keys: [KeyAttribute] | [KeyAttribute, KeyAttribute];
  gsi?: GsiDefinition;
  ttlAttribute?: string;
}

/**
 * One entry per table, driving both `scripts/migrate.ts` (CreateTable +
 * UpdateTimeToLive) and this package's own repos, which must address the
 * same key names. DynamoDB only requires AttributeDefinitions for
 * attributes that appear in a KeySchema — everything else stored is
 * schemaless, which is why these lists are short relative to each repo's
 * full item shape.
 */
export const TABLE_SCHEMAS: readonly TableSchema[] = [
  {
    logicalName: "corpus-server",
    keys: [{ name: "serverId", type: "S", keyType: "HASH" }],
    gsi: {
      indexName: "GSI1",
      keys: [
        { name: "bootStatus", type: "S", keyType: "HASH" },
        { name: "serverId", type: "S", keyType: "RANGE" },
      ],
    },
  },
  {
    logicalName: "tool-snapshot",
    keys: [
      { name: "pk", type: "S", keyType: "HASH" },
      { name: "sk", type: "S", keyType: "RANGE" },
    ],
    gsi: {
      indexName: "GSI1",
      keys: [
        { name: "crawlId", type: "S", keyType: "HASH" },
        { name: "capSort", type: "S", keyType: "RANGE" },
      ],
    },
  },
  {
    logicalName: "drift-record",
    keys: [
      { name: "pk", type: "S", keyType: "HASH" },
      { name: "sk", type: "S", keyType: "RANGE" },
    ],
    gsi: {
      indexName: "GSI1",
      keys: [
        { name: "changeClass", type: "S", keyType: "HASH" },
        { name: "capabilityClass", type: "S", keyType: "RANGE" },
      ],
    },
  },
  {
    logicalName: "pin",
    keys: [
      { name: "pk", type: "S", keyType: "HASH" },
      { name: "sk", type: "S", keyType: "RANGE" },
    ],
  },
  {
    logicalName: "ledger-event",
    keys: [
      { name: "pk", type: "S", keyType: "HASH" },
      { name: "sk", type: "S", keyType: "RANGE" },
    ],
    gsi: {
      indexName: "GSI1",
      keys: [
        { name: "type", type: "S", keyType: "HASH" },
        { name: "sk", type: "S", keyType: "RANGE" },
      ],
    },
  },
  {
    logicalName: "quarantine",
    keys: [
      { name: "pk", type: "S", keyType: "HASH" },
      { name: "sk", type: "S", keyType: "RANGE" },
    ],
    gsi: {
      indexName: "GSI1",
      keys: [
        { name: "status", type: "S", keyType: "HASH" },
        { name: "advisoryScoreSort", type: "S", keyType: "RANGE" },
      ],
    },
  },
  {
    logicalName: "session",
    keys: [{ name: "sessionId", type: "S", keyType: "HASH" }],
    ttlAttribute: "ttl",
  },
  {
    logicalName: "sse-event",
    keys: [
      { name: "pk", type: "S", keyType: "HASH" },
      { name: "seq", type: "N", keyType: "RANGE" },
    ],
    ttlAttribute: "ttl",
  },
  {
    logicalName: "advisory",
    keys: [{ name: "pk", type: "S", keyType: "HASH" }],
  },
];
