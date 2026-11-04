import type { DataStatus, MetricValue } from "@/lib/types";
import type { LayerId } from "@/store/dashboard-store";
import type { ScenarioState } from "@/lib/simulation/use-scenario";
import { METRICS, areaMetric, layerMetric, primaryWasteMetric, quantileBreaks, type MetricDef, type MetricId } from "@/lib/metrics";
import { RISK_CLASSES, riskClass, type RiskClass } from "@/lib/simulation/model";
import { RISK_COLORS } from "@/lib/data/status";

/**
 * Per-area visual encoding for the 3D city overview — the same metric, breaks and colours as the
 * 2D choropleth, computed from live `useScenario()` results (scenario values are new simulated
 * MetricValues; observed data is never touched).
 *
 * height  ∝ value / max (linear from zero — proportional, honest bars); risk uses score / 100
 * colour  quantile classes over the metric's ramp (risk → fixed class colours)
 * null    flat slab + neutral colour, rendered as "Unavailable" in every readout — never 0
 */

export const UNAVAILABLE_COLOR = "#33465a";

export interface AreaVisual {
  id: string;
  metric: MetricValue;
  /** Normalised 0–1 height, or null when the value is unavailable. */
  t: number | null;
  color: string;
  /** Current modelled risk (always available for tooltips / flood / risk outlines). */
  riskScore: number | null;
  riskClass: RiskClass | null;
  baselineRiskClass: RiskClass | null;
}

export interface LegendStop {
  color: string;
  label?: { th: string; en: string };
  /** Lower bound of the class (quantile ramps). */
  from?: number | null;
}

export interface AreaVisualSet {
  metricId: MetricId;
  def: MetricDef;
  layer: LayerId | null;
  isRisk: boolean;
  byId: Map<string, AreaVisual>;
  min: number | null;
  max: number | null;
  breaks: number[];
  legend: LegendStop[];
  hasNull: boolean;
  /** Dominant provenance of the plotted values (simulated wins so it is always labelled). */
  status: DataStatus;
  /** Signature that changes whenever any target changes (cheap memo key for consumers). */
  signature: string;
}

const STATUS_PRIORITY: DataStatus[] = ["simulated", "estimated", "derived", "observed"];

export function computeAreaVisuals(s: ScenarioState, layer: LayerId | null): AreaVisualSet | null {
  const ds = s.dataset;
  if (!s.ready || !ds) return null;
  const metricId: MetricId = (layer ? layerMetric(layer, ds) : null) ?? primaryWasteMetric(ds);
  const def = METRICS[metricId];
  const isRisk = metricId === "modeledFloodRisk";

  const metrics = s.list.map((a) => ({
    a,
    m: areaMetric(a.area, metricId, {
      result: a.current,
      rain24h: s.source === "historical" ? a.rain24h : undefined,
      rainDate: s.date,
    }),
  }));
  const valueOf = (m: MetricValue) => (m && m.provenance.status !== "unavailable" && m.value !== null && Number.isFinite(m.value) ? m.value : null);
  const values = metrics.map(({ m }) => valueOf(m));
  const nonNull = values.filter((v): v is number => v !== null);
  const min = nonNull.length ? Math.min(...nonNull) : null;
  const max = nonNull.length ? Math.max(...nonNull) : null;
  const ramp = def.ramp;
  const breaks = isRisk ? [25, 50, 75] : quantileBreaks(values, ramp.length);

  const statusCount = new Map<DataStatus, number>();
  const byId = new Map<string, AreaVisual>();
  let hasNull = false;
  const sig: string[] = [metricId];
  metrics.forEach(({ a, m }, i) => {
    const v = values[i];
    let t: number | null = null;
    let color = UNAVAILABLE_COLOR;
    if (v === null) hasNull = true;
    else {
      statusCount.set(m.provenance.status, (statusCount.get(m.provenance.status) ?? 0) + 1);
      if (isRisk) {
        t = Math.min(1, Math.max(0, v / 100));
        const c = riskClass(v);
        color = c ? RISK_COLORS[c] : UNAVAILABLE_COLOR;
      } else {
        t = max && max > 0 ? Math.min(1, Math.max(0, v / max)) : 0;
        let idx = 0;
        for (const b of breaks) if (v >= b) idx++;
        color = ramp[Math.min(idx, ramp.length - 1)];
      }
    }
    const score = a.current.score;
    byId.set(a.area.id, {
      id: a.area.id,
      metric: m,
      t,
      color,
      riskScore: score,
      riskClass: riskClass(score),
      baselineRiskClass: riskClass(a.baseline.score),
    });
    sig.push(`${a.area.id}:${t === null ? "n" : t.toFixed(4)}:${color}:${score ?? "n"}`);
  });

  let status: DataStatus = "unavailable";
  for (const st of STATUS_PRIORITY) {
    if (statusCount.get(st)) {
      status = st;
      break;
    }
  }

  const legend: LegendStop[] = isRisk
    ? RISK_CLASSES.map((c) => ({ color: RISK_COLORS[c.id], label: { th: c.th, en: c.en }, from: c.min }))
    : ramp.map((color, i) => ({ color, from: i === 0 ? min : (breaks[i - 1] ?? null) }));

  return { metricId, def, layer, isRisk, byId, min, max, breaks, legend, hasNull, status, signature: sig.join("|") };
}
