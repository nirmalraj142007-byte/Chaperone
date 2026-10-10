# Runbook: deploying, pausing and resuming the gateway on AWS

Status: **written, synthesized and partly verified locally; never applied.**
`cdk synth` passes and `infra/test/ec2-gateway-stack.test.ts` asserts the
properties below. Caddy has been run against the resumability suites on a local
machine (see "Verify Caddy locally"). No stack in this file has been deployed,
so nothing here has been tested on AWS. Every timing marked *not yet measured*
is exactly that; fill it in during the first real deploy and remove the marker.

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
| `ChaperoneRegistry` | ECR repo `chaperone-gateway`, immutable tags | Stays up. The image for every rollout and rollback is here. |
| `ChaperoneGateway` | VPC (one public subnet, no NAT), `t3.micro` host, Elastic IP, Route 53 A record, security group, instance role, 30-day log group | Pause = *stop the instance*, not destroy the stack. |

`ChaperoneGateway` addresses the tables by name-derived ARN, not by
cross-stack reference. The host exposes only 80/tcp, 443/tcp and 443/udp. There
is **no SSH**: shell access is SSM Session Manager and rollouts are SSM Run
Command. IMDSv2 is required with a hop limit of 2; the default of 1 would stop
the gateway container reaching the instance role's credentials, and every
DynamoDB call would then fail closed.

Stack parameters, supplied at deploy time: `DomainName`, `HostedZoneId`,
`HostedZoneName`, `UpstreamsJson`, and `InstanceType` (default `t3.micro`;
x86 only).

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

1. **Credentials.** The `chaperone-dev` IAM user cannot do this. The 2026-10-10
   read-only preflight showed it is denied on EC2 describe calls, EC2 address
   allocation, CloudFormation, ECS, ECR, ACM, Route 53, DynamoDB listing, SSM
   parameters, billing, Cost Explorer and Service Quotas. Deploy as a user or
   role that can create EC2, IAM roles, Route 53 records, CloudWatch log groups,
   DynamoDB tables and ECR repositories. Whether this account can launch an EC2
   instance at all is **not established**: a dry-run launch could not be
   completed without an AMI id the identity could not look up.
2. **A Route 53 hosted zone** for the domain, in the same account. The stack
   writes the A record into it.
3. **An upstream the gateway can reach.** `UpstreamsJson` is a JSON array of
   `{"id","url","label"}` and must not contain a single quote. **Open item:**
   nothing here deploys the staged `demo-upstream`. Point it at a reachable MCP
   server, or host `demo-upstream` separately first. Without one the gateway
   serves, but every upstream tool is withheld.
4. Docker running; `corepack pnpm install`; `export AWS_REGION=us-east-1`.

## Deploy

```bash
cd infra
SHA=$(git rev-parse HEAD)
ACCOUNT=<ACCOUNT_ID>
REPO=$ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/chaperone-gateway

# 1. Bootstrap once per account/region. (Not run yet: this creates resources.)
corepack pnpm exec cdk bootstrap aws://$ACCOUNT/us-east-1

# 2. Data and registry first. Tables are created once and never destroyed.
corepack pnpm exec cdk deploy ChaperoneAdvisoryPipeline ChaperoneTables ChaperoneRegistry

# 3. Build and push the image, tagged with the git sha. linux/amd64: the host is x86.
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REPO%%/*}"
docker build --platform linux/amd64 -f ../docker/gateway.Dockerfile --build-arg CHAPERONE_COMMIT=$SHA -t $REPO:$SHA ..
docker push $REPO:$SHA

# 4. The host. First boot installs Docker and lays down /opt/chaperone; it does not start the gateway.
corepack pnpm exec cdk deploy ChaperoneGateway \
  --parameters DomainName=gateway.example.com \
  --parameters HostedZoneId=Z0123456789ABC \
  --parameters HostedZoneName=example.com \
  --parameters UpstreamsJson='[{"id":"grocery","url":"https://<upstream>/mcp","label":"Household Grocery"}]'
ID=$(aws cloudformation describe-stacks --stack-name ChaperoneGateway --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)

# 5. Wait for first boot, then roll the image out over SSM.
aws ec2 wait instance-status-ok --instance-ids $ID
run() { aws ssm send-command --instance-ids $ID --document-name AWS-RunShellScript \
  --parameters "commands=[\"$1\"]" --query Command.CommandId --output text; }
CMD=$(run "cloud-init status --wait && /opt/chaperone/deploy.sh $SHA")
aws ssm wait command-executed --command-id $CMD --instance-id $ID
aws ssm get-command-invocation --command-id $CMD --instance-id $ID --query '[Status,StandardOutputContent,StandardErrorContent]'
```

Deploy time: *not yet measured.*

`deploy.sh` logs in to ECR, points `/opt/chaperone/.env` at `<repo>:<sha>`,
pulls, runs `docker compose up -d`, and waits up to 120 s for the gateway
container's HEALTHCHECK to pass. If it does not, it restores the previous image
and exits non-zero.

### DNS

The stack creates the A record from `DomainName` to the Elastic IP (TTL 60 s).
If the domain is not registered with Route 53, delegate the hosted zone's NS
records at the registrar once, up front. Caddy requests its certificate from
Let's Encrypt over HTTP-01 as soon as the name resolves to the host, so the first
HTTPS request can take a minute after DNS propagates; watch
`docker logs chaperone-caddy-1` through SSM. The certificate and ACME account
live in the `caddy_data` volume on the EBS disk, so they survive stop/start and
rollouts. Destroying and recreating the host loses them and re-issues
(Let's Encrypt limits duplicate certificates to 5 per week).

### Pin the upstream's tools

A tool with no pin is refused as unpinned. From a machine with deployer
credentials, against the real tables (no `DDB_ENDPOINT`):

```bash
CHAPERONE_UPSTREAMS='<same JSON>' corepack pnpm pin:bootstrap
```

## Smoke test

```bash
D=https://gateway.example.com
curl -s -o /dev/null -w '%{http_code}\n' http://gateway.example.com/healthz   # 308: Caddy redirects to HTTPS
curl -s $D/healthz | jq '{status, storageBackend, gateWhenUnhealthy}'
#   expect storageBackend "dynamodb-aws"; a 503 means storage is failing and every gated tool is withheld

TARGET=$D/mcp corepack pnpm spec            # 27 named assertions, against the deployed gateway
TARGET=$D/mcp corepack pnpm test:resume     # 10-iteration kill-and-resume loop; must be 10/10
TARGET=$D/mcp corepack pnpm exec vitest run --config spec/stack.vitest.config.ts spec/long-stream.test.ts   # 180 s stream
corepack pnpm verify-ledger                 # deployer credentials, no DDB_ENDPOINT
```

Until these have run against the deployment, "resumable SSE works through
Caddy on AWS" is **not demonstrated**; only the local result below is. Added
latency against DynamoDB on AWS is also unmeasured: run `corepack pnpm bench`
against `$D` and put the result in the README's "Not measured yet" table.

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

**Result, 2026-10-10:** `test:resume` 10/10 iterations passed through Caddy, and
`long-stream.test.ts` held a single SSE stream for 180.4 s (36 progress
notifications) without being cut. The gateway container ran as `uid=1000(node)`
and its HEALTHCHECK passed. What this does not cover: TLS, HTTP/2 and HTTP/3,
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
repeat Deploy steps 4 and 5. The tables and the image are untouched; the Elastic IP and the Caddy certificate are recreated.
Rollback timing: **not yet measured.**

## Stop (pause), after submission on 2026-10-22

```bash
ID=$(aws cloudformation describe-stacks --stack-name ChaperoneGateway --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
# Evidence first: dump the ledger and verify the chain with deployer credentials.
corepack pnpm ddb:dump && corepack pnpm verify-ledger
aws ec2 stop-instances --instance-ids $ID
aws ec2 wait instance-stopped --instance-ids $ID
aws ec2 describe-instances --instance-ids $ID --query "Reservations[0].Instances[0].State.Name" --output text   # stopped
```

Stopping keeps the EBS disk (images, certificate), the Elastic IP, the DNS
record, the role and every table. Nothing needs editing in DNS.

### What still costs while stopped

| Item | Why it persists | $/day |
|---|---|---|
| Elastic IP | **a public IPv4 address is billed hourly whether or not the instance is running** | 0.12 |
| EBS 20 GB gp3 | the disk is kept | 0.05 |
| Route 53 hosted zone | you keep the zone | 0.02 |
| ECR image storage | image kept for the restart | 0.00 |
| DynamoDB storage + PITR, log group | tables retained | about 0 |
| **Total while stopped** | | **about 0.19** |

Releasing the Elastic IP while stopped would save about $0.12/day (about $1.80
over the 15 paused days) but the address would then change on the next start,
and the A record would have to be updated by hand before Caddy could renew or
re-issue. That is a fragile saving for a judged deployment. The default here
keeps the Elastic IP. If you do release it: start the instance, allocate and
associate a new address, then update the record with
`aws route53 change-resource-record-sets` (the stack's own record will drift,
so do not run `cdk deploy ChaperoneGateway` again without reviewing the diff).

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

Finally delete the hosted zone if you created it only for this, and the
`CDKToolkit` bootstrap stack if nothing else uses it. Confirm nothing is left
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
| DynamoDB on-demand + PITR | cents at this volume | 0.01 |
| Route 53 zone (if new) | $0.50/month | 0.02 |
| ECR storage | about 1 GB at $0.10/GB-month | 0.00 |
| Data transfer out | first 100 GB/month free | 0.00 |
| ALB, ACM, NAT gateway | not used | 0.00 |
| **Total while running** | | **about $0.48** |

Use `t3.small` ($0.0208/h, +$0.25/day, about $0.73/day) only if `t3.micro`
runs out of memory; the first-boot script adds a 1 GB swapfile to make that less
likely. Whether `t3.micro` is free-tier eligible depends on the account's plan,
which I could not read. If it is, instance hours, the 20 GB disk (30 GB allowed)
and one public IPv4 address (750 hours/month) could be free, which would bring
the running figure under $0.15/day. That is **not** assumed in the table.

| Case | Days | Running | Stopped | Total |
|---|---|---|---|---|
| A. Continuous, Oct 16 to Nov 20 | 36 running | 36 x 0.48 = $17.3 | none | **about $17** |
| B. Running Oct 16-22 and Nov 7-20, stopped Oct 23 to Nov 6 | 21 running + 15 stopped | 21 x 0.48 = $10.1 | 15 x 0.19 = $2.9 | **about $13** |

B saves about $4 over A, because the Elastic IP, disk and zone keep billing while
stopped. Stopping is still worth doing, but the saving is small; the real cost
risk is a forgotten resource or a failed teardown, so confirm with
`aws ec2 describe-instances` after each step. For comparison, the Fargate + ALB
design priced at about $1.65/day, or about $59 and $35 for the same two cases.
