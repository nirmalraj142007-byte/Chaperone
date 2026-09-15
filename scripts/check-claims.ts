/**
 * `pnpm check-claims` — guards CLAUDE.md's non-negotiable #10: the
 * pre-registered interval between crawl 1 (2026-09-15) and crawl 2
 * (2026-10-20) is 35 days, and every public claim states the day count,
 * never a rounded week count. A rounded figure is easy to reach for by
 * habit ("about five weeks" reads more naturally than "35 days") and easy
 * to miss in review, so this is a grep gate, not a style suggestion.
 *
 * Scans every file `git ls-files` reports for the pathspec `*.md`, `demo`,
 * `docs` — i.e. all committed (or staged) Markdown anywhere in the repo,
 * plus every committed file under demo/ or docs/ regardless of extension,
 * since either directory could grow non-.md prose (a transcript, a script)
 * that ought to be held to the same bar. Reading from `git ls-files`
 * rather than walking the filesystem means this only ever sees committed
 * prose, matching how CLAUDE.md describes it, and never node_modules/,
 * dist/, or an untracked scratch file.
 *
 * A line that legitimately needs to use the phrase — quoting this very
 * rule, or the judge-facing file that names the interval — can opt out
 * with the literal marker `check-claims:allow` anywhere on that line
 * (wrapped as an HTML comment in Markdown so it renders invisibly). That
 * marker is the one intentional exemption path; there is no other way to
 * suppress a match, so tightening this guard later never means widening
 * an exception list, only adding a smarter pattern.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ROUNDED_INTERVAL_PATTERNS: readonly RegExp[] = [
  /\b(six|6|five|5|four|4)\s*weeks?\b/i,
  /about (five|six) weeks/i,
];

const ALLOW_MARKER = "check-claims:allow";

interface Violation {
  file: string;
  line: number;
  text: string;
  matched: string;
}

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

function findViolations(relativePath: string): Violation[] {
  const absolutePath = path.join(ROOT, relativePath);
  const lines = readFileSync(absolutePath, "utf8").split("\n");
  const violations: Violation[] = [];

  lines.forEach((text, index) => {
    if (text.includes(ALLOW_MARKER)) {
      return;
    }
    for (const pattern of ROUNDED_INTERVAL_PATTERNS) {
      const match = pattern.exec(text);
      if (match !== null) {
        violations.push({ file: relativePath, line: index + 1, text, matched: match[0] });
        break; // one flag per line is enough; fixing it re-scans the whole line anyway.
      }
    }
  });

  return violations;
}

function main(): void {
  const files = trackedProseFiles();
  const violations = files.flatMap(findViolations);

  if (violations.length > 0) {
    console.error(
      `check-claims: found ${violations.length} rounded-interval claim${violations.length === 1 ? "" : "s"}. ` +
        `The pre-registered interval is 35 days — state the day count, not a week count.\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}: "${v.matched}" in: ${v.text.trim()}`);
    }
    console.error(
      `\nIf a line is legitimately quoting this rule or the judge-facing file (not stating an ` +
        `interval as fact), add the literal marker "${ALLOW_MARKER}" anywhere on that line to opt it out.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`check-claims: ${files.length} file(s) scanned, no rounded-interval language found.`);
}

main();
