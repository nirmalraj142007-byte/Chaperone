/**
 * Frozen refusal templates. Returned verbatim, never interpolated, never
 * rephrased — a model that can reword a refusal is a model that can be
 * talked into a friendly-sounding allow. REFUSAL_UPSTREAM_UNAVAILABLE must
 * read as a distinct condition from the other two: "this server is down" is
 * not "this tool changed," and conflating them destroys the product's story.
 */

export const REFUSAL_TOOL_CHANGED =
  "This tool's definition has changed since a household member approved it. It has been withheld and the change has been queued for review.";

export const REFUSAL_TOOL_UNPINNED =
  "This tool has not been approved by a household member yet, so it cannot be used.";

export const REFUSAL_UPSTREAM_UNAVAILABLE =
  "The server that provides this tool could not be reached, so it cannot be used right now. This is not a change to the tool itself — try again once the connection is restored.";

export const REFUSAL_MESSAGES = Object.freeze({
  TOOL_CHANGED: REFUSAL_TOOL_CHANGED,
  TOOL_UNPINNED: REFUSAL_TOOL_UNPINNED,
  UPSTREAM_UNAVAILABLE: REFUSAL_UPSTREAM_UNAVAILABLE,
});
