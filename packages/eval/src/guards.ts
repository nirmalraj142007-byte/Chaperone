/**
 * Enforces CLAUDE.md #7: "Never claim an absolute Chaperone block rate...
 * Report it only as a delta against baseline 2." This module is the guard
 * `test/guards.test.ts` exercises — see that file for the required
 * fail-then-pass demonstration. It walks any JSON-shaped value looking for
 * a key that names a Chaperone block rate, holding a plain finite number,
 * anywhere *outside* a `delta` object. A field with that same name nested
 * under `delta` is exactly what CLAUDE.md asks for and is never flagged.
 */
export interface AbsoluteBlockRateViolation {
  path: string;
  value: number;
}

const CHAPERONE_BLOCK_RATE_KEY = /chaperone.*block.*rate|block.*rate.*chaperone/i;

export function findUnqualifiedAbsoluteChaperoneBlockRate(
  value: unknown,
  currentPath = "",
  insideDelta = false,
): AbsoluteBlockRateViolation[] {
  if (value === null || typeof value !== "object") {
    return [];
  }

  const violations: AbsoluteBlockRateViolation[] = [];

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    const nowInsideDelta = insideDelta || key === "delta";

    if (!nowInsideDelta && CHAPERONE_BLOCK_RATE_KEY.test(key) && typeof child === "number" && Number.isFinite(child)) {
      violations.push({ path: nextPath, value: child });
    }

    violations.push(...findUnqualifiedAbsoluteChaperoneBlockRate(child, nextPath, nowInsideDelta));
  }

  return violations;
}

/** True only when `value` is an object carrying a `delta` key at its top level — report.ts's output must satisfy this, per CLAUDE.md #7's "Include the delta field". */
export function hasDeltaField(value: unknown): boolean {
  return typeof value === "object" && value !== null && "delta" in value;
}
