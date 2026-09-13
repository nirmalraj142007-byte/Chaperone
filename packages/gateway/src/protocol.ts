import { ProtocolError } from "@chaperone/errors";

/**
 * What @modelcontextprotocol/sdk 1.30.0 already owns, verified against
 * dist/esm/server/webStandardStreamableHttp.js:
 *
 * - `SUPPORTED_PROTOCOL_VERSIONS` (types.js) spans '2024-10-07' through
 *   '2025-11-25' — deliberately broad, for backwards compatibility with
 *   older clients. The transport itself accepts any of them at
 *   `initialize`, and separately validates the `MCP-Protocol-Version`
 *   header against that same broad list on every non-initialize request
 *   (400 if unsupported, defaulting to the version negotiated at
 *   initialize if the header is absent).
 * - The transport does NOT echo `MCP-Protocol-Version` back on response
 *   headers itself — there is no such `headers.set` call anywhere in
 *   webStandardStreamableHttp.js.
 *
 * Chaperone's own bar is narrower than the SDK's: spec 2025-11-25 or
 * later. This module enforces that floor on top of what the SDK already
 * validates, and owns the response-header echo the SDK doesn't do.
 */
export const MINIMUM_PROTOCOL_VERSION = "2025-11-25";

/**
 * String comparison is correct here only because both sides are
 * `YYYY-MM-DD` revision dates, which sort lexicographically the same as
 * chronologically.
 */
export function assertSupportedProtocolVersion(declaredVersion: string): void {
  if (declaredVersion < MINIMUM_PROTOCOL_VERSION) {
    throw new ProtocolError(
      `Unsupported MCP protocol version "${declaredVersion}": Chaperone requires ` +
        `"${MINIMUM_PROTOCOL_VERSION}" or later.`,
      { declaredVersion, minimumVersion: MINIMUM_PROTOCOL_VERSION },
    );
  }
}

export function echoProtocolVersionHeader(
  res: { setHeader(name: string, value: string): unknown },
  protocolVersion: string,
): void {
  res.setHeader("MCP-Protocol-Version", protocolVersion);
}
