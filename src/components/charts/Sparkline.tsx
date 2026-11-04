"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { VIZ } from "./palette";

/**
 * Tiny inline trend (SVG). Null values break the line (gaps, never zero); the latest point carries an
 * end-dot with a surface ring. Decorative by default — pass `ariaLabel` to expose a summary.
 */
export function Sparkline({
  values,
  width = 72,
  height = 22,
  color = VIZ.accent,
  className,
  ariaLabel,
  min,
  max,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
  ariaLabel?: string;
  min?: number;
  max?: number;
}) {
  const geo = useMemo(() => {
    const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
    if (nums.length < 2) return null;
    const lo = min ?? Math.min(...nums);
    const hi = max ?? Math.max(...nums);
    const span = hi - lo || 1;
    const pad = 3;
    const n = values.length;
    const x = (i: number) => pad + (i / Math.max(1, n - 1)) * (width - pad * 2);
    const y = (v: number) => height - pad - ((v - lo) / span) * (height - pad * 2);
    const segs: string[] = [];
    let cur = "";
    values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        if (cur) segs.push(cur);
        cur = "";
        return;
      }
      cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    if (cur) segs.push(cur);
    let lastIdx = -1;
    for (let i = n - 1; i >= 0; i--) {
      const v = values[i];
      if (v !== null && Number.isFinite(v)) {
        lastIdx = i;
        break;
      }
    }
    const last = lastIdx >= 0 ? { cx: x(lastIdx), cy: y(values[lastIdx] as number) } : null;
    return { segs, last };
  }, [values, width, height, min, max]);

  if (!geo) return null;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0 overflow-visible", className)}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {geo.segs.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
      ))}
      {geo.last && <circle cx={geo.last.cx} cy={geo.last.cy} r={2.75} fill={color} stroke={VIZ.surface} strokeWidth={1.5} />}
    </svg>
  );
}
