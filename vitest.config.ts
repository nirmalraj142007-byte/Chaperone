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
      "@chaperone/advisory": path.resolve(rootDir, "packages/advisory/src/index.ts"),
      "@chaperone/upstream": path.resolve(rootDir, "packages/upstream/src/index.ts"),
      "@chaperone/demo-upstream": path.resolve(rootDir, "packages/demo-upstream/src/lib.ts"),
      "@chaperone/gateway": path.resolve(rootDir, "packages/gateway/src/app.ts"),
      "@chaperone/eval": path.resolve(rootDir, "packages/eval/src/index.ts"),
      "@chaperone/bench": path.resolve(rootDir, "packages/bench/src/index.ts"),
    },
  },
  test: {
    // `pnpm test` — unit and integration only, no Docker required. The two
    // stack-dependent spec/ suites (resumption, long-stream) intentionally
    // do NOT live here: they need a real, already-running gateway and
    // demo-upstream (`docker compose up -d --build`) and would otherwise
    // fail on every machine, and every CI run, that hasn't started that
    // stack first — which is exactly what happened from Phase 9 onward
    // (ci.yml ran `pnpm test`, which included them, without ever starting
    // the stack; see spec/stack.vitest.config.ts and `pnpm test:stack`).
    // .tsx as well as .ts: packages/console's state snapshots render real
    // components, so its suite is TSX. Phase 15.
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
    // packages/console/src/lib.ts's formatDate/formatTime use
    // Intl.DateTimeFormat with no explicit timeZone — correct for
    // production (a resident's browser should show their own local time),
    // but that means the snapshotted HTML in packages/console's state
    // suite bakes in whatever timezone the machine running the test
    // happens to be in. Pinning TZ here (not in lib.ts itself, which would
    // be a real product regression) makes the snapshots deterministic
    // across every machine and CI runner. Discovered 2026-09-20: local runs
    // on a non-UTC machine were green while GitHub Actions' UTC runners
    // failed 5 of packages/console's state snapshots on exactly this — a
    // real environment-dependence the local-only workflow had never
    // surfaced. Fixed at the source (test-environment determinism) rather
    // than by regenerating snapshots against whichever machine happens to
    // run them next.
    env: { TZ: "UTC" },
  },
});
