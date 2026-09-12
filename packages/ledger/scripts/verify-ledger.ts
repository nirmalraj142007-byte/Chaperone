import { loadConfig } from "@chaperone/config";
import { verifyChain } from "../src/repos/ledgerEvent.js";

async function main(): Promise<void> {
  const { householdId } = loadConfig();
  const result = await verifyChain(householdId);

  if (result.ok) {
    console.log(`chain OK — ${result.count} events verified`);
    process.exitCode = 0;
    return;
  }

  console.error(`chain BROKEN at index ${result.index} (sk=${result.brokenSk})`);
  console.error(`  expected: ${result.expected}`);
  console.error(`  actual:   ${result.actual}`);
  process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error("verify-ledger: failed —", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
