/**
 * The one chart on /corpus: four horizontal bars, one per Axis-2
 * capability class, in corpus/TAXONOMY.md's documented order of
 * consequence (transact > communicate > write > read) — never sorted by
 * size, because the order is the argument.
 *
 * The same four rows carry both populated states. Partial plots the
 * sampling frame captured at crawl 1; complete plots the semantic-intent
 * drift rate per class. They are different measures and the caption says
 * so: sharing the rows is the point, because crawl 2 is measured against
 * exactly these strata, which makes the partial chart a finished result
 * rather than a stand-in for the drift chart.
 *
 * One chart, deliberately. A dashboard grid of four small charts would say
 * less and take more room on a projector.
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement, RefObject } from "react";
import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";
import type { BarShapeProps } from "recharts";
import type { Stratum } from "../evidence";

const ROW_H = 44;
/** jsdom and the first paint have no measured width; the chart still renders at this one, so a snapshot is a real chart. */
const FALLBACK_W = 720;
const NARROW = 560;

/**
 * The category axis and the right gutter both shrink on a phone. `right`
 * has to clear the value label printed at the end of the longest bar,
 * which is otherwise cut off at the plot edge — but a 76px gutter on a
 * 343px chart would leave almost nothing for the bars themselves.
 */
function geometry(width: number): { axisW: number; pad: { top: number; right: number; bottom: number; left: number } } {
  const narrow = width < NARROW;
  return {
    axisW: narrow ? 84 : 108,
    pad: { top: 4, right: narrow ? 52 : 76, bottom: 20, left: 0 },
  };
}

function useWidth(fallback: number): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) {
        setW(next);
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  return [ref, w];
}

/**
 * A bar drawn as our own rect so it inherits the console's ink: square
 * corners, carbon fill, the shared stagger, and — for a class whose
 * verdicts are low confidence — a hatch instead of a solid, because a
 * solid bar would claim a confidence the classifier never made.
 */
function StratumBar(props: BarShapeProps): ReactElement {
  const payload = props.payload as Stratum | undefined;
  const low = payload?.lowConfidence === true;
  return (
    <rect
      className="stratum"
      x={props.x}
      y={props.y}
      width={Math.max(0, props.width)}
      height={props.height}
      fill={low ? "url(#hatch-lowconf)" : "var(--accent)"}
      stroke={low ? "var(--accent)" : "none"}
      strokeWidth={low ? 1.5 : 0}
      style={{ "--i": props.index } as CSSProperties}
    />
  );
}

export function Strata({
  rows,
  measure,
  caption,
}: {
  rows: Stratum[];
  /** "count" prints an integer at the end of each bar; "rate" prints a percentage. */
  measure: "count" | "rate";
  caption: string;
}) {
  const [ref, width] = useWidth(FALLBACK_W);
  const { axisW, pad } = geometry(width);
  const height = rows.length * ROW_H + pad.top + pad.bottom;
  const max = measure === "rate" ? 100 : Math.max(1, ...rows.map((r) => r.value));

  return (
    <section aria-labelledby="strata-h" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id="strata-h" className="label">
          {measure === "rate" ? "Semantic-intent drift by capability class" : "Capability strata captured at crawl 1"}
        </h2>
        <span className="max-w-[44rem] text-1 text-n-600">{caption}</span>
      </div>

      {/*
        `min-w-0` is load-bearing. This is measured by a ResizeObserver and
        the chart inside it is given that measured width — so if the box can
        be widened by its own content (a grid or flex item defaults to
        `min-width: auto`), the two feed each other and the chart stays
        stuck at FALLBACK_W, overflowing a phone instead of shrinking to it.
      */}
      <div ref={ref} className="w-full min-w-0" style={{ minHeight: height }}>
        <BarChart
          width={width}
          height={height}
          data={rows}
          layout="vertical"
          margin={pad}
          barCategoryGap={10}
          role="img"
          aria-label={`${caption} ${rows.map((r) => `${r.capabilityClass}: ${r.display}`).join("; ")}`}
        >
          <defs>
            {/* The low-confidence hatch. An SVG pattern, because `background` does not paint an SVG shape. */}
            <pattern id="hatch-lowconf" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <rect width="8" height="8" fill="var(--accent-wash)" />
              <rect width="3" height="8" fill="var(--accent)" />
            </pattern>
          </defs>
          <XAxis type="number" domain={[0, max]} hide />
          <YAxis
            type="category"
            dataKey="capabilityClass"
            width={axisW}
            axisLine={{ stroke: "var(--accent)", strokeWidth: 1.5 }}
            tickLine={false}
            tick={{ fill: "var(--n-900)", fontSize: width < NARROW ? 12 : 14, fontFamily: "var(--font-ui)" }}
          />
          {/* The value is printed at the end of its own bar: a number should not need a legend to be read. */}
          <Bar dataKey="value" shape={StratumBar} isAnimationActive={false}>
            <LabelList
              dataKey="display"
              position="right"
              offset={8}
              fill="var(--n-900)"
              fontSize={width < NARROW ? 14 : 16}
              fontFamily="var(--font-num)"
            />
          </Bar>
        </BarChart>
      </div>

      <dl className="grid gap-x-6 gap-y-1 text-1 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.capabilityClass} className="flex items-baseline justify-between gap-3 border-b-[length:var(--rule)] border-n-100 pb-1">
            <dt className="text-n-800">
              {r.capabilityClass}
              {r.lowConfidence && (
                <span className="label ml-2 text-warn-ink" title="Every read-classed verdict is the classifier's unmatched-verb default.">
                  low confidence
                </span>
              )}
            </dt>
            <dd className="text-n-600">
              <span className="num text-3 text-n-900">{r.display}</span>
              {r.note !== "" && <span className="ml-2">{r.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
