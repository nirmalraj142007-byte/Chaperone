/**
 * /queue — every quarantine for the household, sorted server-side: unscored
 * first (an unscored item is not a safe item), then advisory score
 * descending. The filter is by review state; counts come from the unfiltered
 * list so a filter never hides how much is waiting.
 */
import { useState } from "react";
import { useQueue, type QueueFilter } from "../api";
import { ago, formatDate, formatTime, isFixtureModelId } from "../lib";
import { Link, replaceQuery, useSearch } from "../router";
import { applyOverride, viewOf, withOverride } from "../state";
import { useOverride } from "../screenState";
import { QUEUE_EMPTY, QUEUE_PARTIAL } from "../fixtures";
import type { QueueRow } from "../types";
import { CapabilityBadge, EmptyState, ErrorBox, SkeletonRows, StateMark } from "../components/marks";

const FILTERS: Array<{ value: QueueFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Awaiting" },
  { value: "expired", label: "Expired" },
  { value: "approved", label: "Approved" },
  { value: "refused", label: "Blocked" },
];

function readFilter(search: string): QueueFilter {
  const s = new URLSearchParams(search).get("status");
  return FILTERS.some((f) => f.value === s) ? (s as QueueFilter) : "all";
}

function Advisory({ row }: { row: QueueRow }) {
  if (row.advisory === null) {
    return (
      <span className="label text-warn-ink" title="No advisory score yet. Unscored items sort first: unscored is not safe.">
        Unscored
      </span>
    );
  }
  const fixture = isFixtureModelId(row.advisory.modelId);
  return (
    <span
      className="flex items-baseline gap-1"
      title={
        fixture
          ? "Fixture: a hand-written score for the offline demo, not model output. Not the decision."
          : `Model-generated advisory score from ${row.advisory.modelId}. Not the decision.`
      }
    >
      <span className="num text-4 text-n-900">{Math.round(row.advisory.score)}</span>
      <span className="text-1 text-n-400">/100</span>
      {fixture && <span className="label text-n-600">fixture</span>}
    </span>
  );
}

function Row({ row }: { row: QueueRow }) {
  return (
    <li>
      <Link
        href={`/queue/${encodeURIComponent(row.quarantineId)}`}
        className="micro box group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-accent-wash active:bg-n-100 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_8rem_7rem_6rem_10rem]"
        style={{ minHeight: "var(--row-queue)" }}
      >
        <span className="min-w-0">
          <span className="block truncate text-3 font-semibold text-n-900 group-hover:underline decoration-accent underline-offset-4">
            {row.toolName}
          </span>
          <span className="hash block truncate text-n-400">{row.quarantineId}</span>
        </span>
        <span className="justify-self-end lg:hidden">
          <Advisory row={row} />
        </span>
        <span className="truncate text-n-800">{row.upstreamLabel}</span>
        <span>
          <CapabilityBadge value={row.capabilityClass} />
        </span>
        <span className="flex items-baseline gap-2 lg:block" title={row.detectedAt}>
          <span className="num text-3 text-n-900">{formatTime(row.detectedAt)}</span>
          <span className="block text-1 text-n-600">
            {formatDate(row.detectedAt)} · {ago(row.detectedAt)}
          </span>
        </span>
        <span className="hidden lg:block">
          <Advisory row={row} />
        </span>
        <span>
          <StateMark state={row.reviewState} />
        </span>
      </Link>
    </li>
  );
}

export function Queue() {
  const search = useSearch();
  const override = useOverride();
  const [filter, setFilter] = useState<QueueFilter>(() => readFilter(search));
  const all = useQueue("all");
  const list = useQueue(filter);

  const choose = (value: QueueFilter): void => {
    setFilter(value);
    // withOverride keeps ?state= on the URL, so a filter click during a
    // screenshot run does not silently drop back to live data.
    replaceQuery(withOverride(value === "all" ? "/queue" : `/queue?status=${value}`, override));
  };

  const fixtures = { empty: QUEUE_EMPTY, partial: QUEUE_PARTIAL, what: "the review queue" };
  const view = applyOverride(viewOf(list), override, fixtures);
  const allView = applyOverride(viewOf(all), override, fixtures);
  const summary = allView.status === "ready" ? allView.data : undefined;

  const counts = new Map<QueueFilter, number>([["all", summary?.total ?? 0]]);
  for (const row of summary?.items ?? []) {
    counts.set(row.reviewState, (counts.get(row.reviewState) ?? 0) + 1);
  }
  const awaiting = counts.get("pending") ?? 0;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="label">Tool changes held for review</div>
          <h1 className="title mt-1">Review queue</h1>
        </div>
        <div className="flex items-end gap-6">
          <div className="text-right">
            <div className={`num text-5 ${awaiting > 0 ? "text-warn-ink" : "text-n-900"}`}>{summary ? awaiting : "–"}</div>
            <div className="label mt-1">Awaiting a resident</div>
          </div>
          <div className="text-right">
            <div className="num text-5 text-n-900">{summary ? summary.total : "–"}</div>
            <div className="label mt-1">Held, all time</div>
          </div>
        </div>
      </div>

      <div role="radiogroup" aria-label="Filter by review state" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const on = f.value === filter;
          return (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose(f.value)}
              className={`micro label flex items-baseline gap-2 rounded-form border-[length:var(--rule)] px-3 py-2 ${
                on ? "border-accent bg-accent text-n-0" : "border-accent bg-n-0 text-accent hover:bg-accent-wash active:bg-n-100"
              }`}
            >
              {f.label}
              <span className={`num text-2 normal-case tracking-normal ${on ? "text-n-0" : "text-n-600"}`}>
                {summary ? (counts.get(f.value) ?? 0) : "·"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="hidden gap-4 px-4 lg:grid lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_8rem_7rem_6rem_10rem]" aria-hidden>
        {["Tool", "Upstream", "Capability", "Detected", "Advisory", "Status"].map((h) => (
          <span key={h} className="label">
            {h}
          </span>
        ))}
      </div>

      {view.status === "loading" ? (
        <SkeletonRows label="Reading quarantine table…" />
      ) : view.status === "error" ? (
        <ErrorBox error={view.error} what="the review queue" onRetry={() => void list.refetch()} />
      ) : view.data.items.length === 0 ? (
        // An empty queue is the healthy outcome, not a failure to load, and
        // it is what a household sees on most days. It reads calm on
        // purpose: ledger green, a plain sentence, and the reason it is
        // empty rather than an exhortation to do something.
        filter === "all" ? (
          <EmptyState label="Nothing held" tone="ok" height="var(--row-queue)">
            <p className="text-3">Nothing has changed since you approved it.</p>
            <p className="mt-2">
              Every tool the assistant can reach still matches, byte for byte, the version this household approved. A tool
              only appears here when its description or schema stops matching its pinned hash — and until someone decides,
              it is withheld rather than shown to the assistant.
            </p>
          </EmptyState>
        ) : (
          <EmptyState label={`No changes in this state`} height="var(--row-queue)">
            <p>
              Nothing is currently {FILTERS.find((f) => f.value === filter)?.label.toLowerCase()}. The other filters may
              have rows — the counts above are over the whole queue, not this filter.
            </p>
          </EmptyState>
        )
      ) : (
        <ul className="grid gap-2" aria-label="Quarantined tool changes">
          {view.data.items.map((row) => (
            <Row key={row.quarantineId} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
