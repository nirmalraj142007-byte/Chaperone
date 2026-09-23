/**
 * `pnpm demo:idempotence` — run `pnpm demo:reset` twice, `pnpm ddb:dump`
 * after each, and diff the two dumps with ULIDs and wall-clock timestamps
 * normalised (scripts/demo/normalise.ts). Exits 1 on any other difference.
 */
import "./demo/env.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, loadFixtureFile } from "./demo/fixtures.js";
import { normalisedText, type Dump } from "./demo/normalise.js";
import { resetDemo } from "./demo/reset.js";

function dump(to: string): Dump {
  // The real dump script `pnpm ddb:dump` runs, launched directly (no pnpm shim).
  execFileSync(process.execPath, ["--import", "tsx", path.join("packages", "ledger", "scripts", "dump.ts"), to], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(readFileSync(to, "utf8")) as Dump;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "chaperone-idempotence-"));
  const quiet = (): void => {};

  await resetDemo({ log: quiet });
  const first = dump(path.join(dir, "dump-1.json"));
  await resetDemo({ log: quiet, skipConsole: true });
  const second = dump(path.join(dir, "dump-2.json"));

  // The fixture advisory's date comes from the committed file, so it is fixed too.
  const keepTimestamps = [`${loadFixtureFile().writtenOn}T00:00:00.000Z`];
  const a = normalisedText(first, { keepTimestamps });
  const b = normalisedText(second, { keepTimestamps });
  const fileA = path.join(dir, "normalised-1.json");
  const fileB = path.join(dir, "normalised-2.json");
  writeFileSync(fileA, a.text, "utf8");
  writeFileSync(fileB, b.text, "utf8");

  for (const table of Object.keys(first).sort()) {
    console.log(`  ${table.padEnd(14)} ${first[table]?.length ?? 0} row(s) after reset 1, ${second[table]?.length ?? 0} after reset 2`);
  }
  console.log(`  normalised: ${a.stats.ulids} ULIDs and ${a.stats.timestamps} wall-clock timestamps in dump 1; ${b.stats.ulids} and ${b.stats.timestamps} in dump 2`);

  if (a.text === b.text) {
    console.log("\ndemo:idempotence: PASS — two resets left identical state (ULIDs and wall-clock timestamps aside)");
    return;
  }
  console.error("\ndemo:idempotence: FAIL — the two dumps differ beyond ULIDs and timestamps:\n");
  const diff = spawnSync("git", ["diff", "--no-index", "--no-color", "--unified=2", fileA, fileB], { encoding: "utf8" });
  console.error(diff.stdout.split("\n").slice(0, 60).join("\n"));
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("demo:idempotence: failed —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
