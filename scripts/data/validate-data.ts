/**
 * validate-data.ts — integrity checks for the generated public datasets.
 *
 *   npx tsx scripts/data/validate-data.ts
 *
 * Exits non-zero when any ERROR is found. WARNINGs (e.g. building windows not fetched yet, a stale
 * manifest entry for a building window rewritten after the build) do not fail the run.
 *
 * Schemas: src/lib/validation/schemas.ts (zod, mirroring src/lib/types.ts).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { z } from "zod";
import {
  AreaFeatureCollectionSchema,
  BuildingWindowSchema,
  CityDatasetSchema,
  CommunityFeatureCollectionSchema,
  HourlyRainEventSchema,
  WaterLevelStationSchema,
  FloodEventSchema,
  GenericFeatureCollectionSchema,
  ManifestSchema,
  METRIC_KEYS,
  RainSeriesSchema,
  RainStationSchema,
  SourceRefSchema,
  WASTE_CATEGORIES,
} from "../../src/lib/validation/schemas";
import { BASELINE_SCENARIO, DEFAULT_ASSUMPTIONS, computeAreaRisk } from "../../src/lib/simulation/model";
import type { CityDataset, CityId, DataProvenance, RainSeries, YearValue } from "../../src/lib/types";

const ROOT = path.resolve(__dirname, "..", "..");
const PUB = path.join(ROOT, "public", "data");
const CITIES: CityId[] = ["bangkok", "hatyai"];
const MB = 1024 * 1024;

const errors: string[] = [];
const warnings: string[] = [];
let checks = 0;
const err = (m: string) => errors.push(m);
const warn = (m: string) => warnings.push(m);
function check(cond: boolean, msg: string) {
  checks++;
  if (!cond) err(msg);
  return cond;
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;

function readJson(rel: string): unknown {
  const p = path.join(PUB, rel);
  if (!fs.existsSync(p)) {
    err(`${rel}: missing`);
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    err(`${rel}: invalid JSON (${(e as Error).message})`);
    return undefined;
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.infer<S> | undefined {
  checks++;
  const r = schema.safeParse(data);
  if (!r.success) {
    for (const i of r.error.issues.slice(0, 12)) err(`${label}: ${i.path.join(".") || "(root)"} — ${i.message}`);
    if (r.error.issues.length > 12) err(`${label}: … ${r.error.issues.length - 12} more schema issues`);
    return undefined;
  }
  return r.data;
}

/* ---------------------------------------------------------------- sources */

const sourcesRaw = readJson("sources.json");
const sources = parse(SourceRefSchema.array(), sourcesRaw, "sources.json") ?? [];
const sourceIds = new Set<string>();
for (const s of sources) {
  check(!sourceIds.has(s.id), `sources.json: duplicate id "${s.id}"`);
  sourceIds.add(s.id);
}
const referenced = new Map<string, string>(); // sourceId → first place used
const noteSourceRef = (id: string | undefined, where: string) => {
  if (id && !referenced.has(id)) referenced.set(id, where);
};
function checkProvenance(p: DataProvenance, where: string) {
  noteSourceRef(p.sourceId, where);
  if (p.status !== "unavailable") check(!!p.sourceId, `${where}: status "${p.status}" without sourceId`);
  check(!!p.methodology || p.status === "observed", `${where}: no methodology for a ${p.status} value`);
  if (p.observedFrom && p.observedTo) check(p.observedFrom.slice(0, 10) <= p.observedTo.slice(0, 10), `${where}: observedFrom ${p.observedFrom} after observedTo ${p.observedTo}`);
  if (p.referenceYear !== undefined) check(p.referenceYear >= 1990 && p.referenceYear <= 2030, `${where}: implausible referenceYear ${p.referenceYear}`);
}

/* ---------------------------------------------------------------- helpers */

function annualMeanOf(dates: string[], values: (number | null)[]) {
  const by = new Map<number, { s: number; n: number; nulls: number }>();
  dates.forEach((d, i) => {
    const y = Number(d.slice(0, 4));
    const e = by.get(y) ?? { s: 0, n: 0, nulls: 0 };
    const v = values[i];
    if (v === null || v === undefined) e.nulls++;
    else e.s += v;
    e.n++;
    by.set(y, e);
  });
  const tot: number[] = [];
  for (const [y, e] of by) {
    const diy = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
    if (e.n === diy && e.nulls === 0) tot.push(Math.round(e.s * 10) / 10);
  }
  return tot.length ? tot.reduce((a, b) => a + b, 0) / tot.length : null;
}

function inBbox(lon: number, lat: number, bb: number[], pad: number) {
  return lon >= bb[0] - pad && lon <= bb[2] + pad && lat >= bb[1] - pad && lat <= bb[3] + pad;
}

function forEachPosition(coords: unknown, fn: (lon: number, lat: number) => void) {
  if (!Array.isArray(coords)) return;
  if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
    fn(coords[0], coords[1]);
    return;
  }
  for (const c of coords) forEachPosition(c, fn);
}

/* ---------------------------------------------------------------- per city */

const summary: string[] = [];
const summaryExtra: string[] = [];

for (const city of CITIES) {
  const L = (s: string) => `${city}/${s}`;
  const ds = parse(CityDatasetSchema, readJson(L("areas.json")), L("areas.json")) as CityDataset | undefined;
  const geo = parse(AreaFeatureCollectionSchema, readJson(L("areas.geojson")), L("areas.geojson"));
  const rainGridRaw = readJson(L("rain-grid.json"));
  const rainGrid = parse(RainSeriesSchema, rainGridRaw, L("rain-grid.json")) as RainSeries | undefined;
  const rainAreas = parse(RainSeriesSchema, readJson(L("rain-areas.json")), L("rain-areas.json")) as RainSeries | undefined;
  const floods = parse(FloodEventSchema.array(), readJson(L("flood-events.json")), L("flood-events.json"));
  const stations = parse(RainStationSchema.array(), readJson(L("stations.json")), L("stations.json"));
  if (!ds) continue;
  check(ds.city.id === city, `${L("areas.json")}: city.id is ${ds.city.id}`);
  const bb = ds.city.bbox;

  /* -- areas: counts, ids, codes, fids */
  const ids = ds.areas.map((a) => a.id);
  check(new Set(ids).size === ids.length, `${L("areas.json")}: duplicate area ids`);
  const fids = ds.areas.map((a) => a.fid);
  check(new Set(fids).size === fids.length, `${L("areas.json")}: duplicate fids`);
  check(
    [...fids].sort((a, b) => a - b).every((f, i) => f === i + 1),
    `${L("areas.json")}: fids are not 1..${fids.length}`,
  );
  if (city === "bangkok") {
    check(ds.areas.length === 50, `bangkok: expected 50 districts, found ${ds.areas.length}`);
    const codes = ds.areas.map((a) => a.code ?? "");
    check(new Set(codes).size === 50, "bangkok: district codes are not unique");
    const expected = Array.from({ length: 50 }, (_, i) => String(1001 + i));
    check(expected.every((c) => codes.includes(c)), "bangkok: codes do not cover 1001–1050");
    for (const a of ds.areas) check(a.id === `bkk-${a.code}` && a.kind === "district", `bangkok: area ${a.id} id/code/kind mismatch`);
  } else {
    check(ds.areas.length === 4, `hatyai: expected 4 zones, found ${ds.areas.length}`);
    check(["hy-z1", "hy-z2", "hy-z3", "hy-z4"].every((id) => ids.includes(id)), "hatyai: zone ids are not hy-z1..hy-z4");
    for (const a of ds.areas) check(a.kind === "community-zone", `hatyai: ${a.id} kind ${a.kind}`);
  }

  /* -- provenance on every metric (areas + totals + composition) */
  const allMetrics: { where: string; m: CityDataset["totals"] }[] = [...ds.areas.map((a) => ({ where: `${city}:${a.id}`, m: a.metrics })), { where: `${city}:totals`, m: ds.totals }];
  for (const { where, m } of allMetrics) {
    for (const k of METRIC_KEYS) {
      const v = m[k];
      checkProvenance(v.provenance, `${where}.${k}`);
    }
  }
  checkProvenance(ds.composition.provenance, `${city}:composition`);
  for (const a of ds.areas) if (a.composition) checkProvenance(a.composition.provenance, `${city}:${a.id}.composition`);
  // all rainfall metrics must state the coarse-reanalysis limitation
  for (const { where, m } of allMetrics)
    for (const k of ["rainfallAnnual", "rainfall24h"] as const) {
      const lim = m[k].provenance.limitations ?? [];
      if (m[k].provenance.status !== "unavailable") check(lim.some((s) => /not resolved/i.test(s)), `${where}.${k}: missing the ERA5 spatial-resolution limitation`);
    }

  /* -- composition sums */
  const compCheck = (c: CityDataset["composition"], where: string) => {
    if (c.provenance.status === "unavailable") {
      check(WASTE_CATEGORIES.every((k) => (c.shares as Record<string, number | null>)[k] === null), `${where}: unavailable composition must have null shares`);
      return;
    }
    const sum = WASTE_CATEGORIES.reduce((s, k) => s + (c.shares[k] as number), 0);
    check(near(sum, 100, 0.05), `${where}: composition sums to ${sum}`);
  };
  compCheck(ds.composition, `${city}:composition`);
  for (const a of ds.areas) if (a.composition) compCheck(a.composition, `${city}:${a.id}.composition`);
  for (const a of ds.areas) {
    if (!a.composition || a.composition.provenance.status === "unavailable") continue;
    // an area composition that is not a measurement of the area must be labelled as an estimate
    const sameAsCity = WASTE_CATEGORIES.every((k) => a.composition!.shares[k] === ds.composition.shares[k]);
    if (sameAsCity) check(a.composition.provenance.status === "estimated", `${city}:${a.id}.composition equals the citywide shares but is labelled "${a.composition.provenance.status}" (must be "estimated")`);
  }

  /* -- geometry: areas.geojson ↔ areas.json */
  const geoById = new Map<string, Feature<Polygon | MultiPolygon>>();
  if (geo) {
    check(geo.features.length === ds.areas.length, `${L("areas.geojson")}: ${geo.features.length} features vs ${ds.areas.length} areas`);
    for (const f of geo.features) geoById.set(f.properties.id, f as unknown as Feature<Polygon | MultiPolygon>);
    for (const a of ds.areas) {
      const f = geoById.get(a.id);
      if (!check(!!f, `${L("areas.geojson")}: no feature for ${a.id}`) || !f) continue;
      const p = f.properties as unknown as { fid: number; nameTh: string; nameEn: string; geometryStatus: string };
      check(p.fid === a.fid && p.nameTh === a.nameTh && p.nameEn === a.nameEn && p.geometryStatus === a.geometryStatus, `${L("areas.geojson")}: ${a.id} properties differ from areas.json`);
      let valid = false;
      try {
        valid = turf.booleanValid(f);
      } catch {
        valid = false;
      }
      check(valid, `${L("areas.geojson")}: ${a.id} geometry is not valid`);
      let outside = 0;
      forEachPosition(f.geometry.coordinates, (lon, lat) => {
        if (!inBbox(lon, lat, bb, 1e-4)) outside++;
      });
      check(outside === 0, `${L("areas.geojson")}: ${a.id} has ${outside} vertices outside city bbox`);
      const km2 = turf.area(f) / 1e6;
      const am = a.metrics.areaKm2.value;
      check(am !== null && near(am, km2, 0.0011), `${city}:${a.id}: areaKm2 ${am} ≠ polygon ${km2.toFixed(4)}`);
      check(turf.booleanPointInPolygon(turf.point(a.anchor), f, { ignoreBoundary: true }), `${city}:${a.id}: anchor ${a.anchor.join(",")} is not strictly inside its polygon`);
      if (a.geometryStatus === "approximate") check((a.notesEn ?? []).some((n) => /approximate/i.test(n)), `${city}:${a.id}: approximate geometry not flagged in notes`);
    }
  }
  if (city === "bangkok" && geo) {
    const tot = geo.features.reduce((s, f) => s + turf.area(f as unknown as Feature<Polygon>) / 1e6, 0);
    check(Math.abs(tot - 1568.737) / 1568.737 < 0.03, `bangkok: union area ${tot.toFixed(1)} km² not within 3% of 1,568.737 km²`);
  }
  if (city === "hatyai") {
    const mun = readJson(L("municipality.geojson")) as { features?: Feature<Polygon | MultiPolygon>[] } | undefined;
    const mf = mun?.features?.[0];
    if (mf && geo) {
      const ma = turf.area(mf) / 1e6;
      const za = geo.features.reduce((s, f) => s + turf.area(f as unknown as Feature<Polygon>) / 1e6, 0);
      check(near(za, ma, 0.001), `hatyai: zones (${za.toFixed(4)} km²) do not tile the municipality (${ma.toFixed(4)} km²)`);
    }
  }

  /* -- derived-value recomputation */
  for (const { where, m } of allMetrics) {
    const pop = m.population.value,
      area = m.areaKm2.value,
      col = m.wasteCollected.value;
    if (pop !== null && area) check(m.populationDensity.value !== null && near(m.populationDensity.value, pop / area, 0.051), `${where}: populationDensity ${m.populationDensity.value} ≠ ${(pop / area).toFixed(2)}`);
    if (col !== null && pop) check(m.wastePerCapita.value !== null && near(m.wastePerCapita.value, (col * 1000) / pop, 0.0011), `${where}: wastePerCapita ${m.wastePerCapita.value} ≠ ${((col * 1000) / pop).toFixed(4)}`);
    else check(m.wastePerCapita.value === null, `${where}: wastePerCapita present without waste/population`);
    if (col !== null && area) check(m.wasteDensity.value !== null && near(m.wasteDensity.value, col / area, 0.0011), `${where}: wasteDensity ${m.wasteDensity.value} ≠ ${(col / area).toFixed(4)}`);
    for (const k of ["floodExposure", "obstructionSusceptibility"] as const) {
      const v = m[k].value;
      if (v !== null) check(v >= 0 && v <= 1, `${where}.${k}: ${v} outside 0–1`);
    }
    const ds2 = m.drainageStress.value,
      r = m.modeledFloodRisk.value;
    if (ds2 !== null) check(ds2 >= 0 && ds2 <= 100, `${where}.drainageStress ${ds2} outside 0–100`);
    if (r !== null) check(r >= 0 && r <= 100, `${where}.modeledFloodRisk ${r} outside 0–100`);
    if (m.wastePerCapita.value !== null && (m.wastePerCapita.value < 0.2 || m.wastePerCapita.value > 10)) warn(`${where}: wastePerCapita ${m.wastePerCapita.value} kg/person/day looks implausible`);
    if (m.wastePerCapita.value !== null && m.population.provenance.referenceYear !== m.wasteCollected.provenance.referenceYear) {
      check((m.wastePerCapita.provenance.limitations ?? []).some((s) => /cross-period/i.test(s)), `${where}: wastePerCapita mixes years without a cross-period limitation`);
    }
  }

  /* -- totals vs areas */
  const sumOf = (k: (typeof METRIC_KEYS)[number]) => ds.areas.reduce((s, a) => s + (a.metrics[k].value ?? 0), 0);
  const allHave = (k: (typeof METRIC_KEYS)[number]) => ds.areas.every((a) => a.metrics[k].value !== null);
  if (city === "bangkok") {
    check(allHave("population") && ds.totals.population.value === sumOf("population"), `bangkok: population total ${ds.totals.population.value} ≠ sum of districts ${sumOf("population")}`);
    const sw = sumOf("wasteCollected");
    const tw = ds.totals.wasteCollected.value ?? 0;
    check(tw >= sw - 0.05, `bangkok: city collected ${tw} below district sum ${sw.toFixed(2)}`);
    check(
      (ds.totals.wasteCollected.provenance.limitations ?? []).some((s) => /Others/.test(s)) || near(tw, sw, 0.05),
      "bangkok: city waste total differs from district sum without saying so",
    );
  } else {
    for (const k of ["wasteCollected", "wasteGenerated"] as const) {
      const t = ds.totals[k].value;
      if (t === null) continue;
      check(allHave(k) && near(sumOf(k), t, 0.05), `hatyai: zone ${k} sum ${sumOf(k).toFixed(2)} ≠ municipality total ${t}`);
      for (const a of ds.areas) check(a.metrics[k].provenance.status === "estimated", `hatyai:${a.id}.${k}: allocated value must be "estimated"`);
    }
  }
  check(near(ds.totals.areaKm2.value ?? 0, sumOf("areaKm2"), 0.01), `${city}: total area ${ds.totals.areaKm2.value} ≠ sum of areas ${sumOf("areaKm2").toFixed(3)}`);

  /* -- waste generated: allocations must add up to the sourced city total and be labelled as estimates */
  {
    const tg = ds.totals.wasteGenerated.value;
    if (tg !== null && allHave("wasteGenerated")) {
      check(near(sumOf("wasteGenerated"), tg, 0.05), `${city}: area wasteGenerated sum ${sumOf("wasteGenerated").toFixed(2)} ≠ city total ${tg}`);
      for (const a of ds.areas) check(a.metrics.wasteGenerated.provenance.status === "estimated", `${city}:${a.id}.wasteGenerated: allocated value must be "estimated"`);
    }
    // the modelled accumulation stock must use generated waste as inflow whenever it exists (same rule as the UI)
    for (const a of ds.areas) {
      const meth = a.metrics.wasteAccumulated.provenance.methodology ?? "";
      if (a.metrics.wasteGenerated.value !== null) check(/inflow = wasteGenerated/.test(meth), `${city}:${a.id}.wasteAccumulated does not use wasteGenerated as inflow`);
      for (const k of ["wastePerCapita", "wasteDensity"] as const) {
        const pv = a.metrics[k].provenance;
        if (a.metrics[k].value !== null) check(/COLLECTED/.test(pv.methodology ?? ""), `${city}:${a.id}.${k}: methodology does not state the waste measure (collected)`);
      }
    }
    // per-year additivity of the history series (areas → city) where every area has a value
    const additive = (key: "wasteHistory" | "wasteGeneratedHistory", cityHist: YearValue[] | undefined, tol: number, label: string) => {
      if (!cityHist?.length) return;
      for (const y of cityHist) {
        if (y.value === null) continue;
        const vals = ds.areas.map((a) => (a[key] ?? []).find((h) => h.year === y.year)?.value ?? null);
        if (vals.some((v) => v === null)) continue;
        const sum = (vals as number[]).reduce((s2, v) => s2 + v, 0);
        check(near(sum, y.value, tol), `${city}: ${label} ${y.year}: areas sum ${sum.toFixed(2)} ≠ city ${y.value}`);
      }
    };
    additive("wasteGeneratedHistory", ds.wasteGeneratedHistory, 0.05, "wasteGeneratedHistory");
    if (city === "hatyai") additive("wasteHistory", ds.wasteHistory, 0.05, "wasteHistory");
    for (const a of ds.areas) {
      const yrs = (a.wasteGeneratedHistory ?? []).map((h) => h.year);
      check(new Set(yrs).size === yrs.length, `${city}:${a.id}: duplicate years in wasteGeneratedHistory`);
      for (const h of a.wasteGeneratedHistory ?? []) if (h.value !== null) check(h.status === "estimated", `${city}:${a.id}: wasteGeneratedHistory ${h.year} is an allocation and must be "estimated"`);
    }
  }

  /* -- model consistency (baseline) */
  const annuals = ds.areas.map((a) => a.metrics.rainfallAnnual.value).filter((v): v is number => v !== null);
  const meanAnnual = annuals.length ? annuals.reduce((s, v) => s + v, 0) / annuals.length : null;
  for (const a of ds.areas) {
    const v = a.metrics.rainfallAnnual.value;
    const spatial = meanAnnual && v ? v / meanAnnual : 1;
    const r = computeAreaRisk(
      { floodExposure: a.metrics.floodExposure.value, obstructionSusceptibility: a.metrics.obstructionSusceptibility.value, rainSpatialFactor: spatial },
      BASELINE_SCENARIO,
      DEFAULT_ASSUMPTIONS,
    );
    check(r.score === a.metrics.modeledFloodRisk.value, `${city}:${a.id}: modeledFloodRisk ${a.metrics.modeledFloodRisk.value} ≠ model ${r.score}`);
    check(r.drainageStressPct === a.metrics.drainageStress.value, `${city}:${a.id}: drainageStress ${a.metrics.drainageStress.value} ≠ model ${r.drainageStressPct}`);
  }

  /* -- waste history */
  for (const a of ds.areas) {
    const years = a.wasteHistory.map((y) => y.year);
    check(new Set(years).size === years.length, `${city}:${a.id}: duplicate years in wasteHistory`);
  }
  const cy = ds.wasteHistory.map((y) => y.year);
  check(new Set(cy).size === cy.length, `${city}: duplicate years in city wasteHistory`);

  /* -- rainfall series */
  if (rainGrid && rainAreas) {
    check(rainAreas.kind === "area" && rainAreas.cityId === city, `${L("rain-areas.json")}: kind/cityId`);
    check(rainGrid.kind === "reanalysis-grid" && rainGrid.cityId === city, `${L("rain-grid.json")}: kind/cityId`);
    check(
      rainAreas.dates.length === rainGrid.dates.length && rainAreas.dates.every((d, i) => d === rainGrid.dates[i]),
      `${L("rain-areas.json")}: dates differ from rain-grid.json`,
    );
    const sIds = rainAreas.series.map((s) => s.id);
    check(sIds.length === ids.length && sIds.every((id, i) => id === ids[i]), `${L("rain-areas.json")}: series ids do not match area ids`);
    checkProvenance(rainAreas.provenance, L("rain-areas.json"));
    checkProvenance(rainGrid.provenance, L("rain-grid.json"));
    check(rainAreas.provenance.status === "estimated", `${L("rain-areas.json")}: status must be "estimated"`);
    for (const s of rainAreas.series) {
      const a = ds.areas.find((x) => x.id === s.id);
      if (!a) continue;
      const mean = annualMeanOf(rainAreas.dates, s.values);
      const m = a.metrics.rainfallAnnual.value;
      check(mean === null ? m === null : m !== null && near(m, mean, 0.06), `${city}:${a.id}: rainfallAnnual ${m} ≠ recomputed ${mean}`);
      if (m !== null && (m < 1000 || m > 3500)) warn(`${city}:${a.id}: rainfallAnnual ${m} mm outside the plausible 1000–3500 mm range`);
      const last = s.values[s.values.length - 1];
      check(a.metrics.rainfall24h.value === (last ?? null), `${city}:${a.id}: rainfall24h ${a.metrics.rainfall24h.value} ≠ last series value ${last}`);
      check(s.lon === a.anchor[0] && s.lat === a.anchor[1], `${city}:${a.id}: rain-areas series point is not the area anchor`);
      for (const v of s.values) if (v !== null && (v < 0 || v > 1000)) {
        err(`${city}:${a.id}: implausible daily rainfall ${v}`);
        break;
      }
    }
  }

  /* -- flood events & stations */
  for (const f of floods ?? []) {
    check(f.cityId === city, `${L("flood-events.json")}: ${f.id} has cityId ${f.cityId}`);
    check(f.from <= f.to, `${L("flood-events.json")}: ${f.id} from > to`);
    noteSourceRef(f.sourceId, `${city}:flood ${f.id}`);
    if (f.peakRainMm) checkProvenance(f.peakRainMm.provenance, `${city}:flood ${f.id}.peakRainMm`);
  }
  for (const s of stations ?? []) {
    noteSourceRef(s.rain24h.provenance.sourceId, `${city}:station ${s.id}`);
  }
  for (const f of (floods ?? []) as (typeof floods & object)[number][]) {
    const extra = f as unknown as { sourceIds?: string[]; peakValues?: { sourceId?: string; value?: number | null; status?: string }[] };
    for (const id of extra.sourceIds ?? []) noteSourceRef(id, `${city}:flood ${f.id}.sourceIds`);
    for (const pv of extra.peakValues ?? []) {
      noteSourceRef(pv.sourceId, `${city}:flood ${f.id}.peakValues`);
      if (pv.value === null || pv.value === undefined) check(pv.status === "unavailable", `${city}:flood ${f.id}: peak value without a number must be "unavailable"`);
    }
    if (f.peakRainMm) check(f.peakRainMm.value === null || f.peakRainMm.value >= 0, `${city}:flood ${f.id}: negative peakRainMm`);
  }

  /* -- water-level gauges (snapshot) */
  const levels = parse(WaterLevelStationSchema.array(), readJson(L("water-levels.json")), L("water-levels.json"));
  if (levels) {
    const wids = levels.map((w) => w.id);
    check(new Set(wids).size === wids.length, `${L("water-levels.json")}: duplicate station ids`);
    check(levels.length > 0, `${L("water-levels.json")}: no stations`);
    for (const w of levels) {
      const where = `${city}:water-level ${w.id}`;
      check(inBbox(w.lon, w.lat, bb, 0.2), `${where}: position ${w.lon},${w.lat} far outside the city bbox`);
      checkProvenance(w.waterLevel.provenance, `${where}.waterLevel`);
      check(w.waterLevel.provenance.status === "observed" || w.waterLevel.provenance.status === "unavailable", `${where}.waterLevel must be observed (snapshot) or unavailable`);
      if (w.bankLevel) checkProvenance(w.bankLevel.provenance, `${where}.bankLevel`);
      if (w.capacityPct) {
        checkProvenance(w.capacityPct.provenance, `${where}.capacityPct`);
        const v = w.capacityPct.value;
        if (v !== null && (v < -50 || v > 300)) warn(`${where}: capacityPct ${v}% looks implausible`);
        if (v !== null) check(w.waterLevel.value !== null && !!w.bankLevel && w.bankLevel.value !== null, `${where}: capacityPct without both water and bank levels`);
      }
      const lvl = w.waterLevel.value;
      if (lvl !== null && (lvl < -10 || lvl > 60)) err(`${where}: water level ${lvl} m MSL is implausible`);
    }
    const onRiver = (re: RegExp) => levels.some((w) => re.test(`${w.waterway ?? ""} ${w.nameTh ?? ""} ${w.nameEn}`));
    if (city === "bangkok") check(onRiver(/เจ้าพระยา|Chao ?Phraya/i), "bangkok: no Chao Phraya water-level gauge");
    if (city === "hatyai") check(onRiver(/อู่ตะเภา|U[- ]?Ta ?phao/i), "hatyai: no Khlong U-Taphao water-level gauge");
  }

  /* -- hourly rain events (reanalysis) */
  const hourly = parse(HourlyRainEventSchema.array(), readJson(L("rain-hourly.json")), L("rain-hourly.json"));
  for (const e of hourly ?? []) {
    const where = `${city}:rain-hourly ${e.id}`;
    check(e.cityId === city, `${where}: cityId ${e.cityId}`);
    check(inBbox(e.lon, e.lat, bb, 0.3), `${where}: point far outside the city bbox`);
    checkProvenance(e.provenance, where);
    check(e.provenance.status === "estimated", `${where}: reanalysis series must be "estimated"`);
    for (const v of e.values) if (v !== null && v > 300) {
      err(`${where}: implausible hourly rainfall ${v} mm`);
      break;
    }
  }

  /* -- other public layers */
  for (const layer of ["waterways.geojson", "drainage.geojson", ...(city === "hatyai" ? ["municipality.geojson", "communities.geojson"] : [])]) {
    const fc = parse(GenericFeatureCollectionSchema, readJson(L(layer)), L(layer));
    if (!fc) continue;
    let outside = 0;
    for (const f of fc.features) forEachPosition(f.geometry?.coordinates, (lon, lat) => {
      if (!inBbox(lon, lat, bb, 0.2)) outside++;
    });
    check(outside === 0, `${L(layer)}: ${outside} positions far outside the city bbox`);
    if (layer === "waterways.geojson") {
      const kinds = new Set(["river", "canal", "stream", "drain", "water-area"]);
      const bad = fc.features.filter((f) => !kinds.has(String((f.properties ?? {}).kind))).length;
      check(bad === 0, `${L(layer)}: ${bad} features without a valid kind`);
    }
    if (layer === "drainage.geojson") {
      const kinds = new Set(["pump-station", "gate", "monitoring", "retention", "other"]);
      const meta = (fc as unknown as { metadata?: { sourceIds?: string[] } }).metadata;
      for (const id of meta?.sourceIds ?? []) noteSourceRef(id, `${L(layer)} metadata`);
      const officialKeys = new Set<string>();
      let official = 0;
      for (const f of fc.features) {
        const p = (f.properties ?? {}) as Record<string, unknown>;
        check(kinds.has(String(p.kind)), `${L(layer)}: feature with invalid kind "${String(p.kind)}"`);
        const om = p.officialMatch as { sourceId?: string; distanceM?: number } | undefined;
        if (om) {
          noteSourceRef(om.sourceId, `${L(layer)} officialMatch`);
          check(typeof om.distanceM === "number" && om.distanceM <= 150, `${L(layer)}: officialMatch farther than 150 m (${om.distanceM})`);
        }
        if (p.source !== "bma-dds") continue;
        official++;
        const sid = typeof p.sourceId === "string" ? p.sourceId : undefined;
        check(!!sid && f.geometry?.type === "Point", `${L(layer)}: official feature without sourceId or not a Point`);
        noteSourceRef(sid, `${L(layer)} official feature`);
        const key = `${sid}#${String(p.ddsId)}`;
        check(!officialKeys.has(key), `${L(layer)}: duplicate official feature ${key}`);
        officialKeys.add(key);
        check(p.kind === "pump-station" || p.kind === "gate", `${L(layer)}: official feature ${key} has kind ${String(p.kind)}`);
        const cap = p.capacityM3s;
        check(cap === undefined || cap === null || (typeof cap === "number" && Number.isFinite(cap) && cap > 0), `${L(layer)}: official feature ${key} capacity ${String(cap)} is not a positive number or null`);
      }
      if (official) summaryExtra.push(`${city} drainage: ${official} official BMA DDS points + ${fc.features.length - official} OSM features`);
    }
  }

  /* -- Hat Yai communities: contract, zone membership, honest labelling */
  if (city === "hatyai") {
    const cf = parse(CommunityFeatureCollectionSchema, readJson(L("communities.geojson")), `${L("communities.geojson")} (CommunityProps)`);
    if (cf) {
      const cids = cf.features.map((f) => f.properties.id);
      check(new Set(cids).size === cids.length, `${L("communities.geojson")}: duplicate community ids`);
      const perZone = new Map<string, number>();
      const counts = { verified: 0, illustrative: 0 };
      for (const f of cf.features) {
        const p = f.properties as typeof f.properties & { labelTh?: string; labelEn?: string };
        const where = `${L("communities.geojson")}: ${p.id}`;
        counts[p.locationStatus]++;
        perZone.set(p.zoneId, (perZone.get(p.zoneId) ?? 0) + 1);
        check(p.zoneId === `hy-z${p.zoneNo}`, `${where}: zoneId ${p.zoneId} ≠ zoneNo ${p.zoneNo}`);
        noteSourceRef(p.sourceId, where);
        const zone = geoById.get(p.zoneId);
        if (check(!!zone, `${where}: unknown zone ${p.zoneId}`) && zone) {
          const inside = turf.booleanPointInPolygon(turf.point(f.geometry.coordinates), zone);
          if (p.locationStatus === "illustrative") check(inside, `${where}: illustrative point is outside its zone`);
          else if (!inside) warn(`${where}: verified point lies outside its approximate zone polygon`);
        }
        if (p.locationStatus === "illustrative") {
          check(/ตำแหน่งสาธิต/.test(p.labelTh ?? "") && /not a real location/i.test(p.labelEn ?? ""), `${where}: illustrative point is not labelled as a demonstration position`);
          check(/not a real location/i.test(p.method), `${where}: illustrative method does not say it is not a real location`);
        }
      }
      const zoneCounts = new Map(ds.areas.map((a) => [a.id, a.notesEn?.join(" ").match(/(\d+) communities in the official list/)?.[1]]));
      for (const [zid, n] of perZone) {
        const expected = zoneCounts.get(zid);
        if (expected !== undefined) check(Number(expected) === n, `${L("communities.geojson")}: ${zid} has ${n} communities, official list says ${expected}`);
      }
      const meta = (cf as unknown as { metadata?: { counts?: { total?: number; verified?: number; illustrative?: number } } }).metadata?.counts;
      if (meta) {
        check(meta.total === cf.features.length, `${L("communities.geojson")}: metadata total ${meta.total} ≠ ${cf.features.length} features`);
        check(meta.verified === counts.verified && meta.illustrative === counts.illustrative, `${L("communities.geojson")}: metadata counts differ from the features`);
      }
      summaryExtra.push(`hatyai communities: ${cf.features.length} (${counts.verified} verified, ${counts.illustrative} illustrative)`);
    }
  }

  /* -- building windows (warnings only) */
  let bwOk = 0,
    bwMissing = 0,
    bwEmpty = 0;
  for (const a of ds.areas) {
    const p = path.join(PUB, "buildings", `${a.id}.json`);
    if (!fs.existsSync(p)) {
      bwMissing++;
      continue;
    }
    const size = fs.statSync(p).size;
    if (size > 1.5 * MB) warn(`buildings/${a.id}.json is ${(size / MB).toFixed(2)} MB (> 1.5 MB)`);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      warn(`buildings/${a.id}.json: invalid JSON (${(e as Error).message}) — possibly being written`);
      continue;
    }
    const r = BuildingWindowSchema.safeParse(raw);
    if (!r.success) {
      warn(`buildings/${a.id}.json: schema — ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
      continue;
    }
    noteSourceRef(r.data.sourceId, `buildings/${a.id}.json`);
    if (r.data.areaId !== a.id) warn(`buildings/${a.id}.json: areaId ${r.data.areaId}`);
    if (r.data.buildings.length === 0) {
      bwEmpty++;
      warn(`buildings/${a.id}.json: 0 buildings`);
    } else bwOk++;
    const dx = (r.data.origin[0] - a.anchor[0]) * Math.cos((a.anchor[1] * Math.PI) / 180) * 111320;
    const dy = (r.data.origin[1] - a.anchor[1]) * 110574;
    const f = geoById.get(a.id);
    const originInside = f ? turf.booleanPointInPolygon(turf.point([Math.round(r.data.origin[0] * 1e6) / 1e6, Math.round(r.data.origin[1] * 1e6) / 1e6]), f, { ignoreBoundary: true }) : true;
    if (!originInside) warn(`${city}:${a.id}: building-window origin lies on/outside the polygon edge; the area anchor uses an interior label point instead (${Math.hypot(dx, dy).toFixed(0)} m away)`);
    else if (Math.hypot(dx, dy) > 5) warn(`${city}:${a.id}: anchor is ${Math.hypot(dx, dy).toFixed(0)} m from the building-window origin — re-run build-datasets after fetch-buildings`);
  }
  if (bwMissing) warn(`${city}: ${bwMissing}/${ds.areas.length} building windows not present yet (public/data/buildings/<areaId>.json)`);

  /* -- file sizes */
  for (const f of fs.readdirSync(path.join(PUB, city))) {
    const size = fs.statSync(path.join(PUB, city, f)).size;
    if (size > 3 * MB) warn(`${L(f)} is ${(size / MB).toFixed(2)} MB (> 3 MB)`);
  }

  summary.push(
    `${city}: ${ds.areas.length} areas, population ${ds.totals.population.value}, collected ${ds.totals.wasteCollected.value} t/day, per-capita ${ds.totals.wastePerCapita.value} kg/person/day, rain series ${rainAreas?.dates.length ?? 0} days, flood events ${floods?.length ?? 0}, building windows ${bwOk} ok / ${bwEmpty} empty / ${bwMissing} missing`,
  );
}

/* ---------------------------------------------------------------- source references */

for (const [id, where] of referenced) check(sourceIds.has(id), `sourceId "${id}" (used in ${where}) is not in sources.json`);

/* ---------------------------------------------------------------- manifest */

const manifest = parse(ManifestSchema, readJson("manifest.json"), "manifest.json");
if (manifest) {
  let stale = 0;
  for (const f of manifest.files) {
    const p = path.join(PUB, f.path);
    if (!fs.existsSync(p)) {
      err(`manifest.json: ${f.path} listed but missing`);
      continue;
    }
    const sha = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    if (sha !== f.sha256) {
      if (f.path.startsWith("buildings/")) stale++;
      else err(`manifest.json: sha256 mismatch for ${f.path} (re-run build-datasets)`);
    }
  }
  if (stale) warn(`manifest.json: ${stale} building window(s) changed after the build — re-run build-datasets to refresh the manifest`);
}

/* ---------------------------------------------------------------- report */

console.log("validate-data");
for (const s of [...summary, ...summaryExtra]) console.log(`  ${s}`);
console.log(`  sources: ${sources.length} (${referenced.size} referenced)`);
if (warnings.length) {
  console.log(`WARNINGS (${warnings.length}):`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length) {
  console.log(`ERRORS (${errors.length}):`);
  for (const e of errors) console.log(`  - ${e}`);
  console.log(`FAIL: ${errors.length} error(s), ${warnings.length} warning(s), ${checks} checks`);
  process.exit(1);
}
console.log(`PASS: ${checks} checks, 0 errors, ${warnings.length} warning(s)`);
