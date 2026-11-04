/**
 * Choropleth classification computed in JS (not in style expressions) so the map, legend and
 * tooltip share exactly one set of values, classes and colours.
 *
 *  - Sequential metrics: 5 quantile classes (metrics.quantileBreaks) sampled from the metric ramp.
 *  - Modelled flood risk: the model's fixed classes (RISK_CLASSES) with the risk palette.
 *  - Rainfall 24 h: TMD 24-hour intensity classes, so days stay comparable while scrubbing the
 *    timeline (a per-day quantile would make a dry day look as alarming as a storm).
 *
 * Scenario-aware metrics come from useScenario() via metrics.areaMetric (status "simulated");
 * observed records are never mutated.
 */
import type { AreaRecord, CityDataset, DataStatus, MetricValue } from "@/lib/types";
import type { Bi } from "@/lib/i18n";
import type { LayerId } from "@/store/dashboard-store";
import { METRICS, areaMetric, layerMetric, quantileBreaks, rampColor, type MetricDef, type MetricId } from "@/lib/metrics";
import { RISK_CLASSES, rainClass24h, riskClass, type RainClass } from "@/lib/simulation/model";
import type { ScenarioState } from "@/lib/simulation/use-scenario";
import { RISK_COLORS } from "@/lib/data/status";

export type ClassScheme = "quantile" | "risk" | "rain";

export interface LegendClass {
  color: string;
  /** Inclusive lower bound (null = open). */
  from: number | null;
  /** Upper bound (null = open). */
  to: number | null;
  label?: Bi;
  count: number;
}

export interface ChoroplethModel {
  layer: LayerId;
  metricId: MetricId;
  def: MetricDef;
  scheme: ClassScheme;
  /** Displayed value per area id (live MetricValue when scenario-dependent). */
  values: Map<string, MetricValue>;
  /** Fill colour per feature id (fid); null = no data (hatched). */
  colorByFid: Map<number, string | null>;
  classes: LegendClass[];
  /** Distinct statuses among displayed (non-null) values. */
  statuses: DataStatus[];
  nullCount: number;
  total: number;
  /** True when values come from the live scenario / timeline model rather than the static dataset. */
  live: boolean;
  /** Why values are live: the scenario model (simulated) or a historical timeline date (dataset values for that day). */
  liveKind: "scenario" | "timeline" | null;
  /** Historical date applied (rainfall / risk replay) or null. */
  date: string | null;
}

/** TMD 24-hour rainfall classes (mm). */
export const RAIN_CLASSES: { id: RainClass; from: number; to: number | null; color: string; label: Bi }[] = [
  { id: "none", from: 0, to: 0.1, color: "#16314b", label: { th: "ไม่มีฝน", en: "No rain" } },
  { id: "light", from: 0.1, to: 10, color: "#1767a1", label: { th: "ฝนเล็กน้อย", en: "Light" } },
  { id: "moderate", from: 10, to: 35, color: "#1f95d0", label: { th: "ฝนปานกลาง", en: "Moderate" } },
  { id: "heavy", from: 35, to: 90, color: "#25d9f2", label: { th: "ฝนหนัก", en: "Heavy" } },
  { id: "veryHeavy", from: 90, to: null, color: "#c9f6ff", label: { th: "ฝนหนักมาก", en: "Very heavy" } },
];

/** Modelled drainage-stress classes (0–100 %), shared by the drainage-asset halos and legend. */
export const STRESS_CLASSES: { from: number; to: number; color: string }[] = [
  { from: 0, to: 20, color: "#2f6f7a" },
  { from: 20, to: 40, color: "#7f9a5a" },
  { from: 40, to: 60, color: "#f5d65a" },
  { from: 60, to: 80, color: "#f6a34b" },
  { from: 80, to: 100, color: "#f05b63" },
];
export function stressClass(pct: number | null): number {
  if (pct === null || !Number.isFinite(pct)) return -1;
  return Math.max(0, Math.min(4, Math.floor(pct / 20)));
}

const valueOf = (m: MetricValue | undefined) =>
  m && m.value !== null && Number.isFinite(m.value) && m.provenance?.status !== "unavailable" ? m.value : null;

/** Value for one area under the current scenario/timeline state. */
export function displayMetric(area: AreaRecord, metricId: MetricId, scenario: ScenarioState): { metric: MetricValue; live: boolean } {
  const base = area.metrics[metricId];
  const sc = scenario.ready ? scenario.byId.get(area.id) : undefined;
  const dynamic = scenario.source !== "baseline";
  if (metricId === "modeledFloodRisk" || metricId === "drainageStress") {
    if (sc && (dynamic || valueOf(base) === null)) return { metric: areaMetric(area, metricId, { result: sc.current }), live: true };
    return { metric: base, live: false };
  }
  if (metricId === "rainfall24h" && sc && scenario.source === "historical") {
    return { metric: areaMetric(area, metricId, { result: sc.current, rain24h: sc.rain24h, rainDate: scenario.date }), live: true };
  }
  return { metric: base, live: false };
}

function quantileClasses(values: number[], ramp: string[]) {
  const raw = quantileBreaks(values, 5);
  const breaks = raw.filter((b, i) => i === 0 || b > raw[i - 1] + 1e-9);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const usable = breaks.filter((b) => b > min && b < max);
  const n = usable.length + 1;
  const colors = Array.from({ length: n }, (_, i) => rampColor(ramp, n === 1 ? 0.65 : 0.12 + (0.88 * i) / (n - 1)));
  const classOf = (v: number) => {
    let i = 0;
    while (i < usable.length && v > usable[i]) i++;
    return i;
  };
  const classes: LegendClass[] = colors.map((color, i) => ({
    color,
    from: i === 0 ? min : usable[i - 1],
    to: i === n - 1 ? max : usable[i],
    count: 0,
  }));
  return { classes, classOf };
}

export function computeChoropleth(layer: LayerId | null, dataset: CityDataset | undefined, scenario: ScenarioState): ChoroplethModel | null {
  if (!layer || !dataset) return null;
  const metricId = layerMetric(layer, dataset);
  if (!metricId) return null;
  const def = METRICS[metricId];
  const values = new Map<string, MetricValue>();
  const colorByFid = new Map<number, string | null>();
  const statuses = new Set<DataStatus>();
  let live = false;

  const rows: { area: AreaRecord; v: number | null }[] = dataset.areas.map((area) => {
    const r = displayMetric(area, metricId, scenario);
    values.set(area.id, r.metric);
    live = live || r.live;
    const v = valueOf(r.metric);
    if (v !== null) statuses.add(r.metric.provenance.status);
    return { area, v };
  });
  const present = rows.map((r) => r.v).filter((v): v is number => v !== null);

  let scheme: ClassScheme;
  let classes: LegendClass[];
  let classOf: (v: number) => number;

  if (metricId === "modeledFloodRisk") {
    scheme = "risk";
    classes = RISK_CLASSES.map((c) => ({ color: RISK_COLORS[c.id], from: c.min, to: c.max, label: { th: c.th, en: c.en }, count: 0 }));
    classOf = (v) => RISK_CLASSES.findIndex((c) => c.id === riskClass(v));
  } else if (metricId === "rainfall24h") {
    scheme = "rain";
    classes = RAIN_CLASSES.map((c) => ({ color: c.color, from: c.from, to: c.to, label: c.label, count: 0 }));
    classOf = (v) => RAIN_CLASSES.findIndex((c) => c.id === rainClass24h(v));
  } else {
    scheme = "quantile";
    if (present.length) {
      const q = quantileClasses(present, def.ramp);
      classes = q.classes;
      classOf = q.classOf;
    } else {
      classes = [];
      classOf = () => -1;
    }
  }

  let nullCount = 0;
  for (const { area, v } of rows) {
    if (v === null) {
      nullCount++;
      colorByFid.set(area.fid, null);
      continue;
    }
    const i = classOf(v);
    const c = classes[i];
    if (c) c.count++;
    colorByFid.set(area.fid, c ? c.color : null);
  }

  return {
    layer,
    metricId,
    def,
    scheme,
    values,
    colorByFid,
    classes,
    statuses: [...statuses],
    nullCount,
    total: rows.length,
    live,
    liveKind: !live ? null : statuses.has("simulated") ? "scenario" : "timeline",
    date: scenario.source === "historical" ? scenario.date : null,
  };
}
