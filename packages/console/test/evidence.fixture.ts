/**
 * The *real* committed evidence, loaded from disk the same way the Vite
 * plugin loads it, with only the two build-varying fields pinned.
 *
 * Deliberately not a hand-written fixture: the point of /corpus is that
 * what it shows is what is in git, so the snapshots are worth something
 * only if they are rendered from the same files. If someone edits
 * data/crawl-1-report.json, these snapshots must fail.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvidence, type Evidence } from "../evidence.load";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const real = loadEvidence(repoRoot);

/** `headSha` and `builtAt` change on every commit and every run; everything else is the committed truth. */
const evidence: Evidence = {
  ...real,
  headSha: "0000000000000000000000000000000000000000",
  builtAt: "2026-09-20T12:00:00.000Z",
};

export default evidence;
