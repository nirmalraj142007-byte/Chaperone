/**
 * `pnpm audit --audit-level=high` fails today (exit 1) on two real, current
 * advisories in dev-only tooling — see docs/SECURITY.md for the full
 * reasoning and expiry dates. A CI gate that's already red before anyone's
 * change is a gate nobody looks at, so this wraps the raw audit: pass when
 * every high/critical finding is one of the two documented exceptions
 * below, fail loudly (a new, unaudited high/critical dependency
 * vulnerability, or a documented one whose severity changed) otherwise.
 *
 * The allowlist here and the table in docs/SECURITY.md must be kept in
 * sync by hand — this script doesn't read the doc, it's the doc's word made
 * checkable. If you add or remove an entry here, update that table too.
 */
import { execFileSync } from "node:child_process";

interface Advisory {
  severity: string;
  module_name: string;
  github_advisory_id: string;
  title: string;
  url: string;
}

interface AuditReport {
  advisories: Record<string, Advisory>;
}

/** Keep in sync with the "Dependency audit exceptions" table in docs/SECURITY.md. */
const DOCUMENTED_EXCEPTIONS = new Set(["GHSA-fx2h-pf6j-xcff", "GHSA-5xrq-8626-4rwp"]);

function runAudit(): AuditReport {
  try {
    // shell: true — on Windows, `pnpm` resolves to a .cmd/.ps1 shim that
    // execFileSync can't exec directly without going through a shell.
    // Every argument here is a fixed literal, never user input, so this
    // carries none of the usual shell-injection risk.
    const stdout = execFileSync("pnpm", ["audit", "--audit-level=high", "--json"], { encoding: "utf8", shell: true });
    return JSON.parse(stdout) as AuditReport;
  } catch (error) {
    // pnpm audit exits non-zero whenever it finds anything at/above the
    // threshold — that's the normal case here, not a failure to run it.
    // stdout still carries the JSON report on that path.
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.trim().length > 0) {
      return JSON.parse(stdout) as AuditReport;
    }
    throw error;
  }
}

const report = runAudit();
const findings = Object.values(report.advisories ?? {});
const unexpected = findings.filter((a) => !DOCUMENTED_EXCEPTIONS.has(a.github_advisory_id));

if (findings.length === 0) {
  console.log("pnpm audit --audit-level=high: clean, no exceptions needed.");
  process.exit(0);
}

for (const a of findings) {
  const status = DOCUMENTED_EXCEPTIONS.has(a.github_advisory_id) ? "documented exception" : "UNEXPECTED";
  console.log(`[${status}] ${a.severity} — ${a.module_name}: ${a.title} (${a.github_advisory_id})`);
}

if (unexpected.length > 0) {
  console.error(
    `\n${unexpected.length} high/critical finding(s) are not in docs/SECURITY.md's exception table. Either fix them or add a dated, reasoned exception there and in scripts/check-audit-exceptions.ts.`,
  );
  process.exit(1);
}

console.log(`\nAll ${findings.length} finding(s) are documented exceptions. Passing.`);
process.exit(0);
