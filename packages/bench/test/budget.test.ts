import { describe, expect, it } from "vitest";
import { LATENCY_BUDGET, checkBudget, describeViolations } from "../src/budget.js";
import type { Summary } from "../src/percentiles.js";

function summary(p95: number, p99: number): Summary {
  return { n: 1000, p50: 1, p95, p99, mean: 1, max: p99 };
}

describe("checkBudget", () => {
  it("passes a run inside both budgets", () => {
    expect(checkBudget(summary(12, 40)).ok).toBe(true);
  });

  it("passes a run landing exactly on the budget", () => {
    // The budget is a ceiling that is allowed to be reached: the check is
    // strictly greater-than, so 30.00ms at p95 is not a failure.
    const check = checkBudget(summary(LATENCY_BUDGET.p95Ms, LATENCY_BUDGET.p99Ms));
    expect(check.ok).toBe(true);
    expect(check.violations).toEqual([]);
  });

  it("fails on a p95 over budget and names the measured value", () => {
    const check = checkBudget(summary(30.01, 40));
    expect(check.ok).toBe(false);
    expect(check.violations).toEqual([{ percentile: "p95", measuredMs: 30.01, budgetMs: 30 }]);
  });

  it("fails on a p99 over budget even when p95 is inside it", () => {
    const check = checkBudget(summary(10, 61));
    expect(check.ok).toBe(false);
    expect(check.violations.map((v) => v.percentile)).toEqual(["p99"]);
  });

  it("reports both violations when both are exceeded", () => {
    const check = checkBudget(summary(80, 200));
    expect(check.violations.map((v) => v.percentile)).toEqual(["p95", "p99"]);
  });

  it("enforces the 30ms/60ms budget the README and demo script state", () => {
    // These two numbers are said out loud on camera. If they change here
    // without changing there, the claim and the build disagree.
    expect(LATENCY_BUDGET).toEqual({ p95Ms: 30, p99Ms: 60 });
  });
});

describe("describeViolations", () => {
  it("states the measured value, the budget, and the overshoot", () => {
    const [line] = describeViolations(checkBudget(summary(45.5, 40)).violations);
    expect(line).toContain("45.50ms");
    expect(line).toContain("30ms budget");
    expect(line).toContain("15.50ms");
  });

  it("returns nothing for a passing run", () => {
    expect(describeViolations(checkBudget(summary(1, 1)).violations)).toEqual([]);
  });
});
