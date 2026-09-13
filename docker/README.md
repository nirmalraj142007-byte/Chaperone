# Boot harness Docker topology

Everything here is created and torn down automatically by
`packages/crawler/src/boot.ts`'s `ensureCrawlInfrastructure()` (idempotent —
safe to call at the start of every crawl run). This file documents what that
function does and why, for a reader who wants the topology without reading
TypeScript.

## Images

- **`chaperone/crawler-runtime`** (`crawler-runtime.Dockerfile`) — Node 22 +
  Python 3.12 + `uv`/`uvx`, nothing else. What every candidate server boots
  inside.
- **`chaperone/crawl-proxy`** (`proxy/Dockerfile`) — `tinyproxy` on Alpine,
  configured as an egress allowlist (`proxy/tinyproxy.conf`, `proxy/filter`).

## Networks — the egress allowlist, enforced by topology rather than convention

```
docker network create --internal --subnet=172.28.0.0/16 chaperone-crawl-internal
docker network create chaperone-crawl-egress
```

- **`chaperone-crawl-internal`** — created with Docker's `--internal` flag,
  which means literally no NAT/route to the outside world. Every boot
  attempt's container attaches only here.
- **`chaperone-crawl-egress`** — an ordinary bridge network with real
  internet access.
- **The proxy container is the only thing attached to both.** A boot
  attempt's `HTTP_PROXY`/`HTTPS_PROXY` point at the proxy container's name on
  the internal network; anything that tries to bypass the proxy and open a
  raw connection instead has nowhere to go — confirmed empirically
  (2026-09-13): without the proxy env vars set, a container on the internal
  network can't even resolve DNS (`Temporary failure in name resolution`).

```
docker run -d --name chaperone-crawl-proxy \
  --network chaperone-crawl-internal --network-alias proxy \
  chaperone/crawl-proxy:latest
docker network connect chaperone-crawl-egress chaperone-crawl-proxy
```

## What the allowlist actually allows

`proxy/filter` (matched as POSIX extended regex, case-insensitive —
`FilterType ere` in `tinyproxy.conf`): exactly `registry.npmjs.org`,
`pypi.org`, `files.pythonhosted.org`. Everything else gets tinyproxy's `403
Filtered`, confirmed live against a real `https://example.com` request.

## Per-boot-attempt container flags

`--memory=512m --cpus=1 --pids-limit=256 --read-only`, plus
`--tmpfs /tmp:rw,exec,nosuid,size=1g` — note `exec` is not the default for a
bare `--tmpfs /tmp` (Docker defaults to `noexec`), and every install method
this harness uses downloads code and then runs it from `/tmp`; see
friction-log.md Entry 006 for how that was discovered. Every container gets a
unique `--name` and is force-removed in a `finally` block after every boot
attempt, plus a "remove anything left over from a prior interrupted run"
sweep at the start of every crawl (`docker.ps -a --filter
name=^chaperone-boot-`) — killing the harness process itself (Ctrl+C, a
crash) does not run that `finally` block, so without the sweep, containers
from an interrupted run would keep running indefinitely.
