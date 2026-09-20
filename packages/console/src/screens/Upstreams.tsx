/**
 * /upstreams — the third-party MCP servers this household has connected,
 * what Chaperone has pinned for each, and whether the gateway can currently
 * reach them.
 *
 * Connection state comes from the pool's own `describe()`, which is
 * synchronous and dials nothing: opening this tab must not generate traffic
 * against other people's servers, and a dead upstream should render as
 * visibly dead rather than as a slow page.
 *
 * The rehearsal control at the bottom fires demo-upstream's scripted
 * mutation. It is compiled out unless VITE_DEMO_CONTROLS=true, because a
 * button that changes what a tool claims is the one thing this product
 * exists to catch, and it has no business existing in a household build.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUpstreams } from "../api";
import { ago, formatDate, formatTime } from "../lib";
import { Link } from "../router";
import { applyOverride, viewOf } from "../state";
import { useOverride } from "../screenState";
import type { UpstreamRow, UpstreamsResponse, UpstreamState } from "../types";
import { EmptyState, ErrorBox, SkeletonRows } from "../components/marks";

const STATE: Record<UpstreamState, { label: string; tone: string; note: string }> = {
  ready: { label: "Connected", tone: "border-ok bg-ok-wash text-ok", note: "The gateway holds a live MCP session with this server." },
  connecting: {
    label: "Not yet dialled",
    tone: "border-n-400 bg-n-100 text-n-600",
    note: "The pool connects on first use, so a server stays here until a tools/list or tools/call touches it. Not an error.",
  },
  failed: {
    label: "Unreachable",
    tone: "border-blocked bg-blocked-wash text-blocked",
    note: "The last connect attempt failed. Tools from this server are withheld — an upstream that cannot be read cannot be compared against its pin.",
  },
  unknown: {
    label: "State unknown",
    tone: "border-n-400 bg-n-100 text-n-600",
    note: "This gateway did not report a pool state. Unknown is never rendered as healthy.",
  },
};

const EMPTY: UpstreamsResponse = { householdId: "household-demo", upstreams: [] };

const PARTIAL: UpstreamsResponse = {
  householdId: "household-demo",
  upstreams: [
    {
      id: "grocery",
      label: "Household Grocery",
      pinnedTools: 3,
      pendingReview: 1,
      state: "ready",
      connectedAt: "2026-09-20T09:14:02.000Z",
      sessionOpen: true,
      consecutiveFailures: 0,
    },
    {
      id: "calendar",
      label: "Household Calendar",
      pinnedTools: 0,
      pendingReview: 0,
      state: "connecting",
      connectedAt: null,
      sessionOpen: false,
      consecutiveFailures: 0,
    },
  ],
};

function Row({ u }: { u: UpstreamRow }) {
  const s = STATE[u.state];
  return (
    <li className="box grid gap-3 p-4" style={{ minHeight: "var(--row-upstream)" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <span className="min-w-0">
          <span className="block truncate text-3 font-semibold text-n-900">{u.label}</span>
          <span className="hash block truncate text-n-400">{u.id}</span>
        </span>
        <span className={`label inline-flex items-center border-l-[length:var(--rule-heavy)] px-2 py-px ${s.tone}`} title={s.note}>
          {s.label}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <div>
          <dt className="label">Pinned tools</dt>
          <dd className="num text-4 text-n-900">{u.pinnedTools}</dd>
        </div>
        <div>
          <dt className="label">Awaiting review</dt>
          <dd className={`num text-4 ${u.pendingReview > 0 ? "text-warn-ink" : "text-n-900"}`}>{u.pendingReview}</dd>
        </div>
        <div>
          <dt className="label">Last connect</dt>
          <dd className="text-n-900" title={u.connectedAt ?? undefined}>
            {u.connectedAt === null ? (
              <span className="text-n-600">never this process</span>
            ) : (
              <>
                <span className="num text-3">{formatTime(u.connectedAt)}</span>{" "}
                <span className="text-1 text-n-600">
                  {formatDate(u.connectedAt)} · {ago(u.connectedAt)}
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="label">Session</dt>
          <dd className="text-n-900">
            {u.sessionOpen ? "held" : "none"}
            {u.consecutiveFailures > 0 && (
              <span className="label ml-2 text-blocked">
                <span className="num text-2 normal-case tracking-normal">{u.consecutiveFailures}</span> failed
              </span>
            )}
          </dd>
        </div>
      </dl>
      <p className="text-1 text-n-600">{s.note}</p>
      {u.pendingReview > 0 && (
        <Link
          href="/queue?status=pending"
          className="label micro w-fit border-b-[length:var(--rule)] border-warn text-warn-ink hover:text-accent hover:border-accent"
        >
          Review {u.pendingReview} held {u.pendingReview === 1 ? "change" : "changes"} →
        </Link>
      )}
    </li>
  );
}

type ControlRun = { phase: "idle" } | { phase: "running"; action: string } | { phase: "done"; action: string; ok: boolean; text: string };

/**
 * Rehearsal only. Fires demo-upstream's `/control/mutate`, which swaps
 * `add_item`'s description for one that also tells the model to read the
 * household calendar — same name, same schema, same version string. That
 * is the exact scenario the whole project measures, and it is scripted
 * here so the demo does not depend on a third party shipping an update on
 * camera.
 */
function DemoControls() {
  const queryClient = useQueryClient();
  const [run, setRun] = useState<ControlRun>({ phase: "idle" });

  const fire = (action: "mutate" | "reset") => async (): Promise<void> => {
    setRun({ phase: "running", action });
    try {
      const res = await fetch(`/control/${action}`, { method: "POST" });
      const text = await res.text();
      setRun({ phase: "done", action, ok: res.ok, text: text.slice(0, 400) });
    } catch (error) {
      setRun({ phase: "done", action, ok: false, text: error instanceof Error ? error.message : "Could not reach demo-upstream." });
    }
    await queryClient.invalidateQueries();
  };

  const busy = run.phase === "running";
  return (
    <section aria-labelledby="demo-h" className="box border-warn border-[length:var(--rule-heavy)] p-4">
      <h2 id="demo-h" className="label">
        Rehearsal control · demo-upstream only
      </h2>
      <p className="mt-1 max-w-[60rem] text-1 text-n-600">
        Present because <span className="hash text-n-900">VITE_DEMO_CONTROLS</span> was set at build time, and compiled out
        otherwise. It changes what the staged grocery server claims{" "}
        <span className="hash text-n-900">add_item</span> does, so the gateway sees a real{" "}
        <span className="hash text-n-900">notifications/tools/list_changed</span> from a real upstream.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void fire("mutate")()}
          disabled={busy}
          className="micro label rounded-form border-[length:var(--rule)] border-warn bg-warn-wash px-4 py-2 text-warn-ink hover:bg-warn hover:text-n-0 active:translate-y-px disabled:border-n-200 disabled:bg-n-100 disabled:text-n-400"
        >
          {busy && run.action === "mutate" ? "Mutating…" : "Mutate add_item"}
        </button>
        <button
          type="button"
          onClick={() => void fire("reset")()}
          disabled={busy}
          className="micro label rounded-form border-[length:var(--rule)] border-accent bg-n-0 px-4 py-2 text-accent hover:bg-accent-wash active:translate-y-px disabled:border-n-200 disabled:bg-n-100 disabled:text-n-400"
        >
          {busy && run.action === "reset" ? "Resetting…" : "Reset to original"}
        </button>
      </div>
      {run.phase === "done" && (
        <p
          role={run.ok ? "status" : "alert"}
          className={`mt-3 border-l-[length:var(--rule-heavy)] px-3 py-2 text-2 ${run.ok ? "border-ok bg-ok-wash" : "border-blocked bg-blocked-wash"}`}
        >
          <span className="label mr-2">{run.ok ? `/control/${run.action}` : "Failed"}</span>
          <span className="hash">{run.text}</span>
        </p>
      )}
    </section>
  );
}

function Frame({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="grid gap-6">
      <div>
        <div className="label">{subtitle}</div>
        <h1 className="title mt-1">Upstreams</h1>
      </div>
      {children}
    </div>
  );
}

export function Upstreams() {
  const override = useOverride();
  const query = useUpstreams();
  const view = applyOverride(viewOf(query), override, { empty: EMPTY, partial: PARTIAL, what: "the upstream list" });
  // Dot access, not `import.meta.env["VITE_DEMO_CONTROLS"]`: Vite only
  // statically replaces the dotted form. With bracket notation this stays a
  // runtime lookup, the branch is never constant-folded, and <DemoControls>
  // ships in every build — which is what happened on first write, and is
  // why the Phase 15 acceptance run greps the bundle for it.
  const demo = import.meta.env.VITE_DEMO_CONTROLS === "true";

  return (
    <Frame
      subtitle={
        view.status === "ready"
          ? `${view.data.upstreams.length} configured for ${view.data.householdId}`
          : "Third-party MCP servers this household has connected"
      }
    >
      {view.status === "loading" ? (
        <SkeletonRows rows={2} label="Reading upstream pool and pins…" height="var(--row-upstream)" />
      ) : view.status === "error" ? (
        <ErrorBox
          error={view.error}
          what="the upstream list"
          onRetry={() => void query.refetch()}
          alsoIn="the gateway's CHAPERONE_UPSTREAMS environment variable"
        />
      ) : view.data.upstreams.length === 0 ? (
        <EmptyState label="No upstreams configured" height="var(--row-upstream)">
          <p>
            This gateway has no third-party servers to sit in front of. Upstreams are configured with{" "}
            <span className="hash text-n-900">CHAPERONE_UPSTREAMS</span>, a JSON array of{" "}
            <span className="hash text-n-900">{`{ id, url, label }`}</span> — the compose file sets one, the staged grocery
            server.
          </p>
        </EmptyState>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2" aria-label="Configured upstreams">
          {view.data.upstreams.map((u) => (
            <Row key={u.id} u={u} />
          ))}
        </ul>
      )}
      {demo && <DemoControls />}
    </Frame>
  );
}
