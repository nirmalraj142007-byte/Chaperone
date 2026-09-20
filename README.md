An assistant re-reads the instructions for every tool it owns, every time it
connects, and remembers nothing about what they said last time. Chaperone is
that memory. It sits alongside the assistant's connections to third-party
tool servers, keeps a record of what each tool claimed the last time a
resident approved it, and tells the household, in one sentence, the moment
that claim changes.

# Chaperone

Cross-session state for an assistant that has none. A resident approves
"Shopping List" once; nothing in MCP binds what that tool claimed at
approval to what it claims on every connect after that. Chaperone
content-hashes each tool definition at the moment a household approves it,
and withholds any tool whose definition has drifted, showing the changed
clause on a card before anything runs.

Internally it is a spec-2025-11-25 Streamable HTTP MCP server that proxies
N upstream servers. The entire security property is a synchronous hash
comparison in `packages/policy` — no LLM in that package's import graph,
enforced by `pnpm depcruise`.

MIT licensed. The repo is public from commit one.

## Measured results

Two numbers here are externally verifiable: anyone can rerun them. Both are
reported as measured, including where the measurement is unflattering.

### Boot success — an ecosystem finding

> 47.8% of public MCP servers with a discoverable install command did not
> start from their own documented setup instructions (152 booted of 291
> attempted; 656 had no discoverable install path at all).

Measured against 947 candidate servers in crawl 1 (2026-09-15). This is a
measurement of other people's repositories, not of this one. Regenerate with
`pnpm crawl:boot-rate --crawl-id=crawl-1`; the counts are in
`data/boot-rate.json` and `benchmarks/boot-rate.json`, both derived from
`data/crawl-1-report.json` by one shared function.

### Added latency — measured, and not yet verified against the target

**The 30 ms added-p95 budget is UNVERIFIED.** It has not been measured
against provisioned DynamoDB, and this repo does not claim to have met it.
Phase 18 takes that measurement and publishes a second file; until then the
budget is a target the build enforces, not a result.

What has been measured, at concurrency 4 over 1000 samples per mode against
**DynamoDB Local**:

| | added p50 | added p95 | added p99 |
|---|---|---|---|
| `backend: dynamodb-local` | 480.53 ms | 591.89 ms | 635.63 ms |

That is not "Chaperone's added latency." It is Chaperone's added latency
*against a single-writer storage backend*, and the distinction is the whole
finding.

**The result, stated as a cost model rather than a millisecond count:**

> Every gated `tools/call` performs one pin read plus two resumable-SSE
> event-store events, each of which is a sequence `UpdateItem` and a
> `PutItem` — **four DynamoDB write operations per tool call.**

That count is a property of Chaperone and transfers between environments.
The milliseconds do not: they belong to the backend. Against DynamoDB Local
— a single-writer SQLite process whose throughput is flat at roughly 60
writes/second regardless of client concurrency (measured: per-op p50 20.7 ms
at concurrency 1, 54.7 ms at 4, 127.3 ms at 8, throughput 42–70 ops/s
throughout) — those four writes dominate the added latency entirely, and
dominate it more as concurrency rises. Storage is the measurement; the
gateway's own work is a rounding error beside it.

This is the cost of resumable SSE being real rather than claimed. Every
event that a client could later replay with `Last-Event-ID` has to be
durable before the response goes out. A gateway that skipped those writes
would be faster and would lose the flagship property.

`benchmarks/latency.json` records `environment.backend` as a required
field — the bench runner reads it from the gateway's own `/healthz` and
refuses to write a file without it, because a latency number that cannot be
attributed to a backend cannot be compared to anything, including the
`dynamodb-aws` run Phase 18 will produce. Both runs get reported.

The budget is enforced by exit code, not by a sentence: `pnpm bench` exits 1
when added p95 exceeds 30 ms or p99 exceeds 60 ms. **It currently exits 1.**
A performance claim that does not fail a build is a performance hope.

### What is not claimed

Chaperone's block rate against its own attack corpus is **tautological** —
the attacks are author-written and the mechanism is a hash comparison, so it
cannot come out any other way. It is reported only as a delta against
baseline 2, never as an absolute. `packages/eval` has a test that fails if
an absolute block rate leaks into a report object.

## Running it

```
pnpm install
docker compose up -d          # ddb, demo-upstream, gateway
pnpm ddb:migrate              # idempotent
pnpm pin:bootstrap            # pin the demo upstream's tools
```

Then:

```
pnpm bench                    # latency + boot rate + ledger chain; exits 1 over budget
pnpm verify-ledger            # hash-chain walk
pnpm spec                     # MCP conformance suite
pnpm test:all                 # everything a judge would run
```

`pnpm bench` clears the `sse-event` table before measuring
(`packages/ledger/scripts/reset-sse.ts`), because DynamoDB Local does not
enforce TTL and those rows otherwise accumulate across runs and make each
run slower than the last — a benchmark whose result depends on how many
times it has been run is not a measurement. It never touches `ledger-event`,
and refuses to run without `DDB_ENDPOINT` set.

## Observability

- `GET /healthz` — per-component checks (DynamoDB, event store, upstreams),
  `storageBackend`, version, commit, uptime. 200 healthy or degraded, 503
  when storage is unreachable. The body carries a `gateWhenUnhealthy` field
  stating that **a 503 is not a permissive state**: when DynamoDB is
  unreachable the gateway cannot read the pin that authorises a tool, so
  every gated tool is withheld. Unhealthy means fewer tools are reachable,
  never more.
- `GET /metrics` — Prometheus text exposition: request counts and a duration
  histogram by method, gate decisions, quarantine events, upstream errors,
  event-store writes, advisory-unavailable count. No tool names, hashes,
  quarantine IDs or session IDs are ever label values, and unrecognised MCP
  methods collapse to `other` so label cardinality is bounded.
- A request ID is minted at ingress, echoed on `X-Request-Id`, and carried
  on every log line for that request — including lines from the gate, the
  upstream pool and the event store, which are never handed the request.
- Every gated tool logs its allow decision at debug with both hashes
  truncated to 12 characters. That line is what makes the mechanism legible
  when the terminal is on camera: two hashes, equal or not equal, and
  nothing else consulted.

## Evidence and pre-registration

`corpus/TAXONOMY.md` and `corpus/PREDICTIONS.md` were committed before crawl
1 ran and are frozen; their commit timestamps are load-bearing. Crawl 1 ran
2026-09-15 and crawl 2 runs 2026-10-20 — **35 days**, stated as a day count
rather than a rounded week count, with `pnpm check-claims` failing CI on
rounded-week language in committed prose.

See [`CRAWL_DATES.md`](CRAWL_DATES.md), [`corpus/TAXONOMY.md`](corpus/TAXONOMY.md),
[`corpus/PREDICTIONS.md`](corpus/PREDICTIONS.md), [`docs/DECISIONS.md`](docs/DECISIONS.md)
and [`friction-log.md`](friction-log.md).

## License

MIT — see [`LICENSE`](LICENSE).
