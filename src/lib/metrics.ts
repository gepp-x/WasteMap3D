import type { AreaMetrics, AreaRecord, CityDataset, MetricValue } from "@/lib/types";
import type { Bi } from "@/lib/i18n";
import type { LayerId } from "@/store/dashboard-store";
import type { RiskResult } from "@/lib/simulation/model";

export type MetricId = keyof AreaMetrics;

export interface MetricDef {
  id: MetricId;
  label: Bi;
  short: Bi;
  unit: string;
  decimals: number;
  /** Sequential colour ramp, low → high (dark basemap friendly). */
  ramp: string[];
  higherIsWorse: boolean;
}

const RAMP_WASTE = ["#13304a", "#0f5a68", "#0f8a86", "#2fbf9a", "#9fe08a", "#f5d65a"];
const RAMP_PERCAP = ["#16293f", "#26476b", "#2f7aa0", "#25b5c9", "#7fe3e4", "#e9fbff"];
const RAMP_POP = ["#1a2440", "#2e3a73", "#4f4fa6", "#7b63cc", "#ad86ea", "#e0c9ff"];
const RAMP_RAIN = ["#0d2238", "#123e66", "#1767a1", "#1f95d0", "#25d9f2", "#bff4ff"];
const RAMP_STRESS = ["#13324a", "#2f5b5a", "#8f8a4a", "#f5d65a", "#f6a34b", "#f05b63"];
export const RAMP_RISK = ["#46d98b", "#f5d65a", "#f6a34b", "#f05b63"];

export const METRICS: Record<MetricId, MetricDef> = {
  population: { id: "population", label: { th: "ประชากร", en: "Population" }, short: { th: "ประชากร", en: "Population" }, unit: "persons", decimals: 0, ramp: RAMP_POP, higherIsWorse: false },
  areaKm2: { id: "areaKm2", label: { th: "พื้นที่", en: "Area" }, short: { th: "พื้นที่", en: "Area" }, unit: "km2", decimals: 1, ramp: RAMP_POP, higherIsWorse: false },
  populationDensity: { id: "populationDensity", label: { th: "ความหนาแน่นประชากร", en: "Population density" }, short: { th: "ความหนาแน่น", en: "Density" }, unit: "persons/km2", decimals: 0, ramp: RAMP_POP, higherIsWorse: false },
  wasteGenerated: { id: "wasteGenerated", label: { th: "ปริมาณขยะที่เกิดขึ้น", en: "Waste generated" }, short: { th: "ขยะเกิดขึ้น", en: "Generated" }, unit: "t/day", decimals: 1, ramp: RAMP_WASTE, higherIsWorse: true },
  wasteCollected: { id: "wasteCollected", label: { th: "ปริมาณขยะที่จัดเก็บได้", en: "Waste collected" }, short: { th: "ขยะจัดเก็บ", en: "Collected" }, unit: "t/day", decimals: 1, ramp: RAMP_WASTE, higherIsWorse: true },
  wasteAccumulated: { id: "wasteAccumulated", label: { th: "ขยะตกค้างสะสม (จำลอง)", en: "Modeled waste accumulation" }, short: { th: "ขยะตกค้าง", en: "Accumulated" }, unit: "t", decimals: 1, ramp: RAMP_STRESS, higherIsWorse: true },
  wastePerCapita: { id: "wastePerCapita", label: { th: "ขยะที่จัดเก็บได้ต่อคนต่อวัน", en: "Collected waste per capita" }, short: { th: "ต่อคน", en: "Per capita" }, unit: "kg/person/day", decimals: 2, ramp: RAMP_PERCAP, higherIsWorse: true },
  wasteDensity: { id: "wasteDensity", label: { th: "ความหนาแน่นขยะที่จัดเก็บได้", en: "Collected waste density" }, short: { th: "ขยะ/พื้นที่", en: "Waste density" }, unit: "t/day/km2", decimals: 2, ramp: RAMP_WASTE, higherIsWorse: true },
  rainfallAnnual: { id: "rainfallAnnual", label: { th: "ปริมาณฝนรายปี", en: "Annual rainfall" }, short: { th: "ฝนรายปี", en: "Annual rain" }, unit: "mm/year", decimals: 0, ramp: RAMP_RAIN, higherIsWorse: true },
  rainfall24h: { id: "rainfall24h", label: { th: "ปริมาณฝน 24 ชม.", en: "Rainfall (24 h)" }, short: { th: "ฝน 24 ชม.", en: "Rain 24h" }, unit: "mm", decimals: 1, ramp: RAMP_RAIN, higherIsWorse: true },
  drainageStress: { id: "drainageStress", label: { th: "แรงกดดันระบบระบายน้ำ (แบบจำลอง)", en: "Modeled drainage stress" }, short: { th: "แรงกดดันระบายน้ำ", en: "Drainage stress" }, unit: "%", decimals: 0, ramp: RAMP_STRESS, higherIsWorse: true },
  floodExposure: { id: "floodExposure", label: { th: "ความเปราะบางเชิงพื้นที่ต่อน้ำท่วม", en: "Geographic flood exposure" }, short: { th: "ความเปราะบาง", en: "Exposure" }, unit: "index", decimals: 2, ramp: RAMP_STRESS, higherIsWorse: true },
  obstructionSusceptibility: { id: "obstructionSusceptibility", label: { th: "ความเสี่ยงขยะอุดตันทางระบายน้ำ", en: "Waste obstruction susceptibility" }, short: { th: "ขยะอุดตัน", en: "Obstruction" }, unit: "index", decimals: 2, ramp: RAMP_STRESS, higherIsWorse: true },
  modeledFloodRisk: { id: "modeledFloodRisk", label: { th: "ความเสี่ยงน้ำท่วม (แบบจำลอง)", en: "Modeled flood risk" }, short: { th: "ความเสี่ยง", en: "Risk" }, unit: "score", decimals: 0, ramp: RAMP_RISK, higherIsWorse: true },
};

/** Which waste measure the dataset actually observes (never mix definitions on one map). */
export function primaryWasteMetric(ds: CityDataset | undefined): "wasteCollected" | "wasteGenerated" {
  if (!ds) return "wasteCollected";
  const n = (k: "wasteCollected" | "wasteGenerated") => ds.areas.filter((a) => a.metrics[k]?.value !== null && a.metrics[k]?.value !== undefined).length;
  return n("wasteCollected") >= n("wasteGenerated") ? "wasteCollected" : "wasteGenerated";
}

/** Map layer → metric shown by its choropleth. */
export function layerMetric(layer: LayerId, ds: CityDataset | undefined): MetricId | null {
  switch (layer) {
    case "wasteVolume":
      return primaryWasteMetric(ds);
    case "wastePerCapita":
      return "wastePerCapita";
    case "floodRisk":
      return "modeledFloodRisk";
    case "populationDensity":
      return "populationDensity";
    case "rainEstimated":
      return "rainfall24h";
    default:
      return null;
  }
}

/**
 * Value of a metric for an area, with scenario-dependent metrics taken from the live model result
 * (status "simulated"). Observed data is never overwritten — scenario values are new MetricValues.
 */
export function areaMetric(area: AreaRecord, id: MetricId, live?: { result: RiskResult; rain24h?: number | null; rainDate?: string | null }): MetricValue {
  const base = area.metrics[id];
  if (live) {
    if (id === "modeledFloodRisk") {
      return { value: live.result.score, unit: "score", provenance: { ...base.provenance, status: live.result.score === null ? "unavailable" : "simulated" } };
    }
    if (id === "drainageStress") {
      return { value: live.result.drainageStressPct, unit: "%", provenance: { ...base.provenance, status: "simulated" } };
    }
    if (id === "rainfall24h" && live.rain24h !== undefined) {
      return {
        value: live.rain24h,
        unit: "mm",
        provenance: { ...base.provenance, status: live.rain24h === null ? "unavailable" : base.provenance.status, observedFrom: live.rainDate ?? base.provenance.observedFrom, observedTo: live.rainDate ?? base.provenance.observedTo },
      };
    }
  }
  return base;
}

/** Quantile breaks (n classes) over non-null values; deterministic. */
export function quantileBreaks(values: (number | null)[], n: number): number[] {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return [];
  const out: number[] = [];
  for (let i = 1; i < n; i++) {
    const q = (i / n) * (v.length - 1);
    const lo = Math.floor(q);
    const hi = Math.ceil(q);
    out.push(v[lo] + (v[hi] - v[lo]) * (q - lo));
  }
  return out;
}

/** Linear colour interpolation in a ramp for t ∈ [0,1]. */
export function rampColor(ramp: string[], t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  if (i >= ramp.length - 1) return ramp[ramp.length - 1];
  const a = hex(ramp[i]);
  const b = hex(ramp[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
function hex(h: string) {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
