/**
 * Explainable, deterministic flood-risk scenario model.
 *
 *   Risk = 100 × (0.45·R + 0.25·D + 0.20·E + 0.10·W)   (weights renormalised over available factors)
 *
 * R  rainfall factor            = clamp(P / P_REF)                    P = depth of the scenario storm (mm)
 * D  drainage stress (0–1)      = clamp(L / L_SAT)                    L = load intensity / effective capacity
 * E  geographic/hist. exposure  = per-area index from the dataset (0–1)
 * W  waste-related obstruction  = per-area susceptibility scaled by scenario obstruction + collection efficiency
 *
 * ILLUSTRATIVE ONLY. Weights, thresholds and the capacity assumption are demo
 * assumptions — not validated hydraulic coefficients and not an official forecast.
 * Pure functions only: no I/O, no randomness, safe to import from scripts and UI.
 */

export const MODEL_VERSION = "1.0.0";

export const WEIGHTS = { R: 0.45, D: 0.25, E: 0.2, W: 0.1 } as const;
export type FactorKey = keyof typeof WEIGHTS;

/** Storm depth (mm) at which the rainfall factor saturates. TMD "very heavy" begins at 90.1 mm/24 h; 150 mm leaves headroom. */
export const P_REF_MM = 150;
/** Load ratio at which modelled drainage stress reaches 100 %. L = 1 (exactly at assumed capacity) ⇒ 66.7 %. */
export const L_SAT = 1.5;
/** Minimum share of model weight that must be backed by data before a score is produced. */
export const MIN_COMPLETENESS = 0.55;

export type RiskClass = "low" | "moderate" | "high" | "veryHigh";

export const RISK_CLASSES: { id: RiskClass; min: number; max: number; th: string; en: string }[] = [
  { id: "low", min: 0, max: 24, th: "ต่ำ", en: "Low" },
  { id: "moderate", min: 25, max: 49, th: "ปานกลาง", en: "Moderate" },
  { id: "high", min: 50, max: 74, th: "สูง", en: "High" },
  { id: "veryHigh", min: 75, max: 100, th: "สูงมาก", en: "Very High" },
];

export function riskClass(score: number | null): RiskClass | null {
  if (score === null || !Number.isFinite(score)) return null;
  if (score < 25) return "low";
  if (score < 50) return "moderate";
  if (score < 75) return "high";
  return "veryHigh";
}

/** TMD 24-hour rainfall intensity classes (mm). */
export type RainClass = "none" | "light" | "moderate" | "heavy" | "veryHeavy";
export function rainClass24h(mm: number | null): RainClass | null {
  if (mm === null || !Number.isFinite(mm)) return null;
  if (mm < 0.1) return "none";
  if (mm <= 10) return "light";
  if (mm <= 35) return "moderate";
  if (mm <= 90) return "heavy";
  return "veryHeavy";
}

export interface ScenarioParams {
  /** Mean rainfall intensity of the hypothetical storm (mm/h). */
  rainIntensityMmH: number;
  /** Storm duration (h). */
  rainDurationH: number;
  /** Hypothetical loss of drainage capacity (0–0.6). */
  drainageCapacityReduction: number;
  /** Hypothetical share of drain inlets partially obstructed by solid waste (0–1). */
  obstruction: number;
  /** Upstream / external runoff intensity (0–1). */
  upstreamRunoff: number;
  /** Waste collection efficiency (0.5–1). */
  collectionEfficiency: number;
}

export type PresetId = "normal" | "heavyRain" | "extremeRain" | "drainageObstruction" | "combinedStress";

export const SCENARIO_PRESETS: Record<PresetId, { th: string; en: string; descTh: string; descEn: string; params: ScenarioParams }> = {
  normal: {
    th: "สภาวะปกติ",
    en: "Normal Conditions",
    descTh: "ฝนปานกลาง 10 มม./ชม. นาน 2 ชม. ระบบระบายน้ำเต็มประสิทธิภาพ",
    descEn: "Moderate rain, 10 mm/h for 2 h, full drainage capacity",
    params: { rainIntensityMmH: 10, rainDurationH: 2, drainageCapacityReduction: 0, obstruction: 0.3, upstreamRunoff: 0.2, collectionEfficiency: 0.95 },
  },
  heavyRain: {
    th: "ฝนตกหนัก",
    en: "Heavy Rain",
    descTh: "ฝน 30 มม./ชม. นาน 2 ชม. (60 มม. — ระดับฝนหนักตามเกณฑ์ กรมอุตุนิยมวิทยา)",
    descEn: "30 mm/h for 2 h (60 mm — TMD 'heavy' class)",
    params: { rainIntensityMmH: 30, rainDurationH: 2, drainageCapacityReduction: 0, obstruction: 0.3, upstreamRunoff: 0.3, collectionEfficiency: 0.95 },
  },
  extremeRain: {
    th: "ฝนตกหนักมาก",
    en: "Extreme Rain",
    descTh: "ฝน 60 มม./ชม. นาน 3 ชม. (180 มม. — ระดับฝนหนักมาก)",
    descEn: "60 mm/h for 3 h (180 mm — TMD 'very heavy' class)",
    params: { rainIntensityMmH: 60, rainDurationH: 3, drainageCapacityReduction: 0, obstruction: 0.3, upstreamRunoff: 0.5, collectionEfficiency: 0.95 },
  },
  drainageObstruction: {
    th: "ท่อระบายน้ำอุดตัน",
    en: "Drainage Obstruction",
    descTh: "ฝนหนัก 30 มม./ชม. + ความสามารถระบายน้ำลดลง 25% + ขยะอุดตันสูง",
    descEn: "Heavy rain 30 mm/h + 25% capacity loss + high waste obstruction",
    params: { rainIntensityMmH: 30, rainDurationH: 2, drainageCapacityReduction: 0.25, obstruction: 0.8, upstreamRunoff: 0.3, collectionEfficiency: 0.8 },
  },
  combinedStress: {
    th: "แรงกดดันรวม",
    en: "Combined Stress",
    descTh: "ฝนหนักมาก + น้ำหลากจากต้นน้ำ + ระบายน้ำลดลง 30% + ขยะอุดตัน + เก็บขยะได้น้อยลง",
    descEn: "Extreme rain + upstream runoff + 30% capacity loss + obstruction + reduced collection",
    params: { rainIntensityMmH: 60, rainDurationH: 3, drainageCapacityReduction: 0.3, obstruction: 0.85, upstreamRunoff: 0.75, collectionEfficiency: 0.75 },
  },
};

export const BASELINE_SCENARIO: ScenarioParams = SCENARIO_PRESETS.normal.params;

export const PARAM_BOUNDS: Record<keyof ScenarioParams, { min: number; max: number; step: number }> = {
  rainIntensityMmH: { min: 0, max: 120, step: 1 },
  rainDurationH: { min: 0.5, max: 12, step: 0.5 },
  drainageCapacityReduction: { min: 0, max: 0.6, step: 0.01 },
  obstruction: { min: 0, max: 1, step: 0.01 },
  upstreamRunoff: { min: 0, max: 1, step: 0.01 },
  collectionEfficiency: { min: 0.5, max: 1, step: 0.01 },
};

/** Per-area model inputs. Null means "no defensible value" and is handled explicitly. */
export interface AreaRiskInputs {
  floodExposure: number | null; // E 0–1
  obstructionSusceptibility: number | null; // W_area 0–1
  /** Relative rainfall factor (area annual rainfall / city mean). 1 when unknown. */
  rainSpatialFactor?: number | null;
}

export interface ModelAssumptions {
  /** Assumed rainfall intensity the drainage network handles at full capacity (mm/h). */
  designIntensityMmH: number;
}

/** Default capacity assumption (illustrative; see docs/SIMULATION_MODEL.md for the cited basis). */
export const DEFAULT_ASSUMPTIONS: ModelAssumptions = { designIntensityMmH: 60 };

export interface FactorBreakdown {
  key: FactorKey;
  /** Normalised factor value 0–1, or null if missing. */
  value: number | null;
  weight: number;
  /** Effective (renormalised) weight actually applied. */
  appliedWeight: number;
  /** Points contributed to the 0–100 score. */
  points: number;
  missing: boolean;
}

export interface RiskResult {
  score: number | null;
  riskClass: RiskClass | null;
  factors: Record<FactorKey, FactorBreakdown>;
  /** Modelled drainage stress, 0–100 %. */
  drainageStressPct: number;
  /** Storm depth applied to this area (mm). */
  rainDepthMm: number;
  /** Load / effective capacity. */
  loadRatio: number;
  /** Effective waste-obstruction index after scenario adjustments (0–1) or null. */
  obstructionEffective: number | null;
  /** Share of model weight backed by data (0–1). */
  completeness: number;
  missing: FactorKey[];
}

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const round = (v: number, d = 1) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/** Duration factor: longer storms exhaust in-network storage. 3 h ⇒ 1.0, capped at 1.25. */
export function durationFactor(h: number) {
  return Math.min(1.25, 0.85 + 0.05 * Math.max(0, h));
}

/** W_eff = clamp(W_area × (0.4 + 1.2·obstruction) × (1 + 2·(1 − collectionEfficiency))). */
export function effectiveObstruction(wArea: number | null, p: ScenarioParams): number | null {
  if (wArea === null || !Number.isFinite(wArea)) return null;
  return clamp(wArea * (0.4 + 1.2 * p.obstruction) * (1 + 2 * (1 - p.collectionEfficiency)));
}

export interface StormDrivers {
  /** Instantaneous or mean intensity driving drainage load (mm/h). */
  intensityMmH: number;
  /** Cumulative depth driving the rainfall factor (mm). */
  depthMm: number;
  /** Elapsed storm duration (h), used for the storage factor. */
  durationH: number;
}

/** Drivers for the whole storm (mean intensity × full duration). */
export function stormDrivers(p: ScenarioParams): StormDrivers {
  return { intensityMmH: p.rainIntensityMmH, depthMm: p.rainIntensityMmH * p.rainDurationH, durationH: p.rainDurationH };
}

export function computeAreaRisk(
  inputs: AreaRiskInputs,
  p: ScenarioParams,
  assumptions: ModelAssumptions = DEFAULT_ASSUMPTIONS,
  drivers: StormDrivers = stormDrivers(p),
): RiskResult {
  const spatial = inputs.rainSpatialFactor && Number.isFinite(inputs.rainSpatialFactor) ? inputs.rainSpatialFactor : 1;
  const depth = drivers.depthMm * spatial;
  const R = clamp(depth / P_REF_MM);

  const wEff = effectiveObstruction(inputs.obstructionSusceptibility, p);
  // Waste obstruction removes up to 40 % of the remaining capacity; when W is unknown no reduction is applied.
  const effCapacity =
    assumptions.designIntensityMmH * (1 - clamp(p.drainageCapacityReduction, 0, 0.95)) * (1 - 0.4 * (wEff ?? 0));
  const load = drivers.intensityMmH * spatial * (1 + 0.6 * clamp(p.upstreamRunoff)) * durationFactor(drivers.durationH);
  const L = effCapacity > 0 ? load / effCapacity : Infinity;
  const D = clamp(L / L_SAT);

  const E = inputs.floodExposure !== null && Number.isFinite(inputs.floodExposure) ? clamp(inputs.floodExposure) : null;

  const raw: Record<FactorKey, number | null> = { R, D, E, W: wEff };
  const available = (Object.keys(WEIGHTS) as FactorKey[]).filter((k) => raw[k] !== null);
  const completeness = available.reduce((s, k) => s + WEIGHTS[k], 0);

  const factors = {} as Record<FactorKey, FactorBreakdown>;
  let total = 0;
  for (const k of Object.keys(WEIGHTS) as FactorKey[]) {
    const v = raw[k];
    const applied = v === null || completeness === 0 ? 0 : WEIGHTS[k] / completeness;
    const pts = v === null ? 0 : 100 * applied * v;
    total += pts;
    factors[k] = { key: k, value: v === null ? null : round(v, 3), weight: WEIGHTS[k], appliedWeight: round(applied, 4), points: round(pts, 2), missing: v === null };
  }

  const score = completeness + 1e-9 >= MIN_COMPLETENESS ? round(clamp(total, 0, 100), 1) : null;
  return {
    score,
    riskClass: riskClass(score),
    factors,
    drainageStressPct: round(D * 100, 1),
    rainDepthMm: round(depth, 1),
    loadRatio: round(L, 3),
    obstructionEffective: wEff === null ? null : round(wEff, 3),
    completeness: round(completeness, 3),
    missing: (Object.keys(WEIGHTS) as FactorKey[]).filter((k) => raw[k] === null),
  };
}

/**
 * Illustrative accumulation stock (t):
 *   Accumulation(t) = Accumulation(t−1) + Inflow(t) − Collected(t)
 *   Collected(t)    = efficiency × (Accumulation(t−1) + Inflow(t))
 * Inflow and Collected in t/day with a daily step, so the stock is in tonnes.
 */
export function simulateAccumulation(inflowTPerDay: number | null, efficiency: number, days: number, initialT = 0) {
  if (inflowTPerDay === null || !Number.isFinite(inflowTPerDay)) return null;
  const eff = clamp(efficiency, 0, 1);
  const stock: number[] = [];
  const collected: number[] = [];
  let a = initialT;
  for (let d = 0; d < days; d++) {
    const available = a + inflowTPerDay;
    const c = eff * available;
    a = available - c;
    stock.push(round(a, 2));
    collected.push(round(c, 2));
  }
  return { stock, collected, final: stock.length ? stock[stock.length - 1] : initialT };
}

/** Steady-state stock for a constant inflow: A* = G·(1−η)/η. */
export function steadyStateAccumulation(inflowTPerDay: number | null, efficiency: number) {
  if (inflowTPerDay === null || !Number.isFinite(inflowTPerDay) || efficiency <= 0) return null;
  return round((inflowTPerDay * (1 - efficiency)) / efficiency, 2);
}

export interface TimelineStep {
  /** Hours since storm start. */
  t: number;
  intensityMmH: number;
  cumulativeMm: number;
}

/**
 * Deterministic simulated-event hyetograph: triangular storm (peak at 40 % of the duration, peak = 2 × mean)
 * followed by a 3 h recession with no rain. Total depth = intensity × duration exactly.
 */
export function scenarioHyetograph(p: ScenarioParams, stepH = 0.25, tailH = 3): TimelineStep[] {
  const T = Math.max(stepH, p.rainDurationH);
  const peakT = 0.4 * T;
  const peak = 2 * p.rainIntensityMmH;
  const steps: TimelineStep[] = [];
  let cum = 0;
  const n = Math.round((T + tailH) / stepH);
  for (let i = 0; i <= n; i++) {
    const t = i * stepH;
    let I = 0;
    if (t <= T) I = t <= peakT ? (peak * t) / peakT : (peak * (T - t)) / (T - peakT);
    if (i > 0) {
      const tPrev = (i - 1) * stepH;
      const segEnd = Math.min(t, T);
      if (tPrev < T) {
        // trapezoid integration of the piecewise-linear intensity over [tPrev, segEnd]
        const ip = tPrev <= peakT ? (peak * tPrev) / peakT : (peak * (T - tPrev)) / (T - peakT);
        const ie = segEnd <= peakT ? (peak * segEnd) / peakT : (peak * (T - segEnd)) / (T - peakT);
        if (tPrev < peakT && segEnd > peakT) {
          cum += ((ip + peak) / 2) * (peakT - tPrev) + ((peak + ie) / 2) * (segEnd - peakT);
        } else {
          cum += ((ip + ie) / 2) * (segEnd - tPrev);
        }
      }
    }
    steps.push({ t: round(t, 3), intensityMmH: round(Math.max(0, I), 2), cumulativeMm: round(cum, 2) });
  }
  return steps;
}

/** Drivers at a given point on the simulated-event timeline. */
export function driversAt(step: TimelineStep, p: ScenarioParams): StormDrivers {
  return { intensityMmH: step.intensityMmH, depthMm: step.cumulativeMm, durationH: Math.min(step.t, p.rainDurationH) };
}

/** Before / after comparison for one area. */
export function compareScenarios(inputs: AreaRiskInputs, baseline: ScenarioParams, current: ScenarioParams, a: ModelAssumptions = DEFAULT_ASSUMPTIONS) {
  const before = computeAreaRisk(inputs, baseline, a);
  const after = computeAreaRisk(inputs, current, a);
  const delta = before.score !== null && after.score !== null ? round(after.score - before.score, 1) : null;
  return { before, after, delta };
}
