import { describe, expect, it, vi } from "vitest";
import { ProtocolError } from "@chaperone/errors";
import { MINIMUM_PROTOCOL_VERSION, assertSupportedProtocolVersion, echoProtocolVersionHeader } from "../src/protocol.js";

describe("assertSupportedProtocolVersion", () => {
  it("accepts the minimum version", () => {
    expect(() => assertSupportedProtocolVersion(MINIMUM_PROTOCOL_VERSION)).not.toThrow();
  });

  it("accepts a later revision", () => {
    expect(() => assertSupportedProtocolVersion("2026-01-01")).not.toThrow();
  });

  it("rejects an older revision with a ProtocolError naming both versions", () => {
    let caught: unknown;
    try {
      assertSupportedProtocolVersion("2024-11-05");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProtocolError);
    const message = (caught as ProtocolError).message;
    expect(message).toContain("2024-11-05");
    expect(message).toContain(MINIMUM_PROTOCOL_VERSION);
  });
});

describe("echoProtocolVersionHeader", () => {
  it("sets the MCP-Protocol-Version response header", () => {
    const setHeader = vi.fn();
    echoProtocolVersionHeader({ setHeader }, "2025-11-25");
    expect(setHeader).toHaveBeenCalledWith("MCP-Protocol-Version", "2025-11-25");
  });
});
