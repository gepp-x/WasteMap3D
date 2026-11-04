"use client";

import { useMemo } from "react";
import type { MetricValue } from "@/lib/types";
import { STATUS_META } from "@/lib/data/status";
import { useLang, useTr } from "@/lib/i18n";
import { formatMetric, formatNumber } from "@/lib/formatters";
import { axisStyle } from "@/components/charts/EChart";
import { ChartCanvas, ChartEmpty, ChartFrame, tipNote, tipRow, tipTitle, tooltipOpt } from "./chart-kit";
import { VIZ } from "./palette";
import { valueOf } from "./derive";

const S = {
  title: { th: "เทียบสัดส่วนกับค่าสูงสุดของเมือง", en: "Normalised to the city maximum" },
  sub: { th: "100% = พื้นที่ที่มีค่าสูงสุดในเมือง", en: "100% = highest area in the city" },
  ofMax: { th: "ของค่าสูงสุด", en: "of max" },
  metric: { th: "ตัวชี้วัด", en: "Metric" },
  aria: { th: "แผนภูมิแท่งเปรียบเทียบสองพื้นที่", en: "Grouped bars comparing two areas" },
};

export interface CompareRow {
  label: string;
  a: MetricValue;
  b: MetricValue;
  /** City maximum for this metric (normalisation base). */
  max: number | null;
  decimals: number;
}

export function CompareBars({ rows, nameA, nameB, height }: { rows: CompareRow[]; nameA: string; nameB: string; height?: number }) {
  const t = useTr();
  const lang = useLang();
  const h = height ?? 36 + rows.length * 34;

  const norm = useMemo(
    () =>
      rows.map((r) => {
        const a = valueOf(r.a);
        const b = valueOf(r.b);
        const ok = r.max !== null && r.max > 0;
        return { a: a !== null && ok ? (a / r.max!) * 100 : null, b: b !== null && ok ? (b / r.max!) * 100 : null };
      }),
    [rows],
  );

  const option = useMemo(
    () => ({
      grid: { left: 4, right: 12, top: 4, bottom: 4, containLabel: true },
      tooltip: tooltipOpt({
        trigger: "axis",
        axisPointer: { type: "shadow", shadowStyle: { color: "rgba(145,168,186,0.06)" } },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex ?? -1;
          const r = rows[i];
          if (!r) return "";
          const na = norm[i];
          const line = (m: MetricValue, n: number | null, color: string, name: string) =>
            tipRow(color, formatMetric(m, lang, r.decimals), `${name}${n !== null ? ` · ${formatNumber(n, lang, 0)}% ${t(S.ofMax)}` : ""}`, { key: "rect" }) +
            tipNote(`${STATUS_META[m.provenance.status].glyph} ${t(STATUS_META[m.provenance.status].label)}`);
          return tipTitle(r.label) + line(r.a, na.a, VIZ.seriesA, nameA) + line(r.b, na.b, VIZ.seriesB, nameB);
        },
      }),
      xAxis: { type: "value", min: 0, max: 100, splitNumber: 4, ...axisStyle, axisLine: { show: false }, axisLabel: { ...axisStyle.axisLabel, formatter: "{value}%" } },
      yAxis: { type: "category", inverse: true, data: rows.map((r) => r.label), ...axisStyle, splitLine: { show: false }, axisLabel: { ...axisStyle.axisLabel, width: 110, overflow: "truncate" } },
      series: [
        {
          id: "a",
          name: nameA,
          type: "bar",
          barMaxWidth: 10,
          barGap: "25%",
          itemStyle: { color: VIZ.seriesA, borderRadius: [0, 3, 3, 0] },
          data: norm.map((n) => (n.a === null ? "-" : n.a)),
        },
        {
          id: "b",
          name: nameB,
          type: "bar",
          barMaxWidth: 10,
          barGap: "25%",
          itemStyle: { color: VIZ.seriesB, borderRadius: [0, 3, 3, 0] },
          data: norm.map((n) => (n.b === null ? "-" : n.b)),
        },
      ],
    }),
    [rows, norm, nameA, nameB, lang, t],
  );

  if (!rows.length) {
    return (
      <ChartFrame title={t(S.title)}>
        <ChartEmpty />
      </ChartFrame>
    );
  }

  const aria = `${t(S.aria)}: ${rows.map((r) => `${r.label} — ${nameA} ${formatMetric(r.a, lang, r.decimals)}, ${nameB} ${formatMetric(r.b, lang, r.decimals)}`).join("; ")}`;

  return (
    <ChartFrame
      title={t(S.title)}
      subtitle={t(S.sub)}
      table={{
        caption: t(S.title),
        columns: [t(S.metric), nameA, nameB],
        rows: rows.map((r) => [r.label, formatMetric(r.a, lang, r.decimals), formatMetric(r.b, lang, r.decimals)]),
      }}
      footer={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ui-text-2">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: VIZ.seriesA }} />
            <span className="font-medium text-ui-text">A</span> {nameA}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: VIZ.seriesB }} />
            <span className="font-medium text-ui-text">B</span> {nameB}
          </span>
        </div>
      }
    >
      <ChartCanvas option={option} aria={aria} style={{ height: h, minHeight: h }} />
    </ChartFrame>
  );
}
