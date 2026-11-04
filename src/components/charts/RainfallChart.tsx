"use client";

import { useCallback, useMemo } from "react";
import type { ECElementEvent } from "echarts/core";
import type { RainSeries } from "@/lib/types";
import { rainClass24h } from "@/lib/simulation/model";
import { STATUS_META } from "@/lib/data/status";
import { useLang, useTr } from "@/lib/i18n";
import { formatDate, formatNumber } from "@/lib/formatters";
import { axisStyle } from "@/components/charts/EChart";
import { ChartCanvas, ChartEmpty, ChartFrame, formatDayMonth, tipNote, tipRow, tipTitle, tooltipOpt } from "./chart-kit";
import { RAIN_CLASS_LABELS, TMD_CLASSES, VIZ } from "./palette";
import { areaRainSeries, meanRainSeries, rainWindow, windowStats } from "./derive";

const S = {
  titleArea: { th: "ฝนรายวัน", en: "Daily rainfall" },
  titleCity: { th: "ฝนรายวันเฉลี่ยทั้งเมือง", en: "City mean daily rainfall" },
  days: { th: "วัน", en: "days" },
  mmDay: { th: "มม./วัน", en: "mm/day" },
  date: { th: "วันที่", en: "Date" },
  rain: { th: "ปริมาณฝน", en: "Rainfall" },
  tmd: { th: "เกณฑ์กรมอุตุนิยมวิทยา", en: "TMD class" },
  meanOf: { th: "ค่าเฉลี่ยของ {n} พื้นที่", en: "Mean of {n} areas" },
  clickHint: { th: "คลิกแท่งเพื่อเลือกวันบนไทม์ไลน์", en: "Click a bar to set the timeline date" },
  aria: { th: "กราฟแท่งปริมาณฝนรายวัน", en: "Bar chart of daily rainfall" },
  total: { th: "รวม", en: "Total" },
  max: { th: "สูงสุด", en: "Max" },
  noArea: { th: "ไม่มีอนุกรมฝนสำหรับพื้นที่นี้", en: "No rainfall series for this area" },
  selected: { th: "วันที่เลือก", en: "Selected" },
};

export interface RainfallChartProps {
  series: RainSeries | null | undefined;
  /** Area id; omit/null for the city mean across all series. */
  areaId?: string | null;
  /** Last index of the window (defaults to the latest date). */
  endIndex?: number | null;
  days: number;
  selectedIndex?: number | null;
  onSelectIndex?: (index: number) => void;
  height?: number;
  title?: string;
  subtitle?: string;
}

export function RainfallChart({ series, areaId, endIndex, days, selectedIndex, onSelectIndex, height = 170, title, subtitle }: RainfallChartProps) {
  const t = useTr();
  const lang = useLang();

  const values = useMemo(() => {
    if (!series) return null;
    return areaId ? areaRainSeries(series, areaId) : meanRainSeries(series);
  }, [series, areaId]);

  const model = useMemo(() => {
    if (!series || !values) return null;
    const [start, end] = rainWindow(series.dates.length, endIndex, days);
    if (end < start) return null;
    const dates = series.dates.slice(start, end + 1);
    const vals = values.slice(start, end + 1).map((v) => (v === undefined ? null : v));
    const stats = windowStats(values, start, end);
    const yMax = Math.max(10, Math.ceil(((stats.max ?? 0) * 1.15) / 5) * 5);
    return { start, end, dates, vals, stats, yMax };
  }, [series, values, endIndex, days]);

  const clickable = !!onSelectIndex;
  const sel = model && selectedIndex !== null && selectedIndex !== undefined && selectedIndex >= model.start && selectedIndex <= model.end ? selectedIndex - model.start : null;

  const option = useMemo(() => {
    if (!model) return {};
    const bands = TMD_CLASSES.filter((c) => c.min < model.yMax).map((c) => [
      {
        yAxis: c.min,
        name: t(c.label),
        itemStyle: { color: c.tint },
        label: { show: true, position: "insideTopRight", color: "rgba(145,168,186,0.75)", fontSize: 9.5, formatter: t(c.label) },
      },
      { yAxis: Math.min(c.max ?? model.yMax, model.yMax) },
    ]);
    return {
      grid: { left: 4, right: 8, top: 14, bottom: 4, containLabel: true },
      tooltip: tooltipOpt({
        trigger: "axis",
        axisPointer: { type: "shadow", shadowStyle: { color: "rgba(37,217,242,0.06)" } },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex ?? -1;
          const d = model.dates[i];
          if (!d) return "";
          const v = model.vals[i];
          const cls = rainClass24h(v);
          return (
            tipTitle(formatDate(d, lang, "long")) +
            tipRow(sel === i ? VIZ.rainSelected : VIZ.rain, v === null ? t(STATUS_META.unavailable.label) : `${formatNumber(v, lang, 1)} ${t(S.mmDay)}`, t(S.rain)) +
            (cls ? tipNote(`${t(S.tmd)}: ${t(RAIN_CLASS_LABELS[cls])}`) : "") +
            (clickable ? tipNote(t(S.clickHint)) : "")
          );
        },
      }),
      xAxis: {
        type: "category",
        data: model.dates,
        ...axisStyle,
        axisLabel: { ...axisStyle.axisLabel, hideOverlap: true, formatter: (d: string) => formatDayMonth(d, lang) },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        max: model.yMax,
        name: t(S.mmDay),
        nameTextStyle: { color: VIZ.ink2, fontSize: 10, align: "left", padding: [0, 0, 0, -4] },
        ...axisStyle,
        axisLine: { show: false },
        splitNumber: 3,
      },
      series: [
        {
          // Full-height transparent hit column: the whole day is the click/hover target, not the 1–2 px bar.
          id: "hit",
          type: "bar",
          barGap: "-100%",
          barCategoryGap: "10%",
          barMaxWidth: 14,
          silent: !clickable,
          cursor: clickable ? "pointer" : "default",
          data: model.dates.map(() => model.yMax),
          itemStyle: { color: "rgba(0,0,0,0)" },
          emphasis: { itemStyle: { color: clickable ? "rgba(37,217,242,0.07)" : "rgba(0,0,0,0)" } },
          tooltip: { show: false },
          z: 1,
        },
        {
          id: "rain",
          type: "bar",
          barGap: "-100%",
          barCategoryGap: "10%",
          barMaxWidth: 14,
          cursor: clickable ? "pointer" : "default",
          data: model.vals.map((v, i) => ({
            value: v === null ? "-" : v,
            itemStyle: { color: sel === null ? VIZ.rain : i === sel ? VIZ.rainSelected : VIZ.rainMuted, borderRadius: [2, 2, 0, 0] },
          })),
          markArea: { silent: true, data: bands },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: VIZ.rainSelected, width: 1, type: "solid", opacity: 0.8 },
            label: { show: true, position: "insideEndTop", color: VIZ.ink, fontSize: 10, formatter: () => (sel !== null ? formatDayMonth(model.dates[sel], lang) : "") },
            data: sel !== null ? [{ xAxis: model.dates[sel] }] : [],
          },
          z: 2,
        },
      ],
    };
  }, [model, sel, lang, t, clickable]);

  const onClick = useCallback(
    (e: ECElementEvent) => {
      if (!model || !onSelectIndex || typeof e.dataIndex !== "number") return;
      onSelectIndex(model.start + e.dataIndex);
    },
    [model, onSelectIndex],
  );

  const ttl = title ?? t(areaId ? S.titleArea : S.titleCity);
  const status = series?.provenance.status ?? "unavailable";

  if (!series) {
    return (
      <ChartFrame title={ttl} subtitle={subtitle} status="unavailable">
        <ChartEmpty height={height} />
      </ChartFrame>
    );
  }
  if (!model || !values) {
    return (
      <ChartFrame title={ttl} subtitle={subtitle} status="unavailable">
        <ChartEmpty height={height} message={t(S.noArea)} />
      </ChartFrame>
    );
  }

  const sub =
    subtitle ??
    [
      `${formatNumber(model.dates.length, lang)} ${t(S.days)}`,
      `${formatDate(model.dates[0], lang)} – ${formatDate(model.dates[model.dates.length - 1], lang)}`,
      areaId ? null : t(S.meanOf).replace("{n}", formatNumber(series.series.length, lang)),
    ]
      .filter(Boolean)
      .join(" · ");
  const aria = `${t(S.aria)} — ${sub}. ${t(S.total)} ${formatNumber(model.stats.sum, lang, 1)} mm; ${t(S.max)} ${formatNumber(model.stats.max, lang, 1)} mm${
    model.stats.maxIdx !== null ? ` (${formatDate(series.dates[model.stats.maxIdx], lang)})` : ""
  }${sel !== null ? `. ${t(S.selected)}: ${formatDate(model.dates[sel], lang)} ${formatNumber(model.vals[sel], lang, 1)} mm` : ""}`;

  return (
    <ChartFrame
      title={ttl}
      subtitle={sub}
      status={status}
      table={{
        caption: ttl,
        columns: [t(S.date), `${t(S.rain)} (${t(S.mmDay)})`, t(S.tmd)],
        rows: model.dates
          .map((d, i) => {
            const v = model.vals[i];
            const c = rainClass24h(v);
            return [formatDate(d, lang), v === null ? t(STATUS_META.unavailable.label) : formatNumber(v, lang, 1), c ? t(RAIN_CLASS_LABELS[c]) : "—"];
          })
          .reverse(),
      }}
    >
      <ChartCanvas option={option} onClick={clickable ? onClick : undefined} aria={aria} style={{ height, minHeight: height }} />
    </ChartFrame>
  );
}
