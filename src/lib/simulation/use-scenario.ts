"use client";

import { useMemo } from "react";
import { useCityBundle } from "@/lib/data/loader";
import { useDashboard } from "@/store/dashboard-store";
import type { AreaRecord, CityDataset, RainSeries } from "@/lib/types";
import {
  BASELINE_SCENARIO,
  DEFAULT_ASSUMPTIONS,
  computeAreaRisk,
  driversAt,
  riskClass,
  scenarioHyetograph,
  type AreaRiskInputs,
  type RiskClass,
  type RiskResult,
  type ScenarioParams,
  type StormDrivers,
  type TimelineStep,
} from "./model";

/**
 * Assumed duration over which an observed/reanalysis daily total falls when the historical timeline
 * replays a past day through the model (illustrative assumption, documented in SIMULATION_MODEL.md).
 */
export const HISTORICAL_STORM_HOURS = 3;

export interface AreaScenario {
  area: AreaRecord;
  inputs: AreaRiskInputs;
  baseline: RiskResult;
  current: RiskResult;
  delta: number | null;
  /** Rainfall applied for the selected historical date (mm) — reanalysis estimate, or null. */
  rain24h: number | null;
}

export interface CityScenarioSummary {
  /** Population-weighted mean of current scores (areas with population + score). */
  meanScore: number | null;
  meanBaseline: number | null;
  maxScore: number | null;
  /** Population-weighted mean drainage stress (%). */
  meanDrainageStress: number | null;
  /** Share (0–1) and count of population living in areas classed High or Very High. */
  exposedPopulationShare: number | null;
  exposedPopulation: number | null;
  classCounts: Record<RiskClass, number>;
  /** City mean rainfall depth applied (mm). */
  rainDepthMm: number | null;
}

export interface ScenarioState {
  ready: boolean;
  dataset?: CityDataset;
  byId: Map<string, AreaScenario>;
  list: AreaScenario[];
  summary: CityScenarioSummary;
  /** "baseline" when nothing is active, "scenario" for Scenario Lab, "historical" when replaying a date. */
  source: "baseline" | "scenario" | "historical";
  params: ScenarioParams;
  hyetograph: TimelineStep[];
  /** Current step (scenario timeline) or null when showing the full-storm summary. */
  step: TimelineStep | null;
  /** Selected historical date (ISO) or null. */
  date: string | null;
  /** City-mean rainfall intensity being visualised (mm/h) — drives 3D rain density. */
  visualIntensityMmH: number;
}

function spatialFactors(areas: AreaRecord[]) {
  const vals = areas.map((a) => a.metrics.rainfallAnnual?.value).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  const mean = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  return (a: AreaRecord) => {
    const v = a.metrics.rainfallAnnual?.value;
    return mean && v ? v / mean : 1;
  };
}

export function inputsFor(area: AreaRecord, spatial: (a: AreaRecord) => number): AreaRiskInputs {
  return {
    floodExposure: area.metrics.floodExposure?.value ?? null,
    obstructionSusceptibility: area.metrics.obstructionSusceptibility?.value ?? null,
    rainSpatialFactor: spatial(area),
  };
}

function rainForDate(series: RainSeries | null | undefined, areaId: string, idx: number | null): number | null {
  if (!series || idx === null) return null;
  const s = series.series.find((x) => x.id === areaId);
  if (!s) return null;
  const v = s.values[idx];
  return v === undefined ? null : v;
}

function summarize(list: AreaScenario[]): CityScenarioSummary {
  let wSum = 0,
    sSum = 0,
    bSum = 0,
    dSum = 0,
    exposed = 0,
    popTotal = 0,
    rainSum = 0,
    rainN = 0;
  let max: number | null = null;
  const classCounts: Record<RiskClass, number> = { low: 0, moderate: 0, high: 0, veryHigh: 0 };
  for (const a of list) {
    const pop = a.area.metrics.population?.value ?? null;
    const sc = a.current.score;
    if (sc !== null) {
      max = max === null ? sc : Math.max(max, sc);
      const c = riskClass(sc);
      if (c) classCounts[c]++;
    }
    rainSum += a.current.rainDepthMm;
    rainN++;
    if (pop !== null && sc !== null) {
      wSum += pop;
      sSum += pop * sc;
      bSum += pop * (a.baseline.score ?? 0);
      dSum += pop * a.current.drainageStressPct;
      if (sc >= 50) exposed += pop;
    }
    if (pop !== null) popTotal += pop;
  }
  return {
    meanScore: wSum ? Math.round((sSum / wSum) * 10) / 10 : null,
    meanBaseline: wSum ? Math.round((bSum / wSum) * 10) / 10 : null,
    maxScore: max,
    meanDrainageStress: wSum ? Math.round((dSum / wSum) * 10) / 10 : null,
    exposedPopulationShare: popTotal ? exposed / popTotal : null,
    exposedPopulation: popTotal ? exposed : null,
    classCounts,
    rainDepthMm: rainN ? Math.round((rainSum / rainN) * 10) / 10 : null,
  };
}

/**
 * Single source of truth for modelled values shown by the map, 3D scene, KPIs, charts and rankings.
 * Pure derivation from (immutable dataset × scenario params × timeline position) — nothing is written back.
 */
export function useScenario(): ScenarioState {
  const { bundle } = useCityBundle();
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  const params = useDashboard((s) => s.scenario);
  const timelineMode = useDashboard((s) => s.timelineMode);
  const scenarioStep = useDashboard((s) => s.scenarioStep);
  const dateIndex = useDashboard((s) => s.dateIndex);

  const hyetograph = useMemo(() => scenarioHyetograph(params), [params]);

  return useMemo<ScenarioState>(() => {
    const ds = bundle?.dataset;
    const empty: ScenarioState = {
      ready: false,
      byId: new Map(),
      list: [],
      summary: summarize([]),
      source: "baseline",
      params,
      hyetograph,
      step: null,
      date: null,
      visualIntensityMmH: 0,
    };
    if (!ds) return empty;

    const spatial = spatialFactors(ds.areas);
    const historical = !scenarioActive && timelineMode === "historical" && dateIndex !== null;
    const step = scenarioActive && timelineMode === "scenario" && scenarioStep > 0 ? (hyetograph[Math.min(scenarioStep, hyetograph.length - 1)] ?? null) : null;
    const date = historical && bundle?.rainAreas ? (bundle.rainAreas.dates[dateIndex!] ?? null) : null;

    const list: AreaScenario[] = ds.areas.map((area) => {
      const inputs = inputsFor(area, spatial);
      const baseline = computeAreaRisk(inputs, BASELINE_SCENARIO, DEFAULT_ASSUMPTIONS);
      let current = baseline;
      let rain24h: number | null = null;
      if (scenarioActive) {
        current = step ? computeAreaRisk(inputs, params, DEFAULT_ASSUMPTIONS, driversAt(step, params)) : computeAreaRisk(inputs, params, DEFAULT_ASSUMPTIONS);
      } else if (historical) {
        rain24h = rainForDate(bundle?.rainAreas, area.id, dateIndex);
        if (rain24h !== null) {
          const drivers: StormDrivers = { depthMm: rain24h, intensityMmH: rain24h / HISTORICAL_STORM_HOURS, durationH: HISTORICAL_STORM_HOURS };
          // spatial factor already embedded in the area's own reanalysis series → neutralise it
          current = computeAreaRisk({ ...inputs, rainSpatialFactor: 1 }, BASELINE_SCENARIO, DEFAULT_ASSUMPTIONS, drivers);
        }
      }
      const delta = baseline.score !== null && current.score !== null ? Math.round((current.score - baseline.score) * 10) / 10 : null;
      return { area, inputs, baseline, current, delta, rain24h };
    });

    const byId = new Map(list.map((x) => [x.area.id, x] as const));
    let visualIntensityMmH = 0;
    if (scenarioActive) visualIntensityMmH = step ? step.intensityMmH : params.rainIntensityMmH;
    else if (historical) {
      const vals = list.map((x) => x.rain24h).filter((v): v is number => v !== null);
      visualIntensityMmH = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length / HISTORICAL_STORM_HOURS : 0;
    }

    return {
      ready: true,
      dataset: ds,
      byId,
      list,
      summary: summarize(list),
      source: scenarioActive ? "scenario" : historical ? "historical" : "baseline",
      params,
      hyetograph,
      step,
      date,
      visualIntensityMmH,
    };
  }, [bundle, scenarioActive, params, timelineMode, scenarioStep, dateIndex, hyetograph]);
}
