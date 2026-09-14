/**
 * Exactly-once guard for `tools/call`, keyed by the downstream JSON-RPC
 * request ID (`extra.requestId` in upstreamProxy.ts's `CallToolRequestSchema`
 * handler — the same value already threaded through to
 * `@chaperone/upstream`'s `CallContext.downstreamRequestId`).
 *
 * A well-behaved reconnect never reaches this at all: the SDK client
 * resumes a dropped stream with a GET carrying `Last-Event-ID`
 * (client/streamableHttp.js's `_startOrAuthSse`), which re-attaches to the
 * transport's existing `_requestToStreamMapping` entry and replays stored
 * events via event-store.ts — the original `tools/call` handler keeps
 * running server-side, untouched, because nothing in the SDK ties its
 * `AbortController` to one HTTP connection's socket (only to an explicit
 * `$/cancelRequest` or the whole transport's own `close()` — verified
 * against shared/protocol.js's `_onrequest`/`_onclose`).
 *
 * This registry exists for the case that guarantee doesn't cover: a second
 * POST that reuses the same JSON-RPC request ID — a client (or a test
 * driving the wire protocol directly, rather than through the SDK's own
 * reconnect logic) resending the original call instead of only reattaching
 * to it. Without this, `buildPassthroughServer`'s handler would call
 * `pool.callTool` — and so the real upstream — a second time.
 *
 * Scoped to one session: `buildPassthroughServer` (upstreamProxy.ts) is
 * called once per session (session.ts), so a `CallRegistry` built inside it
 * lives exactly as long as that session's `Server` instance and is dropped
 * with it — entries never leak across sessions and are never explicitly
 * evicted, because a duplicate arriving *after* the original call settled
 * must still resolve to that same result rather than re-invoking the
 * upstream.
 */
export interface CallRegistry {
  runOnce<T>(requestId: string | number, run: () => Promise<T>): Promise<T>;
}

export function createCallRegistry(): CallRegistry {
  const inFlight = new Map<string | number, Promise<unknown>>();

  return {
    runOnce<T>(requestId: string | number, run: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(requestId);
      if (existing !== undefined) {
        return existing as Promise<T>;
      }
      const promise = run();
      inFlight.set(requestId, promise);
      return promise;
    },
  };
}
