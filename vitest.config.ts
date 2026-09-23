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
    include: ["packages/*/test/**/*.test.{ts,tsx}", "scripts/test/**/*.test.ts"],
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
    // Worker cap. Vitest defaults to one fork per logical core minus one: 15
    // on the 16-thread machine this was diagnosed on. The suite is
    // import-bound, not test-bound (a full run measured ~570s of module
    // collection against ~25s of test bodies, summed across workers), and
    // every fork holds its own copy of the module graph, AWS SDK included:
    // the vitest processes alone peaked at ~1.3 GB. With a couple of GB free
    // that is paging, and under paging tests that were only fast by luck
    // (packages/demo-upstream/test/http.test.ts, packages/eval/test/guards.test.ts)
    // blew their 5s/10s limits while passing alone. 4 is close to what a
    // 4-vCPU CI runner gets by default (cores - 1 = 3). Raising individual
    // timeouts instead would only have hidden the pressure.
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    // Coverage gates (`pnpm test` runs with --coverage; a run below a
    // threshold exits non-zero). Deliberately per package, not global:
    //   policy   100%: it is ~200 lines and it is the entire security
    //            property (CLAUDE.md, Tests). A line there that no test
    //            reaches is a line nobody has shown to be right. If a branch
    //            looks unreachable, test it (see canonical-guard.test.ts)
    //            rather than lowering this or excluding the file.
    //   ledger, gateway  80%: CLAUDE.md's bar for everything else.
    // Nothing is excluded but type-only files, which have no statements.
    // gateway/src/index.ts (the process entry point, top-level await, starts
    // a server) is INCLUDED and counts at 0%; the gate still clears 80% with
    // it in, which is the honest number.
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["packages/policy/src/**/*.ts", "packages/ledger/src/**/*.ts", "packages/gateway/src/**/*.ts"],
      exclude: ["**/types.ts"],
      thresholds: {
        "packages/policy/src/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/ledger/src/**": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "packages/gateway/src/**": { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
    },
  },
});
