import { describe, expect, it } from "vitest";
import { bootAndList, buildShellCommand } from "../src/boot.js";

describe("buildShellCommand", () => {
  it("builds an npx command from a bare package identifier, adding -y", () => {
    expect(buildShellCommand("npx", "@foo/bar-mcp")).toBe("exec npx '-y' '@foo/bar-mcp'");
  });

  it("normalizes an npx spec that already includes the launcher and flags", () => {
    expect(buildShellCommand("npx", "npx -y @agentbodega/mcp")).toBe("exec npx '-y' '@agentbodega/mcp'");
  });

  it("does not double up -y when the spec already has it, in a different position", () => {
    expect(buildShellCommand("npx", "npx some-pkg -y")).toBe("exec npx 'some-pkg' '-y'");
  });

  it("builds a uvx command from a bare package identifier", () => {
    expect(buildShellCommand("uvx", "jupytercad-mcp")).toBe("exec uvx 'jupytercad-mcp'");
  });

  it("strips a leading uvx launcher token when the spec already includes it", () => {
    expect(buildShellCommand("uvx", "uvx mcp-server-selenium")).toBe("exec uvx 'mcp-server-selenium'");
  });

  it("builds a two-step pip install-then-exec command for a plausible package name", () => {
    const cmd = buildShellCommand("pip", "gadgethumans-api-hub-mcp");
    expect(cmd).toContain("pip install --no-input --disable-pip-version-check 'gadgethumans-api-hub-mcp'");
    expect(cmd).toContain("exec 'gadgethumans-api-hub-mcp'");
  });

  it("accepts a pip package name with an extras marker", () => {
    expect(() => buildShellCommand("pip", "somepkg[extra]")).not.toThrow();
  });

  it("rejects a pip 'spec' that is actually a compound shell snippet, not a package name", () => {
    // A real corpus example (awesome-mcp-servers README extraction): the
    // code span behind a `pip install` mention wasn't a bare package name.
    expect(() => buildShellCommand("pip", "pillow && python3 image_mcp.py")).toThrow(RangeError);
  });

  it("rejects an installMethod it doesn't know how to run", () => {
    expect(() => buildShellCommand("docker", "some/image")).toThrow(RangeError);
  });

  it("single-quotes an argument containing a single quote safely", () => {
    expect(buildShellCommand("npx", "it's-a-pkg")).toBe(`exec npx '-y' 'it'\\''s-a-pkg'`);
  });
});

describe("bootAndList — NO_INSTALL_PATH short-circuit (no docker required)", () => {
  it("returns NO_INSTALL_PATH immediately for a null installMethod", async () => {
    const result = await bootAndList(
      { serverId: "x", repoOwner: null, repoName: null, installMethod: null, installSpec: null },
      { timeoutMs: 30_000, network: "allowlist" },
    );
    const { durationMs, ...rest } = result;
    expect(rest).toEqual({ serverId: "x", status: "NO_INSTALL_PATH", tools: [], stderrTail: "", transport: "unknown" });
    // durationMs is a real Date.now() delta (boot.ts), not hardcoded — an
    // exact-0 assertion here flaked under load (two Date.now() calls
    // straddling a millisecond boundary during a scheduling delay).
    // This short-circuit does no real I/O, so treat "small" as the actual
    // property under test rather than "instant": non-negative and well
    // under a second, generous enough to hold on a machine saturated by
    // concurrent container boots during the real crawl.
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(durationMs).toBeLessThan(1000);
  });

  it("returns NO_INSTALL_PATH for an installMethod this harness can't automate (docker, manual)", async () => {
    const result = await bootAndList(
      { serverId: "y", repoOwner: null, repoName: null, installMethod: "manual", installSpec: "see README" },
      { timeoutMs: 30_000, network: "allowlist" },
    );
    expect(result.status).toBe("NO_INSTALL_PATH");
  });

  it("returns NO_INSTALL_PATH for a pip candidate whose installSpec doesn't parse as a package name", async () => {
    const result = await bootAndList(
      { serverId: "z", repoOwner: null, repoName: null, installMethod: "pip", installSpec: "pillow && python3 image_mcp.py" },
      { timeoutMs: 30_000, network: "allowlist" },
    );
    expect(result.status).toBe("NO_INSTALL_PATH");
  });
});
