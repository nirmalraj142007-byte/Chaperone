/**
 * Response shapes of the gateway's `/api/*` routes (packages/gateway/src/api.ts).
 * Mirrored rather than imported: the gateway is a NodeNext build and this
 * is a browser bundle; a type-only mirror is cheaper than a shared package
 * for five read-only shapes. If one drifts, the screen that reads it breaks
 * visibly in dev — and api.test.ts in the gateway pins the server side.
 */
export type ReviewState = "pending" | "expired" | "approved" | "refused";
export type CapabilityClass = "read" | "write" | "transact" | "communicate";

export interface QueueRow {
  quarantineId: string;
  toolName: string;
  upstreamId: string;
  upstreamLabel: string;
  capabilityClass: CapabilityClass | string;
  detectedAt: string;
  resolvedAt?: string;
  reviewState: ReviewState;
  advisory: { score: number; modelId: string } | null;
}

export interface QueueResponse {
  items: QueueRow[];
  total: number;
}

export interface DiffSpan {
  side: "before" | "after";
  start: number;
  end: number;
  kind: "add" | "remove";
}

export interface LedgerEvent {
  index: number;
  sk: string;
  ts: string;
  type: string;
  actor: string;
  eventHash: string;
  prevEventHash: string;
  payload: Record<string, unknown>;
}

export interface ToolText {
  name?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface Advisory {
  quarantineId: string;
  score: number;
  summary: string;
  modelId: string;
  generatedAt: string;
  promptSha: string;
}

export interface QuarantineDetail extends Omit<QueueRow, "advisory"> {
  tokenExpiresAt: string;
  tokenHeld: boolean;
  fromHash: string;
  toHash: string;
  before: ToolText;
  after: ToolText;
  diffSpans: DiffSpan[];
  pinnedVersion: { hash: string; approvedAt: string; approvedBy: string; eventSk?: string } | null;
  advisory: Advisory | null;
  events: LedgerEvent[];
}

export interface LedgerResponse {
  events: LedgerEvent[];
  total: number;
}

export type VerifyResponse =
  | { ok: true; count: number }
  | { ok: false; index: number; brokenSk: string; reason: "hash" | "link" | "unhashed"; expected: string; actual: string };

export interface UpstreamsResponse {
  householdId: string;
  upstreams: Array<{ id: string; label: string; pinnedTools: number; pendingReview: number }>;
}
