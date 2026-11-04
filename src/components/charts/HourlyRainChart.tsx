"use client";

import { useCallback, useMemo } from "react";
import type { ECElementEvent } from "echarts/core";
import type { HourlyRainEvent } from "@/lib/types";
import { STATUS_META } from "@/lib/data/status";
import { useLang, useTr } from "@/lib/i18n";
import { formatDate, formatNumber } from "@/lib/formatters";
import type { Lang } from "@/store/dashboard-store";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { axisStyle } from "@/components/charts/EChart";
import { ChartCanvas, ChartEmpty, ChartFrame, formatDayMonth, tipNote, tipRow, tipTitle, tooltipOpt } from "./chart-kit";
import { VIZ } from "./palette";
import { hourlyStats, localDateOf, localHourOf } from "./derive";

const S = {
  hourly: { th: "ฝนรายชั่วโมง", en: "Hourly rainfall" },
  cumulative: { th: "ฝนสะสม", en: "Cumulative" },
  mmH: { th: "มม./ชม.", en: "mm/h" },
  mm: { th: "มม.", en: "mm" },
  hours: { th: "{n} ชั่วโมง", en: "{n} hours" },
  total: { th: "รวมทั้งช่วง", en: "Event total" },
  peak: { th: "ชั่วโมงที่ฝนหนักที่สุด", en: "Peak hour" },
  max24: { th: "ฝนสะสมสูงสุดใน 24 ชม.", en: "Max rolling 24 h" },
  peakMark: { th: "สูงสุด", en: "Peak" },
  window: { th: "ฝนช่วง {a}–{b} น.", en: "Rain {a}–{b}" },
  selected: { th: "วันที่เลือกบนไทม์ไลน์", en: "Timeline date" },
  clickHint: { th: "คลิกแท่งเพื่อเลือกวันนั้นบนไทม์ไลน์", en: "Click a bar to set that day on the timeline" },
  aria: { th: "กราฟแท่งฝนรายชั่วโมงพร้อมเส้นฝนสะสม", en: "Hourly rainfall bars with a cumulative line" },
  time: { th: "วันเวลา", en: "Date & time" },
  method: {
    th: "ข้อมูลแบบจำลองสภาพอากาศย้อนหลัง ERA5 (ไม่ใช่ค่าจากสถานีวัดฝน) · ค่าที่เวลา T คือฝนสะสมในชั่วโมงก่อนหน้า · กริดเดียวขนาดราว 27 กม. ค่าสูงสุดเฉพาะจุดจากสถานีอาจสูงกว่ามาก",
    en: "ERA5 reanalysis (model output, not gauge data) · the value at hour T is rain in the preceding hour · a single ≈27 km cell — local gauge peaks can be much higher",
  },
};

const pad = (h: number) => `${String(h).padStart(2, "0")}:00`;

function hourLabel(iso: string, lang: Lang) {
  const h = localHourOf(iso);
  return lang === "th" ? `${pad(h)} น.` : pad(h);
}

export interface HourlyRainChartProps {
  event: HourlyRainEvent | null | undefined;
  /** Local date (YYYY-MM-DD) to highlight, e.g. the historical timeline date. */
  highlightDate?: string | null;
  /** Click a bar → its local date (drives the shared timeline). */
  onSelectDate?: (date: string) => void;
  height?: number;
  title?: string;
  /** Show the total / peak / 24 h stat strip (default true). */
  showStats?: boolean;
}

export function HourlyRainChart({ event, highlightDate, onSelectDate, height = 180, title, showStats = true }: HourlyRainChartProps) {
  const t = useTr();
  const lang = useLang();

  const model = useMemo(() => {
    if (!event || !event.times?.length || !event.values?.length) return null;
    const n = Math.min(event.times.length, event.values.length);
    const times = event.times.slice(0, n);
    const vals = event.values.slice(0, n).map((v) => (v === null || v === undefined || !Number.isFinite(v) ? null : v));
    const stats = hourlyStats({ times, values: vals });
    if (stats.validHours === 0) return null;
    const yMax = Math.max(5, Math.ceil(((stats.peak ?? 0) * 1.25) / 5) * 5);
    const cMax = Math.max(10, Math.ceil(((stats.total ?? 0) * 1.08) / 50) * 50);
    // Day boundaries (local midnight) carry the date labels and the faint split lines.
    const isDayStart = times.map((x, i) => i === 0 || localDateOf(x) !== localDateOf(times[i - 1]));
    return { times, vals, stats, yMax, cMax, isDayStart };
  }, [event]);

  const hl = useMemo(() => {
    if (!model || !highlightDate) return null;
    let a = -1,
      b = -1;
    model.times.forEach((x, i) => {
      if (localDateOf(x) === highlightDate) {
        if (a < 0) a = i;
        b = i;
      }
    });
    return a >= 0 ? { a, b } : null;
  }, [model, highlightDate]);

  const clickable = !!onSelectDate;

  const option = useMemo(() => {
    if (!model) return {};
    const { times, vals, stats, yMax, cMax, isDayStart } = model;
    return {
      grid: { left: 4, right: 6, top: 22, bottom: 4, containLabel: true },
      tooltip: tooltipOpt({
        trigger: "axis",
        axisPointer: { type: "shadow", shadowStyle: { color: "rgba(37,217,242,0.06)" } },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex ?? -1;
          const iso = times[i];
          if (!iso) return "";
          const v = vals[i];
          const h = localHourOf(iso);
          return (
            tipTitle(`${formatDate(localDateOf(iso), lang, "long")} · ${hourLabel(iso, lang)}`) +
            tipRow(VIZ.rain, v === null ? t(STATUS_META.unavailable.label) : `${formatNumber(v, lang, 1)} ${t(S.mmH)}`, t(S.window).replace("{a}", pad((h + 23) % 24)).replace("{b}", pad(h))) +
            tipRow(VIZ.ink, `${formatNumber(stats.cumulative[i], lang, 1)} ${t(S.mm)}`, t(S.cumulative)) +
            (clickable ? tipNote(t(S.clickHint)) : "")
          );
        },
      }),
      xAxis: {
        type: "category",
        data: times,
        ...axisStyle,
        axisLabel: {
          ...axisStyle.axisLabel,
          interval: (i: number) => isDayStart[i],
          formatter: (iso: string) => formatDayMonth(localDateOf(iso), lang),
        },
        splitLine: { show: true, interval: (i: number) => isDayStart[i] && i > 0, lineStyle: { color: "rgba(145,168,186,0.14)" } },
      },
      yAxis: [
        {
          type: "value",
          max: yMax,
          name: t(S.mmH),
          nameTextStyle: { color: VIZ.ink2, fontSize: 10, align: "left", padding: [0, 0, 0, -4] },
          ...axisStyle,
          axisLine: { show: false },
          splitNumber: 3,
        },
        {
          type: "value",
          max: cMax,
          name: t(S.cumulative),
          nameTextStyle: { color: VIZ.ink2, fontSize: 10, align: "right", padding: [0, -4, 0, 0] },
          ...axisStyle,
          axisLine: { show: false },
          splitLine: { show: false },
          splitNumber: 3,
        },
      ],
      series: [
        {
          id: "hourly",
          type: "bar",
          barCategoryGap: "18%",
          cursor: clickable ? "pointer" : "default",
          data: vals.map((v, i) => ({
            value: v === null ? "-" : v,
            itemStyle: { color: hl && (i < hl.a || i > hl.b) ? VIZ.rainMuted : i === stats.peakIdx ? VIZ.rainSelected : VIZ.rain, borderRadius: [1.5, 1.5, 0, 0] },
          })),
          markArea: hl
            ? {
                silent: true,
                itemStyle: { color: "rgba(37,217,242,0.07)", borderColor: "rgba(37,217,242,0.35)", borderWidth: 1 },
                label: { show: true, position: "insideTop", color: VIZ.rainSelected, fontSize: 9.5, formatter: t(S.selected) },
                data: [[{ xAxis: times[hl.a] }, { xAxis: times[hl.b] }]],
              }
            : undefined,
          markPoint:
            stats.peakIdx !== null
              ? {
                  silent: true,
                  symbol: "pin",
                  symbolSize: 30,
                  itemStyle: { color: VIZ.rainSelected },
                  label: { color: "#06111e", fontSize: 9, fontWeight: 600, formatter: () => formatNumber(stats.peak, lang, 0) },
                  data: [{ name: t(S.peakMark), coord: [times[stats.peakIdx], stats.peak] }],
                }
              : undefined,
          z: 2,
        },
        {
          id: "cumulative",
          type: "line",
          yAxisIndex: 1,
          data: stats.cumulative,
          showSymbol: false,
          symbol: "none",
          lineStyle: { color: VIZ.ink, width: 1.5, opacity: 0.85 },
          areaStyle: { color: "rgba(234,244,250,0.04)" },
          silent: true,
          z: 3,
        },
      ],
    };
  }, [model, hl, lang, t, clickable]);

  const onClick = useCallback(
    (e: ECElementEvent) => {
      if (!model || !onSelectDate || typeof e.dataIndex !== "number" || e.seriesId !== "hourly") return;
      const iso = model.times[e.dataIndex];
      if (iso) onSelectDate(localDateOf(iso));
    },
    [model, onSelectDate],
  );

  const ttl = title ?? (event ? (lang === "th" ? event.titleTh : event.titleEn) : t(S.hourly));
  if (!event || !model) {
    return (
      <ChartFrame title={ttl} status="unavailable">
        <ChartEmpty height={height} />
      </ChartFrame>
    );
  }

  const { stats, times } = model;
  const status = event.provenance?.status ?? "estimated";
  const from = localDateOf(times[0]);
  const to = localDateOf(times[times.length - 1]);
  const sub = [t(S.hourly), t(S.hours).replace("{n}", formatNumber(stats.hours, lang)), from === to ? formatDate(from, lang) : `${formatDate(from, lang)} – ${formatDate(to, lang)}`].join(" · ");
  const peakTime = stats.peakIdx !== null ? times[stats.peakIdx] : null;
  const max24End = stats.max24EndIdx !== null ? times[stats.max24EndIdx] : null;
  const aria = `${t(S.aria)} — ${ttl}. ${sub}. ${t(S.total)} ${formatNumber(stats.total, lang, 1)} ${t(S.mm)}; ${t(S.peak)} ${formatNumber(stats.peak, lang, 1)} ${t(S.mmH)}${
    peakTime ? ` (${formatDate(localDateOf(peakTime), lang)} ${hourLabel(peakTime, lang)})` : ""
  }${hl ? `. ${t(S.selected)}: ${formatDate(highlightDate, lang)}` : ""}`;

  return (
    <ChartFrame
      title={ttl}
      subtitle={sub}
      status={status}
      table={{
        caption: ttl,
        columns: [t(S.time), `${t(S.hourly)} (${t(S.mmH)})`, `${t(S.cumulative)} (${t(S.mm)})`],
        rows: times.map((iso, i) => [`${formatDate(localDateOf(iso), lang)} ${hourLabel(iso, lang)}`, model.vals[i] === null ? t(STATUS_META.unavailable.label) : formatNumber(model.vals[i], lang, 1), formatNumber(stats.cumulative[i], lang, 1)]),
      }}
      footer={<p className="text-[10.5px] leading-4 text-ui-text-2">{t(S.method)}</p>}
    >
      <ChartCanvas option={option} onClick={clickable ? onClick : undefined} aria={aria} style={{ height, minHeight: height }} />
      {showStats && (
        <dl className="grid grid-cols-3 gap-2">
          {[
            { k: "total", label: t(S.total), v: stats.total, unit: t(S.mm), hint: null as string | null },
            { k: "peak", label: t(S.peak), v: stats.peak, unit: t(S.mmH), hint: peakTime ? `${formatDayMonth(localDateOf(peakTime), lang)} ${hourLabel(peakTime, lang)}` : null },
            { k: "max24", label: t(S.max24), v: stats.max24, unit: t(S.mm), hint: max24End ? `${t({ th: "สิ้นสุด", en: "ending" })} ${formatDayMonth(localDateOf(max24End), lang)} ${hourLabel(max24End, lang)}` : null },
          ].map((x) => (
            <div key={x.k} className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-2.5 py-2">
              <dt className="flex items-start justify-between gap-1 text-[10.5px] leading-4 text-ui-text-2">
                <span>{x.label}</span>
                <StatusBadge status={status} size="xs" showLabel={false} />
              </dt>
              <dd className="ui-num text-[15px] font-semibold text-ui-text">
                {x.v === null ? <span className="text-[11px] font-normal text-ui-text-3">{t(STATUS_META.unavailable.label)}</span> : formatNumber(x.v, lang, 1)}
                {x.v !== null && <span className="ml-1 text-[10.5px] font-normal text-ui-text-2">{x.unit}</span>}
              </dd>
              {x.hint && <dd className="truncate text-[10px] text-ui-text-2">{x.hint}</dd>}
            </div>
          ))}
        </dl>
      )}
    </ChartFrame>
  );
}
