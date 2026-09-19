/**
 * Config for `pnpm test:stack` — the two spec/ suites that talk to a real,
 * already-running gateway and demo-upstream over the network
 * (spec/resumption.test.ts, spec/long-stream.test.ts) rather than an
 * in-process server. Separate from the root vitest.config.ts (packages/*
 * unit/integration tests, no Docker required) and from spec/vitest.config.ts
 * (`pnpm spec`, the in-process conformance suite) because these two need
 * `docker compose up -d --build` plus a migrated DynamoDB before they can
 * pass — bundling them into either of the other two configs means either
 * `pnpm test` silently requires Docker (surprising on a laptop with it
 * down) or `pnpm spec`'s fast in-process suite starts depending on a live
 * stack it was built specifically to avoid needing.
 *
 * resumption and long-stream import no `@chaperone/*` package — they talk
 * to the stack purely over raw HTTP/the MCP SDK client. ledger-tamper and
 * refusal-final do: they run real repo code (the ledger, and for
 * refusal-final an in-process gateway and demo upstream) against DynamoDB
 * Local, so the alias block below points those imports at source, same as
 * the root config.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const pkg = (name: string, entry = "index.ts"): string => path.resolve(rootDir, "packages", name, "src", entry);

export default defineConfig({
  resolve: {
    alias: {
      "@chaperone/errors": pkg("errors"),
      "@chaperone/config": pkg("config"),
      "@chaperone/logger": pkg("logger"),
      "@chaperone/policy": pkg("policy"),
      "@chaperone/ledger": pkg("ledger"),
      "@chaperone/advisory": pkg("advisory"),
      "@chaperone/upstream": pkg("upstream"),
      "@chaperone/demo-upstream": pkg("demo-upstream", "lib.ts"),
      "@chaperone/gateway": pkg("gateway", "app.ts"),
    },
  },
  test: {
    root: rootDir,
    include: ["spec/resumption.test.ts", "spec/long-stream.test.ts", "spec/ledger-tamper.test.ts", "spec/refusal-final.test.ts"],
    reporters: ["verbose"],
  },
});
