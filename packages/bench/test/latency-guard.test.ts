/**
 * The guard that keeps the latency number honest. `runLatency` itself
 * needs a live stack and is exercised by `pnpm bench`; what is unit-tested
 * here is the check that decides whether a measured call counted — because
 * that is the failure that is silent and that flatters.
 */
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { REFUSAL_TOOL_CHANGED, REFUSAL_TOOL_UNPINNED, REFUSAL_UPSTREAM_UNAVAILABLE } from "@chaperone/policy";
import { BenchError } from "@chaperone/errors";
import { assertRealResult, targetFor, DEFAULT_DIRECT_URL, DEFAULT_GATEWAY_URL } from "../src/latency.js";

const ok: CallToolResult = { content: [{ type: "text", text: "Your shopping list: 2 × batteries." }] };

describe("assertRealResult", () => {
  it("accepts a real tool result", () => {
    expect(() => assertRealResult(ok, "proxied")).not.toThrow();
  });

  for (const [name, refusal] of [
    ["a changed tool", REFUSAL_TOOL_CHANGED],
    ["an unpinned tool", REFUSAL_TOOL_UNPINNED],
    ["an unavailable upstream", REFUSAL_UPSTREAM_UNAVAILABLE],
  ] as const) {
    it(`rejects the frozen refusal for ${name}`, () => {
      // A refusal is fast and makes no upstream call, so measuring one
      // would publish a flatteringly low added latency for a path that
      // never ran the proxy. It has to be an error, not a sample.
      const result: CallToolResult = { content: [{ type: "text", text: refusal }], isError: true };
      expect(() => assertRealResult(result, "proxied")).toThrow(BenchError);
      expect(() => assertRealResult(result, "proxied")).toThrow(/frozen refusal/);
    });
  }

  it("names the command that fixes an unpinned run", () => {
    const result: CallToolResult = { content: [{ type: "text", text: REFUSAL_TOOL_UNPINNED }], isError: true };
    expect(() => assertRealResult(result, "proxied")).toThrow(/pnpm pin:bootstrap/);
  });

  it("rejects a refusal even when it arrives alongside a consent card block", () => {
    // A real refusal carries the card as a second content block, so the
    // check cannot assume the refusal is the whole of the text.
    const result: CallToolResult = {
      content: [
        { type: "text", text: REFUSAL_TOOL_CHANGED },
        { type: "text", text: "Chaperone: a tool you approved has changed." },
      ],
      isError: true,
    };
    expect(() => assertRealResult(result, "proxied")).toThrow(BenchError);
  });

  it("rejects any isError result, refusal or not", () => {
    expect(() => assertRealResult({ content: [{ type: "text", text: "boom" }], isError: true }, "direct")).toThrow(
      BenchError,
    );
  });

  it("rejects an empty result", () => {
    expect(() => assertRealResult({ content: [] }, "direct")).toThrow(BenchError);
  });
});

describe("targetFor", () => {
  it("calls the namespaced tool through the gateway", () => {
    // The one place the proxy is deliberately not byte-transparent. Timing
    // the bare name against the gateway would measure an unknown-tool error.
    expect(targetFor("proxied", DEFAULT_GATEWAY_URL, DEFAULT_DIRECT_URL)).toEqual({
      url: DEFAULT_GATEWAY_URL,
      toolName: "grocery__read_list",
    });
  });

  it("calls the bare tool name straight at the upstream", () => {
    expect(targetFor("direct", DEFAULT_GATEWAY_URL, DEFAULT_DIRECT_URL)).toEqual({
      url: DEFAULT_DIRECT_URL,
      toolName: "read_list",
    });
  });

  it("measures a gated tool, not an ungated first-party one", () => {
    // chaperone/* tools bypass the gate entirely; timing one would produce
    // a smaller, meaningless number.
    expect(targetFor("proxied", DEFAULT_GATEWAY_URL, DEFAULT_DIRECT_URL).toolName).not.toContain("chaperone");
  });
});
