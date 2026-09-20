/**
 * The latency budget, and the check that makes it a build step rather than
 * a sentence in a README.
 *
 * A performance claim that does not fail a build is a performance hope:
 * nothing stops the number drifting past the claim between one commit and
 * the demo, and nobody finds out until a judge reruns it. `pnpm bench`
 * exits 1 on a violation for the same reason `pnpm depcruise` exits 1 when
 * an LLM enters the policy import graph — both are product claims, and a
 * claim nothing enforces decays.
 *
 * The budget is stated on *added* latency, never absolute. Absolute
 * latency is mostly demo-upstream's own response time and the machine's;
 * neither is something this project can be held to.
 */
import type { Summary } from "./percentiles.js";

export interface Budget {
  p95Ms: number;
  p99Ms: number;
}

/**
 * 30ms at p95, 60ms at p99.
 *
 * 30 is the number the README and the demo script say out loud, so it is
 * the number the build enforces — the two must not be settable
 * independently. p99 is set at 2× rather than tightened, because the tail
 * of a DynamoDB round trip is not something the gateway controls and a
 * budget that fails on someone else's GC pause trains people to ignore it.
 */
export const LATENCY_BUDGET: Budget = { p95Ms: 30, p99Ms: 60 };

export interface BudgetViolation {
  percentile: "p95" | "p99";
  measuredMs: number;
  budgetMs: number;
}

export interface BudgetCheck {
  ok: boolean;
  violations: BudgetViolation[];
}

/**
 * Strictly greater-than, so a measurement landing exactly on the budget
 * passes. The budget is a ceiling that is allowed to be reached.
 */
export function checkBudget(added: Summary, budget: Budget = LATENCY_BUDGET): BudgetCheck {
  const violations: BudgetViolation[] = [];
  if (added.p95 > budget.p95Ms) {
    violations.push({ percentile: "p95", measuredMs: added.p95, budgetMs: budget.p95Ms });
  }
  if (added.p99 > budget.p99Ms) {
    violations.push({ percentile: "p99", measuredMs: added.p99, budgetMs: budget.p99Ms });
  }
  return { ok: violations.length === 0, violations };
}

/** One line per violation, for the failing run's stderr. */
export function describeViolations(violations: readonly BudgetViolation[]): string[] {
  return violations.map(
    (v) =>
      `added latency ${v.percentile} was ${v.measuredMs.toFixed(2)}ms, over the ${v.budgetMs}ms budget ` +
      `by ${(v.measuredMs - v.budgetMs).toFixed(2)}ms`,
  );
}
