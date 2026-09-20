/**
 * The gateway's Prometheus surface: a small in-process registry plus the
 * counters and histogram `/metrics` exposes.
 *
 * Hand-rolled rather than pulling in `prom-client`, for one reason that is
 * not "fewer dependencies": the exposition format is the entire contract
 * here, it is about forty lines of string building, and a hand-rolled
 * version can be unit-tested against literal expected text. A scrape that
 * silently emits a format Prometheus rejects is exactly the class of
 * "green but doing nothing" failure CLAUDE.md's working-style note warns
 * about, and metrics.test.ts asserts on the bytes.
 *
 * Process-local and unauthenticated by design. These are operational
 * counters — request counts, durations, how many tools got quarantined —
 * not household data: no tool names, no hashes, no quarantine IDs and no
 * session IDs ever become label values. Label cardinality is bounded by
 * construction for the same reason (`mcp_method` is mapped onto a fixed
 * set below, never passed through from the wire).
 */

/** Seconds. Tuned around the 30ms added-latency budget: five buckets sit under it. */
const DURATION_BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/**
 * The only `mcp_method` label values that can ever be emitted. An
 * unrecognised method off the wire becomes `other` rather than becoming a
 * new time series — a buggy (or hostile) client sending a million distinct
 * method names must not be able to grow this process's memory.
 */
const KNOWN_MCP_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "ping",
]);

export function normaliseMcpMethod(method: unknown): string {
  if (typeof method !== "string" || method.length === 0) {
    return "none";
  }
  return KNOWN_MCP_METHODS.has(method) ? method : "other";
}

type Labels = Record<string, string>;

/** Prometheus label-value escaping: backslash, double quote, newline. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return "";
  }
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",")}}`;
}

/** Stable key for a label set, independent of insertion order. */
function labelKey(labels: Labels): string {
  return renderLabels(labels);
}

class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing === undefined) {
      this.values.set(key, { labels, value: amount });
      return;
    }
    existing.value += amount;
  }

  render(): string[] {
    // A counter with no observations still emits its HELP/TYPE header, so a
    // reader can tell "this gateway has had zero upstream errors" apart from
    // "this gateway does not report upstream errors."
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    const sorted = [...this.values.values()].sort((a, b) => labelKey(a.labels).localeCompare(labelKey(b.labels)));
    for (const { labels, value } of sorted) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines;
  }

  /** Test-only. */
  reset(): void {
    this.values.clear();
  }
}

interface HistogramSeries {
  labels: Labels;
  counts: number[];
  sum: number;
  count: number;
}

class Histogram {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: readonly number[],
  ) {}

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (entry === undefined) {
      entry = { labels, counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      const bound = this.buckets[i];
      // Prometheus histogram buckets are cumulative: an observation counts
      // in every bucket whose upper bound it is <=, not only the tightest.
      if (bound !== undefined && value <= bound) {
        entry.counts[i] = (entry.counts[i] ?? 0) + 1;
      }
    }
    entry.sum += value;
    entry.count += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    const sorted = [...this.series.values()].sort((a, b) => labelKey(a.labels).localeCompare(labelKey(b.labels)));
    for (const entry of sorted) {
      for (let i = 0; i < this.buckets.length; i++) {
        const bound = this.buckets[i];
        if (bound === undefined) {
          continue;
        }
        lines.push(`${this.name}_bucket${renderLabels({ ...entry.labels, le: String(bound) })} ${entry.counts[i] ?? 0}`);
      }
      lines.push(`${this.name}_bucket${renderLabels({ ...entry.labels, le: "+Inf" })} ${entry.count}`);
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    return lines;
  }

  /** Test-only. */
  reset(): void {
    this.series.clear();
  }
}

export const requestsTotal = new Counter(
  "chaperone_requests_total",
  "HTTP requests handled by the gateway, by transport method, MCP method and response status.",
);

export const requestDurationSeconds = new Histogram(
  "chaperone_request_duration_seconds",
  "Wall-clock duration of a handled gateway request, by transport method and MCP method.",
  DURATION_BUCKETS_SECONDS,
);

export const quarantineEventsTotal = new Counter(
  "chaperone_quarantine_events_total",
  "Gate outcomes for a tool whose definition no longer matches its pin. opened = a new quarantine; reused = one already open; already_refused = a change the household refused before; write_failed = the quarantine could not be recorded.",
);

export const upstreamErrorsTotal = new Counter(
  "chaperone_upstream_errors_total",
  "Failed calls to a configured upstream MCP server, by upstream and operation.",
);

export const eventStoreWritesTotal = new Counter(
  "chaperone_event_store_writes_total",
  "Resumable-SSE event-store writes, by outcome. A failed write means that event cannot be replayed after a reconnect.",
);

export const advisoryUnavailableTotal = new Counter(
  "chaperone_advisory_unavailable_total",
  "Consent cards rendered with no advisory score available. The advisory is decoration; the card still renders and the gate decision is unaffected.",
);

export const gateDecisionsTotal = new Counter(
  "chaperone_gate_decisions_total",
  "Tool-definition gate decisions. allow = the current definition hashes to the pinned hash; deny = everything else, including a storage failure.",
);

const COLLECTORS = [
  requestsTotal,
  requestDurationSeconds,
  quarantineEventsTotal,
  upstreamErrorsTotal,
  eventStoreWritesTotal,
  advisoryUnavailableTotal,
  gateDecisionsTotal,
] as const;

/** The full scrape body, Prometheus text exposition format 0.0.4. Always ends with a newline. */
export function renderMetrics(): string {
  return `${COLLECTORS.flatMap((collector) => collector.render()).join("\n")}\n`;
}

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Test-only: drops every observation, so one suite's counts cannot leak into another's assertions. */
export function resetMetricsForTests(): void {
  for (const collector of COLLECTORS) {
    collector.reset();
  }
}
