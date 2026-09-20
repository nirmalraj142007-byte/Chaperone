import { describe, expect, it } from "vitest";
import { bootAndList, buildDockerArgs, buildShellCommand } from "../src/boot.js";

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

/**
 * Phase 5 built the isolation topology (docker/README.md, tinyproxy
 * allowlist, `--internal` network) but no test ever asserted the actual
 * per-container flags this function produces — `buildDockerArgs` wasn't
 * even exported. Booting a real Docker daemon in this suite to prove
 * network reachability end-to-end would need Docker available wherever
 * `pnpm test` runs (it is, in CI's `stack` job, but not in every dev
 * environment), so this asserts the mechanism that enforces "the boot
 * container cannot reach an arbitrary external host": with `network: "none"`
 * there is no network device in the container at all — not a firewall rule
 * that could be misconfigured, an absence — and with `network: "allowlist"`
 * the container joins an `--internal` Docker network (docker/README.md)
 * that has no route to the internet by construction, reachable only
 * through the tinyproxy container's own allowlist. Both are asserted here
 * directly off the real argument list `bootAndList` passes to `docker run`.
 */
describe("buildDockerArgs — container isolation flags", () => {
  const args = (network: "none" | "allowlist") =>
    buildDockerArgs("chaperone-boot-test", "exec npx '-y' 'foo'", { API_KEY: "placeholder-not-a-real-key" }, network);

  it("network: none gives the container no network device at all, not a permissive default", () => {
    const a = args("none");
    const idx = a.indexOf("--network");
    expect(idx).toBeGreaterThan(-1);
    expect(a[idx + 1]).toBe("none");
  });

  it("network: allowlist joins the internal, routeless Docker network — never the host network or a bridge with internet access", () => {
    const a = args("allowlist");
    const idx = a.indexOf("--network");
    expect(a[idx + 1]).toBe("chaperone-crawl-internal");
    expect(a).not.toContain("host");
    expect(a).not.toContain("bridge");
  });

  it("always sets memory, cpu, and pid limits, and a read-only root filesystem", () => {
    for (const network of ["none", "allowlist"] as const) {
      const a = args(network);
      expect(a).toContain("--memory=512m");
      expect(a).toContain("--cpus=1");
      expect(a).toContain("--pids-limit=256");
      expect(a).toContain("--read-only");
    }
  });

  it("never receives real credentials — only whatever placeholder env the caller built", () => {
    const a = buildDockerArgs("c", "exec npx foo", { GITHUB_TOKEN: "placeholder-not-a-real-key" }, "none");
    const envArgs = a.filter((_, i) => a[i - 1] === "-e");
    expect(envArgs).toContain("GITHUB_TOKEN=placeholder-not-a-real-key");
    expect(envArgs.some((e) => e.startsWith("GITHUB_TOKEN=") && !e.includes("placeholder"))).toBe(false);
  });

  it("only network: allowlist gets a proxy env var pointed at the tinyproxy container — network: none gets none", () => {
    const withAllowlist = args("allowlist");
    const withNone = args("none");
    expect(withAllowlist).toContain("HTTP_PROXY=http://proxy:3128");
    expect(withNone).not.toContain("HTTP_PROXY=http://proxy:3128");
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
