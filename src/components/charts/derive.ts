/**
 * Pure derivations used by the analytics panels. Nothing here invents a value: every number is
 * computed from dataset MetricValues / RainSeries / GeoJSON, and every result carries the status
 * the computation deserves (derived from sourced inputs, simulated for model outputs).
 */
import { bbox as turfBbox, booleanPointInPolygon } from "@turf/turf";
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon, Position } from "geojson";
import type { AreaRecord, CityDataset, DataProvenance, DataStatus, HourlyRainEvent, MetricValue, RainSeries, RainStation } from "@/lib/types";
import type { AreaScenario } from "@/lib/simulation/use-scenario";
import { areaMetric, type MetricId } from "@/lib/metrics";
import { distanceM } from "@/lib/geo/local";
import type { Bi } from "@/lib/i18n";

/* ------------------------------------------------------------------ */
/*  Metric helpers                                                     */
/* ------------------------------------------------------------------ */

export const UNAVAILABLE_METRIC = (unit: string): MetricValue => ({ value: null, unit, provenance: { status: "unavailable" } });

export function hasValue(m: MetricValue | null | undefined): m is MetricValue & { value: number } {
  return !!m && m.value !== null && Number.isFinite(m.value) && m.provenance.status !== "unavailable";
}

export function valueOf(m: MetricValue | null | undefined): number | null {
  return hasValue(m) ? m.value : null;
}

/** Safe accessor (datasets may be partial while the pipeline runs). */
export function metricOf(area: AreaRecord, id: MetricId): MetricValue | undefined {
  return area.metrics?.[id];
}

/** Model output wrapped as a MetricValue (status simulated, or unavailable when null). */
export function modelMetric(value: number | null, unit: string, provenance: Partial<DataProvenance> = {}): MetricValue {
  const ok = value !== null && Number.isFinite(value);
  return { value: ok ? value : null, unit, provenance: { ...provenance, status: ok ? "simulated" : "unavailable" } };
}

/** A value calculated from sourced inputs. Status follows the weakest input (estimated stays estimated). */
export function derivedMetric(value: number | null, unit: string, inputStatus: DataStatus, provenance: Partial<DataProvenance> = {}): MetricValue {
  const ok = value !== null && Number.isFinite(value);
  const status: DataStatus = !ok ? "unavailable" : inputStatus === "observed" ? "derived" : inputStatus;
  return { value: ok ? value : null, unit, provenance: { ...provenance, status } };
}

/**
 * Value for an area with live (scenario/historical) metrics taken from the model.
 * Observed data is never overwritten: live values are new MetricValues.
 */
export function liveAreaMetric(area: AreaRecord, id: MetricId, as: AreaScenario | undefined, rainDate: string | null): MetricValue {
  const base = metricOf(area, id);
  if (as && (id === "modeledFloodRisk" || id === "drainageStress")) {
    if (base) return areaMetric(area, id, { result: as.current });
    return id === "modeledFloodRisk" ? modelMetric(as.current.score, "score") : modelMetric(as.current.drainageStressPct, "%");
  }
  if (as && id === "rainfall24h" && rainDate) {
    if (base) return areaMetric(area, id, { result: as.current, rain24h: as.rain24h, rainDate });
  }
  return base ?? UNAVAILABLE_METRIC("");
}

export function baselineAreaMetric(area: AreaRecord, id: MetricId, as: AreaScenario | undefined): MetricValue {
  const base = metricOf(area, id);
  if (as && (id === "modeledFloodRisk" || id === "drainageStress")) {
    if (base) return areaMetric(area, id, { result: as.baseline });
    return id === "modeledFloodRisk" ? modelMetric(as.baseline.score, "score") : modelMetric(as.baseline.drainageStressPct, "%");
  }
  return base ?? UNAVAILABLE_METRIC("");
}

/** Mean of non-null area values for a metric (derived — the comparison reference for mini bars). */
export function areaMean(areas: AreaRecord[], id: MetricId): { mean: number | null; n: number; max: number | null } {
  let s = 0,
    n = 0,
    max: number | null = null;
  for (const a of areas) {
    const v = valueOf(metricOf(a, id));
    if (v === null) continue;
    s += v;
    n++;
    max = max === null ? v : Math.max(max, v);
  }
  return { mean: n ? s / n : null, n, max };
}

export interface RankedRow {
  area: AreaRecord;
  metric: MetricValue;
  value: number | null;
  rank: number | null;
}

/** Descending rank (1 = highest). Null values are kept at the end without a rank. */
export function rankAreas(areas: AreaRecord[], get: (a: AreaRecord) => MetricValue, dir: "desc" | "asc" = "desc"): RankedRow[] {
  const rows = areas.map((area) => {
    const metric = get(area);
    return { area, metric, value: valueOf(metric), rank: null as number | null };
  });
  const valued = rows.filter((r) => r.value !== null).sort((a, b) => (dir === "desc" ? b.value! - a.value! : a.value! - b.value!) || a.area.id.localeCompare(b.area.id));
  valued.forEach((r, i) => (r.rank = i + 1));
  const missing = rows.filter((r) => r.value === null).sort((a, b) => a.area.nameEn.localeCompare(b.area.nameEn));
  return [...valued, ...missing];
}

/* ------------------------------------------------------------------ */
/*  Rainfall series                                                    */
/* ------------------------------------------------------------------ */

/** Per-day arithmetic mean across series (null when every series is null that day). */
export function meanRainSeries(rs: RainSeries): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < rs.dates.length; i++) {
    let s = 0,
      n = 0;
    for (const ser of rs.series) {
      const v = ser.values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      s += v;
      n++;
    }
    out.push(n ? Math.round((s / n) * 10) / 10 : null);
  }
  return out;
}

export function areaRainSeries(rs: RainSeries | null | undefined, areaId: string): (number | null)[] | null {
  const s = rs?.series.find((x) => x.id === areaId);
  return s ? s.values : null;
}

/** Inclusive [start, end] window of `days` ending at `endIndex` (or the last index). */
export function rainWindow(length: number, endIndex: number | null | undefined, days: number): [number, number] {
  if (length <= 0) return [0, -1];
  const end = Math.min(length - 1, Math.max(0, endIndex ?? length - 1));
  return [Math.max(0, end - days + 1), end];
}

export function windowStats(values: (number | null)[], start: number, end: number) {
  let sum = 0,
    n = 0,
    max: number | null = null,
    maxIdx: number | null = null,
    wetDays = 0;
  for (let i = start; i <= end; i++) {
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    sum += v;
    n++;
    if (v >= 0.1) wetDays++;
    if (max === null || v > max) {
      max = v;
      maxIdx = i;
    }
  }
  return { sum: n ? Math.round(sum * 10) / 10 : null, n, max, maxIdx, wetDays, days: end - start + 1 };
}

/* ------------------------------------------------------------------ */
/*  Stations                                                           */
/* ------------------------------------------------------------------ */

export interface NearbyStation {
  station: RainStation;
  distanceKm: number;
}

export function nearbyStations(stations: RainStation[] | null | undefined, anchor: [number, number], radiusKm = 6): NearbyStation[] {
  if (!stations) return [];
  return stations
    .map((station) => ({ station, distanceKm: distanceM(anchor, [station.lon, station.lat]) / 1000 }))
    .filter((s) => s.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/* ------------------------------------------------------------------ */
/*  Waterways & drainage infrastructure (OpenStreetMap)                */
/* ------------------------------------------------------------------ */

const KIND_KEYS = ["kind", "waterway", "man_made", "type", "class", "fclass", "t", "category"] as const;

export function featureKind(props: Record<string, unknown> | null | undefined): string {
  if (!props) return "unknown";
  for (const k of KIND_KEYS) {
    const v = props[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "unknown";
}

const KIND_LABELS: Record<string, Bi> = {
  river: { th: "แม่น้ำ", en: "River" },
  canal: { th: "คลอง", en: "Canal" },
  stream: { th: "ลำน้ำ/ลำธาร", en: "Stream" },
  drain: { th: "รางระบายน้ำ", en: "Drain" },
  ditch: { th: "คูน้ำ", en: "Ditch" },
  culvert: { th: "ท่อลอด", en: "Culvert" },
  tidal_channel: { th: "ร่องน้ำขึ้นลง", en: "Tidal channel" },
  riverbank: { th: "ตลิ่ง/ผิวน้ำแม่น้ำ", en: "Riverbank" },
  water: { th: "แหล่งน้ำ", en: "Water body" },
  reservoir: { th: "อ่างเก็บน้ำ", en: "Reservoir" },
  basin: { th: "แก้มลิง/บ่อหน่วงน้ำ", en: "Retention basin" },
  pond: { th: "บ่อน้ำ", en: "Pond" },
  pumping_station: { th: "สถานีสูบน้ำ", en: "Pumping station" },
  pump: { th: "เครื่องสูบน้ำ", en: "Pump" },
  floodgate: { th: "ประตูระบายน้ำ", en: "Floodgate" },
  sluice_gate: { th: "ประตูระบายน้ำ", en: "Sluice gate" },
  lock_gate: { th: "ประตูน้ำ", en: "Lock gate" },
  weir: { th: "ฝาย", en: "Weir" },
  dam: { th: "เขื่อน", en: "Dam" },
  dyke: { th: "คันกั้นน้ำ", en: "Dyke" },
  embankment: { th: "คันกั้นน้ำ", en: "Embankment" },
  flood_wall: { th: "กำแพงกั้นน้ำ", en: "Flood wall" },
  tunnel: { th: "อุโมงค์ระบายน้ำ", en: "Drainage tunnel" },
  storm_drain: { th: "ท่อระบายน้ำฝน", en: "Storm drain" },
  wastewater_plant: { th: "โรงบำบัดน้ำเสีย", en: "Wastewater plant" },
  // drainage.geojson kinds (OSM-derived and the official BMA Drainage and Sewerage Department inventory)
  "pump-station": { th: "สถานีสูบน้ำ/บ่อสูบน้ำ", en: "Pump station / pump sump" },
  gate: { th: "ประตูระบายน้ำ", en: "Floodgate / sluice" },
  monitoring: { th: "สถานีวัดระดับน้ำ", en: "Water-level station" },
  retention: { th: "แก้มลิง/บ่อหน่วงน้ำ", en: "Retention basin" },
  other: { th: "โครงสร้างระบายน้ำอื่น ๆ", en: "Other drainage structure" },
  unknown: { th: "ไม่ระบุประเภท", en: "Unclassified" },
};

export function kindLabel(kind: string): Bi {
  return KIND_LABELS[kind] ?? { th: kind.replace(/_/g, " "), en: kind.replace(/_/g, " ") };
}

export interface KindCount {
  kind: string;
  count: number;
  /** Line length (km) for linear features, 0 for points/areas. */
  lengthKm: number;
}

type AreaPolygon = Feature<Polygon | MultiPolygon>;

function forEachLine(geom: Geometry | null | undefined, fn: (line: Position[]) => void) {
  if (!geom) return;
  switch (geom.type) {
    case "LineString":
      fn(geom.coordinates);
      break;
    case "MultiLineString":
      geom.coordinates.forEach(fn);
      break;
    case "GeometryCollection":
      geom.geometries.forEach((g) => forEachLine(g, fn));
      break;
    default:
      break;
  }
}

function representativePoint(geom: Geometry | null | undefined): [number, number] | null {
  if (!geom) return null;
  switch (geom.type) {
    case "Point":
      return [geom.coordinates[0], geom.coordinates[1]];
    case "MultiPoint":
    case "LineString":
      return geom.coordinates.length ? [geom.coordinates[0][0], geom.coordinates[0][1]] : null;
    case "MultiLineString":
    case "Polygon":
      return geom.coordinates[0]?.length ? [geom.coordinates[0][0][0], geom.coordinates[0][0][1]] : null;
    case "MultiPolygon":
      return geom.coordinates[0]?.[0]?.length ? [geom.coordinates[0][0][0][0], geom.coordinates[0][0][0][1]] : null;
    default:
      return null;
  }
}

function lineLengthKm(line: Position[]) {
  let m = 0;
  for (let i = 1; i < line.length; i++) m += distanceM([line[i - 1][0], line[i - 1][1]], [line[i][0], line[i][1]]);
  return m / 1000;
}

const bboxCache = new WeakMap<object, number[]>();
function cachedBbox(f: Feature): number[] {
  let b = bboxCache.get(f);
  if (!b) {
    b = turfBbox(f);
    bboxCache.set(f, b);
  }
  return b;
}
const bboxOverlap = (a: number[], b: number[]) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** City-wide feature counts and total line length per kind (no clipping). */
export function infrastructureByKind(fc: FeatureCollection | null | undefined): KindCount[] {
  if (!fc) return [];
  const map = new Map<string, KindCount>();
  for (const f of fc.features) {
    const kind = featureKind(f.properties as Record<string, unknown>);
    const row = map.get(kind) ?? { kind, count: 0, lengthKm: 0 };
    row.count++;
    forEachLine(f.geometry, (line) => (row.lengthKm += lineLengthKm(line)));
    map.set(kind, row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Waterway context for one area: line length inside the polygon (segments are subdivided to ≤150 m
 * pieces and kept when the piece midpoint falls inside — an approximation good to a few percent) and
 * feature counts by kind (a feature counts when any part lies inside).
 */
export function infrastructureInArea(fc: FeatureCollection | null | undefined, polygon: AreaPolygon | null): { totalKm: number; byKind: KindCount[] } | null {
  if (!fc || !polygon) return null;
  const pb = cachedBbox(polygon);
  const map = new Map<string, KindCount>();
  let totalKm = 0;
  for (const f of fc.features) {
    if (!f.geometry) continue;
    if (!bboxOverlap(cachedBbox(f), pb)) continue;
    const kind = featureKind(f.properties as Record<string, unknown>);
    let inside = false;
    let km = 0;
    let isLinear = false;
    forEachLine(f.geometry, (line) => {
      isLinear = true;
      for (let i = 1; i < line.length; i++) {
        const a: [number, number] = [line[i - 1][0], line[i - 1][1]];
        const b: [number, number] = [line[i][0], line[i][1]];
        const d = distanceM(a, b);
        const pieces = Math.max(1, Math.ceil(d / 150));
        for (let k = 0; k < pieces; k++) {
          const t = (k + 0.5) / pieces;
          const mid: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          if (mid[0] < pb[0] || mid[0] > pb[2] || mid[1] < pb[1] || mid[1] > pb[3]) continue;
          if (booleanPointInPolygon(mid, polygon)) {
            km += d / pieces / 1000;
            inside = true;
          }
        }
      }
    });
    if (!isLinear) {
      const p = representativePoint(f.geometry);
      inside = !!p && booleanPointInPolygon(p, polygon);
    }
    if (!inside) continue;
    const row = map.get(kind) ?? { kind, count: 0, lengthKm: 0 };
    row.count++;
    row.lengthKm += km;
    totalKm += km;
    map.set(kind, row);
  }
  return { totalKm, byKind: [...map.values()].sort((a, b) => b.count - a.count) };
}

export function areaPolygon(fc: FeatureCollection<Geometry, { id: string }> | null | undefined, areaId: string): AreaPolygon | null {
  const f = fc?.features.find((x) => x.properties?.id === areaId);
  if (!f || !f.geometry || (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")) return null;
  return f as AreaPolygon;
}

/* ------------------------------------------------------------------ */
/*  Dataset helpers                                                    */
/* ------------------------------------------------------------------ */

/** Nearest other area by anchor distance (default comparison partner). */
export function nearestArea(ds: CityDataset, area: AreaRecord): AreaRecord | null {
  let best: AreaRecord | null = null;
  let bestD = Infinity;
  for (const a of ds.areas) {
    if (a.id === area.id) continue;
    const d = distanceM(area.anchor, a.anchor);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

export function periodOf(p: DataProvenance | undefined): { from?: string; to?: string; year?: number } {
  if (!p) return {};
  return { from: p.observedFrom, to: p.observedTo, year: p.referenceYear };
}

/* ------------------------------------------------------------------ */
/*  Hourly rainfall events (reanalysis, status estimated)              */
/* ------------------------------------------------------------------ */

/** Local calendar date (YYYY-MM-DD) of an ISO datetime stamped in +07:00 (falls back to Date parsing). */
export function localDateOf(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?\+07:00$/.test(iso)) return iso.slice(0, 10);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** Local hour (0–23, Asia/Bangkok) of an ISO datetime. */
export function localHourOf(iso: string): number {
  if (/T\d{2}:/.test(iso) && iso.endsWith("+07:00")) return Number(iso.slice(11, 13));
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 0 : new Date(d.getTime() + 7 * 3600_000).getUTCHours();
}

export interface HourlyStats {
  /** Running total (mm) — null hours add nothing but keep the running value. */
  cumulative: number[];
  total: number | null;
  hours: number;
  validHours: number;
  peakIdx: number | null;
  peak: number | null;
  /** Maximum rolling 24-hour sum and the index of the hour that ends it. */
  max24: number | null;
  max24EndIdx: number | null;
  /** Distinct local dates covered, in order. */
  dates: string[];
  /** Daily totals (local day) — sums of the hourly values. */
  daily: { date: string; mm: number | null }[];
}

export function hourlyStats(ev: Pick<HourlyRainEvent, "times" | "values">): HourlyStats {
  const n = Math.min(ev.times.length, ev.values.length);
  const cumulative: number[] = [];
  let run = 0,
    valid = 0,
    peak: number | null = null,
    peakIdx: number | null = null;
  const dailyMap = new Map<string, { s: number; n: number }>();
  const dates: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = ev.values[i];
    // Daily grouping follows the source convention (Open-Meteo daily sum = hourly stamps 00:00–23:00 of that
    // local date), so these totals match the daily series used by the timeline.
    const day = localDateOf(ev.times[i]);
    if (!dates.includes(day)) dates.push(day);
    if (!dailyMap.has(day)) dailyMap.set(day, { s: 0, n: 0 });
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      run += v;
      valid++;
      const dm = dailyMap.get(day)!;
      dm.s += v;
      dm.n++;
      if (peak === null || v > peak) {
        peak = v;
        peakIdx = i;
      }
    }
    cumulative.push(Math.round(run * 10) / 10);
  }
  let max24: number | null = null,
    max24EndIdx: number | null = null,
    win = 0;
  for (let i = 0; i < n; i++) {
    const v = ev.values[i];
    win += v !== null && v !== undefined && Number.isFinite(v) ? v : 0;
    if (i >= 24) {
      const o = ev.values[i - 24];
      win -= o !== null && o !== undefined && Number.isFinite(o) ? o : 0;
    }
    if (i >= 23 && (max24 === null || win > max24)) {
      max24 = Math.round(win * 10) / 10;
      max24EndIdx = i;
    }
  }
  const daily = [...dailyMap.entries()].map(([date, x]) => ({ date, mm: x.n ? Math.round(x.s * 10) / 10 : null }));
  return { cumulative, total: valid ? Math.round(run * 10) / 10 : null, hours: n, validHours: valid, peakIdx, peak, max24, max24EndIdx, dates, daily };
}

/** First event whose local date range contains `date` (YYYY-MM-DD). */
export function eventForDate(events: HourlyRainEvent[] | null | undefined, date: string | null | undefined): HourlyRainEvent | null {
  if (!events || !date) return null;
  for (const ev of events) {
    if (!ev.times.length) continue;
    const from = localDateOf(ev.times[0]);
    const to = localDateOf(ev.times[ev.times.length - 1]);
    if (date >= from && date <= to) return ev;
  }
  return null;
}
