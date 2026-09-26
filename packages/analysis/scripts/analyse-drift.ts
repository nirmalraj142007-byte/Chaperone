/**
 * `pnpm analyse:drift` — the drift analysis (Phase 19; planning audit M1, P7).
 *
 *   pnpm analyse:drift                         crawl-1 vs crawl-2 (+ crawl-interim-1 if it has a report).
 *                                              The only run that writes data/drift.json.
 *   pnpm analyse:drift --dry-run               crawl-1 vs crawl-1. Must show 0 drift and 0 classifier
 *                                              artifacts. Writes nothing under data/.
 *   pnpm analyse:drift --later=crawl-interim-1 the Oct 2 rehearsal: a segment, never a headline. Writes
 *                                              data/labels-todo.json so labelling can start early.
 *   --out=<path>                               also write the report object here (never data/drift.json
 *                                              unless this is the crawl-1 vs crawl-2 run).
 *   --no-interim                               ignore the interim crawl even if it has a report.
 *
 * Exit codes: 0 complete; 1 on any AnalysisError (a gate refused, the evidence
 * is inconsistent) or when human labels are still needed.
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { checkChangelog } from "@chaperone/advisory";
import { AnalysisError, ConfigError } from "@chaperone/errors";
import {
  type AnalysisNote,
  CRAWL_1_ID,
  CRAWL_2_ID,
  type Comparison,
  type DriftReport,
  analyseDrift,
  buildLabelsTodoFile,
  defaultCapabilitiesPath,
  emptyLabelsFile,
  headlineDriftPath,
  isHeadlineComparison,
  loadCandidates,
  loadSnapshot,
  makeStyle,
  parseLabelsFile,
  parseScheduledDates,
  sideBySide,
  writeDriftReport,
  writeJsonAtomic,
} from "../src/index.js";
import { DATA_DIR, REPO_ROOT, argValue, colorEnabled, firstCommitContainingBlob, readJsonIfExists, workingTreeTaxonomyBlob } from "./lib.js";

const INTERIM_ID = "crawl-interim-1";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function printNotes(notes: readonly AnalysisNote[], style: ReturnType<typeof makeStyle>): void {
  for (const note of notes) {
    if (note.level === "floor") {
      console.log(style.red(`!! ${note.text}`));
    } else if (note.level === "warn") {
      console.log(`!  ${note.text}`);
    } else {
      console.log(`   ${note.text}`);
    }
  }
}

function printReport(report: DriftReport, laterId: string): void {
  const p = report.pairing;
  const e = report.toolEvents;
  console.log("");
  console.log(`n (servers captured in both):   ${report.n}   [headlineEligible: ${report.headlineEligible}]`);
  console.log(`interval (from timestamps):     ${report.interval} days  (${report.crawl1StartedAt} -> ${report.crawl2StartedAt})`);
  console.log("pairing (denominator: crawl 1 bootedServerIds):");
  console.log(`  present in both:              ${p.presentInBoth.servers} servers, ${p.presentInBoth.tools} tools`);
  console.log(`  tool-added:                   ${p.toolAdded.tools} tools on ${p.toolAdded.servers} servers`);
  console.log(`  tool-removed:                 ${p.toolRemoved.tools} tools on ${p.toolRemoved.servers} servers`);
  console.log(`  server absent in ${laterId}:${" ".repeat(Math.max(1, 12 - laterId.length))}${p.serverAbsentInLaterCrawl.servers} servers (${p.serverAbsentInLaterCrawl.tools} tools)`);
  console.log("tool pairs by change class:");
  console.log(`  unchanged ${e.unchanged} · cosmetic ${e.cosmetic} · schema-additive ${e.schemaAdditive} · semantic-intent ${e.semanticIntent}`);
  console.log(`classifier: ${report.classifier.version} both sides, recomputed mismatches ${report.classifier.recomputedMismatches}, artifacts ${report.classifier.artifacts.length}`);
  console.log(
    `labels: ${report.labels.required} required, ${report.labels.human} human, ${report.labels.mechanical} mechanical, ${report.labels.humanOverrodeProposal} overrode the proposal`,
  );
  console.log(`semantic-intent servers: ${report.semanticIntent.drifted} of ${report.semanticIntent.servers}` + (report.semanticIntent.ratePct === null ? " (no rate: below floor)" : ` (${report.semanticIntent.ratePct.toFixed(1)}%)`));
  if (report.segments !== null) {
    const s1 = report.segments.crawl1ToInterim;
    const s2 = report.segments.interimToCrawl2;
    console.log(`SEGMENTS (structure, never a headline; n = ${s1.n}):`);
    console.log(`  crawl-1 -> interim:  ${s1.semanticIntentServers} servers with semantic-intent${s1.ratePct === null ? "" : ` (segment ${s1.ratePct.toFixed(1)}%)`}`);
    console.log(`  interim -> crawl-2:  ${s2.semanticIntentServers} servers with semantic-intent${s2.ratePct === null ? "" : ` (segment ${s2.ratePct.toFixed(1)}%)`}`);
    const t = report.timeToFirstChange;
    console.log(
      `time to first change: by interim ${t.observedAtInterim}, only after interim ${t.firstObservedOnlyAtCrawl2}, drifted but not captured at interim ${t.driftedNotCapturedAtInterim}`,
    );
    console.log(`reversions: ${t.reversions?.length ?? 0} tools on ${t.changedThenRevertedByCrawl2} servers`);
  }
  console.log(`rider C: ${report.riderC.status}${report.riderC.verdict ? ` (${report.riderC.verdict})` : ""}`);
  console.log("");
  const width = Math.max(30, Math.min(56, Math.floor(((process.stdout.columns ?? 120) - 3) / 2)));
  console.log(sideBySide({ title: "HEADLINE (flat)", text: report.sentences.flat }, { title: "BY CAPABILITY (stratified)", text: report.sentences.stratified }, width));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const style = makeStyle(colorEnabled());

  const laterId = dryRun ? CRAWL_1_ID : (argValue(argv, "later") ?? CRAWL_2_ID);
  if (dryRun && argValue(argv, "later") !== undefined) {
    throw new ConfigError("--dry-run compares crawl-1 with itself; do not pass --later with it");
  }
  if (!(await exists(path.join(DATA_DIR, `${laterId}-report.json`)))) {
    throw new AnalysisError(
      `data/${laterId}-report.json does not exist: ${laterId} has not run.` +
        (laterId === CRAWL_2_ID ? " Crawl 2 is scheduled for 2026-10-20. To rehearse now: pnpm analyse:drift --dry-run, or --later=crawl-interim-1 after Oct 2." : ""),
    );
  }
  const useInterim =
    !dryRun && laterId === CRAWL_2_ID && !argv.includes("--no-interim") && (await exists(path.join(DATA_DIR, `${INTERIM_ID}-report.json`)));
  const comparison: Comparison = { earlier: CRAWL_1_ID, later: laterId, dryRun };

  const banner = dryRun
    ? "DRY RUN: crawl-1 against itself. A check of the pipeline, not a finding. Writes nothing under data/."
    : isHeadlineComparison(comparison)
      ? `HEADLINE: crawl-1 vs crawl-2${useInterim ? ` (with ${INTERIM_ID} for segments, time bins and reversions)` : " (no interim crawl report)"}`
      : `REHEARSAL: crawl-1 vs ${laterId}. This is a segment, never a headline; data/drift.json is not written.`;
  console.log(style.bold(`analyse:drift — ${banner}`));

  const load = (crawlId: string) => loadSnapshot({ dataDir: DATA_DIR, crawlId, capabilitiesPath: defaultCapabilitiesPath(DATA_DIR, crawlId) });
  const crawl1 = await load(CRAWL_1_ID);
  const later = laterId === CRAWL_1_ID ? crawl1 : await load(laterId);
  const interim = useInterim ? await load(INTERIM_ID) : null;
  const tools = (s: typeof crawl1) => [...s.servers.values()].reduce((sum, t) => sum + t.size, 0);
  console.log(`loaded from data/raw: ${CRAWL_1_ID} ${crawl1.bootedServerIds.length} servers / ${tools(crawl1)} tools; ${laterId} ${later.bootedServerIds.length} / ${tools(later)}` + (interim ? `; ${INTERIM_ID} ${interim.bootedServerIds.length} / ${tools(interim)}` : ""));

  const labelsPath = path.join(DATA_DIR, "labels.json");
  const labelsJson = await readJsonIfExists(labelsPath);
  const labels = labelsJson === undefined ? emptyLabelsFile() : parseLabelsFile(labelsJson, "data/labels.json");
  const firstCommitAt = firstCommitContainingBlob(crawl1.taxonomyBlobSha);
  console.log(`taxonomy gate: blob ${crawl1.taxonomyBlobSha.slice(0, 12)} first committed ${firstCommitAt ?? "(never)"}; crawl 1 started ${crawl1.startedAt}`);

  const result = await analyseDrift({
    crawl1,
    later,
    interim,
    labels,
    taxonomy: { firstCommitAt, workingTreeBlobSha: workingTreeTaxonomyBlob() },
    candidates: await loadCandidates(path.join(REPO_ROOT, "corpus", "candidates.json")),
    scheduled: parseScheduledDates(await readFile(path.join(REPO_ROOT, "CRAWL_DATES.md"), "utf8")),
    checkSignal: (owner, repo, since) => checkChangelog(owner, repo, since, process.env["GITHUB_TOKEN"]),
    now: new Date(),
  });

  printNotes(result.notes, style);
  const todoPath = path.join(DATA_DIR, "labels-todo.json");

  if (result.status === "needs-labels") {
    if (!dryRun) {
      await writeJsonAtomic(todoPath, buildLabelsTodoFile(result.todo, crawl1.taxonomyBlobSha, new Date().toISOString()));
      console.log(`wrote data/labels-todo.json: ${result.todo.length} items. Label them with: pnpm analyse:label`);
    }
    console.log(style.red(`incomplete: ${result.todo.length} of ${result.labelsRequired} required labels missing. data/drift.json not written.`));
    process.exitCode = 1;
    return;
  }

  if (!dryRun) {
    await writeJsonAtomic(todoPath, buildLabelsTodoFile([], crawl1.taxonomyBlobSha, new Date().toISOString()));
  }
  printReport(result.report, laterId);

  const outArg = argValue(argv, "out");
  if (isHeadlineComparison(comparison)) {
    await writeDriftReport(headlineDriftPath(REPO_ROOT), REPO_ROOT, comparison, result.report);
    console.log("\nwrote data/drift.json (status: complete)");
  }
  if (outArg !== undefined) {
    await writeDriftReport(path.resolve(outArg), REPO_ROOT, comparison, result.report);
    console.log(`wrote ${outArg}`);
  }
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(makeStyle(colorEnabled()).red(`analyse:drift refused: ${message}`));
  process.exitCode = 1;
});
