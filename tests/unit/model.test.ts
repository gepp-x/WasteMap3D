import { describe, expect, it, vi } from "vitest";
import {
  BASELINE_SCENARIO,
  DEFAULT_ASSUMPTIONS,
  L_SAT,
  MIN_COMPLETENESS,
  PARAM_BOUNDS,
  P_REF_MM,
  RISK_CLASSES,
  SCENARIO_PRESETS,
  WEIGHTS,
  compareScenarios,
  computeAreaRisk,
  driversAt,
  durationFactor,
  effectiveObstruction,
  rainClass24h,
  riskClass,
  scenarioHyetograph,
  simulateAccumulation,
  steadyStateAccumulation,
  stormDrivers,
  type AreaRiskInputs,
  type FactorKey,
  type ScenarioParams,
} from "@/lib/simulation/model";

/** A spread of area inputs (exposure × obstruction susceptibility × spatial rain factor). */
const AREAS: AreaRiskInputs[] = [];
for (const E of [0, 0.25, 0.5, 0.75, 1]) {
  for (const W of [0, 0.3, 0.6, 1]) {
    for (const rainSpatialFactor of [0.85, 1, 1.15]) AREAS.push({ floodExposure: E, obstructionSusceptibility: W, rainSpatialFactor });
  }
}

const P = (over: Partial<ScenarioParams> = {}): ScenarioParams => ({ ...BASELINE_SCENARIO, ...over });

function sweep(key: keyof ScenarioParams, n = 24): number[] {
  const { min, max } = PARAM_BOUNDS[key];
  return Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n);
}

/** Asserts score(v) is monotone in `key` over its full bound, for every area; returns whether it ever strictly changed. */
function expectMonotone(key: keyof ScenarioParams, direction: 1 | -1, base: Partial<ScenarioParams> = {}) {
  let strict = false;
  for (const inputs of AREAS) {
    let prev: number | null = null;
    for (const v of sweep(key)) {
      const score = computeAreaRisk(inputs, P({ ...base, [key]: v })).score;
      expect(score).not.toBeNull();
      if (prev !== null) {
        if (direction === 1) expect(score!).toBeGreaterThanOrEqual(prev);
        else expect(score!).toBeLessThanOrEqual(prev);
        if (score !== prev) strict = true;
      }
      prev = score;
    }
  }
  return strict;
}

describe("weights and classes", () => {
  it("factor weights sum to exactly 1", () => {
    const sum = (Object.values(WEIGHTS) as number[]).reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1, 12);
    expect(WEIGHTS).toEqual({ R: 0.45, D: 0.25, E: 0.2, W: 0.1 });
  });

  it("risk class thresholds are 0–24 / 25–49 / 50–74 / 75–100", () => {
    expect(riskClass(0)).toBe("low");
    expect(riskClass(24.9)).toBe("low");
    expect(riskClass(25)).toBe("moderate");
    expect(riskClass(49.9)).toBe("moderate");
    expect(riskClass(50)).toBe("high");
    expect(riskClass(74.9)).toBe("high");
    expect(riskClass(75)).toBe("veryHigh");
    expect(riskClass(100)).toBe("veryHigh");
    expect(riskClass(null)).toBeNull();
    expect(riskClass(Number.NaN)).toBeNull();
  });

  it("class table is contiguous and covers 0–100", () => {
    expect(RISK_CLASSES.map((c) => [c.min, c.max])).toEqual([
      [0, 24],
      [25, 49],
      [50, 74],
      [75, 100],
    ]);
    for (const c of RISK_CLASSES) {
      expect(riskClass(c.min)).toBe(c.id);
      expect(riskClass(c.max)).toBe(c.id);
    }
  });

  it("TMD 24-hour rain classes follow the published thresholds", () => {
    expect(rainClass24h(0)).toBe("none");
    expect(rainClass24h(0.1)).toBe("light");
    expect(rainClass24h(10)).toBe("light");
    expect(rainClass24h(10.1)).toBe("moderate");
    expect(rainClass24h(35)).toBe("moderate");
    expect(rainClass24h(35.1)).toBe("heavy");
    expect(rainClass24h(90)).toBe("heavy");
    expect(rainClass24h(90.1)).toBe("veryHeavy");
    expect(rainClass24h(null)).toBeNull();
  });
});

describe("factor normalisation", () => {
  it("R = clamp(P / 150) and D = clamp(L / 1.5) with the documented load and capacity", () => {
    const p = P({ rainIntensityMmH: 30, rainDurationH: 2, drainageCapacityReduction: 0.2, upstreamRunoff: 0.5 });
    const r = computeAreaRisk({ floodExposure: 0.4, obstructionSusceptibility: null, rainSpatialFactor: 1 }, p);
    expect(r.rainDepthMm).toBe(60);
    expect(r.factors.R.value).toBeCloseTo(60 / P_REF_MM, 3);
    const load = 30 * (1 + 0.6 * 0.5) * durationFactor(2);
    const capacity = DEFAULT_ASSUMPTIONS.designIntensityMmH * (1 - 0.2); // W unknown ⇒ no obstruction reduction
    expect(r.loadRatio).toBeCloseTo(load / capacity, 3);
    expect(r.factors.D.value).toBeCloseTo(Math.min(1, load / capacity / L_SAT), 3);
    expect(r.drainageStressPct).toBeCloseTo(Math.min(100, (100 * load) / capacity / L_SAT), 1);
  });

  it("R saturates at the reference depth", () => {
    const r = computeAreaRisk({ floodExposure: 0.5, obstructionSusceptibility: 0.5 }, P({ rainIntensityMmH: 100, rainDurationH: 6 }));
    expect(r.factors.R.value).toBe(1);
  });

  it("duration factor: 0.85 + 0.05·h, 1.0 at 3 h, capped at 1.25", () => {
    expect(durationFactor(0)).toBeCloseTo(0.85);
    expect(durationFactor(3)).toBeCloseTo(1);
    expect(durationFactor(8)).toBeCloseTo(1.25);
    expect(durationFactor(12)).toBe(1.25);
  });

  it("W_eff = clamp(W × (0.4 + 1.2·obstruction) × (1 + 2·(1 − η)))", () => {
    const p = P({ obstruction: 0.5, collectionEfficiency: 0.9 });
    expect(effectiveObstruction(0.4, p)).toBeCloseTo(0.4 * (0.4 + 0.6) * (1 + 0.2), 10);
    expect(effectiveObstruction(1, P({ obstruction: 1, collectionEfficiency: 0.5 }))).toBe(1);
    expect(effectiveObstruction(null, p)).toBeNull();
    expect(effectiveObstruction(Number.NaN, p)).toBeNull();
  });

  it("score equals the weighted sum of factor points", () => {
    for (const inputs of AREAS) {
      const r = computeAreaRisk(inputs, SCENARIO_PRESETS.heavyRain.params);
      const sum = (Object.keys(WEIGHTS) as FactorKey[]).reduce((s, k) => s + r.factors[k].points, 0);
      expect(r.score).not.toBeNull();
      expect(Math.abs(r.score! - sum)).toBeLessThanOrEqual(0.06);
    }
  });
});

describe("monotonicity", () => {
  it("score is non-decreasing in rain intensity", () => {
    expect(expectMonotone("rainIntensityMmH", 1)).toBe(true);
  });
  it("score is non-decreasing in storm duration", () => {
    expect(expectMonotone("rainDurationH", 1, { rainIntensityMmH: 15 })).toBe(true);
  });
  it("score is non-decreasing in drainage capacity reduction", () => {
    expect(expectMonotone("drainageCapacityReduction", 1, { rainIntensityMmH: 25 })).toBe(true);
  });
  it("score is non-decreasing in waste-related obstruction", () => {
    expect(expectMonotone("obstruction", 1, { rainIntensityMmH: 25 })).toBe(true);
  });
  it("score is non-decreasing in upstream runoff", () => {
    expect(expectMonotone("upstreamRunoff", 1, { rainIntensityMmH: 25 })).toBe(true);
  });
  it("score is non-increasing in collection efficiency", () => {
    expect(expectMonotone("collectionEfficiency", -1, { rainIntensityMmH: 25, obstruction: 0.7 })).toBe(true);
  });
  it("score is non-decreasing in geographic exposure", () => {
    let prev = -1;
    for (const E of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const s = computeAreaRisk({ floodExposure: E, obstructionSusceptibility: 0.5 }, BASELINE_SCENARIO).score!;
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });
});

describe("missing data", () => {
  const p = SCENARIO_PRESETS.heavyRain.params;

  it("a missing factor is renormalised, never counted as 0", () => {
    const full = computeAreaRisk({ floodExposure: 0.6, obstructionSusceptibility: 0.5 }, p);
    const noE = computeAreaRisk({ floodExposure: null, obstructionSusceptibility: 0.5 }, p);
    expect(noE.missing).toEqual(["E"]);
    expect(noE.completeness).toBeCloseTo(0.8, 6);
    expect(noE.factors.E.missing).toBe(true);
    expect(noE.factors.E.value).toBeNull();
    expect(noE.factors.E.points).toBe(0);
    expect(noE.factors.R.appliedWeight).toBeCloseTo(0.45 / 0.8, 4);
    expect(noE.factors.D.appliedWeight).toBeCloseTo(0.25 / 0.8, 4);
    expect(noE.factors.W.appliedWeight).toBeCloseTo(0.1 / 0.8, 4);
    const expected = (100 * (0.45 * noE.factors.R.value! + 0.25 * noE.factors.D.value! + 0.1 * noE.factors.W.value!)) / 0.8;
    expect(noE.score!).toBeCloseTo(expected, 0);
    // Treating E as 0 would give a strictly lower score than renormalising.
    const asZero = computeAreaRisk({ floodExposure: 0, obstructionSusceptibility: 0.5 }, p);
    expect(noE.score!).toBeGreaterThan(asZero.score!);
    expect(full.completeness).toBe(1);
  });

  it("NaN inputs are treated as missing", () => {
    const r = computeAreaRisk({ floodExposure: Number.NaN, obstructionSusceptibility: Number.NaN }, p);
    expect(r.missing).toEqual(["E", "W"]);
    expect(r.obstructionEffective).toBeNull();
  });

  it("applied weights always sum to 1 over available factors", () => {
    for (const E of [0.5, null]) {
      for (const W of [0.5, null]) {
        const r = computeAreaRisk({ floodExposure: E, obstructionSusceptibility: W }, p);
        const sum = (Object.keys(WEIGHTS) as FactorKey[]).reduce((s, k) => s + r.factors[k].appliedWeight, 0);
        expect(sum).toBeCloseTo(1, 3);
      }
    }
  });

  it("completeness threshold: score is produced iff completeness ≥ 0.55", () => {
    expect(MIN_COMPLETENESS).toBe(0.55);
    for (const E of [0.5, null]) {
      for (const W of [0.5, null]) {
        const r = computeAreaRisk({ floodExposure: E, obstructionSusceptibility: W }, p);
        expect(r.score === null).toBe(r.completeness < MIN_COMPLETENESS);
        expect(r.riskClass === null).toBe(r.score === null);
      }
    }
    // R and D are always computable from the scenario, so completeness never drops below 0.70 today.
    const worst = computeAreaRisk({ floodExposure: null, obstructionSusceptibility: null }, p);
    expect(worst.completeness).toBeCloseTo(0.7, 6);
    expect(worst.completeness).toBeGreaterThanOrEqual(MIN_COMPLETENESS);
    expect(worst.score).not.toBeNull();
  });
});

describe("hyetograph", () => {
  it("conserves storm depth: total = intensity × duration (±0.5 %)", () => {
    for (const I of [1, 5, 10, 30, 60, 87, 120]) {
      for (let T = 0.5; T <= 12; T += 0.5) {
        const steps = scenarioHyetograph(P({ rainIntensityMmH: I, rainDurationH: T }));
        const total = steps[steps.length - 1].cumulativeMm;
        expect(Math.abs(total - I * T) / (I * T)).toBeLessThanOrEqual(0.005);
      }
    }
  });

  it("uses 15-minute steps, a triangular storm peaking at 2 × mean, and a 3 h dry recession", () => {
    const p = P({ rainIntensityMmH: 30, rainDurationH: 2.5 }); // peak at 0.4 × 2.5 = 1.0 h (on the grid)
    const steps = scenarioHyetograph(p);
    expect(steps[1].t - steps[0].t).toBeCloseTo(0.25);
    expect(steps[steps.length - 1].t).toBeCloseTo(2.5 + 3);
    expect(steps[0].intensityMmH).toBe(0);
    expect(Math.max(...steps.map((s) => s.intensityMmH))).toBeCloseTo(60, 6);
    expect(steps.find((s) => s.t === 1)!.intensityMmH).toBeCloseTo(60, 6);
    for (const s of steps.filter((x) => x.t > 2.5)) expect(s.intensityMmH).toBe(0);
    for (let i = 1; i < steps.length; i++) expect(steps[i].cumulativeMm).toBeGreaterThanOrEqual(steps[i - 1].cumulativeMm);
    const atEnd = steps.find((s) => s.t === 2.5)!.cumulativeMm;
    expect(steps[steps.length - 1].cumulativeMm).toBe(atEnd);
  });

  it("zero intensity gives a dry hyetograph", () => {
    const steps = scenarioHyetograph(P({ rainIntensityMmH: 0 }));
    expect(steps.every((s) => s.intensityMmH === 0 && s.cumulativeMm === 0)).toBe(true);
  });

  it("drivers at a step use the instantaneous intensity, cumulative depth and capped elapsed time", () => {
    const p = P({ rainIntensityMmH: 20, rainDurationH: 2 });
    const steps = scenarioHyetograph(p);
    const late = steps[steps.length - 1];
    expect(driversAt(late, p)).toEqual({ intensityMmH: 0, depthMm: late.cumulativeMm, durationH: 2 });
    expect(stormDrivers(p)).toEqual({ intensityMmH: 20, depthMm: 40, durationH: 2 });
  });
});

describe("accumulation model", () => {
  it("follows A(t) = A(t−1) + G − C(t) with C(t) = η·(A(t−1) + G)", () => {
    const G = 120;
    const eta = 0.9;
    const res = simulateAccumulation(G, eta, 10, 50)!;
    let a = 50;
    for (let d = 0; d < 10; d++) {
      const c = eta * (a + G);
      const next = a + G - c;
      expect(res.collected[d]).toBeCloseTo(c, 2);
      expect(res.stock[d]).toBeCloseTo(next, 2);
      a = next;
    }
    expect(res.final).toBe(res.stock[9]);
  });

  it("converges to the steady state G·(1 − η)/η", () => {
    for (const [G, eta] of [
      [100, 0.95],
      [42.5, 0.8],
      [10, 0.5],
    ] as const) {
      const res = simulateAccumulation(G, eta, 400)!;
      const ss = steadyStateAccumulation(G, eta)!;
      expect(ss).toBeCloseTo((G * (1 - eta)) / eta, 2);
      expect(Math.abs(res.final - ss)).toBeLessThanOrEqual(0.011);
    }
  });

  it("returns null for unavailable inflow (never 0)", () => {
    expect(simulateAccumulation(null, 0.9, 5)).toBeNull();
    expect(steadyStateAccumulation(null, 0.9)).toBeNull();
    expect(steadyStateAccumulation(100, 0)).toBeNull();
  });
});

describe("presets", () => {
  it("normal < heavyRain < extremeRain for identical area inputs", () => {
    for (const inputs of AREAS) {
      const n = computeAreaRisk(inputs, SCENARIO_PRESETS.normal.params).score!;
      const h = computeAreaRisk(inputs, SCENARIO_PRESETS.heavyRain.params).score!;
      const x = computeAreaRisk(inputs, SCENARIO_PRESETS.extremeRain.params).score!;
      expect(n).toBeLessThan(h);
      expect(h).toBeLessThan(x);
    }
  });

  it("stress presets are never below their rain-only counterparts", () => {
    for (const inputs of AREAS) {
      const h = computeAreaRisk(inputs, SCENARIO_PRESETS.heavyRain.params).score!;
      const o = computeAreaRisk(inputs, SCENARIO_PRESETS.drainageObstruction.params).score!;
      const x = computeAreaRisk(inputs, SCENARIO_PRESETS.extremeRain.params).score!;
      const c = computeAreaRisk(inputs, SCENARIO_PRESETS.combinedStress.params).score!;
      expect(o).toBeGreaterThanOrEqual(h);
      expect(c).toBeGreaterThanOrEqual(x);
    }
  });

  it("preset parameters stay within PARAM_BOUNDS and the baseline is the normal preset", () => {
    expect(BASELINE_SCENARIO).toEqual(SCENARIO_PRESETS.normal.params);
    for (const preset of Object.values(SCENARIO_PRESETS)) {
      for (const [k, v] of Object.entries(preset.params) as [keyof ScenarioParams, number][]) {
        expect(v).toBeGreaterThanOrEqual(PARAM_BOUNDS[k].min);
        expect(v).toBeLessThanOrEqual(PARAM_BOUNDS[k].max);
      }
    }
  });

  it("compareScenarios reports after − before", () => {
    const inputs = { floodExposure: 0.5, obstructionSusceptibility: 0.5 };
    const c = compareScenarios(inputs, BASELINE_SCENARIO, SCENARIO_PRESETS.extremeRain.params);
    expect(c.delta).toBeCloseTo(c.after.score! - c.before.score!, 1);
    expect(c.delta!).toBeGreaterThan(0);
  });
});

describe("determinism", () => {
  it("identical inputs give identical outputs and never use randomness", () => {
    const rnd = vi.spyOn(Math, "random");
    const run = () =>
      AREAS.map((a) => ({
        risk: computeAreaRisk(a, SCENARIO_PRESETS.combinedStress.params),
        hyeto: scenarioHyetograph(SCENARIO_PRESETS.combinedStress.params),
        acc: simulateAccumulation(80, 0.85, 30),
      }));
    expect(run()).toEqual(run());
    expect(rnd).not.toHaveBeenCalled();
  });

  it("does not mutate its inputs", () => {
    const inputs: AreaRiskInputs = Object.freeze({ floodExposure: 0.3, obstructionSusceptibility: 0.7, rainSpatialFactor: 1.1 });
    const params = Object.freeze({ ...SCENARIO_PRESETS.drainageObstruction.params });
    expect(() => computeAreaRisk(inputs, params)).not.toThrow();
    expect(() => scenarioHyetograph(params)).not.toThrow();
  });
});
