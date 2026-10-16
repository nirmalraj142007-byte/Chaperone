# Superseded measurements

Kept unedited, byte for byte as the bench wrote them, so the record of what
was claimed and when stays intact. None of these is the current number;
`../latency.json` is.

## `latency-2026-10-16-ssm-tunnel.json`

Added p95 835.78 ms against `dynamodb-aws`, commit `3c910e5`. Superseded the
same day by the on-host run in `../latency.json` (added p95 53.82 ms).

**Why it does not measure Chaperone.** The deployed gateway and demo upstream
are not public, so this run reached both from a laptop in India through two
SSM port-forwards to the `t3.micro` in us-east-1. The tunnel's round trip
(direct p50 249.70 ms) is in both the direct and the proxied path and cancels
in the subtraction, but its jitter does not cancel: the proxied p95 was
1189.54 ms against a direct p95 of 353.77 ms, and that tail belongs to the
tunnel. The file predates `environment.vantage`, so it does not say
`ssm-tunnel` itself; this note does.

The on-host run that replaced it runs the bench inside the host's compose
network, so both paths stay on the instance and only the gateway's own
DynamoDB calls leave it. Method: `docs/RUNBOOK.md`, "Latency against DynamoDB
on AWS".
