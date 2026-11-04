"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { CloudRain, Gauge, RotateCcw, ShieldAlert, Scale, Trash, TriangleAlert, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { COMMON, useLang, useTr } from "@/lib/i18n";
import { useCityBundle, useDataStore } from "@/lib/data/loader";
import { RISK_COLORS, STATUS_META } from "@/lib/data/status";
import { primaryWasteMetric } from "@/lib/metrics";
import { formatDate, formatMetric, formatNumber, formatYear, unitLabel } from "@/lib/formatters";
import { L_SAT, RISK_CLASSES, SCENARIO_PRESETS, riskClass } from "@/lib/simulation/model";
import { useScenario, type AreaScenario } from "@/lib/simulation/use-scenario";
import type { DataProvenance, DataStatus, RainSeries } from "@/lib/types";
import { useDashboard, type LayerId } from "@/store/dashboard-store";
import { useReducedMotionPref } from "@/lib/animation/tokens";
import { AnimatedNumber } from "@/components/motion/AnimatedNumber";
import { EntranceGroup, EntranceItem } from "@/components/motion/Entrance";
import { ScenarioPulse } from "@/components/motion/ScenarioTransition";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/dashboard/Header";

/* ------------------------------------------------------------------ */
/*  Model                                                              */
/* ------------------------------------------------------------------ */

type KpiId = "waste" | "population" | "perCapita" | "rain" | "drainage" | "exposure";

type MicroChart =
  | { kind: "spark"; values: number[]; marker: number | null; color: string; summary: string }
  | { kind: "bars"; values: number[]; highlight: number | null; color: string; summary: string }
  | { kind: "strip"; values: number[]; domain: [number, number]; highlight: number | null; reference: number | null; color: string; summary: string }
  | { kind: "stack"; parts: { value: number; color: string }[]; summary: string };

interface KpiDelta {
  value: number;
  unit: string;
  decimals: number;
}

interface KpiModel {
  id: KpiId;
  icon: LucideIcon;
  label: string;
  fullLabel: string;
  short: string;
  value: number | null;
  unit: string;
  decimals: number;
  status: DataStatus;
  provenance?: DataProvenance;
  /** Shown on the third line when no area is selected (date / basis). */
  context: string | null;
  method: string | null;
  delta: KpiDelta | null;
  area: { name: string; text: string } | null;
  /**
   * A second, separately labelled measure shown under the value when no area is selected
   * (e.g. waste generated next to waste collected). Never summed or mixed with the card value.
   */
  secondary: { label: string; text: string; status: DataStatus; provenance?: DataProvenance } | null;
  chart: MicroChart | null;
  layer: LayerId | null;
  actionLabel: string;
  action: () => void;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const nonNull = <T,>(x: T | null | undefined): x is T => x !== null && x !== undefined && (typeof x !== "number" || Number.isFinite(x));

/** Population-weighted baseline aggregates — same weighting rules as useScenario().summary. */
function baselineStats(list: AreaScenario[]) {
  let w = 0;
  let d = 0;
  let exposed = 0;
  let popTotal = 0;
  for (const x of list) {
    const pop = x.area.metrics.population?.value ?? null;
    if (pop !== null && x.baseline.score !== null) {
      w += pop;
      d += pop * x.baseline.drainageStressPct;
      if (x.baseline.score >= 50) exposed += pop;
    }
    if (pop !== null) popTotal += pop;
  }
  return {
    drainage: w ? Math.round((d / w) * 10) / 10 : null,
  secondary: null,
    exposureShare: popTotal ? exposed / popTotal : null,
    depth: mean(list.map((x) => x.baseline.rainDepthMm)),
  };
}

/** City-mean daily rainfall series, bucketed to ≤ 48 points for a sparkline. */
function cityMeanDaily(series: RainSeries | null | undefined) {
  if (!series || !series.dates.length || !series.series.length) return null;
  const n = series.dates.length;
  const daily: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const vals = series.series.map((s) => s.values[i]).filter(nonNull);
    daily[i] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  const buckets = Math.min(48, n);
  const size = n / buckets;
  const values: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const slice = daily.slice(Math.floor(b * size), Math.max(Math.floor((b + 1) * size), Math.floor(b * size) + 1)).filter(nonNull);
    values.push(slice.length ? slice.reduce((a, c) => a + c, 0) / slice.length : 0);
  }
  return { values, bucketOf: (i: number) => Math.min(buckets - 1, Math.floor(i / size)), first: series.dates[0], last: series.dates[n - 1] };
}

function useKpis() {
  const t = useTr();
  const lang = useLang();
  const { status, bundle, error, cityId } = useCityBundle();
  const scen = useScenario();
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const presetId = useDashboard((s) => s.presetId);
  const dateIndex = useDashboard((s) => s.dateIndex);
  const scenarioStep = useDashboard((s) => s.scenarioStep);

  const daily = useMemo(() => cityMeanDaily(bundle?.rainAreas ?? bundle?.rainGrid), [bundle]);
  const base = useMemo(() => baselineStats(scen.list), [scen.list]);

  const kpis = useMemo<KpiModel[] | null>(() => {
    const ds = bundle?.dataset;
    if (!ds || !scen.ready) return null;
    const store = () => useDashboard.getState();
    const sel = selectedId ? (ds.areas.find((a) => a.id === selectedId) ?? null) : null;
    const selScen = sel ? (scen.byId.get(sel.id) ?? null) : null;
    const selName = sel ? t({ th: sel.nameTh, en: sel.nameEn }) : "";
    const kindTh = ds.city.areaKindTh;
    const kindEn = ds.city.areaKindEn.toLowerCase();
    const live = scen.source !== "baseline";
    const valueOf = (m: { value: number | null; provenance: DataProvenance } | undefined) =>
      m && m.provenance.status !== "unavailable" && nonNull(m.value) ? m.value : null;

    /* 1 — waste volume ------------------------------------------------ */
    const primary = primaryWasteMetric(ds);
    const wm = ds.totals[primary];
    const hist = ds.wasteHistory.filter((y) => nonNull(y.value) && y.status !== "unavailable").sort((a, b) => a.year - b.year);
    const wasteLabel = primary === "wasteCollected" ? { th: "ขยะที่จัดเก็บได้", en: "Waste collected" } : { th: "ขยะที่เกิดขึ้น", en: "Waste generated" };
    // Collected stays the card value; a sourced or estimated "generated" total rides along on its own line.
    const gen = primary === "wasteCollected" ? ds.totals.wasteGenerated : undefined;
    const genValue = valueOf(gen);
    const wasteSecondary: KpiModel["secondary"] =
      gen && genValue !== null
        ? {
            label: t(
              gen.provenance.status === "estimated" || gen.provenance.status === "simulated"
                ? { th: "ขยะที่เกิดขึ้น (ประมาณการ)", en: "Generated (estimate)" }
                : { th: "ขยะที่เกิดขึ้น", en: "Generated" },
            ),
            text: formatMetric(gen, lang, 0),
            status: gen.provenance.status,
            provenance: gen.provenance,
          }
        : null;
    const waste: KpiModel = {
      id: "waste",
      icon: Trash,
      label: t(wasteLabel),
      fullLabel: t(primary === "wasteCollected" ? { th: "ปริมาณขยะที่จัดเก็บได้ทั้งเมือง", en: "Citywide waste collected" } : { th: "ปริมาณขยะที่เกิดขึ้นทั้งเมือง", en: "Citywide waste generated" }),
      short: t({ th: "ขยะ", en: "Waste" }),
      value: valueOf(wm),
      unit: wm?.unit ?? "t/day",
      decimals: 0,
      status: wm?.provenance.status ?? "unavailable",
      provenance: wm?.provenance,
      context: hist.length >= 2 ? `${t({ th: "แนวโน้ม", en: "Trend" })} ${formatYear(hist[0].year, lang)}–${formatYear(hist[hist.length - 1].year, lang)}` : null,
      method: wm?.provenance.methodology ?? null,
      delta: null,
      area: sel ? { name: selName, text: formatMetric(sel.metrics[primary], lang, 1) } : null,
      secondary: wasteSecondary,
      chart:
        hist.length >= 2
          ? {
              kind: "spark",
              values: hist.map((h) => h.value as number),
              marker: hist.length - 1,
              color: "var(--ui-teal)",
              summary: `${t({ th: "แนวโน้มปริมาณขยะรายปี", en: "Annual waste trend" })} ${formatYear(hist[0].year, lang)}–${formatYear(hist[hist.length - 1].year, lang)}`,
            }
          : null,
      layer: "wasteVolume",
      actionLabel: t({ th: "คลิกเพื่อแสดงชั้นข้อมูลปริมาณขยะบนแผนที่", en: "Click to show the waste-volume layer" }),
      action: () => store().setActiveChoropleth("wasteVolume"),
    };

    /* 2 — population -------------------------------------------------- */
    const pm = ds.totals.population;
    const pops = ds.areas
      .map((a) => ({ id: a.id, v: valueOf(a.metrics.population) }))
      .filter((x): x is { id: string; v: number } => x.v !== null)
      .sort((a, b) => b.v - a.v);
    const population: KpiModel = {
      id: "population",
      icon: Users,
      label: t({ th: "ประชากร", en: "Population" }),
      fullLabel: t({ th: "ประชากรทั้งเมือง", en: "Citywide population" }),
      short: t({ th: "ประชากร", en: "Pop." }),
      value: valueOf(pm),
      unit: pm?.unit ?? "persons",
      decimals: 0,
      status: pm?.provenance.status ?? "unavailable",
      provenance: pm?.provenance,
      context: pm?.provenance.referenceYear ? `${t({ th: "ปีอ้างอิง", en: "Reference year" })} ${formatYear(pm.provenance.referenceYear, lang)}` : null,
      method: pm?.provenance.methodology ?? null,
      delta: null,
      area: sel ? { name: selName, text: formatMetric(sel.metrics.population, lang, 0) } : null,
      secondary: null,
      chart:
        pops.length >= 2
          ? {
              kind: "bars",
              values: pops.map((p) => p.v),
              highlight: sel ? pops.findIndex((p) => p.id === sel.id) : null,
              color: "#8f7ae0",
              summary: t({ th: `การกระจายประชากรราย${kindTh} เรียงจากมากไปน้อย`, en: `Population by ${kindEn}, largest first` }),
            }
          : null,
      layer: "populationDensity",
      actionLabel: t({ th: "คลิกเพื่อแสดงความหนาแน่นประชากรบนแผนที่", en: "Click to show population density" }),
      action: () => store().setActiveChoropleth("populationDensity"),
    };

    /* 3 — waste per capita -------------------------------------------- */
    const pc = ds.totals.wastePerCapita;
    const pcs = ds.areas.map((a) => valueOf(a.metrics.wastePerCapita)).filter(nonNull);
    const pcSel = sel ? valueOf(sel.metrics.wastePerCapita) : null;
    const perCapita: KpiModel = {
      id: "perCapita",
      icon: Scale,
      label: t({ th: "ขยะต่อคนต่อวัน", en: "Waste per capita" }),
      fullLabel: t(
        primary === "wasteCollected"
          ? { th: "ขยะที่จัดเก็บได้ต่อคนต่อวัน", en: "Waste collected per person per day" }
          : { th: "ขยะที่เกิดขึ้นต่อคนต่อวัน", en: "Waste generated per person per day" },
      ),
      short: t({ th: "ต่อคน", en: "Per capita" }),
      value: valueOf(pc),
      unit: pc?.unit ?? "kg/person/day",
      decimals: 2,
      status: pc?.provenance.status ?? "unavailable",
      provenance: pc?.provenance,
      context: null,
      method: pc?.provenance.methodology ?? null,
      delta: null,
      area: sel ? { name: selName, text: formatMetric(sel.metrics.wastePerCapita, lang, 2) } : null,
      secondary: null,
      chart:
        pcs.length >= 2
          ? {
              kind: "strip",
              values: pcs,
              domain: [Math.min(...pcs), Math.max(...pcs)],
              highlight: pcSel,
              reference: valueOf(pc),
              color: "var(--ui-cyan)",
              summary: t({ th: `ค่าราย${kindTh} (เส้นประ = ค่าทั้งเมือง)`, en: `Each ${kindEn} (dashed = city value)` }),
            }
          : null,
      layer: "wastePerCapita",
      actionLabel: t({ th: "คลิกเพื่อแสดงชั้นข้อมูลขยะต่อคน", en: "Click to show the waste-per-capita layer" }),
      action: () => store().setActiveChoropleth("wastePerCapita"),
    };

    /* 4 — rainfall ---------------------------------------------------- */
    let rain: KpiModel;
    const rainBase = {
      id: "rain" as const,
      icon: CloudRain,
      short: t({ th: "ฝน", en: "Rain" }),
      layer: "rainEstimated" as LayerId,
      actionLabel: t({ th: "คลิกเพื่อแสดงชั้นข้อมูลฝนรายพื้นที่", en: "Click to show the area rainfall layer" }),
      action: () => store().setActiveChoropleth("rainEstimated"),
    };
    if (scen.source === "scenario") {
      const v = scen.summary.rainDepthMm;
      const presetName = presetId === "custom" ? t({ th: "กำหนดเอง", en: "Custom" }) : t({ th: SCENARIO_PRESETS[presetId].th, en: SCENARIO_PRESETS[presetId].en });
      const stepLabel = scen.step ? formatNumber(scen.step.t, lang, 2) : null;
      rain = {
        ...rainBase,
        label: scen.step ? t({ th: `ฝนสะสม ณ ชม. ที่ ${stepLabel}`, en: `Rain to hour ${stepLabel}` }) : t({ th: "ฝนรวมของพายุจำลอง", en: "Simulated storm depth" }),
        fullLabel: t({ th: "ปริมาณฝนของสถานการณ์จำลอง (เฉลี่ยทุกพื้นที่)", en: "Scenario rainfall depth (mean of all areas)" }),
        value: v,
        unit: "mm",
        decimals: 1,
        status: v === null ? "unavailable" : "simulated",
        context: presetName,
        method: t({
          th: "ความเข้มฝน × ระยะเวลา ปรับตามสัดส่วนฝนรายปีของแต่ละพื้นที่ (แบบจำลองเชิงสาธิต)",
          en: "Intensity × duration, scaled by each area's share of annual rainfall (illustrative model)",
        }),
        delta: v !== null && base.depth !== null ? { value: v - base.depth, unit: "mm", decimals: 1 } : null,
        area: selScen ? { name: selName, text: `${formatNumber(selScen.current.rainDepthMm, lang, 1)} ${unitLabel("mm", lang)}` } : null,
        secondary: null,
        chart: {
          kind: "spark",
          values: scen.hyetograph.map((s) => s.intensityMmH),
          marker: scenarioStep > 0 ? Math.min(scenarioStep, scen.hyetograph.length - 1) : null,
          color: "var(--ui-violet)",
          summary: t({ th: "ไฮเอโทกราฟของพายุจำลอง (มม./ชม.)", en: "Simulated storm hyetograph (mm/h)" }),
        },
      };
    } else if (scen.source === "historical") {
      const vals = scen.list.map((x) => x.rain24h).filter(nonNull);
      const v = mean(vals);
      const series = bundle.rainAreas;
      rain = {
        ...rainBase,
        label: t({ th: "ฝนเฉลี่ยทั้งเมือง 24 ชม.", en: "City-mean rain (24 h)" }),
        fullLabel: t({ th: "ปริมาณฝนเฉลี่ยทั้งเมืองของวันที่เลือก", en: "City-mean rainfall on the selected day" }),
        value: v === null ? null : Math.round(v * 10) / 10,
        unit: "mm",
        decimals: 1,
        status: v === null ? "unavailable" : (series?.provenance.status ?? "estimated"),
        provenance: series?.provenance,
        context: scen.date ? formatDate(scen.date, lang) : null,
        method: series?.provenance.methodology ?? null,
        delta: null,
        area: selScen ? { name: selName, text: selScen.rain24h === null ? t(COMMON.unavailable) : `${formatNumber(selScen.rain24h, lang, 1)} ${unitLabel("mm", lang)}` } : null,
        secondary: null,
        chart: daily
          ? {
              kind: "spark",
              values: daily.values,
              marker: dateIndex !== null ? daily.bucketOf(dateIndex) : null,
              color: "var(--ui-cyan)",
              summary: `${t({ th: "ฝนเฉลี่ยรายวันทั้งเมือง", en: "City-mean daily rainfall" })} ${formatDate(daily.first, lang, "month")} – ${formatDate(daily.last, lang, "month")}`,
            }
          : null,
      };
    } else {
      const m = ds.totals.rainfallAnnual;
      rain = {
        ...rainBase,
        label: t({ th: "ฝนเฉลี่ยรายปี", en: "Mean annual rainfall" }),
        fullLabel: t({ th: "ปริมาณฝนเฉลี่ยรายปีของเมือง", en: "City mean annual rainfall" }),
        value: valueOf(m),
        unit: m?.unit ?? "mm/year",
        decimals: 0,
        status: m?.provenance.status ?? "unavailable",
        provenance: m?.provenance,
        context: t({ th: "เลือกวันบนไทม์ไลน์เพื่อดูฝนรายวัน", en: "Pick a day on the timeline for daily rain" }),
        method: m?.provenance.methodology ?? null,
        delta: null,
        area: sel ? { name: selName, text: formatMetric(sel.metrics.rainfallAnnual, lang, 0) } : null,
        secondary: null,
        chart: daily
          ? {
              kind: "spark",
              values: daily.values,
              marker: null,
              color: "var(--ui-cyan)",
              summary: `${t({ th: "ฝนเฉลี่ยรายวันทั้งเมือง", en: "City-mean daily rainfall" })} ${formatDate(daily.first, lang, "month")} – ${formatDate(daily.last, lang, "month")}`,
            }
          : null,
      };
    }

    /* 5 — modelled drainage stress ------------------------------------ */
    const ds5 = scen.summary.meanDrainageStress;
    const stresses = scen.list.map((x) => x.current.drainageStressPct).filter(nonNull);
    const contextLabel =
      scen.source === "scenario"
        ? t({ th: "เทียบกับสถานการณ์ฐาน", en: "vs. baseline scenario" })
        : scen.source === "historical" && scen.date
          ? formatDate(scen.date, lang)
          : t({ th: "สถานการณ์ฐาน (ฝนปกติ)", en: "Baseline (normal rain)" });
    const drainage: KpiModel = {
      id: "drainage",
      icon: Gauge,
      label: t({ th: "แรงกดดันระบายน้ำ (จำลอง)", en: "Modeled drainage stress" }),
      fullLabel: t(COMMON.modeledDrainageStress),
      short: t({ th: "ระบายน้ำ", en: "Drainage" }),
      value: ds5,
      unit: "%",
      decimals: 1,
      status: ds5 === null ? "unavailable" : "simulated",
      context: contextLabel,
      method: t({
        th: "ค่าเฉลี่ยถ่วงน้ำหนักด้วยประชากร: ภาระน้ำฝน ÷ ความสามารถระบายน้ำที่สมมติ (ไม่ใช่ค่าตรวจวัด)",
        en: "Population-weighted mean of rain load ÷ assumed drainage capacity (not a measurement)",
      }),
      delta: live && ds5 !== null && base.drainage !== null ? { value: ds5 - base.drainage, unit: "%", decimals: 1 } : null,
      area: selScen ? { name: selName, text: `${formatNumber(selScen.current.drainageStressPct, lang, 1)}%` } : null,
      secondary: null,
      chart:
        stresses.length >= 2
          ? {
              kind: "strip",
              values: stresses,
              domain: [0, 100],
              highlight: selScen ? selScen.current.drainageStressPct : null,
              reference: Math.round((100 / L_SAT) * 10) / 10,
              color: "var(--ui-orange)",
              summary: t({ th: `ค่าราย${kindTh} 0–100% (เส้นประ = ระดับความจุที่สมมติ)`, en: `Each ${kindEn}, 0–100% (dashed = assumed capacity)` }),
            }
          : null,
      layer: null,
      actionLabel: t({ th: "คลิกเพื่อเปิดแผงการระบายน้ำ", en: "Click to open the drainage panel" }),
      action: () => {
        const s = store();
        s.setBottomTab("drainage");
        s.setPanel("bottomOpen", true);
      },
    };

    /* 6 — modelled flood-risk exposure -------------------------------- */
    const share = scen.summary.exposedPopulationShare;
    const cc = scen.summary.classCounts;
    const totalClassed = cc.low + cc.moderate + cc.high + cc.veryHigh;
    const selClass = selScen ? riskClass(selScen.current.score) : null;
    const selClassMeta = selClass ? RISK_CLASSES.find((c) => c.id === selClass) : null;
    const exposure: KpiModel = {
      id: "exposure",
      icon: ShieldAlert,
      label: t({ th: "ประชากรในพื้นที่เสี่ยงสูง", en: "Pop. in high-risk areas" }),
      fullLabel: t({
        th: "สัดส่วนประชากรในพื้นที่ความเสี่ยงน้ำท่วมระดับสูง–สูงมาก (แบบจำลอง)",
        en: "Share of population in High / Very High modeled flood-risk areas",
      }),
      short: t({ th: "เสี่ยงสูง", en: "High risk" }),
      value: share === null ? null : Math.round(share * 1000) / 10,
      unit: "%",
      decimals: 1,
      status: share === null ? "unavailable" : "simulated",
      context: contextLabel,
      method: t({
        th: "ความเสี่ยง = 100 × (0.45·ฝน + 0.25·ระบายน้ำ + 0.20·ความเปราะบาง + 0.10·ขยะอุดตัน) — ระดับสูงเริ่มที่ 50 คะแนน",
        en: "Risk = 100 × (0.45·rain + 0.25·drainage + 0.20·exposure + 0.10·obstruction) — High starts at 50",
      }),
      delta: live && share !== null && base.exposureShare !== null ? { value: (share - base.exposureShare) * 100, unit: "%", decimals: 1 } : null,
      area: selScen
        ? {
            name: selName,
            text:
              selScen.current.score === null || !selClassMeta
                ? t(COMMON.unavailable)
                : `${t({ th: selClassMeta.th, en: selClassMeta.en })} · ${formatNumber(selScen.current.score, lang, 0)}`,
          }
        : null,
      secondary: null,
      chart:
        totalClassed > 0
          ? {
              kind: "stack",
              parts: [
                { value: cc.low, color: RISK_COLORS.low },
                { value: cc.moderate, color: RISK_COLORS.moderate },
                { value: cc.high, color: RISK_COLORS.high },
                { value: cc.veryHigh, color: RISK_COLORS.veryHigh },
              ],
              summary: RISK_CLASSES.map((c) => `${t({ th: c.th, en: c.en })} ${cc[c.id]}`).join(" · "),
            }
          : null,
      layer: "floodRisk",
      actionLabel: t({ th: "คลิกเพื่อแสดงชั้นความเสี่ยงน้ำท่วม", en: "Click to show the flood-risk layer" }),
      action: () => store().setActiveChoropleth("floodRisk"),
    };

    return [waste, population, perCapita, rain, drainage, exposure];
  }, [bundle, scen, selectedId, presetId, dateIndex, scenarioStep, daily, base, t, lang]);

  return { status, error, cityId, kpis };
}

/* ------------------------------------------------------------------ */
/*  Micro charts (inline SVG, real data only)                          */
/* ------------------------------------------------------------------ */

const W = 64;
const H = 24;

function MicroChartView({ chart, className }: { chart: MicroChart; className?: string }) {
  const clip = useId();
  let body: React.ReactNode = null;
  if (chart.kind === "spark") {
    const v = chart.values;
    const min = Math.min(...v);
    const max = Math.max(...v);
    const span = max - min || 1;
    const pts = v.map((y, i) => [v.length === 1 ? W / 2 : (i / (v.length - 1)) * W, H - 3 - ((y - min) / span) * (H - 6)] as const);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
    const area = `${line}L${W} ${H}L0 ${H}Z`;
    const m = chart.marker !== null && pts[chart.marker] ? pts[chart.marker] : null;
    body = (
      <>
        <path d={area} fill={chart.color} fillOpacity={0.12} />
        <path d={line} fill="none" stroke={chart.color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {m && (
          <>
            <line x1={m[0]} x2={m[0]} y1={0} y2={H} stroke={chart.color} strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={m[0]} cy={m[1]} r={2.2} fill={chart.color} stroke="var(--ui-surface)" strokeWidth={1} />
          </>
        )}
      </>
    );
  } else if (chart.kind === "bars") {
    const v = chart.values;
    const max = Math.max(...v) || 1;
    const bw = W / v.length;
    body = v.map((y, i) => {
      const h = Math.max(1, (y / max) * (H - 2));
      const hi = i === chart.highlight;
      return (
        <rect
          key={i}
          x={i * bw + bw * 0.12}
          y={H - h}
          width={Math.max(0.6, bw * 0.76)}
          height={h}
          rx={Math.min(1, bw * 0.3)}
          fill={hi ? "var(--ui-cyan)" : chart.color}
          fillOpacity={hi ? 1 : chart.highlight !== null ? 0.35 : 0.6}
        />
      );
    });
  } else if (chart.kind === "strip") {
    const [d0, d1] = chart.domain;
    const span = d1 - d0 || 1;
    const x = (v: number) => 2 + ((v - d0) / span) * (W - 4);
    body = (
      <>
        <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--ui-border-strong)" strokeWidth={1} />
        {chart.values.map((v, i) => (
          <line key={i} x1={x(v)} x2={x(v)} y1={H / 2 - 5} y2={H / 2 + 5} stroke={chart.color} strokeOpacity={0.55} strokeWidth={1} />
        ))}
        {chart.reference !== null && (
          <line x1={x(chart.reference)} x2={x(chart.reference)} y1={1} y2={H - 1} stroke="var(--ui-text-2)" strokeDasharray="2 2" strokeWidth={1} />
        )}
        {chart.highlight !== null && <rect x={x(chart.highlight) - 1.5} y={H / 2 - 8} width={3} height={16} rx={1} fill="var(--ui-cyan)" />}
      </>
    );
  } else {
    const total = chart.parts.reduce((s, p) => s + p.value, 0) || 1;
    const segs = chart.parts.map((p, i) => ({
      ...p,
      x: (chart.parts.slice(0, i).reduce((s, q) => s + q.value, 0) / total) * W,
      w: (p.value / total) * W,
    }));
    body = (
      <>
        <defs>
          <clipPath id={clip}>
            <rect x={0} y={H / 2 - 4} width={W} height={8} rx={4} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clip})`}>
          <rect x={0} y={H / 2 - 4} width={W} height={8} fill="var(--ui-elevated-2)" />
          {segs.map((p, i) => (
            <rect key={i} x={p.x} y={H / 2 - 4} width={p.w} height={8} fill={p.color} />
          ))}
        </g>
      </>
    );
  }
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className}>
      {body}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Pieces                                                             */
/* ------------------------------------------------------------------ */

function DeltaChip({ delta, compact = false }: { delta: KpiDelta; compact?: boolean }) {
  const lang = useLang();
  const t = useTr();
  const v = Math.round(delta.value * 10 ** delta.decimals) / 10 ** delta.decimals;
  const dir = v > 0 ? "up" : v < 0 ? "down" : "flat";
  const glyph = dir === "up" ? "▲" : dir === "down" ? "▼" : "＝";
  const sign = dir === "up" ? "+" : dir === "down" ? "−" : "±";
  const text = `${sign}${formatNumber(Math.abs(v), lang, delta.decimals)}${delta.unit === "%" ? (lang === "th" ? " จุด" : " pt") : ` ${unitLabel(delta.unit, lang)}`}`;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded px-1 font-num font-medium",
        compact ? "text-[10px]" : "text-[10.5px]",
        dir === "up" ? "bg-ui-orange/12 text-ui-orange" : dir === "down" ? "bg-ui-green/12 text-ui-green" : "bg-ui-elevated text-ui-text-2",
      )}
      aria-label={`${t({ th: "เปลี่ยนจากสถานการณ์ฐาน", en: "Change from baseline" })} ${text}`}
    >
      <span aria-hidden>{glyph}</span>
      <span aria-hidden>{text}</span>
    </span>
  );
}

function StatusLine({ status }: { status: DataStatus }) {
  const t = useTr();
  const m = STATUS_META[status];
  return (
    <span>
      <span aria-hidden>{m.glyph}</span> {t(m.label)} — {t(m.description)}
    </span>
  );
}

function periodText(p: DataProvenance | undefined, lang: "th" | "en") {
  if (!p) return null;
  if (p.observedFrom) {
    return p.observedTo && p.observedTo !== p.observedFrom ? `${formatDate(p.observedFrom, lang)} – ${formatDate(p.observedTo, lang)}` : formatDate(p.observedFrom, lang);
  }
  return p.referenceYear ? formatYear(p.referenceYear, lang) : null;
}

function KpiTooltipBody({ kpi }: { kpi: KpiModel }) {
  const t = useTr();
  const lang = useLang();
  const period = periodText(kpi.provenance, lang);
  return (
    <div className="flex flex-col gap-1 py-0.5 text-left">
      <span className="font-semibold">{kpi.fullLabel}</span>
      <span className="ui-num">
        {kpi.value === null ? t(COMMON.unavailable) : `${formatNumber(kpi.value, lang, kpi.decimals)} ${unitLabel(kpi.unit, lang)}`}
      </span>
      <StatusLine status={kpi.status} />
      {kpi.provenance?.sourceName && (
        <span className="opacity-75">
          {t(COMMON.source)}: {kpi.provenance.sourceName}
        </span>
      )}
      {period && (
        <span className="opacity-75">
          {t({ th: "ช่วงอ้างอิง", en: "Period" })}: {period}
        </span>
      )}
      {kpi.method && <span className="line-clamp-4 opacity-75">{kpi.method}</span>}
      {kpi.secondary && (
        <span className="mt-0.5 flex flex-col gap-0.5 border-t border-current/15 pt-1">
          <span>
            <span aria-hidden style={{ color: STATUS_META[kpi.secondary.status].color }}>
              {STATUS_META[kpi.secondary.status].glyph}
            </span>{" "}
            {kpi.secondary.label}: <span className="ui-num">{kpi.secondary.text}</span> — {t(STATUS_META[kpi.secondary.status].label)}
          </span>
          {kpi.secondary.provenance?.methodology && <span className="line-clamp-3 opacity-75">{kpi.secondary.provenance.methodology}</span>}
        </span>
      )}
      {kpi.context && kpi.secondary && <span className="opacity-75">{kpi.context}</span>}
      {kpi.chart && <span className="opacity-75">{kpi.chart.summary}</span>}
      <span className="mt-0.5 opacity-60">{kpi.actionLabel}</span>
    </div>
  );
}

function ariaFor(kpi: KpiModel, display: number | null, lang: "th" | "en", t: (s: { th: string; en: string }) => string) {
  const v = display === null ? t(COMMON.unavailable) : `${formatNumber(kpi.value, lang, kpi.decimals)} ${unitLabel(kpi.unit, lang)}`;
  const second = kpi.secondary ? ` ${kpi.secondary.label}: ${kpi.secondary.text}, ${t(STATUS_META[kpi.secondary.status].label)}.` : "";
  return `${kpi.fullLabel}: ${v}, ${t(STATUS_META[kpi.status].label)}.${second} ${kpi.actionLabel}`;
}

function KpiCard({ kpi, display, pressed }: { kpi: KpiModel; display: number | null; pressed: boolean | undefined }) {
  const t = useTr();
  const lang = useLang();
  const sim = kpi.status === "simulated";
  const card = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={kpi.action}
            aria-pressed={pressed}
            aria-label={ariaFor(kpi, display, lang, t)}
            className={cn(
              "group @container relative flex h-full w-full min-w-0 flex-col gap-1.5 overflow-hidden rounded-xl border bg-ui-surface/90 px-2.5 pt-2.5 pb-2 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors duration-150 outline-none hover:border-ui-border-strong hover:bg-ui-elevated focus-visible:ring-2 focus-visible:ring-ui-cyan/60",
              pressed ? "border-ui-cyan/45" : "border-ui-border",
            )}
          />
        }
      >
        {sim && <span aria-hidden className="ui-sim-stripes absolute inset-x-0 top-0 h-[3px]" />}
        {pressed && <span aria-hidden className="absolute inset-x-3 top-0 h-[2px] rounded-b-full bg-ui-cyan" />}
        <span className="flex items-start justify-between gap-2">
          <Eyebrow className="min-w-0 truncate">{kpi.label}</Eyebrow>
          {/* narrow cards keep the status glyph (still labelled for AT via aria-label) so the KPI title stays readable */}
          <StatusBadge status={kpi.status} size="xs" className="hidden shrink-0 @[11.5rem]:inline-flex" />
          <StatusBadge status={kpi.status} size="xs" showLabel={false} className="shrink-0 @[11.5rem]:hidden" />
        </span>
        <span className="flex items-end justify-between gap-2">
          <span className="flex min-w-0 items-baseline gap-1">
            <AnimatedNumber
              value={display}
              decimals={kpi.decimals}
              className={cn("ui-num shrink-0 whitespace-nowrap text-[17px] leading-none @[12rem]:text-[22px] font-semibold text-ui-text", display === null && "text-[13px] font-normal text-ui-text-3")}
            />
            {display !== null && <span className="min-w-0 truncate text-[11px] text-ui-text-2">{unitLabel(kpi.unit, lang)}</span>}
          </span>
          {/* the figure has priority: the micro chart only appears when the card is wide enough for both */}
          {kpi.chart && <MicroChartView chart={kpi.chart} className="hidden h-6 w-16 shrink-0 @[14rem]:block" />}
        </span>
        <span className="flex h-4 min-w-0 items-center gap-1.5 text-[11px] leading-4 text-ui-text-3">
          {kpi.delta && <DeltaChip delta={kpi.delta} />}
          {kpi.area ? (
            <span className="min-w-0 truncate">
              <span className="text-ui-text-2">{kpi.area.name}</span> <span className="ui-num">{kpi.area.text}</span>
            </span>
          ) : kpi.secondary ? (
            <span className="flex min-w-0 items-center gap-1">
              <span aria-hidden className="shrink-0 text-[10px]" style={{ color: STATUS_META[kpi.secondary.status].color }}>
                {STATUS_META[kpi.secondary.status].glyph}
              </span>
              <span className="min-w-0 truncate">
                {kpi.secondary.label} <span className="ui-num text-ui-text-2">{kpi.secondary.text}</span>
              </span>
            </span>
          ) : kpi.context ? (
            <span className="min-w-0 truncate">{kpi.context}</span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-80">
        <KpiTooltipBody kpi={kpi} />
      </TooltipContent>
    </Tooltip>
  );
  return (
    <EntranceItem kind="card" className="min-w-0">
      {/* scenario-driven KPIs share the app-wide debounced scenario pulse highlight */}
      {sim ? (
        <ScenarioPulse rounded="rounded-xl" className="h-full">
          {card}
        </ScenarioPulse>
      ) : (
        card
      )}
    </EntranceItem>
  );
}

function KpiChip({ kpi, display, pressed }: { kpi: KpiModel; display: number | null; pressed: boolean | undefined }) {
  const t = useTr();
  const lang = useLang();
  const m = STATUS_META[kpi.status];
  return (
    <button
      type="button"
      onClick={kpi.action}
      aria-pressed={pressed}
      aria-label={ariaFor(kpi, display, lang, t)}
      className={cn(
        "flex min-h-10 shrink-0 snap-start items-center gap-1.5 rounded-full border bg-ui-surface/90 py-1.5 pr-3 pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60",
        pressed ? "border-ui-cyan/45" : "border-ui-border",
        kpi.status === "simulated" && "ui-sim-stripes",
      )}
    >
      <span aria-hidden className="text-[10px]" style={{ color: m.color }}>
        {m.glyph}
      </span>
      <span className="text-[11px] text-ui-text-2">{kpi.short}</span>
      <AnimatedNumber value={display} decimals={kpi.decimals} className={cn("ui-num text-[13px] font-semibold text-ui-text", display === null && "text-[11px] font-normal text-ui-text-3")} />
      {display !== null && <span className="text-[10.5px] text-ui-text-2">{unitLabel(kpi.unit, lang)}</span>}
      {kpi.delta && <DeltaChip delta={kpi.delta} compact />}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Strip                                                              */
/* ------------------------------------------------------------------ */

/** Six citywide KPIs. `cards` for desktop/tablet, `chips` for the mobile snap row. */
export function KPIStrip({ variant = "cards", className }: { variant?: "cards" | "chips"; className?: string }) {
  const t = useTr();
  const reduced = useReducedMotionPref();
  const activeChoropleth = useDashboard((s) => s.activeChoropleth);
  const { status, error, cityId, kpis } = useKpis();
  const ready = kpis !== null;

  // On each city's data load: render 0, then the real values on the next frame so they count up.
  const [primedCity, setPrimedCity] = useState<string | null>(null);
  const primed = primedCity === cityId;
  useEffect(() => {
    if (!ready || primed) return;
    const id = requestAnimationFrame(() => setPrimedCity(cityId));
    return () => cancelAnimationFrame(id);
  }, [ready, primed, cityId]);
  const shown = (v: number | null) => (!primed && !reduced && v !== null ? 0 : v);
  const pressedFor = (k: KpiModel) => (k.layer ? activeChoropleth === k.layer : undefined);
  const label = t({ th: "ตัวชี้วัดหลักของเมือง", en: "City key indicators" });

  if (status === "error" && !ready) {
    return (
      <div role="alert" className={cn("flex items-center gap-3 rounded-xl border border-ui-red/35 bg-ui-red/5 px-3 py-2.5", className)}>
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-ui-red" />
        <div className="min-w-0 flex-1 text-[12.5px]">
          <p className="text-ui-text">{t({ th: "ไม่สามารถโหลดข้อมูลของเมืองนี้ได้", en: "This city's dataset could not be loaded" })}</p>
          {error && <p className="truncate font-mono text-[11px] text-ui-text-3">{error}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={() => void useDataStore.getState().loadCity(cityId)}>
          <RotateCcw aria-hidden />
          {t({ th: "ลองอีกครั้ง", en: "Retry" })}
        </Button>
      </div>
    );
  }

  if (variant === "chips") {
    return (
      <div role="region" aria-label={label} aria-busy={!ready} className={cn("ui-scroll flex snap-x snap-mandatory gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none]", className)}>
        {ready
          ? kpis.map((k) => <KpiChip key={k.id} kpi={k} display={shown(k.value)} pressed={pressedFor(k)} />)
          : Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10 w-32 shrink-0 rounded-full bg-ui-elevated" />)}
      </div>
    );
  }

  return (
    <EntranceGroup
      replayKey={ready ? `ready-${cityId}` : "loading"}
      role="region"
      ariaLabel={label}
      className={cn("ui-scroll grid auto-cols-[minmax(108px,1fr)] grid-flow-col gap-2 overflow-x-auto", className)}
    >
      {ready
        ? kpis.map((k) => <KpiCard key={k.id} kpi={k} display={shown(k.value)} pressed={pressedFor(k)} />)
        : Array.from({ length: 6 }, (_, i) => (
            <EntranceItem key={i} kind="fade" className="flex h-[88px] flex-col justify-between rounded-xl border border-ui-border bg-ui-surface/70 px-3 py-2.5">
              <Skeleton className="h-3 w-24 bg-ui-elevated" />
              <Skeleton className="h-6 w-20 bg-ui-elevated" />
              <Skeleton className="h-3 w-28 bg-ui-elevated/70" />
            </EntranceItem>
          ))}
    </EntranceGroup>
  );
}
