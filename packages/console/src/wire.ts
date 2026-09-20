/**
 * The wire log: every request this console makes, as it happens — method,
 * path, status, wall-clock latency, and the gateway's own `X-Request-Id`
 * (the same ID bound into the gateway's structured log line for that
 * request, so a judge can grep one against the other). MCP traffic from the
 * approve path is logged per HTTP hop with its JSON-RPC method.
 *
 * A tiny external store for `useSyncExternalStore`, not a state library.
 */
import { useSyncExternalStore } from "react";

export interface WireEntry {
  id: number;
  at: number;
  channel: "api" | "mcp";
  method: string;
  path: string;
  /** JSON-RPC method(s) carried by this hop, for MCP traffic. */
  rpc?: string;
  status?: number;
  ms?: number;
  requestId?: string;
  error?: string;
}

const MAX_ENTRIES = 60;
let entries: WireEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function wireStart(entry: Omit<WireEntry, "id" | "at">): number {
  const id = nextId++;
  entries = [...entries.slice(-(MAX_ENTRIES - 1)), { ...entry, id, at: Date.now() }];
  emit();
  return id;
}

export function wireFinish(
  id: number,
  patch: { [K in "status" | "ms" | "requestId" | "error"]?: WireEntry[K] | undefined },
): void {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<WireEntry>;
  entries = entries.map((e) => (e.id === id ? { ...e, ...defined } : e));
  emit();
}

/**
 * Clears the log. The wire is a module-level store, so without this the
 * snapshot suite's entry count would depend on how many tests had already
 * run — and a snapshot that changes with test order is a flaky snapshot.
 * Not reachable from the UI: there is no control that clears the wire,
 * deliberately, because the wire is the console's own audit of itself.
 */
export function wireReset(): void {
  entries = [];
  nextId = 1;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWire(): WireEntry[] {
  return useSyncExternalStore(subscribe, () => entries);
}

/** The JSON-RPC method names in an MCP POST body, e.g. "initialize" or "tools/call chaperone/approve_change". */
export function rpcLabel(body: unknown): string | undefined {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const labels = messages.map((m) => {
      const msg = m as { method?: string; params?: { name?: string }; result?: unknown };
      if (msg.method === undefined) {
        return "response";
      }
      return msg.method === "tools/call" && msg.params?.name !== undefined ? `tools/call ${msg.params.name}` : msg.method;
    });
    return labels.join(", ");
  } catch {
    return undefined;
  }
}
