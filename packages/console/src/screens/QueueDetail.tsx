/**
 * /queue/:id — one held change. Visual hierarchy is the argument: the
 * verbatim before/after text (highlighted with the stored diffSpans, never
 * re-diffed here) is the loudest thing on the page; the model-generated
 * advisory sits below it, smaller, greyer, and labelled as not the
 * decision; the decision itself goes through the gateway's token-checked
 * `chaperone/approve_change`, with no console-only shortcut.
 */
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, useQuarantine } from "../api";
import { approveChange, type ApproveStep, type Decision } from "../mcp";
import {
  clipSpansToLength,
  formatDate,
  formatTime,
  MAX_DESCRIPTION_CHARS,
  sanitizeInvisibleChars,
  segmentsFor,
  short,
  truncateForDisplay,
} from "../lib";
import { Link } from "../router";
import { applyOverride, viewOf } from "../state";
import { useOverride } from "../screenState";
import { DETAIL_EMPTY, detailFixture } from "../fixtures";
import type { DiffSpan, LedgerEvent, QuarantineDetail, ToolText } from "../types";
import { CapabilityBadge, EmptyState, ErrorBox, Field, SkeletonBlock, SkeletonRows, StateMark, stateNote } from "../components/marks";

export function Verbatim({ text, spans, side }: { text: string; spans: DiffSpan[]; side: DiffSpan["side"] }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length === 0) {
    return <p className="text-n-400 italic">(no description)</p>;
  }
  const sanitized = sanitizeInvisibleChars(text);
  const { text: shown, truncated } = expanded ? { text: sanitized, truncated: false } : truncateForDisplay(sanitized);
  const shownSpans = expanded ? spans : clipSpansToLength(spans, shown.length);
  return (
    <>
      <p className="text-3 leading-[var(--text-3-lh)] text-n-900 whitespace-pre-wrap break-words">
        {segmentsFor(shown, shownSpans, side).map((seg, i) =>
          seg.mark === "add" ? (
            <mark key={i} className="add">
              {seg.text}
            </mark>
          ) : seg.mark === "remove" ? (
            <del key={i} className="remove">
              {seg.text}
            </del>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </p>
      {truncated && (
        <p className="mt-1 text-1 text-n-600">
          truncated at {MAX_DESCRIPTION_CHARS.toLocaleString("en-US")} characters ({text.length.toLocaleString("en-US")} total)
          {" — "}
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="underline decoration-n-200 underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            show full text
          </button>
        </p>
      )}
    </>
  );
}

function schemaText(t: ToolText): string {
  return JSON.stringify(t.inputSchema ?? null, null, 2);
}

function DiffPanel({ q }: { q: QuarantineDetail }) {
  const schemaChanged = schemaText(q.before) !== schemaText(q.after);
  const addedCount = q.diffSpans.filter((s) => s.side === "after").length;
  return (
    <section aria-labelledby="diff-h" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="diff-h" className="label">
          Tool description, verbatim
        </h2>
        <span className="text-1 text-n-600">
          <mark className="add">added</mark> · <del className="remove">removed</del> · spans stored at detection, not recomputed
          {addedCount > 0 && ` · ${addedCount} changed ${addedCount === 1 ? "clause" : "clauses"}`}
        </span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <article className="box p-4 sm:p-6">
          <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b-[length:var(--rule)] border-n-100 pb-2">
            <span className="label">What the household approved</span>
            <span className="hash text-n-600" title={q.fromHash}>
              {short(q.fromHash)}
            </span>
          </header>
          <Verbatim text={q.before.description ?? ""} spans={q.diffSpans} side="before" />
          <footer className="mt-4 text-1 text-n-600">
            {q.pinnedVersion ? (
              <>
                Approved <span className="num text-2 text-n-900">{formatDate(q.pinnedVersion.approvedAt)}</span>{" "}
                <span className="num text-2 text-n-900">{formatTime(q.pinnedVersion.approvedAt)}</span> by{" "}
                <span className="hash">{q.pinnedVersion.approvedBy}</span>
              </>
            ) : (
              "No approval event found for this hash."
            )}
          </footer>
        </article>
        <article className="box border-[length:var(--rule-heavy)] p-4 sm:p-6">
          <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b-[length:var(--rule)] border-n-100 pb-2">
            <span className="label">What the upstream says now</span>
            <span className="hash text-n-600" title={q.toHash}>
              {short(q.toHash)}
            </span>
          </header>
          <Verbatim text={q.after.description ?? ""} spans={q.diffSpans} side="after" />
          <footer className="mt-4 text-1 text-n-600">
            Detected <span className="num text-2 text-n-900">{formatDate(q.detectedAt)}</span>{" "}
            <span className="num text-2 text-n-900">{formatTime(q.detectedAt)}</span> on{" "}
            <span className="text-n-900">{q.upstreamLabel}</span>
          </footer>
        </article>
      </div>
      {schemaChanged && (
        <details className="box p-4">
          <summary className="label cursor-pointer">Input schema also changed — shown whole, not span-highlighted</summary>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <pre className="hash overflow-x-auto bg-n-50 p-3">{schemaText(q.before)}</pre>
            <pre className="hash overflow-x-auto bg-n-50 p-3">{schemaText(q.after)}</pre>
          </div>
        </details>
      )}
    </section>
  );
}

function AdvisoryPanel({ q }: { q: QuarantineDetail }) {
  const a = q.advisory;
  return (
    <section
      aria-labelledby="adv-h"
      className="rounded-form border-[length:var(--rule)] border-dashed border-n-200 bg-n-50 p-4 text-n-600"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="adv-h" className="label text-n-600">
          Advisory · model-generated · not the decision
        </h2>
        {a && (
          <span className="flex items-baseline gap-1" title="Advisory score, 0–100. Used only to order the queue.">
            <span className="num text-4 text-n-600">{Math.round(a.score)}</span>
            <span className="text-1 text-n-400">/100</span>
          </span>
        )}
      </div>
      {a ? (
        <>
          <p className="mt-2 text-2 italic">“{a.summary}”</p>
          {/* Only what the advisory row actually stores. Token and cost counts aren't persisted, so they aren't shown. */}
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-1 sm:grid-cols-3">
            <div>
              <dt className="text-n-400">model</dt>
              <dd className="hash break-all">{a.modelId}</dd>
            </div>
            <div>
              <dt className="text-n-400">prompt sha</dt>
              <dd className="hash" title={a.promptSha}>
                {short(a.promptSha)}
              </dd>
            </div>
            <div>
              <dt className="text-n-400">generated</dt>
              <dd className="num text-2">
                {formatDate(a.generatedAt)} {formatTime(a.generatedAt)}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="mt-2 text-2">
          No advisory for this change. That is not a signal it is safe — read the verbatim text above. The decision never
          depends on the advisory.
        </p>
      )}
    </section>
  );
}

type RunState =
  | { phase: "idle" }
  | { phase: "running"; decision: Decision; steps: ApproveStep[] }
  | { phase: "done"; decision: Decision; steps: ApproveStep[]; ok: boolean; text: string };

function DecisionPanel({ q }: { q: QuarantineDetail }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [reverted, setReverted] = useState<Decision | null>(null);

  if (q.reviewState !== "pending") {
    // Token consumed (by the card or here) or expired: there is no second approval mechanism to offer.
    const consumed = q.reviewState === "approved" || q.reviewState === "refused";
    return (
      <section aria-labelledby="dec-h" className="box border-n-200 bg-n-50 p-4">
        <h2 id="dec-h" className="label text-n-600">
          Decision
        </h2>
        <div className="mt-2">
          <StateMark state={q.reviewState} />
        </div>
        <p className="mt-2 text-n-800">
          {consumed
            ? `The approval token was consumed${q.resolvedAt ? ` ${formatDate(q.resolvedAt)} ${formatTime(q.resolvedAt)}` : ""}. `
            : `The approval token expired ${formatDate(q.tokenExpiresAt)} ${formatTime(q.tokenExpiresAt)}. `}
          {stateNote(q.reviewState)}
        </p>
        {run.phase === "done" && <RunLog run={run} />}
      </section>
    );
  }

  const busy = run.phase === "running";
  const key = queryKeys.quarantine(q.quarantineId);

  /**
   * The decision is applied optimistically: the state mark flips the moment
   * the resident commits, because the MCP round trip is several hops
   * (initialize, tools/call, session close) and a form that looks inert for
   * that long invites a second click.
   *
   * It reverts *visibly* on failure. The previous cache entry is restored
   * and a crimson notice names what was rolled back. A silent revert would
   * be the worst failure mode this screen has: a resident who believes they
   * blocked something has to be told when they did not.
   */
  const submit = (decision: Decision) => async (e?: FormEvent) => {
    e?.preventDefault();
    if (token.trim().length === 0 || busy) return;
    const steps: ApproveStep[] = [];
    setReverted(null);
    setRun({ phase: "running", decision, steps });

    await queryClient.cancelQueries({ queryKey: key });
    const snapshot = queryClient.getQueryData<QuarantineDetail>(key);
    queryClient.setQueryData<QuarantineDetail>(key, (prev) =>
      prev === undefined
        ? prev
        : { ...prev, reviewState: decision === "approve" ? "approved" : "refused", resolvedAt: new Date().toISOString() },
    );

    let ok = false;
    try {
      const out = await approveChange(q.quarantineId, token.trim(), decision, (step) => {
        steps.push(step);
        setRun({ phase: "running", decision, steps: [...steps] });
      });
      ok = out.ok;
      setRun({ phase: "done", decision, steps: [...steps], ok: out.ok, text: out.text });
    } catch (error) {
      setRun({
        phase: "done",
        decision,
        steps: [...steps],
        ok: false,
        text: error instanceof Error ? `Could not reach the gateway: ${error.message}` : "Could not reach the gateway.",
      });
    }
    if (!ok) {
      // Put the row back exactly as it was, and say so. The gateway is the
      // only authority on whether a decision landed; a rejected token
      // leaves the change withheld, and this screen has to show that.
      if (snapshot !== undefined) {
        queryClient.setQueryData(key, snapshot);
      }
      setReverted(decision);
    }
    // Success or a consumed/expired rejection: either way the server's view is what the page should show next.
    await queryClient.invalidateQueries();
  };

  return (
    <section aria-labelledby="dec-h" className="box border-warn border-[length:var(--rule-heavy)] p-4">
      <h2 id="dec-h" className="label">
        Decision
      </h2>
      <p className="mt-1 text-1 text-n-600">
        Sent as <span className="hash text-accent">chaperone/approve_change</span> over <span className="hash">/mcp</span> —
        the same token-checked path as the consent card.
      </p>
      <form onSubmit={submit("approve")} className="mt-3 grid gap-3">
        <label className="grid gap-1">
          <span className="label">One-time approval token</span>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder="paste from the consent card"
            className="micro hash rounded-form border-[length:var(--rule)] border-accent bg-n-0 px-3 py-2 text-2 text-n-900 placeholder:text-n-400 hover:bg-accent-wash focus:bg-n-0 disabled:border-n-200 disabled:bg-n-100 disabled:text-n-400"
          />
          <span className="text-1 text-n-600">
            Expires {formatDate(q.tokenExpiresAt)} {formatTime(q.tokenExpiresAt)}.{" "}
            {q.tokenHeld ? "The gateway is still holding it for the consent card." : "The gateway no longer holds the plaintext — use the copy from the card."}
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy || token.trim().length === 0}
            className="micro label rounded-form border-[length:var(--rule)] border-ok bg-ok px-4 py-2 text-n-0 hover:bg-[color-mix(in_oklab,var(--ok)_85%,var(--n-900))] active:translate-y-px disabled:border-n-200 disabled:bg-n-100 disabled:text-n-400"
          >
            {busy && run.decision === "approve" ? "Approving…" : "Approve & re-pin"}
          </button>
          <button
            type="button"
            onClick={() => void submit("block")()}
            disabled={busy || token.trim().length === 0}
            className="micro label rounded-form border-[length:var(--rule)] border-blocked bg-n-0 px-4 py-2 text-blocked hover:bg-blocked-wash active:translate-y-px disabled:border-n-200 disabled:bg-n-100 disabled:text-n-400"
          >
            {busy && run.decision === "block" ? "Blocking…" : "Block"}
          </button>
        </div>
      </form>
      {reverted !== null && (
        <p role="alert" className="mt-3 border-l-[length:var(--rule-heavy)] border-blocked bg-blocked-wash px-3 py-2 text-n-900">
          <span className="label mr-2 text-blocked">Rolled back</span>
          This page briefly showed the change as {reverted === "approve" ? "approved" : "blocked"}. The gateway did not
          accept the decision, so it has been put back: the change is still withheld and still awaiting a resident.
        </p>
      )}
      {run.phase !== "idle" && <RunLog run={run} />}
    </section>
  );
}

/** Each MCP step appears as it completes — progressive, not a spinner. */
function RunLog({ run }: { run: Exclude<RunState, { phase: "idle" }> }) {
  return (
    <div className="mt-4 border-t-[length:var(--rule)] border-n-100 pt-3" aria-live="polite">
      <ol className="grid gap-1">
        {run.steps.map((s, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3">
            <span className="hash text-n-800">✓ {s.label}</span>
            <span className="num text-n-600">{s.ms}ms</span>
          </li>
        ))}
        {run.phase === "running" && <li className="hash text-n-400">… waiting on the gateway</li>}
      </ol>
      {run.phase === "done" && (
        <p
          role={run.ok ? "status" : "alert"}
          className={`mt-2 border-l-[length:var(--rule-heavy)] px-3 py-2 ${run.ok ? "border-ok bg-ok-wash text-n-900" : "border-blocked bg-blocked-wash text-n-900"}`}
        >
          <span className="label mr-2">{run.ok ? "Gateway" : "Gateway refused"}</span>
          {run.text}
        </p>
      )}
    </div>
  );
}

function Trail({ events }: { events: LedgerEvent[] }) {
  return (
    <section aria-labelledby="trail-h" className="box p-4">
      <div className="flex items-baseline justify-between">
        <h2 id="trail-h" className="label">
          Ledger trail
        </h2>
        <Link href="/ledger" className="label micro text-n-600 underline decoration-n-200 underline-offset-4 hover:text-accent hover:decoration-accent">
          Full chain →
        </Link>
      </div>
      {events.length === 0 ? (
        <p className="mt-2 text-n-600">No ledger events reference this change.</p>
      ) : (
        <ol className="mt-3 grid gap-0">
          {events.map((e) => (
            <li key={e.sk} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 border-l-[length:var(--rule)] border-accent pb-3 pl-3 last:pb-0">
              <span className="num text-3 text-accent">#{e.index}</span>
              <span className="min-w-0">
                <span className="block font-semibold text-n-900">{e.type}</span>
                <span className="block text-1 text-n-600">
                  <span className="num text-2 text-n-800">{formatTime(e.ts)}</span> · <span className="hash">{e.actor}</span>
                </span>
                <span className="hash block truncate text-n-400" title={e.eventHash}>
                  event {short(e.eventHash)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function QueueDetail({ id }: { id: string }) {
  const override = useOverride();
  const query = useQuarantine(id);
  // partial = the advisory is missing, which is the normal case rather than
  // an exception: the advisory is generated asynchronously and the decision
  // never waits on it.
  const view = applyOverride(viewOf(query), override, {
    empty: DETAIL_EMPTY,
    partial: detailFixture({ advisory: null }),
    what: "this change",
  });
  const q = view.status === "ready" ? view.data : undefined;

  return (
    <div className="grid gap-6">
      <Link href="/queue" className="label micro w-fit text-n-600 hover:text-accent">
        ← Review queue
      </Link>
      {view.status === "loading" ? (
        // Same regions, same heights, same two-column split as the loaded
        // page, so nothing moves when the record lands.
        <div className="grid gap-6">
          <SkeletonBlock label="Reading quarantine, pin, advisory and ledger…" height="120px" />
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
            <div className="grid content-start gap-6">
              <SkeletonBlock label="Tool description, verbatim" height="var(--row-detail)" />
              <SkeletonBlock label="Advisory" height="140px" />
            </div>
            <div className="grid content-start gap-6">
              <SkeletonBlock label="Decision" height="260px" />
              <SkeletonRows rows={1} label="Ledger trail" height="180px" />
            </div>
          </div>
        </div>
      ) : view.status === "error" ? (
        <ErrorBox error={view.error} what="this change" onRetry={() => void query.refetch()} />
      ) : q === undefined || q.quarantineId === "" ? (
        <EmptyState label="No such change">
          <p>
            There is no quarantine with the id <span className="hash text-n-900">{id}</span> for this household. A
            quarantine id is minted when a tool stops matching its pinned hash; if this link came from an older ledger
            entry, the record may belong to a different household.
          </p>
          <Link href="/queue" className="label micro mt-3 inline-block border-b-[length:var(--rule)] border-accent text-accent">
            Back to the review queue →
          </Link>
        </EmptyState>
      ) : (
        <>
          <header className="grid gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="title break-all">{q.toolName}</h1>
              <CapabilityBadge value={q.capabilityClass} />
              <StateMark state={q.reviewState} />
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Field label="Upstream">
                <span className="text-n-900">{q.upstreamLabel}</span>
              </Field>
              <Field label="Quarantine">
                <span className="hash block truncate text-n-900" title={q.quarantineId}>
                  {q.quarantineId}
                </span>
              </Field>
              <Field label="Hash">
                <span className="hash text-n-900">
                  {short(q.fromHash, 8)} → {short(q.toHash, 8)}
                </span>
              </Field>
              <Field label="Pinned version approved">
                <span className="num text-3 text-n-900">
                  {q.pinnedVersion ? formatDate(q.pinnedVersion.approvedAt) : "—"}
                </span>
              </Field>
            </div>
          </header>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
            <div className="grid content-start gap-6">
              <DiffPanel q={q} />
              <AdvisoryPanel q={q} />
            </div>
            <div className="grid content-start gap-6">
              <DecisionPanel q={q} />
              <Trail events={q.events} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
