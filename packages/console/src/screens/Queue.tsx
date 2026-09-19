/**
 * /queue — every quarantine for the household, sorted server-side: unscored
 * first (an unscored item is not a safe item), then advisory score
 * descending. The filter is by review state; counts come from the unfiltered
 * list so a filter never hides how much is waiting.
 */
import { useState } from "react";
import { useQueue, type QueueFilter } from "../api";
import { ago, formatDate, formatTime } from "../lib";
import { Link } from "../router";
import type { QueueRow } from "../types";
import { CapabilityBadge, ErrorBox, SkeletonRows, StateMark } from "../components/marks";

const FILTERS: Array<{ value: QueueFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Awaiting" },
  { value: "expired", label: "Expired" },
  { value: "approved", label: "Approved" },
  { value: "refused", label: "Blocked" },
];

function readFilter(): QueueFilter {
  const s = new URLSearchParams(window.location.search).get("status");
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
  return (
    <span className="flex items-baseline gap-1" title={`Model-generated advisory score from ${row.advisory.modelId}. Not the decision.`}>
      <span className="num text-4 text-n-900">{Math.round(row.advisory.score)}</span>
      <span className="text-1 text-n-400">/100</span>
    </span>
  );
}

function Row({ row }: { row: QueueRow }) {
  return (
    <li>
      <Link
        href={`/queue/${encodeURIComponent(row.quarantineId)}`}
        className="micro box group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-accent-wash active:bg-n-100 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_8rem_7rem_6rem_10rem]"
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
  const [filter, setFilter] = useState<QueueFilter>(readFilter);
  const all = useQueue("all");
  const list = useQueue(filter);

  const choose = (value: QueueFilter): void => {
    setFilter(value);
    const url = value === "all" ? "/queue" : `/queue?status=${value}`;
    window.history.replaceState(null, "", url);
  };

  const counts = new Map<QueueFilter, number>([["all", all.data?.total ?? 0]]);
  for (const row of all.data?.items ?? []) {
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
            <div className={`num text-5 ${awaiting > 0 ? "text-warn-ink" : "text-n-900"}`}>{all.data ? awaiting : "–"}</div>
            <div className="label mt-1">Awaiting a resident</div>
          </div>
          <div className="text-right">
            <div className="num text-5 text-n-900">{all.data ? all.data.total : "–"}</div>
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
                {all.data ? (counts.get(f.value) ?? 0) : "·"}
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

      {list.isPending ? (
        <SkeletonRows label="Reading quarantine table…" />
      ) : list.isError ? (
        <ErrorBox error={list.error} what="the review queue" />
      ) : list.data.items.length === 0 ? (
        <div className="box border-dashed p-6 text-n-600">
          <div className="label text-ok">Nothing held</div>
          <p className="mt-1">
            {filter === "all"
              ? "No tool has changed since the household approved it."
              : "No changes in this state. Try another filter."}
          </p>
        </div>
      ) : (
        <ul className="grid gap-2" aria-label="Quarantined tool changes">
          {list.data.items.map((row) => (
            <Row key={row.quarantineId} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
