/**
 * `pnpm demo:mutate` — makes the demo upstream change `add_item`'s
 * description, the one scripted change the whole demo turns on. It is the
 * same call as the console's "Mutate add_item" button and as
 * `curl -X POST http://localhost:4000/control/mutate`, as a script so that the
 * README's quickstart is the same command in every shell (Windows PowerShell
 * aliases `curl` to something else).
 *
 * `demo:reset` puts the description back.
 *
 * `UPSTREAM_CONTROL_URL` overrides the address; it exists for a deployed demo
 * upstream and defaults to the one `docker compose` publishes.
 */
const base = process.env["UPSTREAM_CONTROL_URL"] ?? "http://localhost:4000";

const response = await fetch(`${base}/control/mutate`, { method: "POST" });
const body = await response.text();
if (!response.ok) {
  console.error(`demo:mutate: ${base}/control/mutate answered ${response.status}: ${body}`);
  process.exitCode = 1;
} else {
  console.log(`add_item's description has changed on the demo upstream (${body})`);
}
