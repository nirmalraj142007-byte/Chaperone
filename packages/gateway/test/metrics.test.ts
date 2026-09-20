import { beforeEach, describe, expect, it } from "vitest";
import {
  METRICS_CONTENT_TYPE,
  normaliseMcpMethod,
  renderMetrics,
  requestDurationSeconds,
  requestsTotal,
  resetMetricsForTests,
  upstreamErrorsTotal,
} from "../src/metrics.js";

beforeEach(() => {
  resetMetricsForTests();
});

/** Every non-comment, non-blank line of a scrape. */
function samples(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe("Prometheus exposition format", () => {
  it("declares the 0.0.4 text content type", () => {
    expect(METRICS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("emits HELP and TYPE for every metric, even with no observations", () => {
    // A reader must be able to tell "zero upstream errors" from "this
    // gateway does not report upstream errors".
    const text = renderMetrics();
    expect(text).toContain("# HELP chaperone_upstream_errors_total");
    expect(text).toContain("# TYPE chaperone_upstream_errors_total counter");
    expect(samples(text).filter((l) => l.startsWith("chaperone_upstream_errors_total"))).toEqual([]);
  });

  it("ends with a newline, as the format requires", () => {
    expect(renderMetrics().endsWith("\n")).toBe(true);
  });

  it("renders a counter with sorted, quoted labels", () => {
    upstreamErrorsTotal.inc({ upstream: "grocery", operation: "tools/call" });
    upstreamErrorsTotal.inc({ upstream: "grocery", operation: "tools/call" });
    expect(renderMetrics()).toContain(
      'chaperone_upstream_errors_total{operation="tools/call",upstream="grocery"} 2',
    );
  });

  it("renders label sets identically regardless of key insertion order", () => {
    upstreamErrorsTotal.inc({ upstream: "grocery", operation: "tools/list" });
    upstreamErrorsTotal.inc({ operation: "tools/list", upstream: "grocery" });
    const lines = samples(renderMetrics()).filter((l) => l.startsWith("chaperone_upstream_errors_total"));
    expect(lines).toEqual(['chaperone_upstream_errors_total{operation="tools/list",upstream="grocery"} 2']);
  });

  it("escapes backslashes, quotes and newlines in label values", () => {
    upstreamErrorsTotal.inc({ upstream: 'a"b\\c\nd', operation: "x" });
    expect(renderMetrics()).toContain('upstream="a\\"b\\\\c\\nd"');
  });
});

describe("request duration histogram", () => {
  it("emits cumulative buckets, a +Inf bucket, a sum and a count", () => {
    requestDurationSeconds.observe({ http_method: "POST", mcp_method: "tools/call" }, 0.004);

    const text = renderMetrics();
    // 0.004s falls in every bucket from 0.005 up, and none below it.
    expect(text).toContain('chaperone_request_duration_seconds_bucket{http_method="POST",le="0.001",mcp_method="tools/call"} 0');
    expect(text).toContain('chaperone_request_duration_seconds_bucket{http_method="POST",le="0.005",mcp_method="tools/call"} 1');
    expect(text).toContain('chaperone_request_duration_seconds_bucket{http_method="POST",le="0.01",mcp_method="tools/call"} 1');
    expect(text).toContain('chaperone_request_duration_seconds_bucket{http_method="POST",le="+Inf",mcp_method="tools/call"} 1');
    expect(text).toContain('chaperone_request_duration_seconds_sum{http_method="POST",mcp_method="tools/call"} 0.004');
    expect(text).toContain('chaperone_request_duration_seconds_count{http_method="POST",mcp_method="tools/call"} 1');
  });

  it("counts an observation past the largest bucket only in +Inf", () => {
    requestDurationSeconds.observe({ http_method: "POST", mcp_method: "ping" }, 99);
    const text = renderMetrics();
    expect(text).toContain('chaperone_request_duration_seconds_bucket{http_method="POST",le="10",mcp_method="ping"} 0');
    expect(text).toContain('chaperone_request_duration_seconds_bucket{http_method="POST",le="+Inf",mcp_method="ping"} 1');
  });

  it("keeps separate series per label set", () => {
    requestDurationSeconds.observe({ http_method: "POST", mcp_method: "tools/list" }, 0.01);
    requestDurationSeconds.observe({ http_method: "GET", mcp_method: "none" }, 0.01);
    const text = renderMetrics();
    expect(text).toContain('chaperone_request_duration_seconds_count{http_method="POST",mcp_method="tools/list"} 1');
    expect(text).toContain('chaperone_request_duration_seconds_count{http_method="GET",mcp_method="none"} 1');
  });
});

describe("normaliseMcpMethod (label cardinality is bounded by construction)", () => {
  it("passes through the known protocol methods", () => {
    expect(normaliseMcpMethod("tools/call")).toBe("tools/call");
    expect(normaliseMcpMethod("initialize")).toBe("initialize");
  });

  it("collapses anything unrecognised to 'other'", () => {
    // Without this, a client sending a million distinct method names grows
    // this process's memory by a million time series.
    expect(normaliseMcpMethod("attacker/" + "x".repeat(500))).toBe("other");
    expect(normaliseMcpMethod("tools/CALL")).toBe("other");
  });

  it("reports a request with no MCP method as 'none', not 'other'", () => {
    // A GET /healthz has no JSON-RPC body at all; that is a different fact
    // from an unrecognised method.
    expect(normaliseMcpMethod(undefined)).toBe("none");
    expect(normaliseMcpMethod("")).toBe("none");
    expect(normaliseMcpMethod(42)).toBe("none");
  });

  it("bounds the emitted series count no matter how many distinct methods arrive", () => {
    for (let i = 0; i < 500; i++) {
      requestsTotal.inc({ http_method: "POST", mcp_method: normaliseMcpMethod(`made/up/${i}`), status: "200" });
    }
    const lines = samples(renderMetrics()).filter((l) => l.startsWith("chaperone_requests_total"));
    expect(lines).toEqual(['chaperone_requests_total{http_method="POST",mcp_method="other",status="200"} 500']);
  });
});
