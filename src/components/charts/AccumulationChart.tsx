"use client";

import { useMemo } from "react";
import { simulateAccumulation, steadyStateAccumulation } from "@/lib/simulation/model";
import { useLang, useTr } from "@/lib/i18n";
import { formatNumber } from "@/lib/formatters";
import { axisStyle } from "@/components/charts/EChart";
import { ChartCanvas, ChartEmpty, ChartFrame, tipRow, tipTitle, tooltipOpt } from "./chart-kit";
import { VIZ } from "./palette";

const S = {
  title: { th: "ขยะตกค้างสะสม (จำลอง 30 วัน)", en: "Modeled waste accumulation (30 days)" },
  sub: {
    th: "สะสม(t) = สะสม(t−1) + ขยะเข้า − ขยะที่เก็บได้ · ประสิทธิภาพการเก็บ {e}%",
    en: "Stock(t) = Stock(t−1) + inflow − collected · collection efficiency {e}%",
  },
  day: { th: "วันที่", en: "Day" },
  stock: { th: "ขยะตกค้าง", en: "Uncollected stock" },
  current: { th: "สถานการณ์ปัจจุบัน", en: "Current scenario" },
  baseline: { th: "สภาวะฐาน", en: "Baseline" },
  steady: { th: "สมดุลระยะยาว", en: "Steady state" },
  t: { th: "ตัน", en: "t" },
  noInflow: { th: "ไม่มีปริมาณขยะสำหรับใช้เป็นข้อมูลนำเข้า", en: "No waste quantity available as model input" },
  aria: { th: "กราฟเส้นขยะตกค้างสะสมจำลอง", en: "Line chart of simulated waste accumulation" },
  eff: { th: "ประสิทธิภาพ", en: "efficiency" },
};

export function AccumulationChart({
  inflow,
  efficiency,
  baselineEfficiency,
  days = 30,
  height = 170,
}: {
  /** Daily inflow (t/day) taken from the dataset; null → unavailable. */
  inflow: number | null;
  efficiency: number;
  /** When different from `efficiency`, a de-emphasised baseline curve is drawn for context. */
  baselineEfficiency?: number;
  days?: number;
  height?: number;
}) {
  const t = useTr();
  const lang = useLang();
  const showBase = baselineEfficiency !== undefined && Math.abs(baselineEfficiency - efficiency) > 1e-6;

  const model = useMemo(() => {
    const cur = simulateAccumulation(inflow, efficiency, days);
    const base = showBase ? simulateAccumulation(inflow, baselineEfficiency!, days) : null;
    const steady = steadyStateAccumulation(inflow, efficiency);
    return { cur, base, steady };
  }, [inflow, efficiency, baselineEfficiency, days, showBase]);

  const option = useMemo(() => {
    const cur = model.cur;
    if (!cur) return {};
    const xs = cur.stock.map((_, i) => i + 1);
    return {
      grid: { left: 4, right: 12, top: 18, bottom: 4, containLabel: true },
      tooltip: tooltipOpt({
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: VIZ.axis, width: 1 } },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex ?? -1;
          if (i < 0) return "";
          return (
            tipTitle(`${t(S.day)} ${i + 1}`) +
            tipRow(VIZ.accent, `${formatNumber(cur.stock[i], lang, 1)} ${t(S.t)}`, t(S.current)) +
            (model.base ? tipRow(VIZ.baseline, `${formatNumber(model.base.stock[i], lang, 1)} ${t(S.t)}`, t(S.baseline), { muted: true }) : "")
          );
        },
      }),
      xAxis: { type: "category", boundaryGap: false, data: xs, ...axisStyle, axisLabel: { ...axisStyle.axisLabel, interval: 4 }, splitLine: { show: false } },
      yAxis: {
        type: "value",
        name: t(S.t),
        nameTextStyle: { color: VIZ.ink2, fontSize: 10, align: "left", padding: [0, 0, 0, -4] },
        ...axisStyle,
        axisLine: { show: false },
        splitNumber: 3,
      },
      series: [
        {
          id: "baseline",
          type: "line",
          showSymbol: false,
          lineStyle: { width: 1.5, color: VIZ.baseline },
          data: model.base ? model.base.stock : [],
          z: 1,
        },
        {
          id: "current",
          type: "line",
          showSymbol: false,
          lineStyle: { width: 2, color: VIZ.accent, cap: "round", join: "round" },
          endLabel: { show: true, color: VIZ.ink, fontSize: 10.5, formatter: (p: { value: number }) => formatNumber(p.value, lang, 1) },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: "rgba(145,168,186,0.55)", width: 1, type: "solid" },
            label: { show: true, position: "insideStartTop", color: VIZ.ink2, fontSize: 9.5, formatter: t(S.steady) },
            data: model.steady !== null ? [{ yAxis: model.steady }] : [],
          },
          data: cur.stock,
          z: 2,
        },
      ],
    };
  }, [model, lang, t]);

  const sub = t(S.sub).replace("{e}", formatNumber(efficiency * 100, lang, 0));
  if (!model.cur) {
    return (
      <ChartFrame title={t(S.title)} subtitle={sub} status="unavailable">
        <ChartEmpty message={t(S.noInflow)} height={96} />
      </ChartFrame>
    );
  }
  const aria = `${t(S.aria)}. ${t(S.day)} 1: ${formatNumber(model.cur.stock[0], lang, 1)} t; ${t(S.day)} ${days}: ${formatNumber(model.cur.final, lang, 1)} t; ${t(S.steady)} ${formatNumber(model.steady, lang, 1)} t`;

  return (
    <ChartFrame
      title={t(S.title)}
      subtitle={sub}
      status="simulated"
      table={{
        caption: t(S.title),
        columns: [t(S.day), `${t(S.current)} (${t(S.t)})`, ...(model.base ? [`${t(S.baseline)} (${t(S.t)})`] : [])],
        rows: model.cur.stock.map((v, i) => [i + 1, formatNumber(v, lang, 1), ...(model.base ? [formatNumber(model.base.stock[i], lang, 1)] : [])]),
      }}
      footer={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ui-text-2">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: VIZ.accent }} />
            {t(S.current)} ({t(S.eff)} {formatNumber(efficiency * 100, lang, 0)}%)
          </span>
          {model.base && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: VIZ.baseline }} />
              {t(S.baseline)} ({t(S.eff)} {formatNumber(baselineEfficiency! * 100, lang, 0)}%)
            </span>
          )}
        </div>
      }
    >
      <ChartCanvas option={option} aria={aria} style={{ height, minHeight: height }} />
    </ChartFrame>
  );
}
