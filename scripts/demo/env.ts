/**
 * The demo runs against the docker-compose stack on this machine and
 * nothing else. This module fills in that stack's addresses for a script
 * run straight from the host (docker-compose.yml sets the container-side
 * equivalents itself), and refuses to let a demo script touch anything that
 * is not DynamoDB Local.
 *
 * Importing it also installs the loopback guard (loopback-guard.ts): from
 * that point this process cannot open a connection to anything but this
 * machine. `scripts/demo-call.ts` deliberately does not import it, since it
 * can be pointed at a deployed gateway with `TARGET=`.
 *
 * Import it before anything that calls `loadConfig()`, which caches the
 * first environment it sees.
 */
import { installLoopbackGuard } from "./loopback-guard.js";

installLoopbackGuard();

export const STACK = {
  ddbEndpoint: "http://localhost:8000",
  gatewayUrl: "http://localhost:3000",
  demoUpstreamUrl: "http://localhost:4000",
  consoleUrl: "http://localhost:4173",
} as const;

process.env["DDB_ENDPOINT"] ??= STACK.ddbEndpoint;
process.env["CHAPERONE_UPSTREAMS"] ??= JSON.stringify([
  { id: "grocery", url: `${STACK.demoUpstreamUrl}/mcp`, label: "Household Grocery" },
]);
process.env["AWS_REGION"] ??= "us-east-1";
// DynamoDB Local ignores credentials, but the SDK's resolver wants some.
process.env["AWS_ACCESS_KEY_ID"] ??= "local";
process.env["AWS_SECRET_ACCESS_KEY"] ??= "local";
// The gate's debug line is for the recorded terminal, not for the scripts.
process.env["LOG_LEVEL"] ??= "warn";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * `demo:reset` drops tables. That must be impossible to point at real
 * DynamoDB, whatever the environment says.
 */
export function assertLocalDynamoDb(): string {
  const endpoint = process.env["DDB_ENDPOINT"];
  if (endpoint === undefined || !isLocalUrl(endpoint)) {
    throw new Error(
      `refusing to run: DDB_ENDPOINT is "${endpoint ?? "(unset)"}", which is not DynamoDB Local on this machine. ` +
        "This script drops and recreates every table.",
    );
  }
  return endpoint;
}
