/**
 * The console bundle the demo serves (`vite preview`, port 4173).
 *
 * Shared by reset.ts (which makes sure it is current) and verify.ts (which
 * serves it). Kept apart from both so neither drags the other's imports in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { REPO_ROOT } from "./fixtures.js";

export const CONSOLE_DIR = path.join(REPO_ROOT, "packages", "console");
const CONSOLE_MARKER = path.join(CONSOLE_DIR, "dist", ".chaperone-demo-build.json");

function newestMtimeMs(target: string): number {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(target).reduce((newest, entry) => Math.max(newest, newestMtimeMs(path.join(target, entry))), stat.mtimeMs);
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * The console reads /corpus and /bench from files inlined into its bundle at
 * build time (packages/console/vite.config.ts), which is what lets it run
 * with the network off. So "point the console at committed data only" means:
 * make sure the bundle in dist/ was built from the files in git as they are
 * now, with the rehearsal controls compiled in.
 */
export function ensureConsoleBundle(log: (line: string) => void): void {
  const inputs = [
    path.join(REPO_ROOT, "data", "crawl-1-report.json"),
    path.join(REPO_ROOT, "data", "crawl-2-report.json"),
    path.join(REPO_ROOT, "data", "boot-rate.json"),
    path.join(REPO_ROOT, "data", "drift.json"),
    path.join(REPO_ROOT, "benchmarks", "latency.json"),
    path.join(CONSOLE_DIR, "src"),
    path.join(CONSOLE_DIR, "index.html"),
    path.join(CONSOLE_DIR, "evidence.load.ts"),
    path.join(CONSOLE_DIR, "vite.config.ts"),
  ];
  const head = gitHead();
  let marker: { head?: string; builtAtMs?: number } | undefined;
  try {
    marker = JSON.parse(readFileSync(CONSOLE_MARKER, "utf8")) as { head?: string; builtAtMs?: number };
  } catch {
    marker = undefined;
  }
  const newestInput = Math.max(...inputs.map(newestMtimeMs));
  const fresh = marker !== undefined && marker.head === head && (marker.builtAtMs ?? 0) >= newestInput;
  if (fresh) {
    log("console: bundle is current for the committed data files");
    return;
  }

  log("console: building the bundle from the committed data files (VITE_DEMO_CONTROLS=true)");
  execFileSync(process.execPath, [viteBin(), "build"], {
    cwd: CONSOLE_DIR,
    env: { ...process.env, VITE_DEMO_CONTROLS: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(CONSOLE_MARKER, JSON.stringify({ head, builtAtMs: Date.now(), demoControls: true }), "utf8");
}


/** The console package's own vite, run with node directly: no `pnpm` or `.cmd` shim in the way. */
export function viteBin(): string {
  return path.join(
    path.dirname(createRequire(path.join(CONSOLE_DIR, "package.json")).resolve("vite/package.json")),
    "bin",
    "vite.js",
  );
}
