/**
 * Read path: GET-only JSON from the gateway's `/api/*`, every call logged to
 * the wire. There is no write function in this file by design — the one
 * mutating action lives in mcp.ts and goes through the gateway's
 * token-checked `chaperone/approve_change`.
 */
import { useQuery } from "@tanstack/react-query";
import { wireFinish, wireStart } from "./wire";
import type {
  LedgerResponse,
  QuarantineDetail,
  QueueResponse,
  ReviewState,
  UpstreamsResponse,
  VerifyResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Parsed JSON body, when the gateway sent one (verify's 503 carries `ok:false`). */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const started = performance.now();
  const id = wireStart({ channel: "api", method: "GET", path });
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: "application/json" } });
  } catch {
    wireFinish(id, { ms: Math.round(performance.now() - started), error: "unreachable" });
    throw new ApiError(0, "The gateway is unreachable.", undefined);
  }
  const ms = Math.round(performance.now() - started);
  const requestId = res.headers.get("x-request-id") ?? undefined;
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  wireFinish(id, { status: res.status, ms, requestId });
  if (!res.ok) {
    const message = (body as { message?: string } | undefined)?.message ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export type QueueFilter = ReviewState | "all";

export const queryKeys = {
  queue: (status: QueueFilter) => ["quarantine", "list", status] as const,
  quarantine: (id: string) => ["quarantine", "detail", id] as const,
  ledger: (type: string) => ["ledger", "list", type] as const,
  verify: ["ledger", "verify"] as const,
  upstreams: ["upstreams"] as const,
};

const LIVE_MS = 15_000;

export function useQueue(status: QueueFilter) {
  return useQuery({
    queryKey: queryKeys.queue(status),
    queryFn: () => getJson<QueueResponse>(`/api/quarantine${status === "all" ? "" : `?status=${status}`}`),
    refetchInterval: LIVE_MS,
  });
}

export function useQuarantine(id: string) {
  return useQuery({
    queryKey: queryKeys.quarantine(id),
    queryFn: () => getJson<QuarantineDetail>(`/api/quarantine/${encodeURIComponent(id)}`),
  });
}

export function useLedger(type: string) {
  return useQuery({
    queryKey: queryKeys.ledger(type),
    queryFn: () => getJson<LedgerResponse>(`/api/ledger${type === "all" ? "" : `?type=${encodeURIComponent(type)}`}`),
    refetchInterval: LIVE_MS,
  });
}

export function useVerify() {
  return useQuery({
    queryKey: queryKeys.verify,
    queryFn: () => getJson<VerifyResponse>("/api/ledger/verify"),
    refetchInterval: LIVE_MS,
    retry: false,
  });
}

export function useUpstreams() {
  return useQuery({
    queryKey: queryKeys.upstreams,
    queryFn: () => getJson<UpstreamsResponse>("/api/upstreams"),
  });
}
