/**
 * `pnpm analyse:label` — the human labelling loop (planning audit M16, M14).
 *
 *   pnpm analyse:label                         walk data/labels-todo.json; answers go to data/labels.json
 *   pnpm analyse:label --prevalence            walk the 150-tool prevalence sample; answers go to data/prevalence.json
 *   pnpm analyse:label --prevalence --draw-only  draw the sample (if data/prevalence.json does not exist yet) and stop
 *   --by=<name>                                who is labelling. Defaults to `git config user.name`. Never "model".
 *   --data-dir=<dir>                           read and write there instead of data/ (for rehearsing on a scratch copy)
 *
 * Type one letter and press Enter. Every answer is saved before the next item
 * is shown, so quitting (q, Ctrl+C, closing the window) loses nothing, and the
 * next run resumes at the first item without a decision. Works in Windows
 * Command Prompt: input is plain lines, and the changed words are marked with
 * [-removed-] / {+added+} whether or not the console shows colour.
 */
import path from "node:path";
import { ConfigError } from "@chaperone/errors";
import {
  CRAWL_1_ID,
  defaultCapabilitiesPath,
  drawPrevalenceSample,
  emptyLabelsFile,
  loadSnapshot,
  makeStyle,
  parseLabelsFile,
  parseLabelsTodoFile,
  parsePrevalenceFile,
  runChangeLabelSession,
  runPrevalenceSession,
  summarizePrevalence,
  writeJsonAtomic,
} from "../src/index.js";
import { DATA_DIR, argValue, colorEnabled, gitUserName, readJsonIfExists, stdinIo, workingTreeTaxonomyBlob } from "./lib.js";

async function prevalence(argv: readonly string[], dataDir: string, labeledBy: string | null): Promise<void> {
  const filePath = path.join(dataDir, "prevalence.json");
  const existing = await readJsonIfExists(filePath);
  let file;
  if (existing === undefined) {
    const crawl1 = await loadSnapshot({ dataDir: DATA_DIR, crawlId: CRAWL_1_ID, capabilitiesPath: defaultCapabilitiesPath(DATA_DIR, CRAWL_1_ID) }); // always the real crawl 1
    file = drawPrevalenceSample(crawl1);
    await writeJsonAtomic(filePath, file);
    console.log(
      `drew ${file.sampleSize} of ${file.frameSize} crawl-1 tools (seed ${file.seed}, ${file.seedDerivation}); allocation ` +
        `transact ${file.allocation.transact}, communicate ${file.allocation.communicate}, write ${file.allocation.write}, read ${file.allocation.read}. ` +
        `wrote ${path.relative(process.cwd(), filePath)}`,
    );
  } else {
    file = parsePrevalenceFile(existing, "data/prevalence.json");
    const s = summarizePrevalence(file);
    console.log(`data/prevalence.json: ${s.answered} of ${s.sampleSize} answered (${s.yes} yes, ${s.no} no)`);
  }
  if (argv.includes("--draw-only")) {
    return;
  }
  if (labeledBy === null) {
    throw new ConfigError("who is labelling? pass --by=<your name> (git config user.name is not set)");
  }
  const { io, close } = stdinIo();
  try {
    await runPrevalenceSession({
      file,
      labeledBy,
      taxonomyBlobSha: workingTreeTaxonomyBlob(),
      io,
      style: makeStyle(colorEnabled()),
      now: () => new Date(),
      save: (f) => writeJsonAtomic(filePath, f),
    });
  } finally {
    close();
  }
}

async function changes(dataDir: string, labeledBy: string | null): Promise<void> {
  const todoJson = await readJsonIfExists(path.join(dataDir, "labels-todo.json"));
  if (todoJson === undefined) {
    console.log("data/labels-todo.json does not exist: run pnpm analyse:drift first (it writes the list of pairs that need a label).");
    return;
  }
  const todo = parseLabelsTodoFile(todoJson, "data/labels-todo.json");
  const labelsPath = path.join(dataDir, "labels.json");
  const labelsJson = await readJsonIfExists(labelsPath);
  const labels = labelsJson === undefined ? emptyLabelsFile() : parseLabelsFile(labelsJson, "data/labels.json");
  if (labeledBy === null) {
    throw new ConfigError("who is labelling? pass --by=<your name> (git config user.name is not set)");
  }
  const { io, close } = stdinIo();
  try {
    await runChangeLabelSession({
      todo,
      labels,
      labeledBy,
      taxonomyBlobSha: workingTreeTaxonomyBlob(),
      io,
      style: makeStyle(colorEnabled()),
      now: () => new Date(),
      save: (l) => writeJsonAtomic(labelsPath, l),
    });
  } finally {
    close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const labeledBy = argValue(argv, "by") ?? gitUserName();
  const dataDir = path.resolve(argValue(argv, "data-dir") ?? DATA_DIR);
  if (argv.includes("--prevalence")) {
    await prevalence(argv, dataDir, labeledBy);
  } else {
    await changes(dataDir, labeledBy);
  }
}

main().catch((e: unknown) => {
  console.error(makeStyle(colorEnabled()).red(`analyse:label: ${e instanceof Error ? e.message : String(e)}`));
  process.exitCode = 1;
});
