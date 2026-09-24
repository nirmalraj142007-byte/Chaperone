/**
 * `pnpm demo:ledger` — `pnpm verify-ledger` with the demo stack's addresses
 * filled in, for a shell that has not exported DDB_ENDPOINT and
 * CHAPERONE_UPSTREAMS (which is every shell on a fresh clone).
 *
 * `verify-ledger` itself stays strict on purpose: it reads its endpoint from
 * the environment so the same command can walk a deployed environment's
 * ledger, and a default that quietly pointed it at localhost would make "chain
 * OK" mean something different depending on what was unset. This wrapper is
 * the one place that supplies the local default, the same way the other
 * `demo:*` scripts do (scripts/demo/env.ts), and it refuses to leave the
 * machine (the loopback guard).
 *
 * It walks the chain with the real script, not a re-implementation.
 */
import "./demo/env.js";

await import("../packages/ledger/scripts/verify-ledger.js");
