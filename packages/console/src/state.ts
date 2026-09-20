/**
 * `?state=empty|loading|error|partial` — a view override on every route.
 *
 * Four states per screen are four things that have to be *designed*, and a
 * state you cannot reach is a state nobody designed. These overrides make
 * each one a URL: reachable for a screenshot, for a rehearsal, and for the
 * snapshot suite, which renders all four of all six routes.
 *
 * The override is applied at the view boundary, not inside the render
 * path, so an overridden screen goes through exactly the same JSX as a
 * real one. A state that looks right under `?state=error` looks right when
 * the gateway is actually down. Documented in docs/UI-STATES.md.
 */
import { ApiError } from "./api";

export const STATE_OVERRIDES = ["empty", "loading", "error", "partial"] as const;
export type StateOverride = (typeof STATE_OVERRIDES)[number];

export function readOverride(search: string): StateOverride | null {
  const value = new URLSearchParams(search).get("state");
  return STATE_OVERRIDES.includes(value as StateOverride) ? (value as StateOverride) : null;
}

/** Carries `?state=` across an in-screen navigation (the queue's filter chips rewrite the URL). */
export function withOverride(url: string, override: StateOverride | null): string {
  if (override === null) {
    return url;
  }
  const [base, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  params.set("state", override);
  return `${base}?${params.toString()}`;
}

export type View<T> = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; data: T };

/** TanStack Query's result, narrowed to the three things a screen actually branches on. */
export function viewOf<T>(q: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined }): View<T> {
  if (q.isPending) return { status: "loading" };
  if (q.isError || q.data === undefined) return { status: "error", error: q.error };
  return { status: "ready", data: q.data };
}

/** The error an `?state=error` screenshot shows: a real 503 body, the shape the gateway sends when DynamoDB is unreachable. */
export function overrideError(what: string): ApiError {
  return new ApiError(503, `Could not read ${what}. The gateway reached the request but not the table.`, { error: "storage_unavailable" });
}

/**
 * Applies an override to a real view. `partial` falls through to the real
 * view unless the caller supplied a partial fixture, because most screens
 * have no partial state — /corpus and /queue/:id are the two that do, and
 * they pass one.
 */
export function applyOverride<T>(
  view: View<T>,
  override: StateOverride | null,
  fixtures: { empty: T; partial?: T; what: string },
): View<T> {
  switch (override) {
    case "loading":
      return { status: "loading" };
    case "error":
      return { status: "error", error: overrideError(fixtures.what) };
    case "empty":
      return { status: "ready", data: fixtures.empty };
    case "partial":
      return fixtures.partial === undefined ? view : { status: "ready", data: fixtures.partial };
    default:
      return view;
  }
}
