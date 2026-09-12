import { describe, expect, it } from "vitest";
import { extractInstallHint, parseAwesomeLine } from "../../src/sources/awesome.js";

// Real lines, captured live from
// https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md
// on 2026-09-12 — see friction-log.md for the extraction approach.

const LINE_WITH_NPX_INSTALL =
  "- [Correctover/mcp-server](https://github.com/Correctover/mcp-server) " +
  "[![Correctover MCP server](https://glama.ai/mcp/servers/Correctover/mcp-server/badges/score.svg)]" +
  "(https://glama.ai/mcp/servers/Correctover/mcp-server) 📇 ☁️ 🏠 🍎 🪟 🐧 - Contract validation and " +
  "self-healing failover for LLM APIs. 6-dimension verification (structure, schema, latency, cost, " +
  "identity, integrity) in 22μs P50. Install: `npx -y correctover-mcp-server`.";

const LINE_WITH_PIP_INSTALL =
  "- [daedalusdevelopmentgroup/ddg-agent-payable-services](https://github.com/daedalusdevelopmentgroup/" +
  "ddg-agent-payable-services) [![daedalusdevelopmentgroup/ddg-agent-payable-services MCP server]" +
  "(https://glama.ai/mcp/servers/daedalusdevelopmentgroup/ddg-agent-payable-services/badges/score.svg)]" +
  "(https://glama.ai/mcp/servers/daedalusdevelopmentgroup/ddg-agent-payable-services) 🐍 ☁️ - Pay-per-call " +
  "x402 gateway for 90+ agent tools. `pip install ddg-agent-services-mcp` or remote " +
  "`https://mcp.daedalusdevelopmentgroup.com/mcp`.";

const NOT_A_SERVER_LINE = "* [Tool Definition Quality Score (TDQS)](https://github.com/glama-ai/tool-definition-quality-score)";

describe("parseAwesomeLine", () => {
  it("extracts owner, repo, displayName, and description from a real README entry", () => {
    const result = parseAwesomeLine(LINE_WITH_NPX_INSTALL);
    expect(result).toBeDefined();
    expect(result?.sourceId).toBe("awesome");
    expect(result?.slug).toBe("Correctover/mcp-server");
    expect(result?.repoUrl).toBe("https://github.com/Correctover/mcp-server");
    expect(result?.displayName).toBe("Correctover/mcp-server");
  });

  it("finds an npx install hint inside the description's inline code span", () => {
    const result = parseAwesomeLine(LINE_WITH_NPX_INSTALL);
    expect(result?.installHint).toEqual({ method: "npx", spec: "npx -y correctover-mcp-server" });
  });

  it("finds a pip install hint and strips the leading 'pip install '", () => {
    const result = parseAwesomeLine(LINE_WITH_PIP_INSTALL);
    expect(result?.installHint).toEqual({ method: "pip", spec: "ddg-agent-services-mcp" });
  });

  it("returns undefined for a bullet that isn't a repo-linked server entry", () => {
    expect(parseAwesomeLine(NOT_A_SERVER_LINE)).toBeUndefined();
    expect(parseAwesomeLine("## Server Implementations")).toBeUndefined();
    expect(parseAwesomeLine("")).toBeUndefined();
  });
});

describe("extractInstallHint", () => {
  it("returns undefined when no code span matches a known install command", () => {
    expect(extractInstallHint("Just a plain description with no code spans.")).toBeUndefined();
    expect(extractInstallHint("Uses `some-config-key` internally.")).toBeUndefined();
  });

  it("recognises docker run/pull commands", () => {
    expect(extractInstallHint("Run it: `docker run -it acme/widget`")).toEqual({
      method: "docker",
      spec: "docker run -it acme/widget",
    });
  });

  it("recognises uvx commands", () => {
    expect(extractInstallHint("Install with `uvx acme-widget`")).toEqual({
      method: "uvx",
      spec: "uvx acme-widget",
    });
  });
});
