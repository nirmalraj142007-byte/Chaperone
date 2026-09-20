/**
 * The prediction track — /corpus's signature element.
 *
 * corpus/PREDICTIONS.md went into git on 2026-09-12, three days before
 * crawl 1 and 38 before crawl 2. It names a band (semantic-intent drift,
 * 20–40%) and commits to reporting whatever lands, including a result that
 * embarrasses the thesis. This draws that band on a 0–100% rule.
 *
 * The important property is that it is complete and legible with **zero**
 * measurements. From 2026-09-15 to 2026-10-20 there is exactly one crawl
 * and nothing to plot, and for those 35 days this element is the content
 * of the screen rather than a hole in it: the prediction is the finished
 * artifact, and the measurement is the thing that is scheduled. On crawl 2
 * four marks land on the same rule, green inside the band and crimson
 * outside.
 */
import type { CSSProperties } from "react";
import type { Drift } from "../evidence";

export interface TrackMark {
  label: string;
  ratePct: number;
  verdict: "inside" | "below" | "above";
}

const clampPct = (n: number): number => Math.max(0, Math.min(100, n));

export function PredictionTrack({
  drift,
  marks,
  pendingAtPct = 30,
  pendingLabel,
}: {
  drift: Drift;
  /** null while the measurement is pending — the band is drawn alone and the plumb line is dashed. */
  marks: TrackMark[] | null;
  /** Where the dashed "measurement due" line sits. Mid-band by default: it is a placeholder for a date, not a predicted value. */
  pendingAtPct?: number;
  pendingLabel: string;
}) {
  const { lowPct, highPct, registeredOn, source } = drift.prediction;
  const bandStyle = { "--from": `${clampPct(lowPct)}%`, "--to": `${clampPct(highPct)}%` } as CSSProperties;

  return (
    <section aria-labelledby="track-h" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id="track-h" className="label">
          Pre-registered prediction · {drift.prediction.metric}
        </h2>
        <span className="text-1 text-n-600">
          on the record in <span className="hash text-n-900">{source}</span> since{" "}
          <span className="num text-2 text-n-900">{registeredOn}</span>, before crawl 1 ran
        </span>
      </div>

      {/*
        The band's own label sits above the rule and the measurement sits
        below it. Both used to hang below, where they collided: the band is
        centred near 30% and the pending marker defaults to 30% too.
      */}
      <div className="pt-1 pb-2">
        {/* h-7: the measured marks' heads rise above the rule, and the band label has to clear them. */}
        <div className="relative h-7">
          <span
            className="label absolute bottom-0 whitespace-nowrap text-warn-ink"
            style={{ left: `${clampPct((lowPct + highPct) / 2)}%`, transform: "translateX(-50%)" }}
          >
            <span className="num text-2 normal-case tracking-normal">{lowPct}</span>&ndash;
            <span className="num text-2 normal-case tracking-normal">{highPct}</span>% predicted
          </span>
        </div>

        <div
          className="track"
          role="img"
          aria-label={
            marks === null
              ? `Predicted ${lowPct} to ${highPct} percent. Not yet measured: ${pendingLabel}.`
              : `Predicted ${lowPct} to ${highPct} percent. Measured: ${marks.map((m) => `${m.label} ${m.ratePct.toFixed(1)}%`).join(", ")}.`
          }
        >
          <span className="track-band" style={bandStyle} />
          {marks === null ? (
            <span className="track-pending" style={{ "--at": `${clampPct(pendingAtPct)}%` } as CSSProperties} />
          ) : (
            marks.map((m, i) => (
              <span
                key={m.label}
                className="track-mark"
                title={`${m.label}: ${m.ratePct.toFixed(1)}% \u2014 ${m.verdict} the predicted band`}
                style={
                  {
                    "--at": `${clampPct(m.ratePct)}%`,
                    "--i": i,
                    "--tone": m.verdict === "inside" ? "var(--ok)" : "var(--blocked)",
                  } as CSSProperties
                }
              />
            ))
          )}
        </div>

        {/* the scale, printed under the rule like a form's ruler */}
        <div className="relative mt-2 h-10">
          {[0, 50, 100].map((v) => (
            <span
              key={v}
              className="label absolute top-0 text-n-400"
              style={{ left: `${v}%`, transform: v === 0 ? "none" : v === 100 ? "translateX(-100%)" : "translateX(-50%)" }}
            >
              {v}%
            </span>
          ))}
          {marks === null ? (
            <span
              className="label absolute top-5 whitespace-nowrap text-n-600"
              style={{ left: `${clampPct(pendingAtPct)}%`, transform: "translateX(-50%)" }}
            >
              {pendingLabel}
            </span>
          ) : (
            marks.map((m, i) => (
              <span
                key={m.label}
                className={`label absolute whitespace-nowrap ${m.verdict === "inside" ? "text-ok" : "text-blocked"}`}
                style={{ top: i % 2 === 0 ? "1.25rem" : "2.1rem", left: `${clampPct(m.ratePct)}%`, transform: "translateX(-50%)" }}
              >
                {m.label} <span className="num text-2 normal-case tracking-normal">{m.ratePct.toFixed(1)}%</span>
              </span>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
