# Runbook: deploying, pausing and resuming the gateway on AWS

Status: **written and synthesized, never applied.** `cdk synth` passes and
`infra/test/gateway-stack.test.ts` asserts the properties below, but no stack in
this file has been deployed. Every timing marked *not yet measured* is exactly
that. Fill them in during the first real deploy and remove the marker.

The local path (`docker compose up -d --build`, README Quickstart) works any
time and needs no AWS account. The live deployment exists for judging
(2026-11-09 to 2026-11-20).

## Why Fargate + ALB (and not the cheaper options)

- **Not App Runner.** App Runner caps request duration at 120 s. Resumable SSE
  is the flagship technical claim, so the stream must be able to sit idle for
  minutes. The ALB idle timeout is set to 300 s.
- **Fargate + ALB over a single EC2 instance with Caddy.** A cheaper
  single-instance design (EC2, Docker Compose, Caddy for TLS) was proposed on
  2026-10-10 and not built; the managed path was chosen instead: no host to
  patch, a health-checked replace-on-failure task, and ACM-issued TLS with no
  certificate state on a box. It costs more per day (see Cost below); that was
  accepted because the account has AWS credits.
- **Public subnets, public IP, no NAT gateway.** A NAT gateway alone would be
  about $1.10/day. The task's security group admits only the ALB's, so the
  public IP is for outbound traffic (ECR pull, DynamoDB, upstreams), not inbound.

## What gets deployed

| Stack | Holds | Lifecycle |
|---|---|---|
| `ChaperoneAdvisoryPipeline` | `chaperone-quarantine`, `chaperone-advisory`, the Step Functions advisory pipeline | Stays up. Owns those two tables. |
| `ChaperoneTables` | the other 7 tables, from `TABLE_SCHEMAS`; every one `RETAIN` | **Never destroyed**, so data survives a pause. |
| `ChaperoneRegistry` | ECR repo `chaperone-gateway`, immutable tags | Stays up while paused (the image is already in it). |
| `ChaperoneGateway` | VPC, ALB, Fargate service, ACM cert, Route 53 alias, logs | Destroyed to pause, redeployed to resume. |

`ChaperoneGateway` addresses the tables by name-derived ARN, not by
cross-stack reference, so destroying it never touches `ChaperoneTables`.
Parameters, supplied at deploy time: `DomainName`, `HostedZoneId`,
`HostedZoneName`, `UpstreamsJson`.

Task role grants (read off the repos; asserted by test):

| Table | Actions |
|---|---|
| `ledger-event` | GetItem, PutItem, Query. **No UpdateItem, no DeleteItem.** |
| `pin` | GetItem, PutItem, Query |
| `quarantine` | GetItem, PutItem, Query, UpdateItem |
| `advisory` | GetItem |
| `session` | GetItem, PutItem, UpdateItem, DeleteItem |
| `sse-event` | PutItem, UpdateItem, Query |
| `corpus-server`, `tool-snapshot`, `drift-record` | none (crawler and analysis run locally) |

## Before you start

1. **Credentials.** The `chaperone-dev` IAM user cannot do this. The 2026-10-10
   read-only preflight showed it has no access to CloudFormation, ECS, ECR, ACM,
   Route 53, DynamoDB listing, billing or Service Quotas, and it cannot call
   `ec2:DescribeAvailabilityZones`. Deploy as a user or role that can create
   those, or attach a policy to a dedicated deployer.
2. **A Route 53 hosted zone** for the domain, in the same account. Certificate
   validation and the alias record are written into it, which is what makes the
   resume step hands-off.
3. **An upstream the gateway can reach.** `UpstreamsJson` is a JSON array of
   `{"id","url","label"}`. **Open item:** nothing in these stacks deploys the
   staged `demo-upstream`. Point it at a reachable MCP server, or host
   `demo-upstream` separately before the first deploy. Without one the gateway
   serves, but every upstream tool is withheld (`/healthz` reports `degraded`).
4. Docker running; `corepack pnpm install`; `export AWS_REGION=us-east-1`.

## Deploy

```bash
cd infra
SHA=$(git rev-parse HEAD)

# 1. Bootstrap once per account/region. (Not run yet: this creates resources.)
corepack pnpm exec cdk bootstrap aws://<ACCOUNT_ID>/us-east-1

# 2. Data and registry first. Tables are created once and never destroyed.
corepack pnpm exec cdk deploy ChaperoneAdvisoryPipeline ChaperoneTables ChaperoneRegistry

# 3. Build and push the image, tagged with the git sha.
REPO=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/chaperone-gateway
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REPO%%/*}"
docker build -f ../docker/gateway.Dockerfile --build-arg CHAPERONE_COMMIT=$SHA -t $REPO:$SHA ..
docker push $REPO:$SHA

# 4. The gateway. The first deploy waits on certificate validation.
corepack pnpm exec cdk deploy ChaperoneGateway -c imageTag=$SHA \
  --parameters DomainName=gateway.example.com \
  --parameters HostedZoneId=Z0123456789ABC \
  --parameters HostedZoneName=example.com \
  --parameters UpstreamsJson='[{"id":"grocery","url":"https://<upstream>/mcp","label":"Household Grocery"}]'
```

Deploy time: *not yet measured.* (Certificate validation is usually the long pole.)

### DNS

Nothing to do by hand. `ChaperoneGateway` creates the ACM DNS-validation CNAME
and the `A` alias from `DomainName` to the ALB in the hosted zone you pass in,
and deletes both when the stack is destroyed. If the domain's registrar is not
Route 53, delegate the zone's NS records to Route 53 once, up front.

### Pin the upstream's tools

A tool with no pin is refused as unpinned. From a machine with deployer
credentials, against the real tables (no `DDB_ENDPOINT`):

```bash
CHAPERONE_UPSTREAMS='<same JSON>' corepack pnpm pin:bootstrap
```

## Smoke test

```bash
D=https://gateway.example.com
curl -s -o /dev/null -w '%{http_code}\n' http://gateway.example.com/healthz   # 301 (redirect to HTTPS)
curl -s $D/healthz | jq '{status, storageBackend, gateWhenUnhealthy}'
#   expect storageBackend "dynamodb-aws"; a 503 means storage is failing and every gated tool is withheld

TARGET=$D/mcp corepack pnpm spec            # 27 named assertions, against the deployed gateway
TARGET=$D/mcp corepack pnpm test:resume     # 10-iteration kill-and-resume loop; must be 10/10
corepack pnpm verify-ledger                 # with deployer credentials and no DDB_ENDPOINT
```

`test:resume` passing through the ALB is the claim the whole design exists for.
Until it has been run against the deployment, "resumable SSE works behind the
ALB" is **not demonstrated**. Added latency against DynamoDB on AWS is also
unmeasured: run `corepack pnpm bench` against `$D` and put the result in the
README's "Not measured yet" table.

## Rollback

Image tags are immutable git shas, so rolling back is pointing the service at
the previous one:

```bash
cd infra
corepack pnpm exec cdk deploy ChaperoneGateway -c imageTag=<PREVIOUS_SHA>
```

Parameters are reused from the previous deploy, so only the tag changes. A
faster, out-of-band option (then reconcile with the command above, or the next
`cdk deploy` will undo it):

```bash
aws ecs update-service --cluster chaperone --service <ServiceName output> \
  --task-definition <previous task definition ARN>
```

The ECS deployment circuit breaker is on, so a task that never becomes healthy
rolls itself back. Rollback timing: **not yet measured.**

## Pause (after submission, 2026-10-22)

```bash
cd infra
corepack pnpm exec cdk destroy ChaperoneGateway
```

This removes the ALB, task, VPC, certificate, alias record and log group. The
ledger, pins and sessions in `ChaperoneTables` and the quarantine/advisory
tables are untouched. **Do not destroy `ChaperoneTables`.** Its tables are
`RETAIN`: destroying the stack would orphan them, and the next deploy would then
fail on the name collision.

Before pausing, snapshot the evidence: `corepack pnpm ddb:dump` and
`corepack pnpm verify-ledger` with deployer credentials, and commit nothing you
have not read.

### What still costs while paused

| Item | Why it persists | Order of magnitude |
|---|---|---|
| Route 53 hosted zone | you keep the zone | $0.50/month |
| ECR images | image kept for the redeploy | ~$0.10/GB-month |
| DynamoDB storage + PITR | tables retained | cents, at this data size (first 25 GB storage is free) |
| Advisory pipeline | Step Functions/Lambda/Streams, idle | ~$0 at idle |

Logs are deleted with the gateway stack (the log group is `DESTROY`); anything
needed from them must be exported before pausing.

## Resume (2026-11-07)

```bash
cd infra
corepack pnpm exec cdk deploy ChaperoneGateway -c imageTag=<SHA already in ECR> \
  --parameters DomainName=... --parameters HostedZoneId=... \
  --parameters HostedZoneName=... --parameters UpstreamsJson='...'
```

No rebuild and no manual DNS: the alias and the certificate validation record
are recreated by the stack. Then run the smoke test above. Re-pin only if the
upstream's tools changed (they should not have; if they did, the gateway will
correctly refuse them until a resident approves, which is the product working).
Resume timing: *not yet measured.*

## Teardown (end of judging, after 2026-11-20)

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
`CDKToolkit` bootstrap stack if nothing else uses it.

## Cost

List-price estimates for us-east-1, from published on-demand rates as I know
them; **not measured and not checked against the live Pricing API.** Compare with
Cost Explorer after the first deployed day. The credit balance and expiry could
not be read (the preflight identity has no billing access), so check them in the
console under Billing > Credits before relying on them.

| Item | Basis | $/day running |
|---|---|---|
| Fargate task, 0.5 vCPU + 1 GB (x86) | $0.04048/vCPU-h, $0.004445/GB-h | 0.59 |
| ALB, hourly | $0.0225/h | 0.54 |
| ALB LCUs | demo traffic, assumed about 1 LCU-h | 0.10 |
| Public IPv4, 2 on the ALB + 1 on the task | $0.005/h each | 0.36 |
| CloudWatch Logs ingest | $0.50/GB, assumed under 50 MB/day | 0.03 |
| DynamoDB on-demand + PITR | cents at this volume | 0.01 |
| Route 53 zone (if new) | $0.50/month | 0.02 |
| ECR storage | about 1 GB at $0.10/GB-month | 0.00 |
| ACM public certificate | free | 0.00 |
| NAT gateway | not used | 0.00 |
| **Total while running** | | **about $1.65** |

Free tier does not meaningfully reduce this: Fargate and ALB hours are not in
the always-free tier, and whether the new-account public-IPv4 allowance covers
ALB addresses is unconfirmed, so it is not counted.

| Case | Days running | Running | Paused | Total |
|---|---|---|---|---|
| A. Continuous, Oct 16 to Nov 20 | 36 | about $59.4 | none | **about $59** |
| B. Oct 16-22 and Nov 7-20 | 7 + 14 = 21 | about $34.7 | 15 paused days at about $0.02 = $0.3 | **about $35** |

B saves about $24 over A. Add the ECR, Route 53 and DynamoDB residue in both.
Anything that runs outside these windows (a forgotten stack, a failed
rollback leaving a second task) is the real cost risk: after each pause, confirm
with `aws elbv2 describe-load-balancers` and `aws ecs list-clusters` that nothing
is left.
