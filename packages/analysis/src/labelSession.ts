/**
 * `pnpm analyse:label`: the M16 labelling loop and M14's prevalence loop.
 *
 * Plain line input (type a letter, press Enter) rather than raw keypresses,
 * because line mode behaves the same in Windows Command Prompt, PowerShell,
 * a Unix terminal and a pipe. Every answer is saved before the next item is
 * shown, so closing the window at any point loses nothing, and the next run
 * resumes at the first item without a decision. `skip` is recorded but is
 * not a decision: a skipped item comes round again on the next run.
 */
import { AnalysisError } from "@chaperone/errors";
import { type HumanChoice, LABEL_PROCEDURE, type LabelRecord, type LabelsFile, type LabelsTodoFile, assertHumanLabeler } from "./labels.js";
import { PREVALENCE_QUESTION, type PrevalenceFile, summarizePrevalence } from "./prevalence.js";
import { groupTodoItems } from "./labelGroups.js";
import { type Style, renderLabelUnit, renderTodoItem } from "./render.js";

export interface LabelIo {
  /** Prints `prompt` and resolves the next input line, or null at end of input. */
  ask(prompt: string): Promise<string | null>;
  print(text: string): void;
}

export interface SessionSummary {
  shown: number;
  decided: number;
  skipped: number;
  /** Items still without a decision after this session. */
  remaining: number;
  quit: boolean;
}

/** Units (groups of identical edits) shown and answered together in the grouped view. */
export const BATCH_SIZE = 5;

const CHANGE_CHOICES: Record<string, HumanChoice> = {
  c: "cosmetic",
  a: "schema-additive",
  i: "semantic-intent",
  s: "skip",
};

const CHANGE_HELP =
  "  c = cosmetic         (no claim changed: wording, typo, formatting)\n" +
  "  a = schema-additive  (optional field / widened enum, nothing else)\n" +
  "  i = semantic-intent  (what it claims to do, access, or talk to changed)\n" +
  "  s = skip             (decide later; it will come round again)\n" +
  "  q = quit             (everything so far is already saved; a half-answered batch is not)\n" +
  "  In a batch, answer with one letter per item, separated by spaces, e.g. \"i c a i s\".";

export interface ChangeSessionOptions {
  todo: LabelsTodoFile;
  labels: LabelsFile;
  labeledBy: string;
  /** `git hash-object corpus/TAXONOMY.md` now. */
  taxonomyBlobSha: string;
  io: LabelIo;
  style: Style;
  now: () => Date;
  save(labels: LabelsFile): Promise<void>;
  /**
   * Show each set of items with an identical edit once, and apply the one answer to every item in it
   * (recorded as `appliedByGroup`). Off by default; `pnpm analyse:label` turns it on unless given --no-group.
   * In this mode nothing proposed by the classifier is shown: the label is the person's own judgement.
   */
  groupIdentical?: boolean;
}

export async function runChangeLabelSession(opts: ChangeSessionOptions): Promise<SessionSummary> {
  assertHumanLabeler(opts.labeledBy);
  if (opts.todo.taxonomyBlobSha !== opts.taxonomyBlobSha) {
    throw new AnalysisError(
      `data/labels-todo.json was generated under corpus/TAXONOMY.md blob ${opts.todo.taxonomyBlobSha}, but the file now hashes to ${opts.taxonomyBlobSha}`,
      {},
    );
  }
  const byKey = new Map(opts.labels.labels.map((l) => [l.key, l]));
  const open = opts.todo.items.filter((item) => {
    const existing = byKey.get(item.key);
    return existing === undefined || existing.label === "skip";
  });
  const summary: SessionSummary = { shown: 0, decided: 0, skipped: 0, remaining: open.length, quit: false };
  if (open.length === 0) {
    opts.io.print(`Nothing to label: all ${opts.todo.items.length} items in labels-todo.json have a decision.`);
    return summary;
  }
  const grouped = opts.groupIdentical === true;
  // A unit is what one answer covers: a group of identical edits, or a single item.
  const units = grouped ? groupTodoItems(open).map((g) => ({ id: g.id, items: g.items })) : open.map((item) => ({ id: "", items: [item] }));
  opts.io.print(
    `${open.length} of ${opts.todo.items.length} items need a decision` +
      (grouped ? `, in ${units.length} groups of identical edits (one answer covers every tool in a group)` : "") +
      `. Labelling as "${opts.labeledBy}".`,
  );
  opts.io.print(CHANGE_HELP);

  // Grouped view: BATCH_SIZE units at a time, answered with one letter per unit ("i c a i s").
  // Ungrouped view keeps one item per prompt.
  const batchSize = grouped ? BATCH_SIZE : 1;
  const batchCount = Math.ceil(units.length / batchSize);
  for (let b = 0; b < batchCount && !summary.quit; b++) {
    const batch = units.slice(b * batchSize, (b + 1) * batchSize);
    if (grouped) {
      opts.io.print(opts.style.bold(`\n=== batch ${b + 1} of ${batchCount}: items 1-${batch.length} ===`));
    }
    for (const [n, unit] of batch.entries()) {
      const first = unit.items[0]!;
      const previouslySkipped = unit.items.some((item) => byKey.get(item.key)?.label === "skip");
      opts.io.print(
        grouped
          ? renderLabelUnit(unit.items, unit.id, n + 1, batch.length, opts.style, previouslySkipped)
          : renderTodoItem(first, b * batchSize + n + 1, units.length, opts.style, previouslySkipped),
      );
      summary.shown += unit.items.length;
    }
    const prompt =
      batch.length > 1
        ? `labels for 1-${batch.length}, ${batch.length} letters separated by spaces [c/a/i/s, q quits, ? for help]: `
        : batch[0]!.items.length > 1
          ? `label for all ${batch[0]!.items.length} tools [c/a/i/s/q, ? for help]: `
          : "label [c/a/i/s/q, ? for help]: ";
    let choices: HumanChoice[] | "quit" | undefined;
    while (choices === undefined) {
      const answer = await opts.io.ask(prompt);
      if (answer === null) {
        choices = "quit";
        break;
      }
      const tokens = answer.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
      if (tokens.length === 1 && tokens[0] === "q") {
        choices = "quit";
      } else if (tokens.length === 1 && (tokens[0] === "?" || tokens[0] === "h")) {
        opts.io.print(CHANGE_HELP);
      } else if (tokens.length !== batch.length) {
        opts.io.print(`expected ${batch.length} letter${batch.length === 1 ? "" : "s"} (one per item, c/a/i/s), got ${tokens.length}. Nothing was saved.`);
      } else {
        const bad = tokens.find((t) => CHANGE_CHOICES[t] === undefined);
        if (bad !== undefined) {
          opts.io.print(`"${bad}" is not one of c, a, i, s. Nothing was saved.`);
        } else {
          choices = tokens.map((t) => CHANGE_CHOICES[t]!);
        }
      }
    }
    if (choices === "quit") {
      // Nothing from a half-answered batch is saved; it comes round again.
      summary.quit = true;
      break;
    }
    const labeledAt = opts.now().toISOString();
    for (const [n, unit] of batch.entries()) {
      const choice = choices[n]!;
      for (const item of unit.items) {
        const record: LabelRecord = {
          key: item.key,
          serverId: item.serverId,
          toolName: item.toolName,
          beforeSha256: item.beforeSha256,
          afterSha256: item.afterSha256,
          label: choice,
          proposed: item.proposed,
          labeledBy: opts.labeledBy,
          labeledAt,
          taxonomyBlobSha: opts.taxonomyBlobSha,
          procedure: LABEL_PROCEDURE,
          // A skip is not an applied label, so it carries no group record.
          ...(unit.items.length > 1 && choice !== "skip" ? { appliedByGroup: { groupId: unit.id, groupSize: unit.items.length } } : {}),
        };
        byKey.set(item.key, record);
      }
      if (choice === "skip") {
        summary.skipped += unit.items.length;
      } else {
        summary.decided += unit.items.length;
        summary.remaining -= unit.items.length;
      }
    }
    opts.labels = { ...opts.labels, labels: [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) };
    await opts.save(opts.labels);
  }
  opts.io.print(
    `\n${summary.decided} decided, ${summary.skipped} skipped this session; ${summary.remaining} still need a decision.` +
      (summary.remaining === 0 ? " Re-run pnpm analyse:drift." : " Run pnpm analyse:label again to continue."),
  );
  return summary;
}

export interface PrevalenceSessionOptions {
  file: PrevalenceFile;
  labeledBy: string;
  taxonomyBlobSha: string;
  io: LabelIo;
  style: Style;
  now: () => Date;
  save(file: PrevalenceFile): Promise<void>;
}

const PREVALENCE_HELP = "  y = yes, instruction-shaped\n  n = no\n  s = skip (comes round again)\n  q = quit (everything so far is already saved)";

export async function runPrevalenceSession(opts: PrevalenceSessionOptions): Promise<SessionSummary> {
  assertHumanLabeler(opts.labeledBy);
  const items = opts.file.items.map((i) => ({ ...i }));
  const openIdx = items.flatMap((item, i) => (item.answer === null ? [i] : []));
  const summary: SessionSummary = { shown: 0, decided: 0, skipped: 0, remaining: openIdx.length, quit: false };
  if (openIdx.length === 0) {
    opts.io.print(`Nothing to label: all ${items.length} sampled tools are answered.`);
    return summary;
  }
  opts.io.print(`${openIdx.length} of ${items.length} sampled crawl-1 tools unanswered. Labelling as "${opts.labeledBy}".`);
  opts.io.print(opts.style.bold(PREVALENCE_QUESTION));
  opts.io.print(PREVALENCE_HELP);

  for (const [n, idx] of openIdx.entries()) {
    const item = items[idx]!;
    opts.io.print(
      `\n${opts.style.bold(`[${n + 1}/${openIdx.length}] ${item.serverId}  ::  ${item.toolName}`)}\n  ${item.description || opts.style.dim("(no description)")}`,
    );
    summary.shown++;
    let answer: "yes" | "no" | "skip" | "quit" | undefined;
    while (answer === undefined) {
      const line = await opts.io.ask("instruction-shaped? [y/n/s/q]: ");
      const key = line === null ? "q" : line.trim().toLowerCase();
      if (key === "y") answer = "yes";
      else if (key === "n") answer = "no";
      else if (key === "s") answer = "skip";
      else if (key === "q") answer = "quit";
      else if (key === "?" || key === "h") opts.io.print(PREVALENCE_HELP);
      else opts.io.print(`"${key}" is not one of y, n, s, q.`);
    }
    if (answer === "quit") {
      summary.quit = true;
      break;
    }
    if (answer === "skip") {
      summary.skipped++;
      continue;
    }
    items[idx] = { ...item, answer, labeledBy: opts.labeledBy, labeledAt: opts.now().toISOString(), taxonomyBlobSha: opts.taxonomyBlobSha, procedure: LABEL_PROCEDURE };
    opts.file = { ...opts.file, items };
    await opts.save(opts.file);
    summary.decided++;
    summary.remaining--;
  }
  const s = summarizePrevalence(opts.file);
  opts.io.print(
    `\n${s.answered} of ${s.sampleSize} answered: ${s.yes} yes, ${s.no} no.` +
      (s.sharePct === null ? " No share is stated until all are answered." : ` Share instruction-shaped: ${s.sharePct.toFixed(1)}% (n = ${s.sampleSize}; prediction 2: 5-12%).`),
  );
  return summary;
}
