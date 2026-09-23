/**
 * `pnpm test:e2e` — the two end-to-end specs in e2e/, run against the real
 * docker-compose stack (gateway, demo-upstream, DynamoDB Local).
 *
 * One worker, no parallelism: every spec resets and mutates the same shared
 * stack (and fails-closed.spec.ts stops DynamoDB), so two specs at once would
 * be a test of each other. There are no retries either. A retry turns "passed
 * the second time" into a green run; the point of `--repeat-each=3` in CI is
 * that a spec which is only sometimes right fails the build.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env["CI"] !== undefined,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "test-results/e2e",
});
