import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

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
    // Explicit paths, not a glob, for the two spec/ entries: a glob wide
    // enough to reach them (e.g. "spec/*.test.ts") would also pull in
    // spec/conformance.spec.test.ts, which is `pnpm spec`'s in-process
    // suite (own config, own timeout) and must not also run — and slow
    // down — every plain `pnpm test`. See CLAUDE.md's `pnpm test --
    // spec/long-stream.test.ts` and `test:resume` (package.json).
    include: ["packages/*/test/**/*.test.ts", "spec/resumption.test.ts", "spec/long-stream.test.ts"],
  },
});
