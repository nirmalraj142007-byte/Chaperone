/**
 * /ledger — the hash chain, drawn at full size as the page header and
 * inked by `GET /api/ledger/verify`, then every event in chain order. The
 * row at the break index is marked VOID; rows after it are marked
 * unverified, because verification stops at the first break.
 */
import { Fragment, useState } from "react";
import { useLedger } from "../api";
import { Chain, ChainStamp, useChainView } from "../components/Chain";
import { ErrorBox, SkeletonRows } from "../components/marks";
import { formatDate, formatTime, short } from "../lib";
import type { LedgerEvent, VerifyResponse } from "../types";

const TYPES = ["all", "PIN_CREATED", "MISMATCH_DETECTED", "TOOL_QUARANTINED", "CONSENT_SHOWN", "APPROVED", "REFUSED", "REPIN"];

function rowState(e: LedgerEvent, verify: VerifyResponse | undefined): "verified" | "broken" | "unverified" | "pending" {
  if (verify === undefined) return "pending";
  if (verify.ok) return "verified";
  return e.index < verify.index ? "verified" : e.index === verify.index ? "broken" : "unverified";
}

const COLS = "md:grid-cols-[4rem_9rem_minmax(0,1.2fr)_minmax(0,1fr)_8rem_8rem]";

function EventRow({ e, verify }: { e: LedgerEvent; verify: VerifyResponse | undefined }) {
  const [open, setOpen] = useState(false);
  const state = rowState(e, verify);
  const tone =
    state === "broken"
      ? "border-blocked bg-blocked-wash"
      : state === "unverified"
        ? "border-n-200 bg-n-50 text-n-600"
        : "border-accent bg-n-0";
  return (
    <li className={`box ${tone}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`micro grid w-full grid-cols-[3rem_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 px-4 py-2 text-left hover:bg-accent-wash active:bg-n-100 ${COLS}`}
      >
        <span className={`num text-3 ${state === "broken" ? "text-blocked" : "text-accent"}`}>#{e.index}</span>
        <span className="order-3 col-span-3 flex items-baseline gap-2 md:order-none md:col-span-1 md:block">
          <span className="num text-2 text-n-900">{formatTime(e.ts)}</span>
          <span className="text-1 text-n-600 md:block">{formatDate(e.ts)}</span>
        </span>
        <span className="min-w-0 truncate font-semibold">
          {e.type}
          {state === "broken" && <span className="label ml-2 text-blocked">void</span>}
          {state === "unverified" && <span className="label ml-2 text-n-400">unverified</span>}
        </span>
        <span className="hash order-4 col-span-3 truncate text-n-600 md:order-none md:col-span-1">{e.actor}</span>
        <span className="hash hidden text-n-800 md:inline" title={e.eventHash}>
          {short(e.eventHash)}
        </span>
        <span className="hash hidden text-n-400 md:inline" title={e.prevEventHash}>
          {short(e.prevEventHash)}
        </span>
      </button>
      {open && (
        <div className="grid gap-2 border-t-[length:var(--rule)] border-n-100 px-4 py-3">
          <div className="grid gap-1 text-1 sm:grid-cols-[6rem_minmax(0,1fr)]">
            <span className="label">sort key</span>
            <span className="hash break-all">{e.sk}</span>
            <span className="label">event hash</span>
            <span className="hash break-all">{e.eventHash}</span>
            <span className="label">prev</span>
            <span className="hash break-all">{e.prevEventHash}</span>
          </div>
          <pre className="hash overflow-x-auto bg-n-50 p-3 text-n-800">{JSON.stringify(e.payload, null, 2)}</pre>
        </div>
      )}
    </li>
  );
}

export function Ledger() {
  const [type, setType] = useState("all");
  const view = useChainView();
  const list = useLedger(type);
  const verify = view.verifyError ? undefined : view.verify;

  const broken = verify !== undefined && !verify.ok;
  return (
    <div className="grid gap-6">
      <section
        aria-labelledby="chain-h"
        className={`box p-4 sm:p-6 ${broken ? "border-blocked border-[length:var(--rule-heavy)]" : view.verifyError ? "border-blocked" : ""}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div id="chain-h" className="label">
              Hash chain · append-only · each event's hash covers its type, actor, time, payload and the previous event's hash
            </div>
            <h1 className="title mt-1">Ledger</h1>
          </div>
          <ChainStamp size="lg" view={view} />
        </div>
        <div className="mt-6">
          <Chain size="lg" view={view} />
        </div>
        <p className="mt-4 max-w-[60rem] text-1 text-n-600">
          Verified by <span className="hash text-n-800">GET /api/ledger/verify</span>: the gateway recomputes every
          event's hash from its stored type, actor, time, payload and <span className="hash">prevEventHash</span>, then
          checks that each <span className="hash">prevEventHash</span> matches the hash of the event before it.{" "}
          {broken && verify && !verify.ok && (
            <span className="text-blocked">
              {verify.reason === "link"
                ? `Event #${verify.index} (${verify.brokenSk}) no longer links to the event before it — an event was removed, reordered or inserted`
                : verify.reason === "unhashed"
                  ? `Event #${verify.index} (${verify.brokenSk}) has no event hash — written under the old payload-only rule, so it can't be vouched for`
                  : `Event #${verify.index} (${verify.brokenSk}) was edited after it was written`}{" "}
              — expected <span className="hash">{short(verify.expected)}</span>, found{" "}
              <span className="hash">{short(verify.actual)}</span>.
            </span>
          )}
        </p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2">
          <span className="label">Type</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="micro hash rounded-form border-[length:var(--rule)] border-accent bg-n-0 px-2 py-1 text-2 hover:bg-accent-wash"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t === "all" ? "All types" : t}
              </option>
            ))}
          </select>
        </label>
        {list.data && (
          <span className="label text-n-600">
            <span className="num text-3 normal-case tracking-normal text-n-900">{list.data.events.length}</span> of{" "}
            <span className="num text-3 normal-case tracking-normal text-n-900">{list.data.total}</span> events
          </span>
        )}
      </div>

      <div className={`hidden gap-x-3 px-4 md:grid ${COLS}`} aria-hidden>
        {["#", "Time", "Type", "Actor", "Event hash", "Prev"].map((h) => (
          <span key={h} className="label">
            {h}
          </span>
        ))}
      </div>
      {list.isPending ? (
        <SkeletonRows rows={5} label="Reading ledger partition…" />
      ) : list.isError ? (
        <ErrorBox error={list.error} what="the ledger" />
      ) : list.data.events.length === 0 ? (
        <div className="box border-dashed p-6 text-n-600">No events{type === "all" ? " yet" : ` of type ${type}`}.</div>
      ) : (
        <ol className="grid gap-1" aria-label="Ledger events, oldest first">
          {list.data.events.map((e) => (
            <Fragment key={e.sk}>
              <EventRow e={e} verify={verify} />
            </Fragment>
          ))}
        </ol>
      )}
    </div>
  );
}
