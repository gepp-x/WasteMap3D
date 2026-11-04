"use client";

import { useMemo } from "react";
import { PARAM_BOUNDS, RISK_CLASSES, computeAreaRisk, riskClass, type AreaRiskInputs, type ScenarioParams } from "@/lib/simulation/model";
import { useLang, useTr } from "@/lib/i18n";
import { formatNumber } from "@/lib/formatters";
import { axisStyle } from "@/components/charts/EChart";
import { ChartCanvas, ChartEmpty, ChartFrame, tipNote, tipRow, tipTitle, tooltipOpt } from "./chart-kit";
import { RISK_CLASS_COLORS, VIZ, withAlpha } from "./palette";

const S = {
  title: { th: "ความไวต่อความรุนแรงของฝน", en: "Sensitivity to rainfall intensity" },
  sub: {
    th: "คะแนนความเสี่ยงเมื่อปรับความรุนแรงฝน 0–120 มม./ชม. (พารามิเตอร์อื่นตามสถานการณ์ปัจจุบัน, ฝนนาน {h} ชม.)",
    en: "Risk score as intensity varies 0–120 mm/h (other parameters from the current scenario, {h} h storm)",
  },
  intensity: { th: "ความรุนแรงฝน", en: "Rain intensity" },
  score: { th: "คะแนนความเสี่ยง", en: "Risk score" },
  current: { th: "ปัจจุบัน", en: "Current" },
  stress: { th: "แรงกดดันระบายน้ำ", en: "Drainage stress" },
  noScore: { th: "ข้อมูลไม่พอสำหรับคำนวณคะแนน", en: "Not enough data to compute a score" },
  aria: { th: "กราฟเส้นคะแนนความเสี่ยงตามความรุนแรงฝน", en: "Line chart of risk score versus rainfall intensity" },
};

const STEP = 2;

export function SensitivityChart({ inputs, params, height = 180 }: { inputs: AreaRiskInputs; params: ScenarioParams; height?: number }) {
  const t = useTr();
  const lang = useLang();
  const maxI = PARAM_BOUNDS.rainIntensityMmH.max;

  const model = useMemo(() => {
    const pts: { x: number; score: number | null; stress: number }[] = [];
    for (let x = 0; x <= maxI; x += STEP) {
      const r = computeAreaRisk(inputs, { ...params, rainIntensityMmH: x });
      pts.push({ x, score: r.score, stress: r.drainageStressPct });
    }
    const cur = computeAreaRisk(inputs, params);
    return { pts, cur, curX: params.rainIntensityMmH };
  }, [inputs, params, maxI]);

  const option = useMemo(() => {
    const bands = RISK_CLASSES.map((c) => [
      { yAxis: c.min, itemStyle: { color: withAlpha(RISK_CLASS_COLORS[c.id], 0.06) }, label: { show: true, position: "insideRight", color: "rgba(145,168,186,0.8)", fontSize: 9.5, formatter: t(c) } },
      { yAxis: c.id === "veryHigh" ? 100 : c.max + 1 },
    ]);
    return {
      grid: { left: 4, right: 10, top: 16, bottom: 4, containLabel: true },
      tooltip: tooltipOpt({
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: VIZ.axis, width: 1 } },
        formatter: (ps: { dataIndex: number; seriesId?: string }[]) => {
          const p = ps.find((x) => x.seriesId === "curve");
          const pt = p ? model.pts[p.dataIndex] : null;
          if (!pt) return "";
          const cls = riskClass(pt.score);
          const c = cls ? RISK_CLASSES.find((r) => r.id === cls) : null;
          return (
            tipTitle(`${t(S.intensity)} ${formatNumber(pt.x, lang, 0)} ${lang === "th" ? "มม./ชม." : "mm/h"}`) +
            tipRow(VIZ.accent, pt.score === null ? "—" : formatNumber(pt.score, lang, 1), t(S.score)) +
            (c ? tipNote(t(c)) : "") +
            tipNote(`${t(S.stress)} ${formatNumber(pt.stress, lang, 0)}%`)
          );
        },
      }),
      xAxis: {
        type: "value",
        min: 0,
        max: maxI,
        interval: 20,
        name: lang === "th" ? "มม./ชม." : "mm/h",
        nameLocation: "end",
        nameTextStyle: { color: VIZ.ink2, fontSize: 10 },
        ...axisStyle,
        splitLine: { show: false },
      },
      yAxis: { type: "value", min: 0, max: 100, interval: 25, ...axisStyle, axisLine: { show: false } },
      series: [
        {
          id: "curve",
          type: "line",
          showSymbol: false,
          connectNulls: false,
          lineStyle: { width: 2, color: VIZ.accent, cap: "round", join: "round" },
          data: model.pts.map((p) => [p.x, p.score === null ? "-" : p.score]),
          markArea: { silent: true, data: bands },
          z: 2,
        },
        {
          id: "current",
          type: "scatter",
          symbolSize: 10,
          itemStyle: { color: VIZ.accent, borderColor: VIZ.surface, borderWidth: 2 },
          label: { show: true, position: "top", color: VIZ.ink, fontSize: 10.5, formatter: t(S.current) },
          tooltip: { show: false },
          data: model.cur.score === null ? [] : [[Math.min(model.curX, maxI), model.cur.score]],
          z: 3,
        },
      ],
    };
  }, [model, lang, t, maxI]);

  const ttl = t(S.title);
  const sub = t(S.sub).replace("{h}", formatNumber(params.rainDurationH, lang, 1));
  if (model.pts.every((p) => p.score === null)) {
    return (
      <ChartFrame title={ttl} subtitle={sub} status="unavailable">
        <ChartEmpty message={t(S.noScore)} height={96} />
      </ChartFrame>
    );
  }
  const at = (x: number) => model.pts.find((p) => p.x === x)?.score ?? null;
  const aria = `${t(S.aria)}. 0 mm/h → ${formatNumber(at(0), lang, 1)}; 60 mm/h → ${formatNumber(at(60), lang, 1)}; 120 mm/h → ${formatNumber(at(120), lang, 1)}. ${t(S.current)} ${formatNumber(model.curX, lang, 0)} mm/h → ${formatNumber(model.cur.score, lang, 1)}`;

  return (
    <ChartFrame
      title={ttl}
      subtitle={sub}
      status="simulated"
      table={{
        caption: ttl,
        columns: [`${t(S.intensity)} (mm/h)`, t(S.score), `${t(S.stress)} (%)`],
        rows: model.pts.filter((p) => p.x % 10 === 0).map((p) => [formatNumber(p.x, lang, 0), p.score === null ? "—" : formatNumber(p.score, lang, 1), formatNumber(p.stress, lang, 0)]),
      }}
    >
      <ChartCanvas option={option} aria={aria} style={{ height, minHeight: height }} />
    </ChartFrame>
  );
}
