/**
 * `pnpm check-placeholders` — fails if any `{{PENDING: ...}}` marker remains
 * in committed prose.
 *
 * Markers stand in for numbers that have not been measured yet (drift rate,
 * baseline 2, production latency). They are expected until crawl 2 runs on
 * 2026-10-20, so this is a PRE-SUBMISSION step, not a CI step: run it after
 * the last measurement is filled in and before submission. It is not wired
 * into `test:all` or `.github/workflows/ci.yml` on purpose; a red CI for a
 * value that cannot exist yet would teach everyone to ignore CI.
 *
 * Scans the same set of files `check-claims` does: every committed `*.md`,
 * plus everything committed under demo/ and docs/. Reading from
 * `git ls-files` means it only sees committed prose, never node_modules/ or
 * an untracked scratch file. It reads the working-tree content of each
 * tracked file, so a staged-but-uncommitted marker is caught too.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPlaceholders } from "./demo/placeholders.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function trackedProseFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--", "*.md", "demo", "docs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function main(): void {
  const files = trackedProseFiles();
  let total = 0;
  const report: string[] = [];

  for (const file of files) {
    const hits = findPlaceholders(readFileSync(path.join(ROOT, file), "utf8"));
    total += hits.length;
    for (const hit of hits) {
      report.push(`  ${file}:${hit.line}: ${hit.matched}`);
    }
  }

  if (total > 0) {
    console.error(`check-placeholders: ${total} unresolved marker${total === 1 ? "" : "s"} in committed prose.\n`);
    console.error(report.join("\n"));
    console.error(
      "\nEach marker names what is unmeasured and when it will be. Replace it with the measured value and its " +
        "provenance, or (if the measurement will not happen) replace it with a plain statement that it was not measured.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`check-placeholders: ${files.length} file(s) scanned, no PENDING markers remain.`);
}

main();
