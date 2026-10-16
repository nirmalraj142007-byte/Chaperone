# Runbook: deploying, pausing and resuming the gateway on AWS

Status: **deployed to AWS on 2026-10-16** (account 856820205068, us-east-1),
at `https://chaperone-demo.duckdns.org`, running image `60e5967`. Every timing
below marked *measured 2026-10-16* comes from that deploy; anything still
*not yet measured* is exactly that. The first real deploy found three bugs that
local verification could not: `deploy.sh` pulled `:unset` (friction log 048),
the advisory Lambdas threw at module load (050), and the Pipe's batch array
made the pipeline "succeed" with nothing written (051). All three are fixed,
and the two in `infra/` are asserted by test.

The local path (`docker compose up -d --build`, README Quickstart) works any
time and needs no AWS account. The live deployment exists for judging
(2026-11-09 to 2026-11-20).

## Why this is EC2 + Caddy, and not Fargate + ALB

An ECS Fargate + ALB design was written first (and briefly committed in
`8d6194b`). It was replaced on 2026-10-10 for cost: an ALB bills hourly plus
a public IPv4 address per AZ, which roughly doubles the running cost of a
one-task service. One small EC2 instance with Docker Compose, with Caddy
obtaining and renewing its own certificate, has no load balancer, no ACM and no
NAT gateway.

What stays true from the original reasoning: **App Runner is out**, because it
caps request duration at 120 s and resumable SSE is the flagship claim. What is
given up: the managed health-checked task replacement. The host is one pet
instance; if it dies, recovery is `cdk destroy` and redeploy (Rollback, below),
and the tables survive because they live in their own stack.

## What gets deployed

| Stack | Holds | Lifecycle |
|---|---|---|
| `ChaperoneAdvisoryPipeline` | `chaperone-quarantine`, `chaperone-advisory`, the Step Functions advisory pipeline | Stays up. Owns those two tables. |
| `ChaperoneTables` | the other 7 tables, from `TABLE_SCHEMAS`; every one `RETAIN` | **Never destroyed**, so data survives anything below. |
| `ChaperoneRegistry` | ECR repos `chaperone-gateway` and `chaperone-demo-upstream`, immutable tags | Stays up. The images for every rollout and rollback are here. |
| `ChaperoneGateway` | VPC (one public subnet, no NAT), `t3.micro` host, Elastic IP, security group, instance role, 30-day log group. **No DNS record:** DNS is external (below). | Pause = *stop the instance*, not destroy the stack. |

Three containers run on the host under Docker Compose: the gateway, the staged
demo upstream (`demo-upstream`) and Caddy. Both images carry the same git-sha
tag and move together.

`ChaperoneGateway` addresses the tables by name-derived ARN, not by
cross-stack reference. The host exposes only 80/tcp, 443/tcp and 443/udp. There
is **no SSH**: shell access is SSM Session Manager and rollouts are SSM Run
Command.

**The demo upstream's `/control/*` routes are not reachable from the internet.**
They are unauthenticated (`mutate`, `reset`, `stats`, `place-order-delay`), so
three things keep them private, each asserted by `infra/test`: `demo-upstream`
has no `ports:` entry in `deploy/docker-compose.yml` (it uses `expose`, which is
reachable on the compose network only); Caddy has one route, to `gateway:3000`,
and none to `demo-upstream`; and the security group admits nothing but 80/443.
A request for `/control/mutate` through Caddy lands on the gateway, which
answers 404. The way in is `demo-control.sh` over SSM (below). IMDSv2 is required with a hop limit of 2; the default of 1 would stop
the gateway container reaching the instance role's credentials, and every
DynamoDB call would then fail closed.

Stack parameters, supplied at deploy time: `DomainName`, `UpstreamsJson`, and
`InstanceType` (default `t3.micro`; x86 only). There is no hosted-zone
parameter: the stack creates no Route 53 zone or record, and `DomainName` is
only written into Caddy's site address and the gateway's origin allowlist.

Instance role grants (read off the repos; asserted by test):

| Table | Actions |
|---|---|
| `ledger-event` | GetItem, PutItem, Query. **No UpdateItem, no DeleteItem.** |
| `pin` | GetItem, PutItem, Query |
| `quarantine` | GetItem, PutItem, Query, UpdateItem |
| `advisory` | GetItem |
| `session` | GetItem, PutItem, UpdateItem, DeleteItem |
| `sse-event` | PutItem, UpdateItem, Query |
| `corpus-server`, `tool-snapshot`, `drift-record` | none (crawler and analysis run locally) |

Plus ECR pull on the one repository, CloudWatch Logs write on one log group, and
the AWS-managed `AmazonSSMManagedInstanceCore`.

## Before you start

1. **Credentials.** Use the `deployer` profile (IAM user `chaperone-deployer`),
   and check it first: `aws sts get-caller-identity --profile deployer` must
   show that user in account 856820205068. The `chaperone-dev` user cannot
   deploy (the 2026-10-10 preflight showed it denied on EC2, CloudFormation,
   ECR, DynamoDB listing and more). The account can launch a `t3.micro`:
   established 2026-10-16.
2. **A hostname you control, with any DNS provider.** The live deployment uses
   the free DuckDNS name `chaperone-demo.duckdns.org`. You point its A record at
   the stack's `ElasticIp` output by hand, once (DNS, below).
3. **The Groq key in Secrets Manager** before `ChaperoneAdvisoryPipeline` runs
   its first execution. The stack only references the secret by name; Deploy
   step 2 creates it from `.env` without printing it.
4. **An upstream.** `UpstreamsJson` defaults to the demo upstream that runs on
   the same host, `[{"id":"grocery","url":"http://demo-upstream:4000/mcp",...}]`,
   so for the demo you pass nothing. To point the gateway at a different MCP
   server instead, override it: a JSON array of `{"id","url","label"}` with no
   single quote in it.
5. Docker running; `corepack pnpm install`; `export AWS_PROFILE=deployer AWS_REGION=us-east-1`;
   and the **Session Manager plugin** for the AWS CLI (for the pinning port-forward).

## Deploy

```bash
cd infra
SHA=$(git rev-parse HEAD)
ACCOUNT=856820205068
export CDK_DEFAULT_ACCOUNT=$ACCOUNT   # the advisory stack takes a concrete env
REGISTRY=$ACCOUNT.dkr.ecr.us-east-1.amazonaws.com
REPO=$REGISTRY/chaperone-gateway
DEMO_REPO=$REGISTRY/chaperone-demo-upstream

# 1. Bootstrap once per account/region.
corepack pnpm exec cdk bootstrap aws://$ACCOUNT/us-east-1

# 2. Data and registry first. Tables are created once and never destroyed.
#    The advisory stack owns chaperone-quarantine and chaperone-advisory, so it
#    must exist before the first rollout or the gateway cannot open a quarantine.
#    Its Groq secret first, read from .env and never echoed:
umask 077; grep -m1 '^GROQ_API_KEY=' ../.env | cut -d= -f2- | tr -d '\r\n"' > /tmp/g
aws secretsmanager create-secret --name chaperone/groq-api-key --secret-string file:///tmp/g; rm -f /tmp/g
corepack pnpm exec cdk deploy ChaperoneTables ChaperoneRegistry ChaperoneAdvisoryPipeline --require-approval never

# 3. Build and push both images, tagged with the same git sha. linux/amd64: the host is x86.
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "$REGISTRY"
docker build --platform linux/amd64 -f ../docker/gateway.Dockerfile --build-arg CHAPERONE_COMMIT=$SHA -t $REPO:$SHA ..
docker build --platform linux/amd64 -f ../docker/demo-upstream.Dockerfile -t $DEMO_REPO:$SHA ..
docker push $REPO:$SHA && docker push $DEMO_REPO:$SHA

# 4. The host. First boot installs Docker and lays down /opt/chaperone; it does not start the gateway.
corepack pnpm exec cdk deploy ChaperoneGateway --exclusively --require-approval never \
  --parameters DomainName=chaperone-demo.duckdns.org
# UpstreamsJson is left at its default: the demo upstream on this host.
ID=$(aws cloudformation describe-stacks --stack-name ChaperoneGateway --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)

# 5. Point DNS at the ElasticIp output (DNS, below) and wait until it resolves.
# 6. Wait for first boot, then roll the image out over SSM.
aws ec2 wait instance-status-ok --instance-ids $ID
run() { aws ssm send-command --instance-ids $ID --document-name AWS-RunShellScript \
  --parameters "commands=[\"$1\"]" --query Command.CommandId --output text; }
CMD=$(run "cloud-init status --wait && /opt/chaperone/deploy.sh $SHA")
aws ssm wait command-executed --command-id $CMD --instance-id $ID
aws ssm get-command-invocation --command-id $CMD --instance-id $ID --query '[Status,StandardOutputContent,StandardErrorContent]'
```

Deploy time, *measured 2026-10-16* (wall clock, from this machine):

| Step | Time |
|---|---|
| `cdk bootstrap` | 1 m 16 s |
| `ChaperoneTables` + `ChaperoneRegistry` | 2 m 10 s |
| Build and push both images, first time (no layer cache in ECR) | 13 m 26 s |
| Build and push both images, second commit | 9 m 58 s |
| `ChaperoneGateway` (VPC, instance, Elastic IP; includes a ~50 s synth) | 4 m 51 s |
| `ChaperoneAdvisoryPipeline`, first deploy (bundles three Lambdas) | 3 m 38 s |
| `ChaperoneAdvisoryPipeline`, an update | 1 m 13 s |
| First rollout, `deploy.sh` over SSM, to both containers healthy | 80 s |
| Let's Encrypt certificate, after DNS resolved | issued during that first rollout; the first HTTPS request after it succeeded |

Image push dominates and is bound by this machine's upload bandwidth, not AWS.
The gateway image is 228 MB in ECR.

`deploy.sh` logs in to ECR, points `/opt/chaperone/.env` at `<repo>:<sha>` for
both images, pulls, runs `docker compose up -d`, and waits up to 120 s for the
gateway's and the demo upstream's HEALTHCHECKs to pass. If either does not, it
restores the previous images and exits non-zero. After a good rollout it prunes
unused images (each is about 1.1 GB; the disk is 20 GB), so a rollback re-pulls
the old tag from ECR.

### DNS

DNS is **external**. The stack has no hosted zone and writes no record; it
outputs `ElasticIp`, and the hostname's A record is pointed there by hand,
once. For the live deployment that is DuckDNS: `chaperone-demo.duckdns.org` ->
`184.196.88.164`, set on duckdns.org on 2026-10-16. Do not roll the image out
until `nslookup chaperone-demo.duckdns.org 8.8.8.8` returns the Elastic IP:
Caddy requests its certificate from Let's Encrypt over HTTP-01 as soon as it
starts, and a name that does not resolve yet burns a failed attempt. Watch
`docker logs chaperone-caddy-1` through SSM. Because the address is an Elastic
IP, it survives stop/start and the record never needs editing. The certificate and ACME account
live in the `caddy_data` volume on the EBS disk, so they survive stop/start and
rollouts. Destroying and recreating the host loses them and re-issues
(Let's Encrypt limits duplicate certificates to 5 per week).

### Pin the upstream's tools

A tool with no pin is refused as unpinned. `pnpm pin:bootstrap` is a `tsx`
entry point (`packages/gateway/scripts/pin-bootstrap.ts`) that is not in the
runtime image, and the demo upstream is not published, so it runs from your
machine through an SSM port-forward to the demo-upstream container, writing to
the real tables with your deployer credentials (no `DDB_ENDPOINT`). Needs the
Session Manager plugin for the AWS CLI.

**On Windows, start the port-forward as a real Windows process**, not a Git Bash
background job: from Git Bash the session printed `Starting session` and never
opened the local port (friction log 049). From PowerShell this works, and
`Port 4000 opened` appears in the log within seconds:

```powershell
Start-Process aws -ArgumentList 'ssm','start-session','--target',$ID,'--document-name',
  'AWS-StartPortForwardingSessionToRemoteHost','--parameters','host=<IP>,portNumber=4000,localPortNumber=4000' `
  -RedirectStandardOutput tunnel.log -WindowStyle Hidden
```

```bash
# the container's address on the host's bridge network (reachable from the host, not the internet)
CMD=$(run "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' chaperone-demo-upstream-1")
aws ssm wait command-executed --command-id $CMD --instance-id $ID
IP=$(aws ssm get-command-invocation --command-id $CMD --instance-id $ID --query StandardOutputContent --output text | tr -d '[:space:]')

aws ssm start-session --target $ID --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$IP,portNumber=4000,localPortNumber=4000" &
CHAPERONE_UPSTREAMS='[{"id":"grocery","url":"http://localhost:4000/mcp","label":"Household Grocery"}]' \
  corepack pnpm pin:bootstrap
kill %1
```

Pins are keyed by upstream id, tool name and definition hash, not by URL, so
pinning through `localhost:4000` is valid for a gateway that reaches the same
server as `demo-upstream:4000`; the local verification below did exactly this.
Ran against AWS on 2026-10-16: `grocery__add_item`, `read_list`, `place_order`
and `track_delivery` were pinned into the real `chaperone-pin` table through the
tunnel, and appeared in `tools/list` over HTTPS straight after.

## Trigger the demo mutation (over SSM)

The demo's one scripted change, `add_item`'s description, is made by
`/opt/chaperone/demo-control.sh`, which sends the request from inside the
`demo-upstream` container to its own loopback. Nothing outside the host can do
this.

```bash
ID=$(aws cloudformation describe-stacks --stack-name ChaperoneGateway --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
ctl() { CMD=$(aws ssm send-command --instance-ids $ID --document-name AWS-RunShellScript \
  --parameters "commands=[\"/opt/chaperone/demo-control.sh $1\"]" --query Command.CommandId --output text)
  aws ssm wait command-executed --command-id $CMD --instance-id $ID
  aws ssm get-command-invocation --command-id $CMD --instance-id $ID --query '[Status,StandardOutputContent]' --output text; }

ctl stats    # 200 {"mutated":false,...}
ctl mutate   # 200 {"mutated":true,"sessionsUpdated":1}   add_item's description has changed
ctl reset    # 200 {"mutated":false,...}                    and back
```

The next `tools/list` through the gateway then shows the changed definition, and
the gateway freezes `add_item` and raises the consent card, which is the demo.
For a shell on the host instead: `aws ssm start-session --target $ID`, then
`/opt/chaperone/demo-control.sh mutate`. Reset between takes with `ctl reset`.
The same script was run for real against the local stack: `stats`, `mutate`,
`stats`, `reset` all answered 200 with the state flipping as shown, and an
unknown argument exits 2. Against AWS on 2026-10-16, `stats`, `mutate`, `stats`
answered 200, with `mutated` flipping to true and 6 upstream sessions notified.

### Clear a pending demo quarantine before a take

`ctl reset` puts the upstream back, but the quarantine the mutation opened
stays `pending` in `chaperone-quarantine`. The next `mutate` produces the same
hash, so the gateway *reuses* that quarantine: the card shows the old detection
time, and no new INSERT reaches the advisory Pipe. Do **not** clear it with the
card's buttons. Approving pins the mutated text, so the demo mutation stops
being a change. Keeping it blocked records a refusal, and a refused change is
never asked about again, so the demo stops raising a card. Both are a
resident's decisions, and neither is yours to make for a take.

Instead remove the staged row and its advisory. This is the narrow AWS
equivalent of `pnpm demo:reset`, which drops the quarantine table locally. The
ledger is not touched: its `TOOL_QUARANTINED` event stays, as the record that
the change was detected.

```bash
Q=<quarantineId>   # from chaperone/pending_changes
K="{\"pk\":{\"S\":\"HOUSEHOLD#household-demo\"},\"sk\":{\"S\":\"QUAR#$Q\"}}"
aws dynamodb get-item --table-name chaperone-quarantine --key "$K" > quarantine-$Q.json   # keep a copy
aws dynamodb delete-item --table-name chaperone-quarantine --key "$K" \
  --condition-expression "#s = :p" --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":p":{"S":"pending"}}'          # only ever a pending one
aws dynamodb delete-item --table-name chaperone-advisory --key "{\"pk\":{\"S\":\"QUAR#$Q\"}}"
```

Done on 2026-10-16 for `01M51BEM84CAZJH85SS1531TNK`, the quarantine from the
first AWS demo mutation. Afterwards `chaperone/pending_changes` over HTTPS
answered "No tool-definition changes are currently pending review.",
`add_item` was back in `tools/list`, and `verify-ledger` still reported chain OK
with 7 events. The next `mutate` opens a fresh quarantine, and the Pipe scores it
by itself.

### Advisory pipeline smoke test (Pipe-started, no household involved)

```bash
DDB_TABLE_PREFIX=chaperone HOUSEHOLD_ID=household-demo \
  CHAPERONE_UPSTREAMS='[{"id":"unused","url":"http://localhost:0/mcp","label":"unused"}]' \
  corepack pnpm advisory:pipe-smoke
```

`scripts/advisory-pipe-smoke.ts` inserts one labelled fixture quarantine into a
throwaway household (`pipe-smoke-<ulid>`), with no ledger event and no usable
approval token. It starts nothing itself: the EventBridge Pipe must start the
execution from the stream INSERT. The script waits for the advisory row, then
deletes both rows it created (the delete is a stream REMOVE, which the Pipe
ignores). One Groq call per run.

**Result, 2026-10-16:** the Pipe started execution
`7617cada-068c-48b8-99a3-e448bc373a87` by itself, from the fixture insert in
`pipe-smoke-01M51EGQ5KWTB51ZD2876MZKK0`. It `SUCCEEDED` in 5.3 s:
`ScoreAdvisoryTask` `scored` (Groq `openai/gpt-oss-120b`, score 60, summary
naming the new "send a copy of every note" clause), `ChangelogCheckTask`
`unresolved` (`upstream-has-no-repo`), and `WriteAdvisoryTask` `written: true`.
The advisory row appeared 7.0 s after the insert, and both fixture rows were then
deleted. The first attempt timed out on the ledger client's 5 s request timeout
before the insert, and wrote nothing (a scan for `pipe-smoke-` rows returned 0).

To view it in the console: Step Functions, region us-east-1, State machines,
`chaperone-advisory-pipeline`, then the execution named above. The Graph view
shows the Parallel branch and the write. Its input is the Pipe's batch array,
`[{"householdId": "pipe-smoke-…", "quarantineId": "01M51EGQ5M25XZ4NGVB7ZKGWC5"}]`.
The earlier executions on the same machine are `ba17bd94-…` (Pipe-started from the
real demo mutation; failed on friction log 050, then redriven into 051's hollow
success) and `phase18-pipe-input-01M51BEM84CAZJH85SS1531TNK` (started by hand
with Pipe-identical input, after both fixes).

## Smoke test

```bash
D=https://gateway.example.com
curl -s -o /dev/null -w '%{http_code}\n' http://gateway.example.com/healthz   # 308: Caddy redirects to HTTPS
curl -s $D/healthz | jq '{status, storageBackend, gateWhenUnhealthy}'
#   expect storageBackend "dynamodb-aws"; a 503 means storage is failing and every gated tool is withheld

for p in /control/stats /control/mutate /control/reset; do
  curl -s -X POST -o /dev/null -w "$p -> %{http_code}\n" $D$p     # all three must be 404 (the gateway's, not the demo upstream's)
done
nc -zv -w3 <ELASTIC_IP> 4000; nc -zv -w3 <ELASTIC_IP> 3000        # both must fail: only 80 and 443 are open

TARGET=$D/mcp corepack pnpm spec            # 27 named assertions, against the deployed gateway
TARGET=$D/mcp corepack pnpm test:resume     # 10-iteration kill-and-resume loop; must be 10/10
TARGET=$D/mcp corepack pnpm exec vitest run --config spec/stack.vitest.config.ts spec/long-stream.test.ts   # 180 s stream
corepack pnpm verify-ledger                 # deployer credentials, no DDB_ENDPOINT
```

A hand-rolled `initialize` must send `protocolVersion` `2025-11-25` or later;
the gateway answers an older one with a 400 that says so.

**Result against the deployment, 2026-10-16** (image `c4ed3d5`):

| Check | Result |
|---|---|
| `http://…/healthz` | 308 to HTTPS |
| `https://…/healthz` | 200, `status` ok, `storageBackend` `dynamodb-aws`, `commit` matches the image |
| TLS | Let's Encrypt `YE2`, `CN=chaperone-demo.duckdns.org`, TLS 1.3, verify return code 0, valid to 2027-01-14 |
| `/control/stats`, `/control/mutate`, `/control/reset` through Caddy | 404, 404, 404 (the gateway's) |
| ports 3000 and 4000 on the Elastic IP | closed |
| `initialize` / `tools/list` / `tools/call grocery__read_list` over HTTPS | negotiated `2025-11-25`; 4 grocery tools + 2 first-party; `"The shopping list is empty."` |
| `TARGET=…/mcp pnpm test:resume` | **10/10** in 78 s; every iteration replayed seq 2 and invoked `place_order` exactly once |
| `spec/long-stream.test.ts` | **passed**, one SSE stream held for 182.8 s over HTTPS through Caddy |
| `pnpm verify-ledger` (deployer credentials) | chain OK, 7 events verified |

So "resumable SSE works through Caddy on AWS" is now demonstrated, for one run
of each. `pnpm spec` against the deployment was not run on 2026-10-16.

### Latency against DynamoDB on AWS

Run the bench **on the instance**, inside the compose network, so the direct
and the proxied call are both local to the host and only the gateway's
DynamoDB calls leave it. The host has no checkout and no `tsx`, so the bench is
bundled into one file, shipped through a presigned URL from the CDK assets
bucket (the instance role needs no new permission), and run in a `node`
container on `chaperone_default`:

```bash
SHA=$(git rev-parse HEAD)   # from a clean tree, or the file says dirty
infra/node_modules/.bin/esbuild packages/bench/scripts/bench.ts --bundle --platform=node --format=esm \
  --target=node24 --outfile=bench.mjs --alias:node:module=./infra/lambda/node-module-shim.ts \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
B=cdk-hnb659fds-assets-$ACCOUNT-us-east-1
aws s3 cp bench.mjs s3://$B/chaperone-bench/bench-$SHA.mjs
URL=$(aws s3 presign s3://$B/chaperone-bench/bench-$SHA.mjs --expires-in 900)
# then over SSM (send the commands as a file:// parameters JSON; the URL holds '&'):
#   curl -fsS "$URL" -o /opt/chaperone/bench/bench.mjs
#   docker run --rm --network chaperone_default -m 256m -v /opt/chaperone/bench:/b -w /b \
#     -e BENCH_GATEWAY_URL=http://gateway:3000/mcp -e BENCH_DIRECT_URL=http://demo-upstream:4000/mcp \
#     -e BENCH_VANTAGE=on-host -e BENCH_INSTANCE_TYPE=t3.micro -e BENCH_COMMIT=$SHA -e BENCH_DIRTY=false \
#     node:24.14.1-alpine node bench.mjs --no-reset-sse --no-ledger --rate=8
#   cat /opt/chaperone/bench/benchmarks/latency.json      # copy it back into the repo
```

The flags each have a reason. `--rate=8`: the gateway rate-limits each client
IP to 10 requests/s (`MCP_RATE_LIMIT`); on the host a call takes a few ms, so an
unpaced run at concurrency 4 is cut off with `-32000 Too many requests` (the
first on-host attempt was). Both modes are paced the same. `--no-ledger`: the
bundle cannot spawn `verify-ledger`, so the block says NOT RUN; run `pnpm
verify-ledger` from a workstation. `--no-reset-sse`: `reset-sse` refuses
without `DDB_ENDPOINT`, and TTL evicts on AWS anyway. The `node:module` alias
is the same shim as the Lambdas, for the same `canonicalize` load. Fetch the
SSM output with `PYTHONUTF8=1` set on Windows (friction log 052).

**Result, 2026-10-16, gateway image `60e5967`, bench `502d3d0` (clean tree),
1000 samples per mode, concurrency 4, paced at 8/s: added p50 33.10 ms, p95
53.82 ms, p99 129.25 ms. Over the 30 ms p95 budget by 23.82 ms; `pnpm bench`
exited 1.** Direct p50/p95 2.60/3.83 ms, proxied 35.70/57.65 ms.
`benchmarks/latency.json` records `backend` `dynamodb-aws`, `vantage`
`on-host`, `instanceType` `t3.micro`, `ratePerSecond` 8.

CPU credits were **not** a factor. The instance is in T3 `unlimited` mode,
which never throttles; over the run (04:06-04:11 UTC) `CPUCreditBalance` rose
from 8.0 to 8.2, `CPUSurplusCreditBalance` and `CPUSurplusCreditsCharged` stayed
0, and `CPUUtilization` peaked at 14% (5-minute averages 5-12%).

Where the time goes, as far as measured: DynamoDB's own
`SuccessfulRequestLatency` in that window was 2.07 ms average per `PutItem` and
2.29 ms per `UpdateItem` on `chaperone-sse-event` (2230 of each), and 0.90 ms per
`GetItem` on `chaperone-pin` (1212). The pin read and four sse-event writes are
roughly 9 ms of server time per call before any network round trip. The rest of
the 33 ms is not attributed; nothing here establishes how much is round trips
and how much is the gateway itself.

**Superseded:** the first AWS run, earlier the same day, went through two SSM
port-forwards from a laptop in India to the gateway and demo-upstream
containers. It reported added p95 835.78 ms, but its direct p50 was 249.70 ms
of tunnel, and the tunnel's jitter, which does not cancel, made the tail. That
number measured the tunnel. The file is kept unedited in
`benchmarks/superseded/latency-2026-10-16-ssm-tunnel.json`, with
`benchmarks/superseded/README.md` saying why.

## Memory budget on a `t3.micro`

A `t3.micro` has 1 GiB, about 0.9 GiB usable. Three containers run beside the
OS, Docker and the SSM agent. Container memory is **measured** (the local stack,
`docker stats` every second for about a minute under the 10-iteration resume
loop, then every 4 s during the 180 s stream). The table below is that local
measurement and the original host estimate; the real host's numbers, measured
2026-10-16, follow it.

| Component | Idle | Peak under load | Compose limit | Source |
|---|---|---|---|---|
| gateway | 49 MiB | 71 MiB | 300 MiB (V8 heap capped at 160) | measured |
| demo-upstream | 36 MiB | 55 MiB | 160 MiB (heap capped at 96) | measured |
| caddy | 14 MiB | 16 MiB | 96 MiB | measured |
| **Containers, sum of peaks** | | **142 MiB** | 556 MiB if every limit were hit | measured |
| OS, dockerd, containerd, SSM agent | | about 300-400 MiB | | estimate |
| **Expected total** | | **about 450-550 MiB of about 900** | | |

So it fits with roughly 350 MiB of headroom, plus the 1 GiB swapfile the
first-boot script adds. No container was OOM-killed. The compose limits sit well
above the measured peaks and well under the host's total, so a runaway container
is killed on its own and does not take down Docker or SSM with it. During a
rollout the old and new containers briefly overlap (`docker compose up -d`
recreates in place, not side by side, so this is short).

**Measured on the real host, 2026-10-16** (`free -m` and `docker stats
--no-stream` over SSM):

| Moment | used | available | swap used | gateway | demo-upstream | caddy |
|---|---:|---:|---:|---:|---:|---:|
| during the 180 s stream, after `test:resume` | 521 MiB | 203 MiB | 19 MiB | 74.9 MiB | 64.6 MiB | 17.6 MiB |
| idle, after the rollback test | 441 MiB | 292 MiB | 45 MiB | 73.5 MiB | 40.6 MiB | 20.0 MiB |

Total 916 MiB. Host overhead (used minus the containers) came to about
300-365 MiB, inside the 300-400 estimate. Available memory stayed above the
150 MiB line, but swap is in light use (19-45 MiB) and only about 200 MiB is
available under load: `t3.micro` fits, without much margin. If a later run
shows available under 150 MiB, move to `t3.small` (about +$0.25/day). Disk:
4.7 GB of 20 GB used.

## Verify Caddy locally

This uses the real `deploy/Caddyfile` and `deploy/docker-compose.yml`, with a
locally built gateway, DynamoDB Local and the demo upstream behind Caddy on
`http://localhost:8080` (plain HTTP, so no certificate and no TLS path).

```bash
C="docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml --env-file deploy/local.env -p chaperone-caddy"
$C up -d --build ddb demo-upstream
export DDB_ENDPOINT=http://localhost:8000 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
  CHAPERONE_UPSTREAMS='[{"id":"grocery","url":"http://localhost:4000/mcp","label":"Household Grocery"}]'
corepack pnpm ddb:migrate
( unset CHAPERONE_UPSTREAMS DDB_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; $C up -d --build gateway caddy )
corepack pnpm pin:bootstrap
TARGET=http://localhost:8080/mcp corepack pnpm test:resume
TARGET=http://localhost:8080/mcp corepack pnpm exec vitest run --config spec/stack.vitest.config.ts spec/long-stream.test.ts
$C down -v
```

The `unset` matters: compose gives shell variables priority over `--env-file`,
and an exported `CHAPERONE_UPSTREAMS=localhost:4000` makes the gateway
container look for its upstream on its own loopback.

**Result, 2026-10-10**, with the full three-service layout (gateway, demo
upstream, Caddy, memory limits applied): `test:resume` 10/10 iterations passed
through Caddy, and `long-stream.test.ts` held a single SSE stream for 180.7 s
(36 progress notifications) without being cut. Both application containers ran
as `uid=1000(node)` with their HEALTHCHECKs passing, and none was OOM-killed or
restarted. `/control/stats`, `/control/mutate`, `/control/reset` and
`/control/place-order-delay` through Caddy all returned the gateway's 404, and
`demo-control.sh` drove the real demo upstream (`stats`, `mutate`, `stats`,
`reset` all 200, with `mutated` flipping true then false). What this does not cover: TLS, HTTP/2 and HTTP/3,
the public internet, a real EC2 network path, and DynamoDB on AWS.

## Rollback

Image tags are immutable git shas, so rolling back is rolling out the previous
one. Over SSM, from any machine with deployer credentials:

```bash
CMD=$(run "/opt/chaperone/deploy.sh <PREVIOUS_SHA>")
aws ssm wait command-executed --command-id $CMD --instance-id $ID
```

A failed rollout already restores the previous image by itself (see Deploy).
If the host itself is broken, rebuild it: `cdk destroy ChaperoneGateway`, then
repeat Deploy steps 4 to 6. The tables and the image are untouched; the Caddy
certificate is re-issued, and **the Elastic IP is a new address**, so the DNS
record must be updated by hand before Caddy can get a certificate.

Rollback timing, *measured 2026-10-16*, rolling `60e5967` back to `c4ed3d5`
over SSM: **87.7 s** from `send-command` to SSM `Success` (it includes
re-pulling the old tag, because `deploy.sh` prunes unused images), and the
public `/healthz` was unreachable for **15.9 s** (last answer from the old
commit to first answer from the new one, polled about every 0.5 s). The two
roll-forwards the same day took 85.1 s and 86.8 s, with 16.7 s and 16.6 s
unreachable. A rollout is therefore about 90 s, of which about 16 s is
downtime: `docker compose up -d` replaces the containers in place, so the old
ones are gone before the new ones are healthy.

**Changing a file under `deploy/` does not reach the running host.** The host's
copy is written once, by the first-boot script. The `deploy.sh` fix of
2026-10-16 was written to the live host over SSM. A `cdk deploy
ChaperoneGateway` after such a change alters the instance's user data, which
CloudFormation applies by stopping and starting the instance (the Elastic IP is
kept); review `cdk diff` first.

## Stop (pause), after submission on 2026-10-22

```bash
ID=$(aws cloudformation describe-stacks --stack-name ChaperoneGateway --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
# Evidence first: dump the ledger and verify the chain with deployer credentials.
corepack pnpm ddb:dump && corepack pnpm verify-ledger
aws ec2 stop-instances --instance-ids $ID
aws ec2 wait instance-stopped --instance-ids $ID
aws ec2 describe-instances --instance-ids $ID --query "Reservations[0].Instances[0].State.Name" --output text   # stopped
```

Stopping keeps the EBS disk (images, certificate), the Elastic IP, the role
and every table. The external DNS record points at the Elastic IP, so nothing
needs editing.

### What still costs while stopped

| Item | Why it persists | $/day |
|---|---|---|
| Elastic IP | **a public IPv4 address is billed hourly whether or not the instance is running** | 0.12 |
| EBS 20 GB gp3 | the disk is kept | 0.05 |
| Secrets Manager, one secret | $0.40/month | 0.01 |
| ECR image storage | image kept for the restart | 0.00 |
| DynamoDB storage + PITR, log group | tables retained | about 0 |
| **Total while stopped** | | **about 0.18** |

Releasing the Elastic IP while stopped would save about $0.12/day (about $1.80
over the 15 paused days) but the address would then change on the next start,
and the A record would have to be updated by hand before Caddy could renew or
re-issue. That is a fragile saving for a judged deployment. The default here
keeps the Elastic IP. If you do release it: start the instance, allocate and
associate a new address, then update the DuckDNS record by hand (the stack's
own Elastic IP will drift, so do not run `cdk deploy ChaperoneGateway` again
without reviewing the diff).

## Start (resume), on 2026-11-07

```bash
aws ec2 start-instances --instance-ids $ID
aws ec2 wait instance-status-ok --instance-ids $ID
```

Docker starts at boot and both containers have `restart: unless-stopped`, so the
gateway and Caddy come back by themselves with the image already on disk; no
ECR login or pull is needed. The Elastic IP is the same, so DNS needs nothing.
Then run the smoke test. If a container did not come back, run
`/opt/chaperone/deploy.sh <SHA>` over SSM. Re-pin only if the upstream's tools
changed; if they did, the gateway correctly refuses them until a resident
approves, which is the product working. Start-to-healthy timing: *not yet measured.*

The Let's Encrypt certificate issued at first deploy is valid for 90 days and is
renewed by Caddy in the last third of its life, so it will not lapse during the
stopped window or judging if the first deploy is on or after 2026-10-16.

## Teardown (after 2026-11-20)

```bash
cd infra
corepack pnpm exec cdk destroy ChaperoneGateway ChaperoneRegistry ChaperoneAdvisoryPipeline
```

`ChaperoneTables` and the advisory pipeline's two tables are `RETAIN`. Deleting
the evidence chain is deliberate and manual; take a `pnpm ddb:dump` first, then:

```bash
for t in corpus-server tool-snapshot drift-record pin ledger-event session sse-event quarantine advisory; do
  aws dynamodb delete-table --table-name chaperone-$t --region us-east-1
done
corepack pnpm exec cdk destroy ChaperoneTables   # now just removes the empty stack
```

Then `aws secretsmanager delete-secret --secret-id chaperone/groq-api-key`,
release the DuckDNS name on duckdns.org, and delete the `CDKToolkit` bootstrap
stack if nothing else uses it (empty its `cdk-hnb659fds-assets-…` bucket
first). Confirm nothing is left
billing: `aws ec2 describe-instances`, `aws ec2 describe-addresses`.

## Cost

List-price estimates for us-east-1 from published on-demand rates as I know them;
**not measured and not checked against the live Pricing API** (the preflight
identity cannot call it). Compare with Cost Explorer after the first deployed
day. The credit balance, expiry and free-tier plan could not be read (the
identity has no billing access): check them in the console under Billing >
Credits and Free Tier before relying on them.

| Item | Basis | $/day running |
|---|---|---|
| EC2 `t3.micro` | $0.0104/h | 0.25 |
| Public IPv4 (Elastic IP) | $0.005/h | 0.12 |
| EBS 20 GB gp3 | $0.08/GB-month | 0.05 |
| CloudWatch Logs ingest | $0.50/GB, assumed under 50 MB/day | 0.03 |
| DynamoDB on-demand, 9 tables, PITR on two | cents at this volume | 0.01 |
| Secrets Manager, one secret (the Groq key) | $0.40/month | 0.01 |
| ECR storage, two repos plus the CDK assets repo | under 1 GB at $0.10/GB-month | 0.01 |
| Lambda, Step Functions, EventBridge Pipe | per use; one execution per quarantine | 0.00 |
| S3, the CDK bootstrap bucket | a few MB of templates and Lambda zips | 0.00 |
| Data transfer out | first 100 GB/month free | 0.00 |
| Route 53, ALB, ACM, NAT gateway | not used (DNS is DuckDNS, free) | 0.00 |
| **Total while running** | | **about $0.47** |

Not on the AWS bill: Groq charges for each advisory it scores (one model call
per quarantine), on its own account.

Use `t3.small` ($0.0208/h, +$0.25/day, about $0.73/day) only if `t3.micro`
runs out of memory; the first-boot script adds a 1 GB swapfile to make that less
likely. Whether `t3.micro` is free-tier eligible depends on the account's plan,
which I could not read. If it is, instance hours, the 20 GB disk (30 GB allowed)
and one public IPv4 address (750 hours/month) could be free, which would bring
the running figure under $0.15/day. That is **not** assumed in the table.

| Case | Days | Running | Stopped | Total |
|---|---|---|---|---|
| A. Continuous, Oct 16 to Nov 20 | 36 running | 36 x 0.47 = $16.9 | none | **about $17** |
| B. Running Oct 16-22 and Nov 7-20, stopped Oct 23 to Nov 6 | 21 running + 15 stopped | 21 x 0.47 = $9.9 | 15 x 0.18 = $2.7 | **about $13** |

B saves about $4 over A, because the Elastic IP, disk and secret keep billing while
stopped. Stopping is still worth doing, but the saving is small; the real cost
risk is a forgotten resource or a failed teardown, so confirm with
`aws ec2 describe-instances` after each step. For comparison, the Fargate + ALB
design priced at about $1.65/day, or about $59 and $35 for the same two cases.
