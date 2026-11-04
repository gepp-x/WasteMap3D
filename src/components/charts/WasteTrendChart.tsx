"use client";

import { useMemo } from "react";
import type { DataStatus, YearValue } from "@/lib/types";
import { STATUS_META } from "@/lib/data/status";
import { useLang, useTr } from "@/lib/i18n";
import { formatNumber, formatYear, unitLabel } from "@/lib/formatters";
import { axisStyle } from "@/components/charts/EChart";
import { ChartCanvas, ChartEmpty, ChartFrame, tipNote, tipRow, tipTitle, tooltipOpt } from "./chart-kit";
import { VIZ, withAlpha } from "./palette";

const S = {
  title: { th: "แนวโน้มปริมาณขยะรายปี", en: "Yearly waste trend" },
  year: { th: "ปี", en: "Year" },
  value: { th: "ปริมาณ", en: "Value" },
  status: { th: "สถานะ", en: "Status" },
  collected: { th: "ขยะที่จัดเก็บได้", en: "Collected" },
  generated: { th: "ขยะที่เกิดขึ้น", en: "Generated" },
  gap: { th: "ช่องว่าง = ไม่มีข้อมูลปีนั้น (ไม่ใช่ศูนย์)", en: "Gaps = no data for that year (not zero)" },
  mixedUnits: { th: "ตัดปีที่ใช้หน่วยต่างกันออก", en: "Years in a different unit were omitted" },
  twoMeasures: {
    th: "เส้นประ = ขยะที่เกิดขึ้น เป็นคนละนิยามกับขยะที่จัดเก็บได้ (ต่างแหล่งข้อมูลและรอบปี) ห้ามนำมาลบกัน",
    en: "Dashed = waste generated: a different definition from collected waste (different source and year basis) — do not subtract one from the other",
  },
  aria: { th: "กราฟเส้นแนวโน้มปริมาณขยะรายปี", en: "Line chart of yearly waste" },
};

/** Marker per status mirrors the status glyphs (● observed, ◆ derived, ◐/hollow estimated, ◇ simulated). */
const SYMBOL: Record<DataStatus, string> = {
  observed: "circle",
  derived: "diamond",
  estimated: "emptyCircle",
  simulated: "emptyDiamond",
  unavailable: "none",
};

interface Pt {
  year: number;
  value: number | null;
  status: DataStatus;
}

function majorityUnit(items: YearValue[]): string | null {
  const counts = new Map<string, number>();
  for (const h of items) if (h.value !== null) counts.set(h.unit, (counts.get(h.unit) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? items[0]?.unit ?? null;
}

function byYear(items: YearValue[], unit: string) {
  const m = new Map<number, YearValue>();
  let dropped = 0;
  for (const h of items) {
    if (!Number.isFinite(h.year)) continue;
    if (h.unit !== unit && h.value !== null) {
      dropped++;
      continue;
    }
    m.set(h.year, h);
  }
  return { m, dropped };
}

const toPt = (year: number, h: YearValue | undefined): Pt => ({
  year,
  value: h && h.value !== null && Number.isFinite(h.value) ? h.value : null,
  status: h ? (h.value === null ? "unavailable" : h.status) : "unavailable",
});

/**
 * Yearly waste trend of ONE measure (the area's primary measure, usually collected). When a separate
 * generated-waste series exists it is drawn as a second, dashed line — never merged into the first.
 */
export function WasteTrendChart({
  history,
  generated,
  title,
  subtitle,
  height = 170,
}: {
  history: YearValue[] | null | undefined;
  /** Optional waste-GENERATED series (separate measure), drawn dashed in a second colour. */
  generated?: YearValue[] | null;
  title?: string;
  subtitle?: string;
  height?: number;
}) {
  const t = useTr();
  const lang = useLang();

  const model = useMemo(() => {
    const items = (history ?? []).filter((h) => Number.isFinite(h.year));
    const unit = majorityUnit(items);
    if (!items.length || !unit) return null;
    const prim = byYear(items, unit);
    // The generated series is shown only in the same unit (never rescaled).
    const genItems = (generated ?? []).filter((h) => Number.isFinite(h.year) && h.unit === unit);
    const gen = genItems.some((h) => h.value !== null) ? byYear(genItems, unit) : null;
    const years = [...prim.m.keys(), ...(gen ? [...gen.m.keys()] : [])];
    if (!years.length) return null;
    const min = Math.min(...years);
    const max = Math.max(...years);
    const points: Pt[] = [];
    const genPoints: Pt[] = [];
    for (let y = min; y <= max; y++) {
      points.push(toPt(y, prim.m.get(y)));
      if (gen) genPoints.push(toPt(y, gen.m.get(y)));
    }
    const statuses = [...new Set([...points, ...genPoints].filter((p) => p.value !== null).map((p) => p.status))];
    return {
      unit,
      points,
      genPoints: gen ? genPoints : null,
      dropped: prim.dropped + ((generated ?? []).length - genItems.length),
      statuses,
      valued: points.filter((p) => p.value !== null).length + genPoints.filter((p) => p.value !== null).length,
    };
  }, [history, generated]);

  const option = useMemo(() => {
    if (!model) return {};
    const u = unitLabel(model.unit, lang);
    const row = (color: string, p: Pt | undefined, label: string) =>
      p ? tipRow(color, p.value === null ? t(STATUS_META.unavailable.label) : `${formatNumber(p.value, lang, 1)} ${u} · ${STATUS_META[p.status].glyph} ${t(STATUS_META[p.status].label)}`, label) : "";
    const series: Record<string, unknown>[] = [
      {
        type: "line",
        name: t(S.collected),
        connectNulls: false,
        showAllSymbol: true,
        lineStyle: { width: 2, color: VIZ.accent, cap: "round", join: "round" },
        areaStyle: model.genPoints ? undefined : { color: withAlpha(VIZ.accent, 0.08) },
        symbolSize: 8,
        data: model.points.map((p) => ({
          value: p.value === null ? "-" : p.value,
          symbol: SYMBOL[p.status],
          itemStyle: { color: p.status === "estimated" || p.status === "simulated" ? VIZ.surface : VIZ.accent, borderColor: VIZ.accent, borderWidth: 2 },
        })),
      },
    ];
    if (model.genPoints) {
      series.push({
        type: "line",
        name: t(S.generated),
        connectNulls: false,
        showAllSymbol: true,
        lineStyle: { width: 2, color: VIZ.secondary, type: "dashed", cap: "round", join: "round" },
        symbolSize: 7,
        data: model.genPoints.map((p) => ({
          value: p.value === null ? "-" : p.value,
          symbol: SYMBOL[p.status],
          itemStyle: { color: p.status === "estimated" || p.status === "simulated" ? VIZ.surface : VIZ.secondary, borderColor: VIZ.secondary, borderWidth: 2 },
        })),
      });
    }
    return {
      grid: { left: 4, right: 12, top: 14, bottom: 4, containLabel: true },
      tooltip: tooltipOpt({
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: VIZ.axis, width: 1 } },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex ?? -1;
          const p = model.points[i];
          if (!p) return "";
          if (!model.genPoints) {
            return (
              tipTitle(`${t(S.year)} ${formatYear(p.year, lang)}`) +
              tipRow(VIZ.accent, p.value === null ? t(STATUS_META.unavailable.label) : `${formatNumber(p.value, lang, 1)} ${u}`, t(S.value)) +
              (p.value !== null ? tipNote(`${STATUS_META[p.status].glyph} ${t(STATUS_META[p.status].label)}`) : "")
            );
          }
          return tipTitle(`${t(S.year)} ${formatYear(p.year, lang)}`) + row(VIZ.accent, p, t(S.collected)) + row(VIZ.secondary, model.genPoints[i], t(S.generated));
        },
      }),
      xAxis: {
        type: "category",
        boundaryGap: model.points.length === 1,
        data: model.points.map((p) => formatYear(p.year, lang)),
        ...axisStyle,
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        name: u,
        nameTextStyle: { color: VIZ.ink2, fontSize: 10, align: "left", padding: [0, 0, 0, -4] },
        ...axisStyle,
        axisLine: { show: false },
        splitNumber: 3,
        scale: false,
      },
      series,
    };
  }, [model, lang, t]);

  if (!model || model.valued === 0) {
    return (
      <ChartFrame title={title ?? t(S.title)} subtitle={subtitle} status="unavailable">
        <ChartEmpty />
      </ChartFrame>
    );
  }

  const u = unitLabel(model.unit, lang);
  const describe = (pts: Pt[]) => {
    const first = pts.find((p) => p.value !== null);
    const last = [...pts].reverse().find((p) => p.value !== null);
    return first && last ? `${formatYear(first.year, lang)} ${formatNumber(first.value, lang, 1)} → ${formatYear(last.year, lang)} ${formatNumber(last.value, lang, 1)}` : t(STATUS_META.unavailable.label);
  };
  const aria = model.genPoints
    ? `${t(S.aria)} (${u}): ${t(S.collected)} ${describe(model.points)}; ${t(S.generated)} ${describe(model.genPoints)}`
    : `${t(S.aria)} (${u}): ${describe(model.points)}`;
  const status: DataStatus = model.statuses.length === 1 ? model.statuses[0] : model.statuses.includes("observed") ? "observed" : (model.statuses[0] ?? "unavailable");
  const cell = (p: Pt | undefined) => (!p || p.value === null ? t(STATUS_META.unavailable.label) : formatNumber(p.value, lang, 1));

  return (
    <ChartFrame
      title={title ?? t(S.title)}
      subtitle={subtitle ? `${subtitle} · ${u}` : u}
      status={status}
      table={{
        caption: title ?? t(S.title),
        columns: model.genPoints
          ? [t(S.year), `${t(S.collected)} (${u})`, t(S.status), `${t(S.generated)} (${u})`, t(S.status)]
          : [t(S.year), `${t(S.value)} (${u})`, t(S.status)],
        rows: model.points.map((p, i) => {
          const base = [formatYear(p.year, lang), cell(p), t(STATUS_META[p.status].label)];
          const g = model.genPoints?.[i];
          return g ? [...base, cell(g), t(STATUS_META[g.status].label)] : base;
        }),
      }}
      footer={
        <div className="flex flex-col gap-1 text-[10.5px] text-ui-text-2">
          {model.genPoints && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: VIZ.accent }} />
                {t(S.collected)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block w-3.5 border-t-2 border-dashed" style={{ borderColor: VIZ.secondary }} />
                {t(S.generated)}
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {model.statuses.map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <span aria-hidden style={{ color: VIZ.ink2 }}>
                  {STATUS_META[s].glyph}
                </span>
                {t(STATUS_META[s].label)}
              </span>
            ))}
            {[...model.points, ...(model.genPoints ?? [])].some((p) => p.value === null) && <span>· {t(S.gap)}</span>}
            {model.dropped > 0 && <span>· {t(S.mixedUnits)}</span>}
          </div>
          {model.genPoints && <p className="leading-4 text-ui-text-3">{t(S.twoMeasures)}</p>}
        </div>
      }
    >
      <ChartCanvas option={option} aria={aria} style={{ height, minHeight: height }} />
    </ChartFrame>
  );
}
