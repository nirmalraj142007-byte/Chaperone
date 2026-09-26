/**
 * The simulated assistant's production bundle, served by `vite preview` on
 * port 5174 (packages/assistant-sim, the primary demo surface).
 *
 * Same shape as console.ts, and shared the same way: reset.ts makes sure the
 * bundle is current, `pnpm demo:assistant` serves it, and the Playwright
 * specs start it themselves. It has no data files to inline, so "current"
 * only means "built from the sources as they are now".
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { REPO_ROOT } from "./fixtures.js";

export const ASSISTANT_DIR = path.join(REPO_ROOT, "packages", "assistant-sim");
const BUILT_INDEX = path.join(ASSISTANT_DIR, "dist", "index.html");

function newestMtimeMs(target: string): number {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(target).reduce((newest, entry) => Math.max(newest, newestMtimeMs(path.join(target, entry))), stat.mtimeMs);
}

/** The package's own vite, run with node directly: no `pnpm` or `.cmd` shim in the way. */
export function assistantViteBin(): string {
  return path.join(
    path.dirname(createRequire(path.join(ASSISTANT_DIR, "package.json")).resolve("vite/package.json")),
    "bin",
    "vite.js",
  );
}

/** Builds the bundle if it is missing or older than any source file. Returns whether it had to build. */
export function ensureAssistantBundle(log: (line: string) => void): boolean {
  const inputs = ["src", "index.html", "vite.config.ts", "package.json"].map((entry) => path.join(ASSISTANT_DIR, entry));
  const newestInput = Math.max(...inputs.map(newestMtimeMs));
  if (existsSync(BUILT_INDEX) && statSync(BUILT_INDEX).mtimeMs >= newestInput) {
    log("assistant: simulated Alexa+ bundle is current");
    return false;
  }
  log("assistant: building the simulated Alexa+ bundle");
  execFileSync(process.execPath, [assistantViteBin(), "build"], { cwd: ASSISTANT_DIR, stdio: ["ignore", "pipe", "pipe"] });
  return true;
}
