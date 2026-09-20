/**
 * React glue for the `?state=` overrides. The decision logic itself is in
 * state.ts and is pure; this file is only the hook that reads the URL, so
 * the override rules stay testable without rendering.
 */
import { useSearch } from "./router";
import { readOverride, type StateOverride } from "./state";

export function useOverride(): StateOverride | null {
  return readOverride(useSearch());
}
