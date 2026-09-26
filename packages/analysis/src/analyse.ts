/**
 * The drift analysis, end to end, as one pure async function over loaded
 * snapshots. The script (scripts/analyse-drift.ts) does the file and git I/O;
 * everything that decides a number is here, so the fixture tests exercise the
 * same code the real run does.
 *
 * Order matters and is the order of corpus/DRIFT-JSON-APPENDIX-report-shape.md:
 * gates first, then pairing, then classifier stability, then labels, and
 * only then any count.
 */
import { AnalysisError } from "@chaperone/errors";
import { type CapabilityClass, type HashedCapability, findCapabilityClassifierArtifacts } from "@chaperone/policy";
import { HEADLINE_FLOOR, assertTaxonomyPreRegistered, headlineEligibility, ratePct, riderCGate, utcCalendarDaysBetween } from "./gates.js";
import {
  type ClassifiedPair,
  type LabelRecord,
  type LabelsFile,
  type ResolvedComparison,
  type TodoItem,
  labelKey,
  mergeTodo,
  resolveComparison,
} from "./labels.js";
import { ANALYSIS_CLASSIFIER_VERSION } from "./load.js";
import { type Pairing, pairSnapshots } from "./pair.js";
import { type RiderCEvaluation, type SignalChecker, evaluateRiderC } from "./riderC.js";
import { CAPABILITY_ORDER, type Candidate, type Snapshot } from "./types.js";

export const CRAWL_1_ID = "crawl-1";
export const CRAWL_2_ID = "crawl-2";

export interface AnalyseInput {
  crawl1: Snapshot;
  /** crawl-2 for the headline; crawl-1 itself for the dry run; crawl-interim-1 for the Oct 2 rehearsal. */
  later: Snapshot;
  /** The interim crawl, used only for segments, the two time bins and reversions. Null if it has no report. */
  interim: Snapshot | null;
  labels: LabelsFile;
  taxonomy: {
    /** Committer time of the earliest commit containing crawl 1's TAXONOMY.md blob. */
    firstCommitAt: string | null;
    /** `git hash-object corpus/TAXONOMY.md` now. */
    workingTreeBlobSha: string;
  };
  candidates: readonly Candidate[];
  /** From CRAWL_DATES.md's table. */
  scheduled: { crawl1: string; crawl2: string };
  /** checkChangelog in production. Only called if rider C's gate is met. */
  checkSignal: SignalChecker | null;
  now: Date;
}

export interface AnalysisNote {
  level: "info" | "warn" | "floor";
  text: string;
}

export interface ToolEvents {
  unchanged: number;
  cosmetic: number;
  schemaAdditive: number;
  semanticIntent: number;
  toolAdded: number;
  toolRemoved: number;
}

export interface Stratum {
  capabilityClass: CapabilityClass;
  servers: number;
  drifted: number;
  ratePct: number | null;
}

export interface SegmentCounts {
  n: number;
  semanticIntentServers: number;
  ratePct: number | null;
  toolEvents: ToolEvents;
}

export interface Reversion {
  serverId: string;
  toolName: string;
  crawl1Sha256: string;
  interimSha256: string;
  interimClass: string;
}

export interface RiderCReport {
  status: "not-evaluated" | "gate-not-met" | "evaluated";
  gate: string;
  gateMet: boolean | null;
  gateReason: string | null;
  predictionSource: string;
  predictedShareBelow: number;
  windowStart: string | null;
  windowEnd: string | null;
  windowEndEnforced: false;
  checkedAt: string | null;
  driftedServers: number | null;
  checkable: number | null;
  unverifiable: number | null;
  withPublishedSignal: number | null;
  evidenceCounts: { release: number | null; tag: number | null; "commit-message": number | null; none: number | null };
  shareWithSignalOfCheckable: number | null;
  shareWithSignalOfDrifted: number | null;
  verdict: RiderCEvaluation["verdict"] | null;
  perServer: RiderCEvaluation["perServer"] | null;
}

export interface DriftReport {
  $comment: string;
  status: "complete";
  interval: number;
  intervalBasis: string;
  n: number;
  nBasis: string;
  crawl1StartedAt: string;
  crawl2StartedAt: string;
  crawl1ScheduledFor: string;
  crawl2ScheduledFor: string;
  scheduledForBasis: string;
  taxonomyBlobSha: string;
  prediction: { source: string; registeredOn: string; metric: string; lowPct: number; highPct: number };
  semanticIntent: { servers: number; drifted: number; ratePct: number | null };
  byCapability: Stratum[];
  countedSeparately: { $comment: string; cosmetic: number; schemaAdditive: number; toolAdded: number; toolRemoved: number };
  attempted: { crawl1: number; interim: number | null; crawl2: number };
  capturedBothCrawls: { count: number; serverIds: string[] };
  headlineEligible: boolean;
  headlineSuppressedReason: string | null;
  riderC: RiderCReport;
  timeToFirstChange: {
    headline: false;
    basis: string;
    observedAtInterim: number | null;
    firstObservedOnlyAtCrawl2: number | null;
    changedThenRevertedByCrawl2: number | null;
    daysCrawl1ToInterim: number | null;
    daysInterimToCrawl2: number | null;
    driftedNotCapturedAtInterim: number | null;
    reversions: Reversion[] | null;
  };
  pairing: {
    basis: string;
    presentInBoth: { servers: number; tools: number };
    toolAdded: { servers: number; tools: number };
    toolRemoved: { servers: number; tools: number };
    serverAbsentInLaterCrawl: { servers: number; tools: number; serverIds: string[] };
  };
  toolEvents: ToolEvents;
  classifier: { version: string; crawl1Source: string; laterSources: Record<string, string>; recomputedMismatches: 0; artifacts: [] };
  labels: { required: number; human: number; mechanical: number; humanOverrodeProposal: number; labelsFile: string; taxonomyBlobSha: string };
  segments: { headline: false; crawl1ToInterim: SegmentCounts; interimToCrawl2: SegmentCounts } | null;
  sentences: { flat: string; stratified: string };
}

export type AnalyseResult =
  | { status: "needs-labels"; todo: TodoItem[]; labelsRequired: number; notes: AnalysisNote[] }
  | { status: "complete"; report: DriftReport; notes: AnalysisNote[] };

const RIDER_C_GATE_TEXT = "semanticDriftRate >= 0.20 && n >= 100";

function hashedRows(snapshot: Snapshot): HashedCapability[] {
  const rows: HashedCapability[] = [];
  for (const tools of snapshot.servers.values()) {
    for (const tool of tools.values()) {
      rows.push({ sha256: tool.sha256, capabilityClass: tool.capabilityClass });
    }
  }
  return rows;
}

function assertNoClassifierArtifacts(a: Snapshot, b: Snapshot): void {
  const artifacts = findCapabilityClassifierArtifacts(hashedRows(a), hashedRows(b));
  if (artifacts.length > 0) {
    throw new AnalysisError(
      `${artifacts.length} tool definitions have an identical sha256 in ${a.crawlId} and ${b.crawlId} but a different capability class. ` +
        "That is a classifier bug, never drift; refusing to publish any capability figure.",
      { artifacts: artifacts.slice(0, 10) },
    );
  }
}

function toolEvents(classified: readonly ClassifiedPair[], pairing: Pairing): ToolEvents {
  const count = (cls: ClassifiedPair["finalClass"]): number => classified.filter((p) => p.finalClass === cls).length;
  return {
    unchanged: count("unchanged"),
    cosmetic: count("cosmetic"),
    schemaAdditive: count("schema-additive"),
    semanticIntent: count("semantic-intent"),
    toolAdded: pairing.toolAdded.length,
    toolRemoved: pairing.toolRemoved.length,
  };
}

function semanticServers(classified: readonly ClassifiedPair[]): Set<string> {
  return new Set(classified.filter((p) => p.finalClass === "semantic-intent").map((p) => p.serverId));
}

function highestClass(classes: Iterable<CapabilityClass>): CapabilityClass {
  const present = new Set(classes);
  return CAPABILITY_ORDER.find((c) => present.has(c)) ?? "read";
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function segment(resolved: ResolvedComparison, pairing: Pairing): SegmentCounts {
  const n = pairing.capturedBoth.length;
  const drifted = semanticServers(resolved.classified).size;
  return { n, semanticIntentServers: drifted, ratePct: ratePct(drifted, n, n >= HEADLINE_FLOOR), toolEvents: toolEvents(resolved.classified, pairing) };
}

export function buildSentences(
  n: number,
  drifted: number,
  byCapability: readonly Stratum[],
  eligible: boolean,
  interval: number,
  fromIso: string,
  toIso: string,
): { flat: string; stratified: string } {
  const pct = (v: number | null): string => (v === null ? "" : ` (${v.toFixed(1)}%)`);
  const flatRate = eligible ? pct(ratePct(drifted, n, true)) : "";
  const flat =
    `Of ${n} MCP servers captured in both crawls, ${drifted}${flatRate} changed what at least one tool claims to do ` +
    `(semantic-intent) in the ${interval} days from ${day(fromIso)} to ${day(toIso)}.` +
    (eligible ? "" : ` No rate is stated: n is below the ${HEADLINE_FLOOR}-server floor.`);
  const strata = byCapability.map((s) => `${s.capabilityClass} ${s.drifted} of ${s.servers}${eligible ? pct(s.ratePct) : ""}`).join(", ");
  const stratified =
    `Semantic-intent drift by what a server's tools can do: ${strata}.` + (eligible ? "" : " Counts only: n is below the floor.");
  return { flat, stratified };
}

export async function analyseDrift(input: AnalyseInput): Promise<AnalyseResult> {
  const { crawl1, later, interim } = input;
  const notes: AnalysisNote[] = [];

  if (crawl1.crawlId !== CRAWL_1_ID) {
    throw new AnalysisError(`the earlier side of every comparison is crawl-1, not ${crawl1.crawlId}`, { crawlId: crawl1.crawlId });
  }

  // --- gate 1: the taxonomy predates crawl 1, and nothing compares across two taxonomies ---
  assertTaxonomyPreRegistered({
    crawl1BlobSha: crawl1.taxonomyBlobSha,
    crawl1StartedAt: crawl1.startedAt,
    firstCommitAt: input.taxonomy.firstCommitAt,
    otherBlobs: [
      { source: `data/${later.crawlId}-report.json`, blobSha: later.taxonomyBlobSha },
      ...(interim ? [{ source: `data/${interim.crawlId}-report.json`, blobSha: interim.taxonomyBlobSha }] : []),
      { source: "corpus/TAXONOMY.md in the working tree", blobSha: input.taxonomy.workingTreeBlobSha },
    ],
  });

  // --- gate 2: intervals from the recorded timestamps, never a constant ---
  const interval = utcCalendarDaysBetween(crawl1.startedAt, later.startedAt);
  if (interval < 0) {
    throw new AnalysisError(`${later.crawlId} started before crawl 1`, { later: later.startedAt, crawl1: crawl1.startedAt });
  }
  let daysCrawl1ToInterim: number | null = null;
  let daysInterimToCrawl2: number | null = null;
  if (interim) {
    const t1 = Date.parse(crawl1.startedAt);
    const ti = Date.parse(interim.startedAt);
    const t2 = Date.parse(later.startedAt);
    if (!(t1 < ti && ti < t2)) {
      throw new AnalysisError(`${interim.crawlId} (${interim.startedAt}) does not fall between crawl 1 and ${later.crawlId}`, {});
    }
    daysCrawl1ToInterim = utcCalendarDaysBetween(crawl1.startedAt, interim.startedAt);
    daysInterimToCrawl2 = utcCalendarDaysBetween(interim.startedAt, later.startedAt);
    if (daysCrawl1ToInterim + daysInterimToCrawl2 !== interval) {
      throw new AnalysisError(`segment days ${daysCrawl1ToInterim} + ${daysInterimToCrawl2} do not add to the interval ${interval}`, {});
    }
  }
  if (day(crawl1.startedAt) !== input.scheduled.crawl1) {
    notes.push({ level: "warn", text: `crawl 1 started on ${day(crawl1.startedAt)}; CRAWL_DATES.md scheduled ${input.scheduled.crawl1}` });
  }
  if (later.crawlId === CRAWL_2_ID && day(later.startedAt) !== input.scheduled.crawl2) {
    notes.push({
      level: "warn",
      text: `crawl 2 started on ${day(later.startedAt)}; CRAWL_DATES.md scheduled ${input.scheduled.crawl2}. The interval is the measured ${interval} days.`,
    });
  }

  // --- the corpus is frozen: no later crawl may contain a server outside it ---
  const candidateIds = new Set(input.candidates.map((c) => c.serverId));
  for (const snapshot of [crawl1, later, ...(interim ? [interim] : [])]) {
    const outside = snapshot.bootedServerIds.filter((id) => !candidateIds.has(id));
    if (outside.length > 0) {
      throw new AnalysisError(`${snapshot.crawlId} captured ${outside.length} servers not in corpus/candidates.json; the corpus is frozen`, {
        outside: outside.slice(0, 10),
      });
    }
  }

  // --- pairing ---
  const headlinePairing = pairSnapshots(crawl1, later);
  if (headlinePairing.laterOnlyServers.length > 0) {
    notes.push({
      level: "info",
      text: `${headlinePairing.laterOnlyServers.length} servers booted in ${later.crawlId} but not crawl 1; they cannot enter the comparison and are not counted`,
    });
  }

  // --- classifier stability, same version both sides ---
  assertNoClassifierArtifacts(crawl1, later);
  if (interim) {
    assertNoClassifierArtifacts(crawl1, interim);
    assertNoClassifierArtifacts(interim, later);
  }

  // --- labels ---
  const labelMap = new Map<string, LabelRecord>(input.labels.labels.map((l) => [l.key, l]));
  const blob = crawl1.taxonomyBlobSha;
  const headline = resolveComparison(`${crawl1.crawlId} -> ${later.crawlId}`, headlinePairing.pairs, labelMap, blob);

  const population = interim ? new Set(headlinePairing.capturedBoth.filter((id) => interim.servers.has(id))) : null;
  const seg1Pairing = interim && population ? pairSnapshots(crawl1, interim, { population }) : null;
  const seg2Pairing = interim && population ? pairSnapshots(interim, later, { population }) : null;
  const seg1 = interim && seg1Pairing ? resolveComparison(`${crawl1.crawlId} -> ${interim.crawlId}`, seg1Pairing.pairs, labelMap, blob) : null;
  const seg2 = interim && seg2Pairing ? resolveComparison(`${interim.crawlId} -> ${later.crawlId}`, seg2Pairing.pairs, labelMap, blob) : null;

  const comparisons = [headline, ...(seg1 ? [seg1] : []), ...(seg2 ? [seg2] : [])];
  // One entry per distinct pair of definitions: the same change can appear
  // in the headline and in a segment, and is labelled (and counted) once.
  const humanKeys = new Set<string>();
  const mechanicalKeys = new Set<string>();
  const overrideKeys = new Set<string>();
  for (const comparison of comparisons) {
    for (const p of comparison.classified) {
      const key = labelKey(p.serverId, p.toolName, p.before.sha256, p.after.sha256);
      if (p.source === "mechanical") {
        mechanicalKeys.add(key);
      } else if (p.source === "human") {
        humanKeys.add(key);
        if (p.proposal !== null && p.finalClass !== p.proposal.proposed) {
          overrideKeys.add(key);
        }
      }
    }
  }
  const todo = mergeTodo(comparisons);
  const labelsRequired = humanKeys.size + todo.length;
  if (todo.length > 0) {
    notes.push({ level: "warn", text: `${todo.length} of ${labelsRequired} required human labels are missing or skipped; run pnpm analyse:label` });
    return { status: "needs-labels", todo, labelsRequired, notes };
  }

  // --- headline counts ---
  const n = headlinePairing.capturedBoth.length;
  const eligibility = headlineEligibility(n);
  if (!eligibility.eligible) {
    notes.push({ level: "floor", text: `headline suppressed: ${eligibility.reason}. Counts only, no percentages.` });
  }
  const driftedSet = semanticServers(headline.classified);
  const drifted = driftedSet.size;

  const strataCounts = new Map<CapabilityClass, { servers: number; drifted: number }>(CAPABILITY_ORDER.map((c) => [c, { servers: 0, drifted: 0 }]));
  for (const serverId of headlinePairing.capturedBoth) {
    const tools = crawl1.servers.get(serverId)!;
    const stratum = strataCounts.get(highestClass([...tools.values()].map((t) => t.capabilityClass)))!;
    stratum.servers++;
    if (driftedSet.has(serverId)) {
      stratum.drifted++;
    }
  }
  const byCapability: Stratum[] = CAPABILITY_ORDER.map((capabilityClass) => {
    const s = strataCounts.get(capabilityClass)!;
    return { capabilityClass, servers: s.servers, drifted: s.drifted, ratePct: ratePct(s.drifted, s.servers, eligibility.eligible) };
  });

  const events = toolEvents(headline.classified, headlinePairing);
  const serversWith = (tools: ReadonlyArray<{ serverId: string }>): number => new Set(tools.map((t) => t.serverId)).size;

  // --- interim: segments, the two bins, reversions ---
  let timeToFirstChange: DriftReport["timeToFirstChange"] = {
    headline: false,
    basis: "interval-censored; see corpus/DRIFT-JSON-APPENDIX-report-shape.md",
    observedAtInterim: null,
    firstObservedOnlyAtCrawl2: null,
    changedThenRevertedByCrawl2: null,
    daysCrawl1ToInterim: null,
    daysInterimToCrawl2: null,
    driftedNotCapturedAtInterim: null,
    reversions: null,
  };
  let segments: DriftReport["segments"] = null;
  if (interim && population && seg1 && seg2 && seg1Pairing && seg2Pairing) {
    const atInterim = semanticServers(seg1.classified);
    const observedAtInterim = [...driftedSet].filter((id) => population.has(id) && atInterim.has(id)).length;
    const firstObservedOnlyAtCrawl2 = [...driftedSet].filter((id) => population.has(id) && !atInterim.has(id)).length;
    const driftedNotCapturedAtInterim = [...driftedSet].filter((id) => !population.has(id)).length;
    if (observedAtInterim + firstObservedOnlyAtCrawl2 + driftedNotCapturedAtInterim !== drifted) {
      throw new AnalysisError("time-to-first-change bins do not add to the drifted count", {});
    }
    const reversions: Reversion[] = [];
    for (const p of seg1.classified) {
      if (p.finalClass === "unchanged") {
        continue;
      }
      const atLater = later.servers.get(p.serverId)?.get(p.toolName);
      if (atLater !== undefined && atLater.sha256 === p.before.sha256) {
        reversions.push({ serverId: p.serverId, toolName: p.toolName, crawl1Sha256: p.before.sha256, interimSha256: p.after.sha256, interimClass: p.finalClass });
      }
    }
    timeToFirstChange = {
      ...timeToFirstChange,
      observedAtInterim,
      firstObservedOnlyAtCrawl2,
      changedThenRevertedByCrawl2: new Set(reversions.map((r) => r.serverId)).size,
      daysCrawl1ToInterim,
      daysInterimToCrawl2,
      driftedNotCapturedAtInterim,
      reversions,
    };
    segments = { headline: false, crawl1ToInterim: segment(seg1, seg1Pairing), interimToCrawl2: segment(seg2, seg2Pairing) };
    if (population.size < HEADLINE_FLOOR) {
      notes.push({ level: "info", text: `segment n = ${population.size} is below ${HEADLINE_FLOOR}; segment rates are null, counts only` });
    }
  }

  // --- rider C ---
  const gate = riderCGate(n === 0 ? 0 : drifted / n, n);
  let riderC: RiderCReport = {
    status: "gate-not-met",
    gate: RIDER_C_GATE_TEXT,
    gateMet: false,
    gateReason: gate.reason,
    predictionSource: "corpus/PREDICTIONS.md, prediction 3",
    predictedShareBelow: 0.3,
    windowStart: crawl1.startedAt,
    windowEnd: later.startedAt,
    windowEndEnforced: false,
    checkedAt: null,
    driftedServers: null,
    checkable: null,
    unverifiable: null,
    withPublishedSignal: null,
    evidenceCounts: { release: null, tag: null, "commit-message": null, none: null },
    shareWithSignalOfCheckable: null,
    shareWithSignalOfDrifted: null,
    verdict: null,
    perServer: null,
  };
  notes.push({ level: gate.met ? "info" : "warn", text: gate.reason });
  if (gate.met) {
    if (input.checkSignal === null) {
      throw new AnalysisError("rider C's gate is met but no changelog checker was supplied; rider C cannot be omitted once its gate is met", {});
    }
    const evaluation = await evaluateRiderC([...driftedSet].sort(), input.candidates, crawl1.startedAt, input.checkSignal);
    riderC = {
      ...riderC,
      status: "evaluated",
      gateMet: true,
      checkedAt: input.now.toISOString(),
      driftedServers: evaluation.driftedServers,
      checkable: evaluation.checkable,
      unverifiable: evaluation.unverifiable,
      withPublishedSignal: evaluation.withPublishedSignal,
      evidenceCounts: evaluation.evidenceCounts,
      shareWithSignalOfCheckable: evaluation.shareWithSignalOfCheckable,
      shareWithSignalOfDrifted: evaluation.shareWithSignalOfDrifted,
      verdict: evaluation.verdict,
      perServer: evaluation.perServer,
    };
    notes.push({
      level: "info",
      text: `rider C: ${evaluation.withPublishedSignal} of ${evaluation.checkable} checkable drifted servers published a signal (${evaluation.unverifiable} had no repo link and are excluded); verdict ${evaluation.verdict}`,
    });
  }

  const report: DriftReport = {
    $comment:
      "Emitted by `pnpm analyse:drift` from crawl-1 against crawl-2. Shape: the pending form committed in e7a453b plus " +
      "corpus/DRIFT-JSON-APPENDIX-report-shape.md (both sections). Only semantic-intent enters `semanticIntent` and `byCapability`.",
    status: "complete",
    interval,
    intervalBasis: "measured: UTC calendar days between crawl1StartedAt and crawl2StartedAt, computed from the two crawl reports",
    n,
    nBasis: "servers captured in BOTH crawls: crawl 1's bootedServerIds intersected with the later crawl's",
    crawl1StartedAt: crawl1.startedAt,
    crawl2StartedAt: later.startedAt,
    crawl1ScheduledFor: input.scheduled.crawl1,
    crawl2ScheduledFor: input.scheduled.crawl2,
    scheduledForBasis: "copied from CRAWL_DATES.md, which is the authority, and re-read from it on every run",
    taxonomyBlobSha: blob,
    prediction: {
      source: "corpus/PREDICTIONS.md",
      registeredOn: "2026-09-12",
      metric: "semantic-intent drift, share of servers captured in both crawls with >= 1 semantic-intent change",
      lowPct: 20,
      highPct: 40,
    },
    semanticIntent: { servers: n, drifted, ratePct: ratePct(drifted, n, eligibility.eligible) },
    byCapability,
    countedSeparately: {
      $comment:
        "CLAUDE.md non-negotiable 9: cosmetic and schema-additive changes are counted and published separately and NEVER enter a headline number. Unit: tools.",
      cosmetic: events.cosmetic,
      schemaAdditive: events.schemaAdditive,
      toolAdded: events.toolAdded,
      toolRemoved: events.toolRemoved,
    },
    attempted: { crawl1: crawl1.attempted, interim: interim ? interim.attempted : null, crawl2: later.attempted },
    capturedBothCrawls: { count: n, serverIds: headlinePairing.capturedBoth },
    headlineEligible: eligibility.eligible,
    headlineSuppressedReason: eligibility.reason,
    riderC,
    timeToFirstChange,
    pairing: {
      basis: "crawl 1 bootedServerIds, joined on (serverId, toolName)",
      presentInBoth: { servers: n, tools: headlinePairing.pairs.length },
      toolAdded: { servers: serversWith(headlinePairing.toolAdded), tools: headlinePairing.toolAdded.length },
      toolRemoved: { servers: serversWith(headlinePairing.toolRemoved), tools: headlinePairing.toolRemoved.length },
      serverAbsentInLaterCrawl: {
        servers: headlinePairing.serverAbsent.length,
        tools: headlinePairing.serverAbsent.reduce((sum, s) => sum + s.tools, 0),
        serverIds: headlinePairing.serverAbsent.map((s) => s.serverId),
      },
    },
    toolEvents: events,
    classifier: {
      version: ANALYSIS_CLASSIFIER_VERSION,
      crawl1Source: "data/crawl-1-capabilities-v2.json",
      laterSources: Object.fromEntries(
        [later, ...(interim ? [interim] : [])]
          .filter((s) => s.crawlId !== CRAWL_1_ID)
          .map((s) => [s.crawlId, `data/${s.crawlId}-capabilities.json`]),
      ),
      recomputedMismatches: 0,
      artifacts: [],
    },
    labels: {
      required: labelsRequired,
      human: humanKeys.size,
      mechanical: mechanicalKeys.size,
      humanOverrodeProposal: overrideKeys.size,
      labelsFile: "data/labels.json",
      taxonomyBlobSha: blob,
    },
    segments,
    sentences: buildSentences(n, drifted, byCapability, eligibility.eligible, interval, crawl1.startedAt, later.startedAt),
  };

  return { status: "complete", report, notes };
}

/** Reads the two scheduled dates out of CRAWL_DATES.md's table. Fails if either row is missing. */
export function parseScheduledDates(markdown: string): { crawl1: string; crawl2: string } {
  const crawl1 = /^\|\s*Crawl 1\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/m.exec(markdown)?.[1];
  const crawl2 = /^\|\s*Crawl 2\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/m.exec(markdown)?.[1];
  if (crawl1 === undefined || crawl2 === undefined) {
    throw new AnalysisError("CRAWL_DATES.md does not have the Crawl 1 / Crawl 2 rows in its table", {});
  }
  return { crawl1, crawl2 };
}
