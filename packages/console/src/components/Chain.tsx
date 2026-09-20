/**
 * The signature element: the ledger drawn as a chain of links, inked in by
 * the result of `GET /api/ledger/verify`. It appears as the perforated top
 * edge of every screen (sm) and as the full header of /ledger (lg).
 *
 * The one orchestrated motion in the console: when a verify result lands,
 * links ink in left to right (staggered by index, the whole run capped at
 * --dur-ink-total however long the chain is), then the stamp lands. On a
 * break the ink stops at the broken link; nothing past it is drawn as
 * verified, because the verifier stops there too.
 */
import type { CSSProperties } from "react";
import { ApiError, useLedger, useVerify } from "../api";
import { linkStates } from "../lib";
import { Link } from "../router";
import { useOverride } from "../screenState";
import { overrideError } from "../state";
import type { VerifyResponse } from "../types";

const INK_TOTAL_MS = 700;
const INK_STEP_MAX_MS = 45;
const WINDOW = { sm: 110, lg: 400 } as const;
/** Past this many links the lg chain drops to --link-md so it stays a few rows, not a wall. */
const DENSE_AFTER = 48;

/** Which slice of the chain to draw when it's longer than the window: the tail, or centred on the break. */
function visibleWindow(total: number, verify: VerifyResponse | undefined, cap: number): { start: number; end: number } {
  if (total <= cap) {
    return { start: 0, end: total };
  }
  if (verify !== undefined && !verify.ok) {
    const start = Math.max(0, Math.min(verify.index - Math.floor(cap / 2), total - cap));
    return { start, end: start + cap };
  }
  return { start: total - cap, end: total };
}

export interface ChainView {
  total: number | undefined;
  verify: VerifyResponse | undefined;
  verifyError: ApiError | null;
}

export function useChainView(): ChainView {
  const ledger = useLedger("all");
  const verify = useVerify();
  const override = useOverride();
  const err = verify.error instanceof ApiError ? verify.error : verify.error ? new ApiError(0, String(verify.error)) : null;

  switch (override) {
    case "loading":
      // `total: undefined` is the chain's own dashed empty frame, not a spinner.
      return { total: undefined, verify: undefined, verifyError: null };
    case "empty":
      return { total: 0, verify: { ok: true, count: 0 }, verifyError: null };
    case "error":
      // Fail closed in the UI: a verifier that could not run has verified nothing.
      return { total: 2, verify: undefined, verifyError: overrideError("the ledger chain") };
    case "partial":
      // Events exist and are listed, but the verifier has not answered yet,
      // so no link is inked and the stamp still reads "verifying".
      return { total: 2, verify: undefined, verifyError: null };
    default:
      return { total: ledger.data?.total, verify: verify.data, verifyError: err };
  }
}

export function Chain({ size, view }: { size: "sm" | "lg"; view: ChainView }) {
  const { total, verify, verifyError } = view;
  if (total === undefined) {
    // Not a spinner: the chain's own empty frame, dashed, until the count lands.
    return (
      <div className="chain" data-size={size} aria-label="Reading the ledger">
        {Array.from({ length: size === "sm" ? 24 : 12 }, (_, i) => (
          <span key={i} className="chain-link" data-state="pending" />
        ))}
      </div>
    );
  }

  const states = linkStates(total, verifyError ? undefined : verify);
  const { start, end } = visibleWindow(total, verify, WINDOW[size]);
  const shown = end - start;
  const stepMs = Math.min(INK_STEP_MAX_MS, INK_TOTAL_MS / Math.max(1, shown));
  // Keyed on the verify result so a fresh result (e.g. a break appearing on reload) re-runs the ink.
  const runKey = verify === undefined ? "pending" : verify.ok ? `ok-${verify.count}` : `broken-${verify.index}-${verify.brokenSk}`;

  return (
    <div
      key={runKey}
      className="chain"
      data-size={size}
      data-dense={size === "lg" && shown > DENSE_AFTER ? "" : undefined}
      style={{ "--dur-step": `${stepMs}ms` } as CSSProperties}
      role="img"
      aria-label={describe(total, verify, verifyError)}
    >
      {start > 0 && <span className="label text-n-600 mr-1">+{start}</span>}
      {states.slice(start, end).map((state, i) => (
        <span
          key={start + i}
          className="chain-link"
          data-state={state}
          title={`#${start + i} · ${state}`}
          style={{ "--i": i } as CSSProperties}
        />
      ))}
      {end < total && <span className="label text-n-600 ml-1">+{total - end}</span>}
    </div>
  );
}

function describe(total: number, verify: VerifyResponse | undefined, error: ApiError | null): string {
  if (error) return "Ledger chain could not be verified";
  if (verify === undefined) return `Verifying ${total} ledger events`;
  if (verify.ok) return `Ledger chain verified: ${verify.count} events`;
  return `Ledger chain broken at index ${verify.index}`;
}

/** The stamp that lands after the ink. Delay matches the ink run so it lands last. */
export function ChainStamp({ size, view }: { size: "sm" | "lg"; view: ChainView }) {
  const { total, verify, verifyError } = view;
  const shown = Math.min(total ?? 0, WINDOW[size]);
  const stepMs = Math.min(INK_STEP_MAX_MS, INK_TOTAL_MS / Math.max(1, shown));
  const delay = { "--stamp-delay": `${Math.round(stepMs * shown)}ms` } as CSSProperties;
  const big = size === "lg";

  if (verifyError) {
    // Fail closed in the UI as well: a verifier that couldn't run has verified nothing.
    return (
      <span className={`stamp ${big ? "text-3" : "text-1"}`} data-tone="blocked" style={delay}>
        Not verified
        <span className="font-normal normal-case tracking-normal">
          {verifyError.status === 0 ? "gateway unreachable" : "storage unavailable"}
        </span>
      </span>
    );
  }
  if (verify === undefined || total === undefined) {
    return (
      <span className={`label text-n-600 ${big ? "text-2" : ""}`} aria-live="polite">
        Verifying{total !== undefined ? ` ${total} links` : ""}…
      </span>
    );
  }
  if (verify.ok) {
    return (
      <span className={`stamp ${big ? "text-3" : "text-1"}`} data-tone="ok" style={delay} aria-live="polite">
        Chain verified
        <span className={`num font-semibold ${big ? "text-5" : "text-3"}`}>{verify.count}</span>
        <span className="font-normal normal-case tracking-normal">{verify.count === 1 ? "event" : "events"}</span>
      </span>
    );
  }
  return (
    <span className={`stamp ${big ? "text-3" : "text-1"}`} data-tone="blocked" style={delay} aria-live="assertive">
      Void · broken at
      <span className={`num font-semibold ${big ? "text-5" : "text-3"}`}>#{verify.index}</span>
      <span className="hash normal-case tracking-normal font-normal">sk {verify.brokenSk}</span>
    </span>
  );
}

/** The compact perforation that runs along the top of every screen; links to /ledger. */
export function Perforation() {
  const view = useChainView();
  return (
    <Link
      href="/ledger"
      className="micro flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 border-b-[length:var(--rule)] border-accent bg-n-0 hover:bg-accent-wash sm:px-6"
      aria-label="Open the ledger"
    >
      <span className="min-w-0 flex-1 overflow-hidden">
        <Chain size="sm" view={view} />
      </span>
      <ChainStamp size="sm" view={view} />
    </Link>
  );
}
