/**
 * Guided story ("เล่าเรื่องเมือง") — a short, data-driven tour of the CURRENT city.
 *
 * Pure and deterministic: (dataset × optional series × options) → ordered steps. No React, no store,
 * no I/O. Every number a step shows travels as a MetricValue with its provenance status; values the
 * tour derives itself (shares, ratios, model summaries) are labelled derived / simulated and carry
 * the method in `provenance.methodology`. Steps whose data is missing are skipped, never faked.
 *
 * The UI (src/hooks/use-story.ts) applies `step.view` to the dashboard store; this module only
 * describes what each step should show.
 */
import type { Bi } from "@/lib/i18n";
import { formatDate, formatNumber } from "@/lib/formatters";
import { primaryWasteMetric } from "@/lib/metrics";
import {
  BASELINE_SCENARIO,
  DEFAULT_ASSUMPTIONS,
  MODEL_VERSION,
  SCENARIO_PRESETS,
  computeAreaRisk,
  type PresetId,
  type ScenarioParams,
} from "@/lib/simulation/model";
import { inputsFor } from "@/lib/simulation/use-scenario";
import { cityMeanSeries, dateIndexRange, peakIndexInRange } from "@/hooks/use-timeline-playback";
import type { AreaRecord, CityDataset, DataProvenance, DataStatus, FloodEvent, HourlyRainEvent, MetricValue, RainSeries, WaterLevelStation } from "@/lib/types";
import type { CameraPreset, DashboardState, LayerId, ThreeScope, ViewMode } from "@/store/dashboard-store";

/* ------------------------------------------------------------------ */
/*  Contract                                                           */
/* ------------------------------------------------------------------ */

export const STORY_MIN_STEPS = 6;
export const STORY_MAX_STEPS = 8;
/** Dwell time per step while the tour auto-advances (manual by default). */
export const STORY_AUTO_ADVANCE_MS = 8000;

export type StoryStepKind =
  | "overview"
  | "topWaste"
  | "topPerCapita"
  | "waterways"
  | "neighbourhood3d"
  | "heavyRain"
  | "combinedStress"
  | "floodEvent"
  | "explore";

export interface StoryMetric {
  id: string;
  label: Bi;
  metric: MetricValue;
  decimals: number;
}

/** What the dashboard should show for a step. Applied to the store only (never to data). */
export interface StoryView {
  viewMode: ViewMode;
  threeScope: ThreeScope;
  cameraPreset: CameraPreset;
  /** Area to select and fly to; null clears the selection and returns the camera to the city view. */
  areaId: string | null;
  /** Active choropleth, or null for none (overlays only). */
  choropleth: LayerId | null;
  /** Overlay layers switched on for this step (other overlays keep the viewer's own setting). */
  overlays: LayerId[];
  /** "baseline" resets any scenario; a preset id applies that Scenario Lab preset. */
  scenario: "baseline" | PresetId;
  /** Historical rainfall day (index into rainAreas.dates) — only used with scenario "baseline". */
  dateIndex: number | null;
  /** Bottom-dock tab to reveal (desktop / tablet only), or null to leave the dock as it is. */
  dockTab: DashboardState["bottomTab"] | null;
}

export interface StoryStep {
  /** Stable id (the step kind — each kind appears at most once). */
  id: StoryStepKind;
  kind: StoryStepKind;
  title: Bi;
  body: Bi;
  /** Caveat shown under the metrics (limitations, estimates, model disclaimer). */
  note?: Bi;
  metrics: StoryMetric[];
  view: StoryView;
  /** Headline status of what the step shows (simulated for scenario steps). */
  status: DataStatus;
}

export interface StoryInput {
  dataset: CityDataset;
  floodEvents?: FloodEvent[] | null;
  rainAreas?: RainSeries | null;
  waterLevels?: WaterLevelStation[] | null;
  rainHourly?: HourlyRainEvent[] | null;
}

export interface StoryOptions {
  /** WebGL availability (null = not probed yet → assume available; the 3D step degrades gracefully). */
  webgl: boolean | null;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const MODEL_SOURCE = "Urban Intelligence illustrative scenario model";

const valueOf = (m: MetricValue | undefined | null) =>
  m && m.provenance.status !== "unavailable" && m.value !== null && Number.isFinite(m.value) ? m.value : null;

/** Area with the largest non-null value (ties → first in dataset order, deterministic). */
export function argmaxArea(areas: AreaRecord[], val: (a: AreaRecord) => number | null): { area: AreaRecord; v: number } | null {
  let best: { area: AreaRecord; v: number } | null = null;
  for (const area of areas) {
    const v = val(area);
    if (v === null || !Number.isFinite(v)) continue;
    if (!best || v > best.v) best = { area, v };
  }
  return best;
}

/**
 * True when a metric actually varies across areas (≥ 3 values and max exceeds min by > 1 %).
 * Hat Yai's zone waste is allocated by population, so its per-capita values are identical by
 * construction — a "highest per capita" step would be meaningless there and is skipped.
 */
export function hasSpread(values: (number | null)[]): boolean {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (v.length < 3) return false;
  const min = Math.min(...v);
  const max = Math.max(...v);
  if (max <= 0) return false;
  return min <= 0 ? max > 0 : max / min - 1 > 0.01;
}

const n = (v: number, lang: "th" | "en", d: number) => formatNumber(v, lang, d);
const nameOf = (a: AreaRecord): Bi => ({ th: a.nameTh, en: a.nameEn });

function derived(value: number | null, unit: string, methodology: string, base?: DataProvenance): MetricValue {
  return {
    value,
    unit,
    provenance: {
      status: value === null ? "unavailable" : "derived",
      methodology,
      referenceYear: base?.referenceYear,
      observedFrom: base?.observedFrom,
      observedTo: base?.observedTo,
    },
  };
}

function simulated(value: number | null, unit: string, methodology: string): MetricValue {
  return { value, unit, provenance: { status: value === null ? "unavailable" : "simulated", sourceName: MODEL_SOURCE, methodology } };
}

/** Same spatial rainfall rule as useScenario(): area annual rainfall ÷ city mean (1 when unknown). */
function spatialFactorFor(areas: AreaRecord[]) {
  const vals = areas.map((a) => a.metrics.rainfallAnnual?.value).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  const mean = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  return (a: AreaRecord) => {
    const v = a.metrics.rainfallAnnual?.value;
    return mean && v ? v / mean : 1;
  };
}

export interface CityRiskSummary {
  /** Population-weighted mean score over areas with population and a score (as useScenario().summary). */
  meanScore: number | null;
  /** Areas classed High or Very High (score ≥ 50). */
  highCount: number;
  /** Share (%) of population living in High / Very High areas. */
  exposedPct: number | null;
  scores: Map<string, number | null>;
}

/** City summary of the illustrative model for one parameter set (full-storm values, no timeline step). */
export function cityRiskSummary(areas: AreaRecord[], params: ScenarioParams): CityRiskSummary {
  const spatial = spatialFactorFor(areas);
  let w = 0;
  let s = 0;
  let exposed = 0;
  let popTotal = 0;
  let highCount = 0;
  const scores = new Map<string, number | null>();
  for (const area of areas) {
    const score = computeAreaRisk(inputsFor(area, spatial), params, DEFAULT_ASSUMPTIONS).score;
    scores.set(area.id, score);
    const pop = area.metrics.population?.value ?? null;
    if (score !== null && score >= 50) highCount++;
    if (pop !== null && score !== null) {
      w += pop;
      s += pop * score;
      if (score >= 50) exposed += pop;
    }
    if (pop !== null) popTotal += pop;
  }
  return {
    meanScore: w ? Math.round((s / w) * 10) / 10 : null,
    highCount,
    exposedPct: popTotal ? Math.round((exposed / popTotal) * 1000) / 10 : null,
    scores,
  };
}

/** Flood events that fall inside the daily rainfall record (with their peak day) and those outside it. */
export function partitionFloodEvents(events: FloodEvent[], rain: RainSeries | null | undefined) {
  const inRange: { event: FloodEvent; from: number; to: number; peak: number }[] = [];
  const outOfRange: FloodEvent[] = [];
  const mean = rain ? cityMeanSeries(rain.series, rain.dates.length) : [];
  for (const event of events) {
    const r = rain ? dateIndexRange(rain.dates, event.from, event.to) : null;
    if (r) inRange.push({ event, from: r[0], to: r[1], peak: peakIndexInRange(mean, r[0], r[1]) });
    else outOfRange.push(event);
  }
  return { inRange, outOfRange, mean };
}

/** Hourly-rain events whose span covers the given ISO day. */
export function hourlyEventsOn(events: HourlyRainEvent[] | null | undefined, isoDay: string | null): HourlyRainEvent[] {
  if (!events || !isoDay) return [];
  const day = isoDay.slice(0, 10);
  return events.filter((e) => e.times.length > 0 && e.times[0].slice(0, 10) <= day && e.times[e.times.length - 1].slice(0, 10) >= day);
}

const baseView = (over: Partial<StoryView>): StoryView => ({
  viewMode: "2d",
  threeScope: "city",
  cameraPreset: "overview",
  areaId: null,
  choropleth: "wasteVolume",
  overlays: [],
  scenario: "baseline",
  dateIndex: null,
  dockTab: null,
  ...over,
});

/* ------------------------------------------------------------------ */
/*  Builder                                                            */
/* ------------------------------------------------------------------ */

export function buildStory(input: StoryInput, opts: StoryOptions): StoryStep[] {
  const ds = input.dataset;
  const areas = ds.areas;
  if (!areas.length) return [];
  const city = ds.city;
  const kind: Bi = { th: city.areaKindTh, en: city.areaKindEn.toLowerCase() };
  const cityName: Bi = { th: city.nameTh, en: city.nameEn };
  const webgl = opts.webgl !== false;
  const steps: StoryStep[] = [];
  const approx = areas.some((a) => a.geometryStatus === "approximate");

  /* 1 — overview & provenance ------------------------------------------ */
  const primary = primaryWasteMetric(ds);
  const wasteTotal = ds.totals[primary];
  const wasteWord: Bi = primary === "wasteCollected" ? { th: "ขยะที่จัดเก็บได้", en: "Waste collected" } : { th: "ขยะที่เกิดขึ้น", en: "Waste generated" };
  const overviewMetrics: StoryMetric[] = [{ id: "population", label: { th: "ประชากร", en: "Population" }, metric: ds.totals.population, decimals: 0 }];
  if (wasteTotal) overviewMetrics.push({ id: "waste", label: wasteWord, metric: wasteTotal, decimals: 0 });
  steps.push({
    id: "overview",
    kind: "overview",
    title: { th: `${cityName.th}: ภาพรวมและที่มาของข้อมูล`, en: `${cityName.en}: the city and its data` },
    body: {
      th: `ทัวร์นี้พาดู ${areas.length} ${kind.th} จากข้อมูลจริงของเมือง ทุกตัวเลขมีป้ายสถานะ — ข้อมูลอ้างอิง คำนวณ ประมาณการ หรือจำลอง — ชี้ที่ตัวเลขเพื่อดูแหล่งที่มาและช่วงเวลา`,
      en: `This tour walks through ${areas.length} ${kind.en}s using the city's own data. Every number carries a status — observed, derived, estimated or simulated — hover a value for its source and period.`,
    },
    note: approx
      ? {
          th: `ขอบเขต${kind.th}บนแผนที่เป็นการแบ่งพื้นที่โดยประมาณเพื่อการสาธิต ไม่ใช่เขตการปกครอง`,
          en: `The ${kind.en} boundaries are approximate demonstration partitions, not administrative limits.`,
        }
      : undefined,
    metrics: overviewMetrics,
    view: baseView({ choropleth: "wasteVolume" }),
    status: ds.totals.population?.provenance.status ?? "unavailable",
  });

  /* 2 — highest waste ----------------------------------------------------- */
  const topWaste = argmaxArea(areas, (a) => valueOf(a.metrics[primary]));
  if (topWaste) {
    const m = topWaste.area.metrics[primary];
    const total = valueOf(wasteTotal);
    const share = total ? Math.round((topWaste.v / total) * 1000) / 10 : null;
    const name = nameOf(topWaste.area);
    const estimated = m.provenance.status === "estimated";
    const metrics: StoryMetric[] = [{ id: "areaWaste", label: { th: `${wasteWord.th} · ${name.th}`, en: `${wasteWord.en} · ${name.en}` }, metric: m, decimals: 1 }];
    if (share !== null) {
      metrics.push({
        id: "share",
        label: { th: "สัดส่วนของทั้งเมือง", en: "Share of city total" },
        metric: derived(share, "%", `${name.en} ${primary} ÷ city total ${primary} × 100`, m.provenance),
        decimals: 1,
      });
    }
    steps.push({
      id: "topWaste",
      kind: "topWaste",
      title: primary === "wasteCollected" ? { th: "ขยะที่จัดเก็บได้มากที่สุด", en: "Where the most waste is collected" } : { th: "ขยะเกิดขึ้นมากที่สุด", en: "Where the most waste is generated" },
      body: {
        th: `${name.th} มี${wasteWord.th}สูงที่สุดในเมือง ${n(topWaste.v, "th", 1)} ตัน/วัน${share !== null ? ` หรือ ${n(share, "th", 1)}% ของทั้งเมือง` : ""}`,
        en: `${name.en} has the city's highest ${wasteWord.en.toLowerCase()}: ${n(topWaste.v, "en", 1)} t/day${share !== null ? `, ${n(share, "en", 1)}% of the city total` : ""}.`,
      },
      note: estimated
        ? { th: "ค่ารายพื้นที่นี้เป็นค่าประมาณการ (กระจายจากยอดรวมของเมืองตามสัดส่วนประชากร)", en: "Area values here are estimates (the city total allocated by population share)." }
        : undefined,
      metrics,
      view: baseView({ areaId: topWaste.area.id, choropleth: "wasteVolume" }),
      status: m.provenance.status,
    });
  }

  /* 3 — highest waste per capita (only when it varies) --------------------- */
  const perCapitaValues = areas.map((a) => valueOf(a.metrics.wastePerCapita));
  const topPc = hasSpread(perCapitaValues) ? argmaxArea(areas, (a) => valueOf(a.metrics.wastePerCapita)) : null;
  if (topPc) {
    const m = topPc.area.metrics.wastePerCapita;
    const cityPc = valueOf(ds.totals.wastePerCapita);
    const ratio = cityPc ? Math.round((topPc.v / cityPc) * 10) / 10 : null;
    const name = nameOf(topPc.area);
    const metrics: StoryMetric[] = [{ id: "areaPerCapita", label: { th: `ขยะต่อคนต่อวัน · ${name.th}`, en: `Waste per capita · ${name.en}` }, metric: m, decimals: 2 }];
    if (ds.totals.wastePerCapita) metrics.push({ id: "cityPerCapita", label: { th: "ค่าทั้งเมือง", en: "City value" }, metric: ds.totals.wastePerCapita, decimals: 2 });
    steps.push({
      id: "topPerCapita",
      kind: "topPerCapita",
      title: { th: "ขยะต่อคนสูงที่สุด", en: "Highest waste per resident" },
      body: {
        th: `${name.th} มีขยะต่อคนต่อวันสูงที่สุด ${n(topPc.v, "th", 2)} กก.${ratio !== null ? ` หรือ ${n(ratio, "th", 1)} เท่าของค่าทั้งเมือง` : ""}`,
        en: `${name.en} has the highest waste per resident: ${n(topPc.v, "en", 2)} kg/day${ratio !== null ? `, ${n(ratio, "en", 1)}× the city value` : ""}.`,
      },
      note: {
        th: "ค่าต่อคนหารด้วยประชากรตามทะเบียนราษฎร พื้นที่ที่มีผู้คนเข้ามาทำงานหรือท่องเที่ยวมากจึงอาจมีค่าสูงกว่าที่ผู้อยู่อาศัยสร้างจริง",
        en: "Per-capita values divide by registered residents, so areas with many commuters or visitors can read higher than residents alone produce.",
      },
      metrics,
      view: baseView({ areaId: topPc.area.id, choropleth: "wastePerCapita" }),
      status: m.provenance.status,
    });
  }

  /* 4 — waterways & drainage ---------------------------------------------- */
  const gauges = (input.waterLevels ?? []).filter((g) => valueOf(g.waterLevel) !== null);
  const topGauge = gauges.length
    ? gauges.reduce((best, g) => {
        const b = valueOf(best.capacityPct) ?? -Infinity;
        const c = valueOf(g.capacityPct) ?? -Infinity;
        return c > b ? g : best;
      }, gauges[0])
    : null;
  const waterMetrics: StoryMetric[] = [];
  if (ds.totals.floodExposure) waterMetrics.push({ id: "exposure", label: { th: "ความเปราะบางต่อน้ำท่วม (ทั้งเมือง)", en: "Flood exposure (city)" }, metric: ds.totals.floodExposure, decimals: 2 });
  if (ds.totals.obstructionSusceptibility)
    waterMetrics.push({ id: "obstruction", label: { th: "ความเสี่ยงขยะอุดตันทางระบายน้ำ", en: "Waste-obstruction susceptibility" }, metric: ds.totals.obstructionSusceptibility, decimals: 2 });
  if (topGauge) {
    const gName = topGauge.nameTh ?? topGauge.nameEn;
    waterMetrics.push({ id: "gauge", label: { th: `ระดับน้ำ · ${gName}`, en: `Water level · ${topGauge.nameEn}` }, metric: topGauge.waterLevel, decimals: 2 });
  }
  steps.push({
    id: "waterways",
    kind: "waterways",
    title: { th: "คลอง ทางน้ำ และระบบระบายน้ำ", en: "Canals, waterways and drainage" },
    body: {
      th: `น้ำฝนต้องไหลผ่านเครือข่ายคลองและท่อระบายน้ำนี้ ขยะที่ตกค้างอาจเป็นปัจจัยหนึ่งที่ทำให้การระบายน้ำช้าลง${gauges.length ? ` แผนที่แสดงสถานีวัดระดับน้ำ ${gauges.length} สถานีด้วย (ค่า ณ เวลาที่ดึงข้อมูล ไม่ใช่ข้อมูลสด)` : ""}`,
      en: `Rain has to drain through this network of canals and drains; uncollected waste is one possible contributing factor that slows it.${gauges.length ? ` The map also shows ${gauges.length} water-level gauge${gauges.length > 1 ? "s" : ""} (a snapshot at retrieval time, not live).` : ""}`,
    },
    note: {
      th: "ดัชนีความเปราะบางและความเสี่ยงขยะอุดตันเป็นค่าประมาณการตามวิธีใน DATA_METHODOLOGY.md",
      en: "Exposure and obstruction indices are estimates; see DATA_METHODOLOGY.md for the method.",
    },
    metrics: waterMetrics,
    view: baseView({ choropleth: null, overlays: gauges.length ? ["waterways", "waterLevel"] : ["waterways"] }),
    status: ds.totals.floodExposure?.provenance.status ?? "estimated",
  });

  /* 5 — 3D neighbourhood of the most exposed area -------------------------- */
  const exposed = argmaxArea(areas, (a) => valueOf(a.metrics.floodExposure));
  if (exposed) {
    const name = nameOf(exposed.area);
    const metrics: StoryMetric[] = [
      { id: "areaExposure", label: { th: `ความเปราะบาง · ${name.th}`, en: `Exposure · ${name.en}` }, metric: exposed.area.metrics.floodExposure, decimals: 2 },
      { id: "areaPopulation", label: { th: "ประชากรในพื้นที่", en: "Residents" }, metric: exposed.area.metrics.population, decimals: 0 },
    ];
    steps.push({
      id: "neighbourhood3d",
      kind: "neighbourhood3d",
      title: { th: `ย่านที่เปราะบางที่สุด: ${name.th}`, en: `Most exposed: ${name.en}` },
      body: webgl
        ? {
            th: `มุมมอง 3 มิติแสดงอาคารจริงจาก OpenStreetMap รอบ${name.th} ซึ่งมีดัชนีความเปราะบางต่อน้ำท่วมสูงที่สุดของเมือง`,
            en: `The 3D view shows real OpenStreetMap buildings around ${name.en}, the area with the city's highest flood-exposure index.`,
          }
        : {
            th: `${name.th} มีดัชนีความเปราะบางต่อน้ำท่วมสูงที่สุดของเมือง (อุปกรณ์นี้ไม่รองรับ WebGL จึงแสดงบนแผนที่ 2 มิติแทน)`,
            en: `${name.en} has the city's highest flood-exposure index (WebGL is unavailable here, so it is shown on the 2D map instead).`,
          },
      metrics,
      view: webgl
        ? baseView({ areaId: exposed.area.id, viewMode: "3d", threeScope: "neighborhood", cameraPreset: "isometric", choropleth: "floodRisk" })
        : baseView({ areaId: exposed.area.id, choropleth: "floodRisk" }),
      status: exposed.area.metrics.floodExposure.provenance.status,
    });
  }

  /* 6 — Heavy Rain preset --------------------------------------------------- */
  const base = cityRiskSummary(areas, BASELINE_SCENARIO);
  const heavy = cityRiskSummary(areas, SCENARIO_PRESETS.heavyRain.params);
  const focusArea = exposed?.area ?? null;
  if (base.meanScore !== null && heavy.meanScore !== null) {
    const preset = SCENARIO_PRESETS.heavyRain;
    const metrics: StoryMetric[] = [
      { id: "riskBaseline", label: { th: "ความเสี่ยงเฉลี่ย · สภาวะปกติ", en: "Mean risk · normal" }, metric: simulated(base.meanScore, "score", `Population-weighted mean of area scores, Normal Conditions preset (model v${MODEL_VERSION}).`), decimals: 1 },
      { id: "riskHeavy", label: { th: "ความเสี่ยงเฉลี่ย · ฝนตกหนัก", en: "Mean risk · heavy rain" }, metric: simulated(heavy.meanScore, "score", `Population-weighted mean of area scores, Heavy Rain preset (model v${MODEL_VERSION}).`), decimals: 1 },
    ];
    if (focusArea) {
      const b = base.scores.get(focusArea.id) ?? null;
      const h = heavy.scores.get(focusArea.id) ?? null;
      if (b !== null && h !== null) {
        metrics.push({
          id: "areaDelta",
          label: { th: `เพิ่มขึ้นที่${focusArea.nameTh}`, en: `Change in ${focusArea.nameEn}` },
          metric: simulated(Math.round((h - b) * 10) / 10, "score", "Area score under Heavy Rain minus its Normal Conditions score."),
          decimals: 1,
        });
      }
    }
    steps.push({
      id: "heavyRain",
      kind: "heavyRain",
      title: { th: `สถานการณ์จำลอง: ${preset.th}`, en: `Scenario: ${preset.en}` },
      body: {
        th: `${preset.descTh} — ความเสี่ยงเฉลี่ยของเมืองตามแบบจำลองเปลี่ยนจาก ${n(base.meanScore, "th", 1)} เป็น ${n(heavy.meanScore, "th", 1)} คะแนน`,
        en: `${preset.descEn} — the modelled city-mean risk moves from ${n(base.meanScore, "en", 1)} to ${n(heavy.meanScore, "en", 1)} points.`,
      },
      note: { th: "การจำลอง — ไม่ใช่การพยากรณ์น้ำท่วมอย่างเป็นทางการ", en: "Simulation — not an official flood forecast." },
      metrics,
      view:
        webgl && focusArea
          ? baseView({ areaId: focusArea.id, viewMode: "split", threeScope: "neighborhood", cameraPreset: "isometric", choropleth: "floodRisk", scenario: "heavyRain" })
          : baseView({ areaId: focusArea?.id ?? null, choropleth: "floodRisk", scenario: "heavyRain" }),
      status: "simulated",
    });
  }

  /* 7 — Combined Stress preset ---------------------------------------------- */
  const combined = cityRiskSummary(areas, SCENARIO_PRESETS.combinedStress.params);
  if (combined.meanScore !== null) {
    const preset = SCENARIO_PRESETS.combinedStress;
    const metrics: StoryMetric[] = [
      { id: "riskCombined", label: { th: "ความเสี่ยงเฉลี่ยของเมือง", en: "City-mean risk" }, metric: simulated(combined.meanScore, "score", `Population-weighted mean of area scores, Combined Stress preset (model v${MODEL_VERSION}).`), decimals: 1 },
    ];
    if (combined.exposedPct !== null) {
      metrics.push({
        id: "exposedPct",
        label: { th: "ประชากรในพื้นที่ความเสี่ยงสูงขึ้นไป", en: "Residents in High+ risk areas" },
        metric: simulated(combined.exposedPct, "%", "Share of registered population living in areas scoring ≥ 50 under Combined Stress."),
        decimals: 1,
      });
    }
    steps.push({
      id: "combinedStress",
      kind: "combinedStress",
      title: { th: `สถานการณ์จำลอง: ${preset.th}`, en: `Scenario: ${preset.en}` },
      body: {
        th: `${preset.descTh} — ${combined.highCount} จาก ${areas.length} ${kind.th}อยู่ในระดับความเสี่ยงสูงขึ้นไปตามแบบจำลอง`,
        en: `${preset.descEn} — ${combined.highCount} of ${areas.length} ${kind.en}s reach High risk or above in the model.`,
      },
      note: {
        th: "ขยะเป็นเพียงปัจจัยหนึ่งที่อาจมีส่วน ไม่ใช่สาเหตุที่พิสูจน์แล้ว น้ำหนักและเกณฑ์เป็นสมมติฐานเพื่อการสาธิต",
        en: "Waste is treated as a possible contributing factor, not a proven cause; weights and thresholds are demo assumptions.",
      },
      metrics,
      view: baseView({ choropleth: "floodRisk", scenario: "combinedStress" }),
      status: "simulated",
    });
  }

  /* 8 — documented flood event inside the rainfall record ------------------- */
  const events = (input.floodEvents ?? []).filter((e) => e.cityId === city.id);
  const { inRange, outOfRange, mean } = partitionFloodEvents(events, input.rainAreas);
  const latest = inRange.slice().sort((a, b) => (a.event.from < b.event.from ? 1 : a.event.from > b.event.from ? -1 : 0))[0];
  if (latest && input.rainAreas) {
    const day = input.rainAreas.dates[latest.peak] ?? null;
    const dayMean = mean[latest.peak] ?? null;
    const ev = latest.event;
    const metrics: StoryMetric[] = [];
    if (ev.peakRainMm) metrics.push({ id: "eventPeak", label: { th: "ฝนสูงสุดรายวัน (สถานีวัด)", en: "Peak daily rain (gauge)" }, metric: ev.peakRainMm, decimals: 1 });
    const rp = input.rainAreas.provenance;
    metrics.push({
      id: "dayMean",
      label: { th: "ฝนเฉลี่ยทั้งเมืองในวันนั้น", en: "City-mean rain that day" },
      metric: {
        value: dayMean,
        unit: "mm",
        provenance: {
          ...rp,
          status: dayMean === null ? "unavailable" : rp.status,
          observedFrom: day ?? undefined,
          observedTo: day ?? undefined,
          methodology: `Mean of the ${ds.areas.length} area series of ${rp.sourceName ?? "the daily reanalysis"} on the event's wettest day.`,
        },
      },
      decimals: 1,
    });
    const hourly = hourlyEventsOn(input.rainHourly, day);
    steps.push({
      id: "floodEvent",
      kind: "floodEvent",
      title: { th: ev.titleTh, en: ev.titleEn },
      body: {
        th: `${ev.summaryTh}${day ? ` — ไทม์ไลน์เลื่อนไปที่ ${formatDate(day, "th")} ซึ่งเป็นวันที่ฝนเฉลี่ยสูงสุดของเหตุการณ์` : ""}`,
        en: `${ev.summaryEn}${day ? ` — the timeline jumps to ${formatDate(day, "en")}, the event's wettest day.` : ""}`,
      },
      note: hourly.length
        ? {
            th: "ฝนจากแบบจำลองย้อนหลังเฉลี่ยทั้งพื้นที่จึงต่ำกว่าค่าสูงสุดของสถานีวัด แท็บ “ฝน” แสดงฝนรายชั่วโมงของเหตุการณ์นี้",
            en: "Area-averaged reanalysis smooths local extremes, so it reads lower than the gauge peak. The Rainfall tab shows this event hour by hour.",
          }
        : {
            th: "ฝนจากแบบจำลองย้อนหลังเฉลี่ยทั้งพื้นที่จึงต่ำกว่าค่าสูงสุดของสถานีวัด",
            en: "Area-averaged reanalysis smooths local extremes, so it reads lower than the gauge peak.",
          },
      metrics,
      view: baseView({ choropleth: "rainEstimated", dateIndex: latest.peak, dockTab: hourly.length ? "rainfall" : null }),
      status: ev.peakRainMm?.provenance.status ?? rp.status,
    });
  }

  /* 9 — reset & where to explore next --------------------------------------- */
  const outside = outOfRange;
  steps.push({
    id: "explore",
    kind: "explore",
    title: { th: "สำรวจต่อด้วยตัวเอง", en: "Where to explore next" },
    body: {
      th: "แดชบอร์ดกลับสู่สถานการณ์ฐานแล้ว ลองสร้างพายุเองในห้องทดลองสถานการณ์ เปรียบเทียบสองพื้นที่ หรือเปิดข้อค้นพบสำคัญและแหล่งข้อมูลเพื่อดูวิธีคำนวณทุกตัวเลข",
      en: "The dashboard is back on the baseline. Build your own storm in the Scenario Lab, compare two areas, or open Insights and Data sources to see how every number is computed.",
    },
    note: outside.length
      ? {
          th: `เหตุการณ์ที่อยู่นอกช่วงข้อมูลฝนรายวัน (${outside.map((e) => e.titleTh).join(", ")}) แสดงในรายการเหตุการณ์และคำอธิบายของไทม์ไลน์`,
          en: `Events outside the daily rainfall record (${outside.map((e) => e.titleEn).join(", ")}) are listed in the flood-event list and the timeline legend.`,
        }
      : undefined,
    metrics: [],
    view: baseView({ choropleth: "wasteVolume" }),
    status: "observed",
  });

  /* Keep the tour 6–8 steps: drop the least essential optional steps first. */
  const dropOrder: StoryStepKind[] = ["topPerCapita", "heavyRain", "waterways"];
  for (const k of dropOrder) {
    if (steps.length <= STORY_MAX_STEPS) break;
    const i = steps.findIndex((s) => s.kind === k);
    if (i >= 0) steps.splice(i, 1);
  }
  return steps;
}
