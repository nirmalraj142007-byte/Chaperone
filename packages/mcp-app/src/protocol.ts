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
