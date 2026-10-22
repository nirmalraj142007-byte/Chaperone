/**
 * The two frozen constants that make a UI resource an MCP App, and the
 * `ui://` addressing scheme for a single quarantine's consent card.
 *
 * Verified against the real `@modelcontextprotocol/ext-apps@1.7.5` package
 * (its own `dist/src/app.d.ts` / `dist/src/spec.types.d.ts`, not a blog post
 * or an older `@mcp-ui/server` example — see docs/DECISIONS.md, "MCP App
 * mechanism"): `RESOURCE_MIME_TYPE` and `RESOURCE_URI_META_KEY` are exported
 * with exactly these literal values. Copied here rather than imported so the
 * card's own render package stays free of a dependency whose only other use
 * is a handful of server-side helpers gateway.ts already gets more directly
 * from the low-level `Server` class.
 */
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
export const MCP_APP_RESOURCE_URI_META_KEY = "ui/resourceUri";
export const MCP_APP_EXTENSION_ID = "io.modelcontextprotocol/ui";

const CONSENT_URI_PREFIX = "ui://chaperone/consent/";

export function consentResourceUri(quarantineId: string): string {
  return `${CONSENT_URI_PREFIX}${quarantineId}`;
}

export const CONSENT_RESOURCE_URI_TEMPLATE = `${CONSENT_URI_PREFIX}{quarantineId}`;

/** Inverse of {@link consentResourceUri}. `undefined` for anything not shaped like one of this card's own URIs. */
export function parseConsentResourceUri(uri: string): string | undefined {
  if (!uri.startsWith(CONSENT_URI_PREFIX)) {
    return undefined;
  }
  const quarantineId = uri.slice(CONSENT_URI_PREFIX.length);
  return quarantineId.length > 0 ? quarantineId : undefined;
}

/**
 * The quarantine id and one-time token for each item in a rendered HTML
 * consent card, in document order, read from the `data-quarantine-id` /
 * `data-approval-token` attributes render.ts puts on each item. This is the
 * only place outside the card's own buttons that a token can be read from a
 * card: the text card carries none (it is model-visible). For hosts, tests
 * and the demo harness; the values are HTML-attribute-escaped, which a
 * base64url token and a ULID never need.
 */
export function approvalsFromCardHtml(html: string): Array<{ quarantineId: string; approvalToken: string }> {
  const found: Array<{ quarantineId: string; approvalToken: string }> = [];
  for (const match of html.matchAll(/data-quarantine-id="([^"]+)" data-approval-token="([^"]+)"/g)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      found.push({ quarantineId: match[1], approvalToken: match[2] });
    }
  }
  return found;
}
