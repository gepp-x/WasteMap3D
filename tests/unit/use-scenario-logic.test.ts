import { describe, expect, it } from "vitest";
import type { AreaMetrics, AreaRecord, DataStatus, MetricValue } from "@/lib/types";
import { BASELINE_SCENARIO, SCENARIO_PRESETS, WEIGHTS, computeAreaRisk, P_REF_MM, type StormDrivers } from "@/lib/simulation/model";
import { HISTORICAL_STORM_HOURS, inputsFor } from "@/lib/simulation/use-scenario";
import { deltaOf, factorRows, summarizeSide, topIncreases, type ScenarioRow } from "@/components/dashboard/BeforeAfter";
import {
  COMMIT_INTERVAL_MS,
  PLAYBACK_BASE_RATE,
  REDUCED_TICK_MS,
  advancePosition,
  cityMeanSeries,
  clampIndex,
  dateIndexRange,
  formatElapsed,
  indexFromRatio,
  nextSpeed,
  peakIndexInRange,
  playbackRate,
  reducedStepSize,
  startPosition,
  stepIndex,
} from "@/hooks/use-timeline-playback";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const mv = (value: number | null, unit: string, status: DataStatus = "observed"): MetricValue => ({ value, unit, provenance: { status: value === null ? "unavailable" : status } });

function mkArea(id: string, opts: { pop: number | null; E: number | null; W: number | null; annualRain?: number | null }): AreaRecord {
  const metrics: AreaMetrics = {
    population: mv(opts.pop, "persons"),
    areaKm2: mv(10, "km2"),
    populationDensity: mv(opts.pop === null ? null : opts.pop / 10, "persons/km2", "derived"),
    wasteGenerated: mv(null, "t/day"),
    wasteCollected: mv(50, "t/day"),
    wasteAccumulated: mv(null, "t", "simulated"),
    wastePerCapita: mv(null, "kg/person/day"),
    wasteDensity: mv(null, "t/day/km2"),
    rainfallAnnual: mv(opts.annualRain ?? null, "mm/year", "estimated"),
    rainfall24h: mv(null, "mm"),
    drainageStress: mv(null, "%", "simulated"),
    floodExposure: mv(opts.E, "index", "derived"),
    obstructionSusceptibility: mv(opts.W, "index", "derived"),
    modeledFloodRisk: mv(null, "score", "simulated"),
  };
  return {
    id,
    fid: Number(id.replace(/\D/g, "")) || 0,
    cityId: "bangkok",
    nameTh: id,
    nameEn: id,
    kind: "district",
    anchor: [100.5, 13.75],
    geometryStatus: "osm",
    metrics,
    wasteHistory: [],
  };
}

function rowFor(area: AreaRecord, current = SCENARIO_PRESETS.extremeRain.params): ScenarioRow {
  const inputs = inputsFor(area, () => 1);
  const baseline = computeAreaRisk(inputs, BASELINE_SCENARIO);
  const cur = computeAreaRisk(inputs, current);
  return { area, baseline, current: cur, delta: deltaOf(baseline.score, cur.score) };
}

/* ------------------------------------------------------------------ */
/*  useScenario building blocks                                        */
/* ------------------------------------------------------------------ */

describe("inputsFor", () => {
  it("maps the dataset's E and W metrics and the spatial rain factor", () => {
    const a = mkArea("bkk-1", { pop: 1000, E: 0.4, W: 0.7, annualRain: 1650 });
    expect(inputsFor(a, () => 1.1)).toEqual({ floodExposure: 0.4, obstructionSusceptibility: 0.7, rainSpatialFactor: 1.1 });
  });

  it("keeps unavailable values as null (never 0)", () => {
    const a = mkArea("bkk-2", { pop: 1000, E: null, W: null });
    const inputs = inputsFor(a, () => 1);
    expect(inputs.floodExposure).toBeNull();
    expect(inputs.obstructionSusceptibility).toBeNull();
    const r = computeAreaRisk(inputs, BASELINE_SCENARIO);
    expect(r.missing).toEqual(["E", "W"]);
  });

  it("tolerates a metric missing from a partial dataset", () => {
    const a = mkArea("bkk-3", { pop: 1000, E: 0.5, W: 0.5 });
    const partial = { ...a, metrics: { ...a.metrics, floodExposure: undefined as unknown as MetricValue } };
    expect(inputsFor(partial, () => 1).floodExposure).toBeNull();
  });
});

describe("historical replay", () => {
  it("assumes the daily reanalysis total falls over 3 hours", () => {
    expect(HISTORICAL_STORM_HOURS).toBe(3);
  });

  it("replayed risk rises with the day's rainfall and R = P / 150", () => {
    const inputs = { floodExposure: 0.5, obstructionSusceptibility: 0.5, rainSpatialFactor: 1 };
    let prev = -1;
    for (const P of [0, 5, 20, 60, 120, 200]) {
      const drivers: StormDrivers = { depthMm: P, intensityMmH: P / HISTORICAL_STORM_HOURS, durationH: HISTORICAL_STORM_HOURS };
      const r = computeAreaRisk(inputs, BASELINE_SCENARIO, undefined, drivers);
      expect(r.factors.R.value).toBeCloseTo(Math.min(1, P / P_REF_MM), 3);
      expect(r.score!).toBeGreaterThanOrEqual(prev);
      prev = r.score!;
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Before / after derivations (Scenario Lab)                          */
/* ------------------------------------------------------------------ */

describe("summarizeSide", () => {
  const rows = [
    rowFor(mkArea("a1", { pop: 100_000, E: 0.9, W: 0.8 })),
    rowFor(mkArea("a2", { pop: 300_000, E: 0.2, W: 0.2 })),
    rowFor(mkArea("a3", { pop: 50_000, E: 0.6, W: 0.4 })),
    rowFor(mkArea("a4", { pop: null, E: 1, W: 1 })), // scored, but no population → excluded from weights
  ];

  it("computes population-weighted means over areas with population and a score", () => {
    for (const side of ["baseline", "current"] as const) {
      const s = summarizeSide(rows, side);
      const weighted = rows.filter((r) => r.area.metrics.population.value !== null);
      const w = weighted.reduce((acc, r) => acc + r.area.metrics.population.value!, 0);
      const mean = weighted.reduce((acc, r) => acc + r.area.metrics.population.value! * r[side].score!, 0) / w;
      const drain = weighted.reduce((acc, r) => acc + r.area.metrics.population.value! * r[side].drainageStressPct, 0) / w;
      expect(s.meanScore).toBeCloseTo(Math.round(mean * 10) / 10, 6);
      expect(s.meanDrainageStress).toBeCloseTo(Math.round(drain * 10) / 10, 6);
      expect(s.maxScore).toBe(Math.max(...rows.map((r) => r[side].score!)));
    }
  });

  it("population share in High / Very High uses score ≥ 50", () => {
    const s = summarizeSide(rows, "current");
    const known = rows.filter((r) => r.area.metrics.population.value !== null);
    const total = known.reduce((acc, r) => acc + r.area.metrics.population.value!, 0);
    const exposed = known.filter((r) => r.current.score! >= 50).reduce((acc, r) => acc + r.area.metrics.population.value!, 0);
    expect(s.exposedShare).toBeCloseTo(exposed / total, 10);
  });

  it("returns null (not 0) when nothing can be weighted", () => {
    const s = summarizeSide([rowFor(mkArea("x", { pop: null, E: 0.5, W: 0.5 }))], "current");
    expect(s.meanScore).toBeNull();
    expect(s.meanDrainageStress).toBeNull();
    expect(s.exposedShare).toBeNull();
    expect(s.maxScore).not.toBeNull();
    expect(summarizeSide([], "baseline")).toEqual({ meanScore: null, maxScore: null, meanDrainageStress: null, exposedShare: null });
  });

  it("the extreme-rain side is never below the baseline side", () => {
    const b = summarizeSide(rows, "baseline");
    const c = summarizeSide(rows, "current");
    expect(c.meanScore!).toBeGreaterThan(b.meanScore!);
    expect(c.meanDrainageStress!).toBeGreaterThan(b.meanDrainageStress!);
    expect(c.exposedShare!).toBeGreaterThanOrEqual(b.exposedShare!);
  });
});

describe("deltaOf", () => {
  it("is null-safe and rounded", () => {
    expect(deltaOf(10, 12.345)).toBe(2.3);
    expect(deltaOf(10, 12.345, 2)).toBe(2.35);
    expect(deltaOf(null, 5)).toBeNull();
    expect(deltaOf(5, null)).toBeNull();
    expect(deltaOf(5, Number.NaN)).toBeNull();
  });
});

describe("topIncreases", () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => rowFor(mkArea(id, { pop: 1000, E: i / 7, W: (7 - i) / 7 })));

  it("returns at most n areas sorted by increase, descending", () => {
    const top = topIncreases(rows, 5);
    expect(top.length).toBe(5);
    for (let i = 1; i < top.length; i++) expect(top[i - 1].delta!).toBeGreaterThanOrEqual(top[i].delta!);
  });

  it("excludes areas without an increase or without a delta", () => {
    const mixed: ScenarioRow[] = [
      { ...rows[0], delta: null },
      { ...rows[1], delta: 0 },
      { ...rows[2], delta: -3 },
      { ...rows[3], delta: 4 },
    ];
    expect(topIncreases(mixed).map((r) => r.area.id)).toEqual([rows[3].area.id]);
  });

  it("breaks ties deterministically", () => {
    const tie: ScenarioRow[] = [
      { ...rows[0], delta: 5 },
      { ...rows[1], delta: 5 },
    ];
    expect(topIncreases(tie).map((r) => r.area.id)).toEqual(topIncreases([...tie].reverse()).map((r) => r.area.id));
  });

  it("does not mutate the input order", () => {
    const ids = rows.map((r) => r.area.id);
    topIncreases(rows);
    expect(rows.map((r) => r.area.id)).toEqual(ids);
  });
});

describe("factorRows", () => {
  it("lists R, D, E, W with renormalised weights and null points for missing factors", () => {
    const row = rowFor(mkArea("m", { pop: 1000, E: null, W: 0.5 }));
    const f = factorRows(row.baseline, row.current);
    expect(f.map((x) => x.key)).toEqual(Object.keys(WEIGHTS));
    const e = f.find((x) => x.key === "E")!;
    expect(e.missing).toBe(true);
    expect(e.before).toBeNull();
    expect(e.after).toBeNull();
    const r = f.find((x) => x.key === "R")!;
    expect(r.maxPoints).toBeCloseTo((0.45 / 0.8) * 100, 1); // E missing ⇒ completeness 0.8
    expect(r.after!).toBeGreaterThan(r.before!);
    const total = f.reduce((s, x) => s + (x.after ?? 0), 0);
    expect(Math.abs(total - row.current.score!)).toBeLessThanOrEqual(0.06);
  });
});

/* ------------------------------------------------------------------ */
/*  Timeline helpers                                                   */
/* ------------------------------------------------------------------ */

describe("timeline helpers", () => {
  it("city-mean series ignores nulls and keeps all-null days null", () => {
    const series = [{ values: [1, null, 10, null] }, { values: [3, null, null, 0] }, { values: [5, null, 20] }];
    expect(cityMeanSeries(series, 4)).toEqual([3, null, 15, 0]);
  });

  it("finds date ranges and the wettest day inside them", () => {
    const dates = ["2025-11-20", "2025-11-21", "2025-11-22", "2025-11-23", "2025-11-24"];
    expect(dateIndexRange(dates, "2025-11-21", "2025-11-23")).toEqual([1, 3]);
    expect(dateIndexRange(dates, "2025-11-19T00:00:00+07:00", "2025-11-21")).toEqual([0, 1]);
    expect(dateIndexRange(dates, "2025-12-01", "2025-12-05")).toBeNull();
    expect(peakIndexInRange([1, 50, null, 300, 20], 1, 3)).toBe(3);
    expect(peakIndexInRange([null, null, null], 0, 2)).toBe(0);
  });

  it("formats elapsed storm time as hh:mm", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(0.25)).toBe("00:15");
    expect(formatElapsed(2.75)).toBe("02:45");
    expect(formatElapsed(12.5)).toBe("12:30");
  });

  it("keyboard stepping clamps and starts sensibly from an unset date", () => {
    expect(stepIndex(null, 1, 0, 99)).toBe(0);
    expect(stepIndex(null, -1, 0, 99)).toBe(99);
    expect(stepIndex(10, 7, 0, 99)).toBe(17);
    expect(stepIndex(95, 7, 0, 99)).toBe(99);
    expect(stepIndex(3, -7, 1, 40)).toBe(1);
    expect(clampIndex(-4, 0, 9)).toBe(0);
  });

  it("maps pointer ratios to indices", () => {
    expect(indexFromRatio(0, 0, 100)).toBe(0);
    expect(indexFromRatio(0.5, 0, 100)).toBe(50);
    expect(indexFromRatio(1.4, 0, 100)).toBe(100);
    expect(indexFromRatio(-1, 1, 20)).toBe(1);
  });
});

describe("playback", () => {
  it("rates: ≈ 4 / 8 / 16 / 32 days per second; 1 simulated hour per second at 1×", () => {
    expect([0.5, 1, 2, 4].map((s) => playbackRate("historical", s))).toEqual([4, 8, 16, 32]);
    expect(playbackRate("scenario", 1) * 0.25).toBe(1);
    expect(PLAYBACK_BASE_RATE.scenario).toBe(4);
  });

  it("speed button cycles 0.5× → 1× → 2× → 4× → 0.5×", () => {
    expect(nextSpeed(0.5)).toBe(1);
    expect(nextSpeed(1)).toBe(2);
    expect(nextSpeed(2)).toBe(4);
    expect(nextSpeed(4)).toBe(0.5);
  });

  it("advances by dt × rate, clamps long frames and stops at the end", () => {
    expect(advancePosition(0, 1000 / 60, 8, 100).pos).toBeCloseTo(8 / 60, 6);
    expect(advancePosition(0, 5000, 8, 100).pos).toBeCloseTo(2, 6); // clamped to 250 ms
    expect(advancePosition(99.9, 100, 8, 100)).toEqual({ pos: 100, ended: true });
    expect(advancePosition(5, -20, 8, 100).pos).toBe(5);
  });

  it("commits at most ~15 Hz", () => {
    expect(1000 / COMMIT_INTERVAL_MS).toBeCloseTo(15, 6);
  });

  it("reduced motion advances in whole steps per tick", () => {
    expect(reducedStepSize(8)).toBe(Math.round((8 * REDUCED_TICK_MS) / 1000));
    expect(reducedStepSize(0.5)).toBe(1);
  });

  it("restarts from the beginning when unset or already at the end", () => {
    expect(startPosition(null, 0, 99)).toBe(0);
    expect(startPosition(99, 0, 99)).toBe(0);
    expect(startPosition(0, 1, 40)).toBe(1); // scenario step 0 is the summary
    expect(startPosition(12, 0, 99)).toBe(12);
  });
});
