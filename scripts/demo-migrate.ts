/**
 * `pnpm demo:migrate` — `pnpm ddb:migrate` with the demo stack's addresses
 * filled in, for a shell that has not exported DDB_ENDPOINT and
 * CHAPERONE_UPSTREAMS (which is every shell on a fresh clone).
 *
 * `ddb:migrate` itself stays strict on purpose, for the same reason
 * `verify-ledger` does (see scripts/demo-ledger.ts): it reads its endpoint from
 * the environment so it can provision a deployed environment, and a default
 * that quietly pointed it at localhost would change what "done" means. This
 * wrapper supplies the local default through scripts/demo/env.ts, which
 * refuses to leave the machine.
 */
import "./demo/env.js";

await import("../packages/ledger/scripts/migrate.js");
