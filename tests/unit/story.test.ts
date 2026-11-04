import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AreaRecord, CityDataset, FloodEvent, HourlyRainEvent, MetricValue, RainSeries, WaterLevelStation } from "@/lib/types";
import { BASELINE_SCENARIO, SCENARIO_PRESETS } from "@/lib/simulation/model";
import {
  STORY_MAX_STEPS,
  STORY_MIN_STEPS,
  argmaxArea,
  buildStory,
  cityRiskSummary,
  hasSpread,
  hourlyEventsOn,
  partitionFloodEvents,
  type StoryInput,
  type StoryStep,
} from "@/lib/story/build-story";

/**
 * Guided story builder: pure, deterministic, data-driven, and honest about provenance.
 * Uses the bundled city datasets (public/data) so the tour is tested against the real numbers.
 */

const DATA = join(process.cwd(), "public", "data");
const read = <T,>(p: string): T => JSON.parse(readFileSync(join(DATA, p), "utf8")) as T;
const readOpt = <T,>(p: string): T | null => (existsSync(join(DATA, p)) ? read<T>(p) : null);

function cityInput(city: "bangkok" | "hatyai"): StoryInput {
  return {
    dataset: read<CityDataset>(`${city}/areas.json`),
    floodEvents: readOpt<FloodEvent[]>(`${city}/flood-events.json`),
    rainAreas: readOpt<RainSeries>(`${city}/rain-areas.json`),
    waterLevels: readOpt<WaterLevelStation[]>(`${city}/water-levels.json`),
    rainHourly: readOpt<HourlyRainEvent[]>(`${city}/rain-hourly.json`),
  };
}

const bangkok = cityInput("bangkok");
const hatyai = cityInput("hatyai");
const kinds = (steps: StoryStep[]) => steps.map((s) => s.kind);
const step = (steps: StoryStep[], k: StoryStep["kind"]) => steps.find((s) => s.kind === k);
const val = (m: MetricValue | undefined) => (m && m.provenance.status !== "unavailable" ? m.value : null);

function synthetic(n: number, over: (i: number, a: AreaRecord) => void = () => {}): CityDataset {
  const ds = structuredClone(bangkok.dataset);
  ds.areas = ds.areas.slice(0, n);
  ds.areas.forEach((a, i) => over(i, a));
  return ds;
}

describe("buildStory — Bangkok (real data)", () => {
  const steps = buildStory(bangkok, { webgl: true });

  it("produces a 6–8 step tour with unique, stable ids", () => {
    expect(steps.length).toBeGreaterThanOrEqual(STORY_MIN_STEPS);
    expect(steps.length).toBeLessThanOrEqual(STORY_MAX_STEPS);
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
    expect(steps[0].kind).toBe("overview");
    expect(steps[steps.length - 1].kind).toBe("explore");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildStory(bangkok, { webgl: true }))).toBe(JSON.stringify(steps));
  });

  it("follows the documented narrative order (flood event in range → per-capita step dropped to keep 8 steps)", () => {
    expect(kinds(steps)).toEqual(["overview", "topWaste", "waterways", "neighbourhood3d", "heavyRain", "combinedStress", "floodEvent", "explore"]);
    const noEvents = buildStory({ ...bangkok, floodEvents: [] }, { webgl: true });
    expect(kinds(noEvents)).toEqual(["overview", "topWaste", "topPerCapita", "waterways", "neighbourhood3d", "heavyRain", "combinedStress", "explore"]);
  });

  it("tells the latest documented Bangkok flood inside the rainfall record with its observed gauge peak", () => {
    const s = step(steps, "floodEvent")!;
    const evs = (bangkok.floodEvents ?? []).filter((e) => e.from >= bangkok.rainAreas!.dates[0] && e.to <= bangkok.rainAreas!.dates[bangkok.rainAreas!.dates.length - 1]);
    const latest = evs.sort((a, b) => (a.from < b.from ? 1 : -1))[0];
    expect(s.title.en).toBe(latest.titleEn);
    const peak = s.metrics.find((m) => m.id === "eventPeak")!.metric;
    expect(peak.provenance.status).toBe("observed");
    expect(peak.value).toBe(latest.peakRainMm!.value);
    expect(s.view.dateIndex).not.toBeNull();
  });

  it("picks the district with the highest collected waste and shows its observed value", () => {
    const s = step(steps, "topWaste")!;
    const best = argmaxArea(bangkok.dataset.areas, (a) => val(a.metrics.wasteCollected))!;
    expect(s.view.areaId).toBe(best.area.id);
    expect(s.view.choropleth).toBe("wasteVolume");
    const m = s.metrics.find((x) => x.id === "areaWaste")!.metric;
    expect(m.provenance.status).toBe("observed");
    expect(m.value).toBe(best.v);
    const share = s.metrics.find((x) => x.id === "share")!.metric;
    expect(share.provenance.status).toBe("derived");
    expect(share.value).toBeCloseTo((best.v / bangkok.dataset.totals.wasteCollected.value!) * 100, 1);
  });

  it("picks the highest per-capita district with a derived status", () => {
    const s = step(buildStory({ ...bangkok, floodEvents: [] }, { webgl: true }), "topPerCapita")!;
    const best = argmaxArea(bangkok.dataset.areas, (a) => val(a.metrics.wastePerCapita))!;
    expect(s.view.areaId).toBe(best.area.id);
    expect(s.view.choropleth).toBe("wastePerCapita");
    expect(s.status).toBe("derived");
  });

  it("flies to the most exposed area in the 3D neighbourhood view", () => {
    const s = step(steps, "neighbourhood3d")!;
    const best = argmaxArea(bangkok.dataset.areas, (a) => val(a.metrics.floodExposure))!;
    expect(s.view).toMatchObject({ areaId: best.area.id, viewMode: "3d", threeScope: "neighborhood" });
  });

  it("labels scenario steps as simulated and matches the model summary", () => {
    const heavy = step(steps, "heavyRain")!;
    expect(heavy.status).toBe("simulated");
    expect(heavy.view.scenario).toBe("heavyRain");
    for (const m of heavy.metrics) expect(m.metric.provenance.status).toBe("simulated");
    const base = cityRiskSummary(bangkok.dataset.areas, BASELINE_SCENARIO);
    const hr = cityRiskSummary(bangkok.dataset.areas, SCENARIO_PRESETS.heavyRain.params);
    expect(heavy.metrics.find((m) => m.id === "riskBaseline")!.metric.value).toBe(base.meanScore);
    expect(heavy.metrics.find((m) => m.id === "riskHeavy")!.metric.value).toBe(hr.meanScore);
    expect(hr.meanScore!).toBeGreaterThan(base.meanScore!);

    const combined = step(steps, "combinedStress")!;
    expect(combined.view.scenario).toBe("combinedStress");
    expect(combined.view.choropleth).toBe("floodRisk");
    for (const m of combined.metrics) expect(m.metric.provenance.status).toBe("simulated");
  });

  it("starts and ends on the baseline with nothing selected", () => {
    for (const s of [steps[0], steps[steps.length - 1]]) {
      expect(s.view).toMatchObject({ scenario: "baseline", areaId: null, dateIndex: null, viewMode: "2d" });
    }
  });

  it("never presents a missing value as a number", () => {
    for (const s of steps) {
      for (const m of s.metrics) {
        if (m.metric.value === null) expect(m.metric.provenance.status).toBe("unavailable");
        else expect(Number.isFinite(m.metric.value)).toBe(true);
      }
    }
  });

  it("degrades the 3D steps to the 2D map without WebGL", () => {
    const flat = buildStory(bangkok, { webgl: false });
    for (const s of flat) expect(s.view.viewMode).toBe("2d");
    expect(step(flat, "neighbourhood3d")!.body.en).toMatch(/WebGL is unavailable/);
  });
});

describe("buildStory — Hat Yai (real data)", () => {
  const steps = buildStory(hatyai, { webgl: true });

  it("stays within 6–8 steps", () => {
    expect(steps.length).toBeGreaterThanOrEqual(STORY_MIN_STEPS);
    expect(steps.length).toBeLessThanOrEqual(STORY_MAX_STEPS);
  });

  it("skips the per-capita step: zone waste is allocated by population, so per capita does not vary", () => {
    expect(hasSpread(hatyai.dataset.areas.map((a) => a.metrics.wastePerCapita.value))).toBe(false);
    expect(step(steps, "topPerCapita")).toBeUndefined();
  });

  it("labels allocated zone waste as an estimate", () => {
    const s = step(steps, "topWaste")!;
    expect(s.status).toBe("estimated");
    expect(s.note?.en).toMatch(/estimate/i);
  });

  it("includes the November 2025 flood via the historical timeline date", () => {
    const s = step(steps, "floodEvent")!;
    expect(s).toBeDefined();
    expect(s.view.scenario).toBe("baseline");
    expect(s.view.choropleth).toBe("rainEstimated");
    const day = hatyai.rainAreas!.dates[s.view.dateIndex!];
    expect(day >= "2025-11-19" && day <= "2025-11-28").toBe(true);
    // the gauge peak stays observed; the reanalysis mean keeps the series' own status
    expect(s.metrics.find((m) => m.id === "eventPeak")!.metric.provenance.status).toBe("observed");
    expect(s.metrics.find((m) => m.id === "dayMean")!.metric.provenance.status).toBe(hatyai.rainAreas!.provenance.status);
    // the flood step comes after the scenarios and before the closing step
    expect(kinds(steps).indexOf("floodEvent")).toBe(steps.length - 2);
  });

  it("formats Thai dates in the Buddhist era", () => {
    expect(step(steps, "floodEvent")!.body.th).toMatch(/2568/);
  });

  it("marks the approximate zone geometry in the overview", () => {
    expect(steps[0].note?.en).toMatch(/approximate/);
  });
});

describe("flood events outside the rainfall record", () => {
  const rain = hatyai.rainAreas!;
  const outside: FloodEvent = {
    id: "bkk-flood-2011",
    cityId: "bangkok",
    titleTh: "มหาอุทกภัย พ.ศ. 2554",
    titleEn: "2011 Great Flood",
    from: "2011-10-01",
    to: "2011-12-15",
    summaryTh: "",
    summaryEn: "",
    sourceId: "x",
  };

  it("partitions events by the daily record", () => {
    const p = partitionFloodEvents([outside, ...(hatyai.floodEvents ?? [])], rain);
    expect(p.outOfRange.map((e) => e.id)).toEqual(["bkk-flood-2011"]);
    expect(p.inRange.every((r) => r.from <= r.peak && r.peak <= r.to)).toBe(true);
  });

  it("never turns an out-of-range event into a timeline step, but mentions it at the end", () => {
    const steps = buildStory({ ...bangkok, floodEvents: [outside] }, { webgl: true });
    expect(step(steps, "floodEvent")).toBeUndefined();
    expect(step(steps, "explore")!.note?.en).toContain("2011 Great Flood");
  });
});

describe("robustness", () => {
  it("skips steps whose data is missing instead of inventing values", () => {
    const ds = synthetic(6, (_, a) => {
      a.metrics.floodExposure = { value: null, unit: "index", provenance: { status: "unavailable" } };
    });
    const steps = buildStory({ dataset: ds }, { webgl: true });
    expect(step(steps, "neighbourhood3d")).toBeUndefined();
    expect(steps[0].kind).toBe("overview");
    expect(steps[steps.length - 1].kind).toBe("explore");
  });

  it("returns an empty tour for an empty dataset", () => {
    expect(buildStory({ dataset: synthetic(0) }, { webgl: true })).toEqual([]);
  });

  it("caps the tour at 8 steps by dropping optional steps first", () => {
    const rainHy = hatyai.rainAreas!;
    const ev: FloodEvent = { ...(hatyai.floodEvents ?? [])[0], cityId: "bangkok" };
    const rainBkk: RainSeries = { ...rainHy, cityId: "bangkok", series: bangkok.rainAreas!.series };
    const steps = buildStory({ ...bangkok, floodEvents: [ev], rainAreas: rainBkk }, { webgl: true });
    expect(steps.length).toBe(STORY_MAX_STEPS);
    expect(step(steps, "floodEvent")).toBeDefined();
    expect(step(steps, "topPerCapita")).toBeUndefined();
  });

  it("finds hourly events that cover a day", () => {
    const ev: HourlyRainEvent = {
      id: "h",
      cityId: "hatyai",
      titleTh: "",
      titleEn: "",
      lon: 0,
      lat: 0,
      times: ["2025-11-20T00:00:00+07:00", "2025-11-22T23:00:00+07:00"],
      values: [1, 2],
      provenance: { status: "estimated" },
    };
    expect(hourlyEventsOn([ev], "2025-11-21")).toHaveLength(1);
    expect(hourlyEventsOn([ev], "2025-11-23")).toHaveLength(0);
    expect(hourlyEventsOn(null, "2025-11-21")).toHaveLength(0);
  });

  it("hasSpread needs ≥ 3 values that differ by more than 1 %", () => {
    expect(hasSpread([1, 1.005, 1.009])).toBe(false);
    expect(hasSpread([1, 2])).toBe(false);
    expect(hasSpread([1, 1.5, null, 2])).toBe(true);
  });
});
