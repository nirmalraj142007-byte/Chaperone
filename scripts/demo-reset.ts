/**
 * `pnpm demo:reset` — see scripts/demo/reset.ts. Flags:
 *   --no-docker    assume ddb + demo-upstream are already running
 *   --no-console   skip the console bundle check
 */
import { STACK } from "./demo/env.js";
import { printChecklist } from "./demo/checklist.js";
import { resetDemo } from "./demo/reset.js";

const started = Date.now();
const args = new Set(process.argv.slice(2));

resetDemo({ skipDocker: args.has("--no-docker"), skipConsole: args.has("--no-console") })
  .then((result) => {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\ndemo:reset: done in ${seconds}s (${result.pins.length} tools pinned, ${result.ledgerEvents} ledger events)`);
    printChecklist({
      consoleUrl: STACK.consoleUrl,
      assistantUrl: STACK.assistantUrl,
      gatewayUrl: STACK.gatewayUrl,
      corpusState: result.corpusState,
    });
  })
  .catch((error: unknown) => {
    console.error("demo:reset: failed —", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
