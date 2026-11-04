"use client";

import { useMemo } from "react";
import type { RiskResult } from "@/lib/simulation/model";
import { useLang, useTr } from "@/lib/i18n";
import { formatNumber } from "@/lib/formatters";
import { axisStyle } from "@/components/charts/EChart";
import { ChartCanvas, ChartEmpty, ChartFrame, tipNote, tipRow, tipTitle, tooltipOpt } from "./chart-kit";
import { FACTOR_COLORS, FACTOR_HELP, FACTOR_LABELS, FACTOR_ORDER, VIZ } from "./palette";

const S = {
  title: { th: "องค์ประกอบของคะแนนความเสี่ยง", en: "Risk score contributions" },
  sub: { th: "คะแนน (0–100) = ผลรวมของคะแนนจากแต่ละปัจจัย", en: "Score (0–100) = sum of factor points" },
  points: { th: "คะแนน", en: "points" },
  factor: { th: "ปัจจัย", en: "Factor" },
  value: { th: "ค่าปัจจัย (0–1)", en: "Factor value (0–1)" },
  weight: { th: "น้ำหนัก → ที่ใช้จริง", en: "Weight → applied" },
  missing: { th: "ไม่มีข้อมูล", en: "Missing" },
  missingNote: {
    th: "น้ำหนักของปัจจัยที่ไม่มีข้อมูลถูกกระจายไปยังปัจจัยที่มีข้อมูล",
    en: "Weight of missing factors is redistributed over available factors",
  },
  noScore: {
    th: "ข้อมูลไม่พอสำหรับคำนวณคะแนน (ต้องมีน้ำหนักข้อมูลอย่างน้อย 55%)",
    en: "Not enough data to produce a score (≥55% of model weight required)",
  },
  total: { th: "รวม", en: "Total" },
  aria: { th: "แผนภูมิแท่งซ้อนแสดงคะแนนจากแต่ละปัจจัย", en: "Stacked bar of factor contributions" },
};

export interface RiskContributionRow {
  label: string;
  result: RiskResult;
}

export function RiskContributionChart({ rows, height }: { rows: RiskContributionRow[]; height?: number }) {
  const t = useTr();
  const lang = useLang();
  const scored = rows.filter((r) => r.result.score !== null);
  const h = height ?? 44 + rows.length * 34;

  const option = useMemo(() => {
    return {
      grid: { left: 4, right: 40, top: 6, bottom: 4, containLabel: true },
      tooltip: tooltipOpt({
        trigger: "axis",
        axisPointer: { type: "none" },
        formatter: (ps: { dataIndex: number }[]) => {
          const r = rows[ps[0]?.dataIndex ?? -1];
          if (!r) return "";
          return (
            tipTitle(`${r.label} · ${t(S.total)} ${formatNumber(r.result.score, lang, 1)}`) +
            FACTOR_ORDER.map((k) => {
              const f = r.result.factors[k];
              return tipRow(f.missing ? VIZ.missing : FACTOR_COLORS[k], f.missing ? t(S.missing) : `${formatNumber(f.points, lang, 1)} ${t(S.points)}`, t(FACTOR_LABELS[k]), {
                key: "rect",
                muted: f.missing,
              });
            }).join("") +
            (r.result.missing.length ? tipNote(t(S.missingNote)) : "")
          );
        },
      }),
      xAxis: { type: "value", min: 0, max: 100, splitNumber: 4, ...axisStyle, axisLine: { show: false } },
      yAxis: { type: "category", inverse: true, data: rows.map((r) => r.label), ...axisStyle, splitLine: { show: false } },
      series: [
        ...FACTOR_ORDER.map((k) => ({
          id: k,
          name: t(FACTOR_LABELS[k]),
          type: "bar",
          stack: "risk",
          barMaxWidth: 18,
          itemStyle: { color: FACTOR_COLORS[k], borderColor: VIZ.surface, borderWidth: 1 },
          emphasis: { focus: "series" },
          data: rows.map((r) => (r.result.score === null || r.result.factors[k].missing ? 0 : r.result.factors[k].points)),
        })),
        {
          id: "total",
          type: "bar",
          stack: "risk",
          silent: true,
          itemStyle: { color: "rgba(0,0,0,0)" },
          label: {
            show: true,
            position: "right",
            color: VIZ.ink,
            fontSize: 11,
            fontWeight: 600,
            formatter: (p: { dataIndex: number }) => formatNumber(rows[p.dataIndex]?.result.score ?? null, lang, 1),
          },
          data: rows.map(() => 0),
        },
      ],
    };
  }, [rows, lang, t]);

  if (!rows.length) {
    return (
      <ChartFrame title={t(S.title)} status="unavailable">
        <ChartEmpty />
      </ChartFrame>
    );
  }

  const primary = rows[rows.length - 1].result;
  const aria = `${t(S.aria)}. ${rows
    .map((r) => `${r.label}: ${FACTOR_ORDER.map((k) => `${k} ${r.result.factors[k].missing ? t(S.missing) : formatNumber(r.result.factors[k].points, lang, 1)}`).join(", ")}; ${t(S.total)} ${formatNumber(r.result.score, lang, 1)}`)
    .join(". ")}`;

  return (
    <ChartFrame title={t(S.title)} subtitle={t(S.sub)} status={scored.length ? "simulated" : "unavailable"}>
      {scored.length ? <ChartCanvas option={option} aria={aria} style={{ height: h, minHeight: h }} /> : <ChartEmpty message={t(S.noScore)} height={64} />}
      <table className="w-full text-[11px]">
        <caption className="sr-only">{t(S.title)}</caption>
        <thead>
          <tr className="text-left text-[10.5px] text-ui-text-2">
            <th scope="col" className="py-1 font-medium">
              {t(S.factor)}
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              {t(S.value)}
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              {t(S.weight)}
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              {t(S.points)}
            </th>
          </tr>
        </thead>
        <tbody>
          {FACTOR_ORDER.map((k) => {
            const f = primary.factors[k];
            return (
              <tr key={k} className="border-t border-ui-border/60 align-top">
                <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                  <span className="flex items-start gap-1.5">
                    <span aria-hidden className="mt-1 inline-block size-2 shrink-0 rounded-[2px]" style={{ background: f.missing ? VIZ.missing : FACTOR_COLORS[k] }} />
                    <span className={f.missing ? "text-ui-text-2" : "text-ui-text"}>
                      {t(FACTOR_LABELS[k])}
                      <span className="block text-[10px] leading-3.5 text-ui-text-2">{f.missing ? t(S.missingNote) : t(FACTOR_HELP[k])}</span>
                    </span>
                  </span>
                </th>
                <td className="ui-num py-1.5 text-right text-ui-text-2">{f.missing ? <span className="italic">{t(S.missing)}</span> : formatNumber(f.value, lang, 2)}</td>
                <td className="ui-num py-1.5 text-right text-ui-text-2">
                  {formatNumber(f.weight * 100, lang, 0)}% → {formatNumber(f.appliedWeight * 100, lang, 0)}%
                </td>
                <td className="ui-num py-1.5 text-right text-ui-text">{f.missing || primary.score === null ? "—" : formatNumber(f.points, lang, 1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ChartFrame>
  );
}
