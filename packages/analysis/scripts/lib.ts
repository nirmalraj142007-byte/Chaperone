/** The git and console I/O both analysis scripts share. Everything that decides a number is in ../src. */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { LabelIo } from "../src/index.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const TAXONOMY_PATH = path.join(REPO_ROOT, "corpus", "TAXONOMY.md");

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Committer time of the earliest commit that contains `blobSha`, or null.
 * The reports record a BLOB hash, not a commit (CRAWL_DATES.md explains
 * why), so "when was the taxonomy committed" means "when did this exact blob
 * first appear". `--find-object` lists the commits that add or remove it.
 */
export function firstCommitContainingBlob(blobSha: string): string | null {
  const out = git(["log", "--all", "--format=%cI", `--find-object=${blobSha}`]);
  const dates = out.split(/\r?\n/).filter((l) => l.length > 0);
  if (dates.length === 0) {
    return null;
  }
  return dates.reduce((min, d) => (Date.parse(d) < Date.parse(min) ? d : min));
}

/** The blob hash of the taxonomy file as it is on disk now (after git's line-ending normalisation). */
export function workingTreeTaxonomyBlob(): string {
  return git(["hash-object", "--", path.relative(REPO_ROOT, TAXONOMY_PATH)]);
}

export function gitUserName(): string | null {
  try {
    const name = git(["config", "user.name"]);
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function colorEnabled(): boolean {
  return process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

/**
 * Line input from stdin. Uses readline's async iterator rather than
 * `question()`, because the iterator simply ends when input ends (Ctrl+Z
 * Enter in Command Prompt, Ctrl+D elsewhere, or the end of a pipe), which
 * the session treats as "quit": everything answered is already saved.
 */
export function stdinIo(): { io: LabelIo; close(): void } {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    io: {
      async ask(prompt: string): Promise<string | null> {
        process.stdout.write(prompt);
        const next = await lines.next();
        return next.done ? null : next.value;
      },
      print(text: string): void {
        process.stdout.write(`${text}\n`);
      },
    },
    close: () => rl.close(),
  };
}

export function argValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}
