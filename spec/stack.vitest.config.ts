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
 * Neither file imports any `@chaperone/*` package — both talk to the
 * stack purely over raw HTTP/the MCP SDK client — so no alias block is
 * needed here, unlike the other two configs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  test: {
    root: rootDir,
    include: ["spec/resumption.test.ts", "spec/long-stream.test.ts"],
    reporters: ["verbose"],
  },
});
