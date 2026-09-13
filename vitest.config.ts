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
      "@chaperone/demo-upstream": path.resolve(rootDir, "packages/demo-upstream/src/lib.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
