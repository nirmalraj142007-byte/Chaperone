/**
 * Per-request logging context, carried on an `AsyncLocalStorage` so that a
 * request ID minted once at HTTP ingress appears on every log line emitted
 * while handling that request — including lines from modules that were
 * never handed the request object (`@chaperone/upstream`'s pool,
 * `packages/gateway/src/gate.ts`, `event-store.ts`).
 *
 * The alternative — threading a `Logger` parameter through every call site
 * down to the pool — would have put a logging concern in the signature of
 * `allow()`'s callers and in `UpstreamPool.callTool`. `AsyncLocalStorage`
 * is Node's supported mechanism for exactly this and it survives `await`,
 * promise chains, and timers.
 *
 * Honest limit, worth knowing before trusting a correlation: async context
 * follows the *call* that started inside `run()`. A long-lived SSE stream
 * whose later writes are driven by a subsequent HTTP request (a resumed
 * GET) carries *that* request's ID, not the one that opened the stream —
 * which is the correct answer for "which request wrote this line," and the
 * wrong answer for anyone expecting one ID per logical stream. Session ID
 * is on the same lines and is the stable key across resumption.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  sessionId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` bound; every log line emitted inside it carries the IDs. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The context of the in-flight request, or undefined outside one (startup, shutdown, a script). */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
