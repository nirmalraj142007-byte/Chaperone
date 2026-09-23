/**
 * `pnpm demo:verify` — see scripts/demo/verify.ts. Flags:
 *   --no-reset     do not reset before the beats (the stack must already be at its starting state)
 *   --leave-dirty  do not reset again afterwards
 */
import "./demo/env.js";
import { verifyDemo } from "./demo/verify.js";

const args = new Set(process.argv.slice(2));

verifyDemo({ skipReset: args.has("--no-reset"), leaveDirty: args.has("--leave-dirty") })
  .then((result) => {
    const seconds = (result.elapsedMs / 1000).toFixed(1);
    console.log(
      `\ndemo:verify: ${result.failed === 0 ? "PASS" : "FAIL"} — ${result.passed} beats passed, ${result.skipped} skipped, ${result.failed} failed, ${seconds}s`,
    );
    // Explicit exit: a browser that is slow to shut down must not hold the run open (see closeBrowser in verify.ts).
    process.exit(result.failed === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    console.error("demo:verify: failed —", error instanceof Error ? error.message : error);
    process.exit(1);
  });
