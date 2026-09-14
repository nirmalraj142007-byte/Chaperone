/**
 * Config for `pnpm spec` — the MCP conformance suite. Separate from the
 * root vitest.config.ts (which only picks up each package's own test
 * directory) so the suite has its own reporter: this output gets filmed at
 * 1:45 in the demo, so "verbose" (one line per named assertion) is
 * deliberate, not the default terse dot/file-path summary.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  resolve: {
    alias: {
      "@chaperone/errors": path.resolve(rootDir, "packages/errors/src/index.ts"),
      "@chaperone/config": path.resolve(rootDir, "packages/config/src/index.ts"),
      "@chaperone/logger": path.resolve(rootDir, "packages/logger/src/index.ts"),
      "@chaperone/policy": path.resolve(rootDir, "packages/policy/src/index.ts"),
      "@chaperone/ledger": path.resolve(rootDir, "packages/ledger/src/index.ts"),
      "@chaperone/upstream": path.resolve(rootDir, "packages/upstream/src/index.ts"),
      "@chaperone/demo-upstream": path.resolve(rootDir, "packages/demo-upstream/src/lib.ts"),
      "@chaperone/gateway": path.resolve(rootDir, "packages/gateway/src/app.ts"),
    },
  },
  test: {
    root: rootDir,
    include: ["spec/**/*.spec.test.ts"],
    reporters: ["verbose"],
    testTimeout: 15_000,
  },
});
