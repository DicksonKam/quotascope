import React, { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import type { Observation } from "../shared/types";
import { historyBoundary, remainingPercent } from "../shared/history";
import { crossesCoverageGap, type CoverageGap } from "../shared/monitoring";
import { date, timezonePreference } from "./time";
type ChartPoint = Observation | { at: number; total: number };
const compact = (n: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const num = (n: number) => Intl.NumberFormat("en").format(n);

export function Chart({
  points,
  field = "remaining",
  label,
  unit = "% remaining",
  coverageGaps,
}: {
  points: ChartPoint[];
  field?: "remaining" | "used" | "total";
  label: string;
  unit?: string;
  coverageGaps?: CoverageGap[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [selected, setSelected] = useState<number | null>(null);
  const [gapDetail, setGapDetail] = useState<string | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const resize = new ResizeObserver(([entry]) =>
      setWidth(Math.max(250, entry.contentRect.width)),
    );
    resize.observe(ref.current);
    return () => resize.disconnect();
  }, [points.length]);
  const value = (point: ChartPoint) =>
    field === "total"
      ? "total" in point
        ? point.total
        : 0
      : "used" in point
        ? field === "used"
          ? point.used
          : remainingPercent(point.used)
        : 0;
  const height = 220,
    left = 45,
    right = 12,
    top = 23,
    bottom = 44;
  if (!points.length)
    return (
      <div className="empty-chart">
        <Activity size={25} />
        <span>History will appear after the first observation.</span>
      </div>
    );
  const inspected = Math.min(selected ?? 0, points.length - 1);
  const xs = points.map((p) => p.at),
    ys = points.map((p) => value(p));
  const allowance = field === "remaining" || field === "used";
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    maxY = allowance ? 100 : Math.max(1, ...ys) * 1.08;
  const x = (v: number) =>
    left + ((v - minX) / Math.max(1, maxX - minX)) * (width - left - right);
  const y = (v: number) => top + (1 - v / maxY) * (height - top - bottom);
  // Boundary detection uses the original used counter, even when displaying remaining allowance.
  const parts: ChartPoint[][] = [[]],
    gaps: { from: ChartPoint; to: ChartPoint; reason: string }[] = [];
  points.forEach((p, i) => {
    const previous = points[i - 1],
      reason =
        i && allowance
          ? coverageGaps && crossesCoverageGap(previous.at, p.at, coverageGaps)
            ? "Recorded gap in successful account reads; intervening values are unknown"
            : "used" in previous && "used" in p
              ? historyBoundary(
                  previous,
                  p,
                  coverageGaps ? Infinity : 6 * 3600000,
                )
              : null
          : null;
    if (reason) {
      parts.push([]);
      gaps.push({ from: previous, to: p, reason });
    }
    parts.at(-1)!.push(p);
  });
  return (
    <div className="chart" ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        <title>{label}</title>
        <desc>
          Solid lines connect observations within a coherent allowance window.
          Dashed connectors mark missing observations or counter and window
          changes; they do not represent measured usage. Hover or touch to
          inspect an observation.
        </desc>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              x1={left}
              x2={width - right}
              y1={y((maxY * i) / 4)}
              y2={y((maxY * i) / 4)}
              className="grid-line"
            />
            <text x={left - 12} y={y((maxY * i) / 4) + 4} textAnchor="end">
              {allowance ? (maxY * i) / 4 : compact((maxY * i) / 4)}
            </text>
          </g>
        ))}
        <text x={left} y={12} className="axis-title">
          {unit}
        </text>
        {gaps.map((gap, i) => (
          <path
            key={`gap-${i}`}
            d={`M${x(gap.from.at)},${y(value(gap.from))} L${x(gap.to.at)},${y(value(gap.to))}`}
            className="history-gap"
          >
            <title>
              {gap.reason}. {date(gap.from.at)} → {date(gap.to.at)}{" "}
              {timezonePreference()}. Connector only; intervening values are
              unknown.
            </title>
          </path>
        ))}
        {parts.map((part, i) =>
          part.length > 1 ? (
            <path
              key={i}
              d={part
                .map((p, j) => `${j ? "L" : "M"}${x(p.at)},${y(value(p))}`)
                .join(" ")}
              className="data-line"
            />
          ) : (
            <circle
              key={i}
              cx={x(part[0].at)}
              cy={y(value(part[0]))}
              r="3"
              className="data-dot"
            />
          ),
        )}
        {(width < 430 ? [0, 0.5, 1] : [0, 0.33, 0.66, 1])
          .filter((_, i) => maxX > minX || i === 0)
          .map((t) => (
            <text
              key={t}
              x={x(minX + t * (maxX - minX))}
              y={height - 17}
              textAnchor={t === 0 ? "start" : t === 1 ? "end" : "middle"}
            >
              {maxX - minX < 86400000
                ? new Date(minX + t * (maxX - minX)).toLocaleTimeString(
                    "en-GB",
                    {
                      timeZone: timezonePreference(),
                      hour: "2-digit",
                      minute: "2-digit",
                    },
                  )
                : date(minX + t * (maxX - minX), {
                    hour: undefined,
                    minute: undefined,
                  })}
            </text>
          ))}
        <text
          x={width - right}
          y={height - 1}
          textAnchor="end"
          className="axis-title"
        >
          Date · {timezonePreference()}
        </text>
        {selected !== null && points[selected] && (
          <>
            <line
              x1={x(points[selected].at)}
              x2={x(points[selected].at)}
              y1={top}
              y2={height - bottom}
              className="grid-line"
            />
            <circle
              cx={x(points[selected].at)}
              cy={y(value(points[selected]))}
              r="4"
              className="data-dot"
            />
          </>
        )}
        <rect
          x={left}
          y={top}
          width={width - left - right}
          height={height - top - bottom}
          fill="transparent"
          tabIndex={0}
          role="slider"
          aria-label="Inspect chart observation"
          aria-valuemin={1}
          aria-valuemax={points.length}
          aria-valuenow={(selected ?? 0) + 1}
          aria-valuetext={`${date(points[inspected].at)}: ${num(value(points[inspected]))} ${unit}`}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              setGapDetail(null);
              setSelected((current) =>
                Math.max(
                  0,
                  Math.min(
                    points.length - 1,
                    (current ?? 0) + (e.key === "ArrowRight" ? 1 : -1),
                  ),
                ),
              );
            }
          }}
          onPointerMove={(e) => {
            const bounds =
              e.currentTarget.ownerSVGElement!.getBoundingClientRect();
            const at =
              minX +
              ((e.clientX - bounds.left - left) / (width - left - right)) *
                (maxX - minX);
            const gap = gaps.find((g) => at > g.from.at && at < g.to.at);
            if (gap) {
              setSelected(null);
              setGapDetail(
                gap.reason + " · intervening values are not asserted",
              );
              return;
            }
            setGapDetail(null);
            let best = 0;
            points.forEach((p, i) => {
              if (Math.abs(p.at - at) < Math.abs(points[best].at - at))
                best = i;
            });
            setSelected(best);
          }}
          onPointerLeave={() => {
            setSelected(null);
            setGapDetail(null);
          }}
        />
      </svg>
      {gapDetail ? (
        <div className="chart-inspection">{gapDetail}</div>
      ) : (
        selected !== null &&
        points[selected] && (
          <div className="chart-inspection">
            {date(points[selected].at)} {timezonePreference()} ·{" "}
            {num(value(points[selected]))} {unit}
          </div>
        )
      )}
      <details className="chart-table">
        <summary>View observations as a table</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Time ({timezonePreference()})</th>
                <th>{unit}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point, index) => (
                <tr key={index}>
                  <td>{date(point.at)}</td>
                  <td>{num(value(point))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
