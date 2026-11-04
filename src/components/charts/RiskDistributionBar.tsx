"use client";

import { useMemo } from "react";
import { RISK_CLASSES, type RiskClass } from "@/lib/simulation/model";
import { useLang, useTr } from "@/lib/i18n";
import { formatNumber } from "@/lib/formatters";
import { ChartCanvas, tipRow, tipTitle, tooltipOpt } from "./chart-kit";
import { RISK_CLASS_COLORS, VIZ } from "./palette";

const S = {
  areas: { th: "พื้นที่", en: "areas" },
  unavailable: { th: "ไม่มีคะแนน", en: "No score" },
  aria: { th: "การกระจายระดับความเสี่ยงน้ำท่วมแบบจำลอง", en: "Distribution of modeled flood-risk classes" },
  of: { th: "จาก", en: "of" },
};

/** Single 100% stacked bar of risk-class counts + a labelled legend (class name, glyph, count) so class is never colour-only. */
export function RiskDistributionBar({ counts, unavailable = 0, kindLabel, height = 26 }: { counts: Record<RiskClass, number>; unavailable?: number; kindLabel?: string; height?: number }) {
  const t = useTr();
  const lang = useLang();
  const total = RISK_CLASSES.reduce((s, c) => s + (counts[c.id] ?? 0), 0) + unavailable;
  const unit = kindLabel ?? t(S.areas);

  const segments = useMemo(
    () => [
      ...RISK_CLASSES.map((c) => ({ id: c.id as string, label: t(c), color: RISK_CLASS_COLORS[c.id], n: counts[c.id] ?? 0 })),
      { id: "na", label: t(S.unavailable), color: VIZ.missing, n: unavailable },
    ],
    [counts, unavailable, t],
  );

  const option = useMemo(
    () => ({
      grid: { left: 0, right: 0, top: 0, bottom: 0, containLabel: false },
      tooltip: tooltipOpt({
        trigger: "item",
        formatter: (p: { seriesIndex: number }) => {
          const s = segments[p.seriesIndex];
          if (!s) return "";
          return tipTitle(s.label) + tipRow(s.color, `${formatNumber(s.n, lang)} ${unit}`, total ? `${formatNumber((s.n / total) * 100, lang, 0)}%` : "", { key: "rect" });
        },
      }),
      xAxis: { type: "value", show: false, min: 0, max: Math.max(1, total) },
      yAxis: { type: "category", show: false, data: ["all"] },
      series: segments.map((s) => ({
        id: s.id,
        type: "bar",
        stack: "dist",
        barWidth: "100%",
        itemStyle: { color: s.color, borderColor: VIZ.surface, borderWidth: s.n ? 1 : 0 },
        emphasis: { itemStyle: { opacity: 0.85 } },
        data: [s.n],
      })),
    }),
    [segments, total, lang, unit],
  );

  const aria = `${t(S.aria)}: ${segments.map((s) => `${s.label} ${s.n}`).join(", ")} (${t(S.of)} ${total} ${unit})`;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-[4px]">
        <ChartCanvas option={option} aria={aria} style={{ height, minHeight: height }} />
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-3" aria-label={t(S.aria)}>
        {segments
          .filter((s) => s.id !== "na" || s.n > 0)
          .map((s) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
              <span className="truncate text-ui-text-2">{s.label}</span>
              <span className="ui-num ml-auto text-ui-text">{formatNumber(s.n, lang)}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
