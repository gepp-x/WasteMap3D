/**
 * Pure transforms from the bundled datasets into lean GeoJSON for MapLibre.
 *
 * Input files are produced by a separate pipeline, so property names are read defensively and
 * normalised into a few short, always-present properties (`_i`, `_k`, `_w`, …). Expressions in the
 * layer specs therefore never hit a missing property (no runtime expression warnings), and the
 * full original feature stays available for tooltips through `items[_i]`.
 *
 * Nothing here invents values: geometry and names pass through, numbers stay inside MetricValues.
 */
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Point, Polygon, Position } from "geojson";
import { booleanPointInPolygon } from "@turf/turf";
import type { AreaFeatureProps } from "@/lib/data/loader";
import type { AreaRecord, DataStatus, MetricValue, RainSeries, RainStation } from "@/lib/types";

export type BBox = [number, number, number, number];

export const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

type Props = Record<string, unknown>;

function str(p: Props | null | undefined, ...keys: string[]): string | undefined {
  if (!p) return undefined;
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function finite(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/* ------------------------------------------------------------------ geometry helpers */

function eachPosition(g: Geometry | null | undefined, fn: (p: Position) => void) {
  if (!g) return;
  switch (g.type) {
    case "Point":
      fn(g.coordinates);
      break;
    case "MultiPoint":
    case "LineString":
      g.coordinates.forEach(fn);
      break;
    case "MultiLineString":
    case "Polygon":
      g.coordinates.forEach((r) => r.forEach(fn));
      break;
    case "MultiPolygon":
      g.coordinates.forEach((poly) => poly.forEach((r) => r.forEach(fn)));
      break;
    case "GeometryCollection":
      g.geometries.forEach((x) => eachPosition(x, fn));
      break;
  }
}

export function geometryBbox(g: Geometry | null | undefined): BBox | null {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  eachPosition(g, ([x, y]) => {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  });
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

const isPolygonal = (g: Geometry | null | undefined): g is Polygon | MultiPolygon => g?.type === "Polygon" || g?.type === "MultiPolygon";
const isLinear = (g: Geometry | null | undefined) => g?.type === "LineString" || g?.type === "MultiLineString";
const isPoint = (g: Geometry | null | undefined) => g?.type === "Point" || g?.type === "MultiPoint";

function representativePoint(g: Geometry | null | undefined): [number, number] | null {
  if (!g) return null;
  if (g.type === "Point") return [g.coordinates[0], g.coordinates[1]];
  const b = geometryBbox(g);
  return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
}

/* ------------------------------------------------------------------ areas */

/** Bounding box per area id (from the bundled polygons; used for camera focus). */
export function areaBboxes(areasGeo: FeatureCollection<Geometry, AreaFeatureProps> | null | undefined): Map<string, BBox> {
  const out = new Map<string, BBox>();
  for (const f of areasGeo?.features ?? []) {
    const id = f.properties?.id;
    const b = geometryBbox(f.geometry);
    if (id && b) out.set(id, b);
  }
  return out;
}

interface AreaIndexEntry {
  id: string;
  bbox: BBox;
  geom: Polygon | MultiPolygon;
}

/** Spatial index (bbox prefilter + exact point-in-polygon) mapping a coordinate to its area id. */
export function makeAreaLocator(areasGeo: FeatureCollection<Geometry, AreaFeatureProps> | null | undefined) {
  const entries: AreaIndexEntry[] = [];
  for (const f of areasGeo?.features ?? []) {
    const id = f.properties?.id;
    const b = geometryBbox(f.geometry);
    if (id && b && isPolygonal(f.geometry)) entries.push({ id, bbox: b, geom: f.geometry });
  }
  return (pt: [number, number] | null): string | null => {
    if (!pt) return null;
    const [x, y] = pt;
    for (const en of entries) {
      const [w, s, e, n] = en.bbox;
      if (x < w || x > e || y < s || y > n) continue;
      if (booleanPointInPolygon(pt, en.geom)) return en.id;
    }
    return null;
  };
}

/** Area anchor points (point-on-surface supplied by the dataset) for labels and hotspots. */
export function anchorsFC(areas: AreaRecord[]): FeatureCollection<Point, { fid: number; id: string; nameEn: string }> {
  return {
    type: "FeatureCollection",
    features: areas
      .filter((a) => Array.isArray(a.anchor) && Number.isFinite(a.anchor[0]) && Number.isFinite(a.anchor[1]))
      .map((a) => ({
        type: "Feature",
        properties: { fid: a.fid, id: a.id, nameEn: a.nameEn ?? "" },
        geometry: { type: "Point", coordinates: [a.anchor[0], a.anchor[1]] },
      })),
  };
}

/* ------------------------------------------------------------------ waterways */

export type WaterKind = "river" | "canal" | "stream" | "drain" | "other";

export interface WaterwayInfo {
  index: number;
  kind: WaterKind;
  /** 0 (ditch) … 3 (major river) */
  widthClass: 0 | 1 | 2 | 3;
  isArea: boolean;
  nameTh?: string;
  nameEn?: string;
}

export interface NormalizedWaterways {
  fc: FeatureCollection;
  items: WaterwayInfo[];
  lineCount: number;
  areaCount: number;
  kinds: Set<WaterKind>;
}

function waterKind(raw: string | undefined): WaterKind {
  const k = (raw ?? "").toLowerCase();
  if (/river|แม่น้ำ/.test(k)) return "river";
  if (/canal|khlong|klong|คลอง/.test(k)) return "canal";
  if (/stream|brook|ลำ/.test(k)) return "stream";
  if (/drain|ditch|culvert|ท่อ|รางระบาย/.test(k)) return "drain";
  return "other";
}

function widthClassOf(p: Props, kind: WaterKind): 0 | 1 | 2 | 3 {
  const wc = p.widthClass ?? p.width_class ?? p.wclass;
  const n = finite(wc);
  if (n !== null) return Math.max(0, Math.min(3, Math.round(n))) as 0 | 1 | 2 | 3;
  if (typeof wc === "string") {
    const s = wc.toLowerCase();
    if (/major|large|wide|xl|primary/.test(s)) return 3;
    if (/medium|mid|secondary/.test(s)) return 2;
    if (/minor|small|narrow|tertiary/.test(s)) return 1;
    if (/tiny|xs/.test(s)) return 0;
  }
  const metres = finite(p.width ?? p.widthM ?? p.width_m);
  if (metres !== null) return metres >= 50 ? 3 : metres >= 15 ? 2 : metres >= 4 ? 1 : 0;
  return kind === "river" ? 3 : kind === "canal" ? 2 : kind === "stream" ? 1 : kind === "drain" ? 0 : 1;
}

export function normalizeWaterways(src: FeatureCollection | null | undefined): NormalizedWaterways | null {
  if (!src || !Array.isArray(src.features)) return null;
  const items: WaterwayInfo[] = [];
  const features: Feature[] = [];
  const kinds = new Set<WaterKind>();
  let lineCount = 0,
    areaCount = 0;
  for (const f of src.features) {
    if (!f?.geometry || (!isLinear(f.geometry) && !isPolygonal(f.geometry))) continue;
    const p = (f.properties ?? {}) as Props;
    const isArea = isPolygonal(f.geometry);
    const kind = waterKind(str(p, "kind", "waterway", "type", "class", "category") ?? str(p, "nameEn", "name:en", "name"));
    const widthClass = isArea ? 3 : widthClassOf(p, kind);
    const index = items.length;
    items.push({ index, kind, widthClass, isArea, nameTh: str(p, "nameTh", "name:th", "name_th", "name"), nameEn: str(p, "nameEn", "name:en", "name_en") });
    kinds.add(kind);
    if (isArea) areaCount++;
    else lineCount++;
    features.push({ type: "Feature", properties: { _i: index, _k: kind, _w: widthClass, _a: isArea ? 1 : 0 }, geometry: f.geometry });
  }
  return { fc: { type: "FeatureCollection", features }, items, lineCount, areaCount, kinds };
}

/* ------------------------------------------------------------------ drainage infrastructure */

export type DrainKind = "pump" | "gate" | "monitoring" | "retention" | "other";
export const DRAIN_KINDS: DrainKind[] = ["pump", "gate", "monitoring", "retention", "other"];

/** Who published the asset: the official BMA DDS register, OpenStreetMap, or something else. */
export type DrainOrigin = "official" | "osm" | "other";

export interface DrainageInfo {
  index: number;
  kind: DrainKind;
  origin: DrainOrigin;
  geom: "point" | "line" | "area";
  areaId: string | null;
  nameTh?: string;
  nameEn?: string;
  operator?: string;
}

export interface NormalizedDrainage {
  fc: FeatureCollection;
  items: DrainageInfo[];
  kinds: Set<DrainKind>;
  /** Point/line/area counts per kind and origin (legend + panels). */
  counts: Record<DrainKind, Record<DrainOrigin, number>>;
  /** item indices grouped by containing area id ("" = outside every area). */
  byArea: Map<string, number[]>;
}

function drainKind(raw: string | undefined): DrainKind {
  const k = (raw ?? "").toLowerCase();
  if (/pump|สูบ/.test(k)) return "pump";
  if (/gate|sluice|lock|weir|barrage|ประตู|ฝาย/.test(k)) return "gate";
  if (/retention|detention|reservoir|pond|basin|monkey|cheek|แก้มลิง|บึง|สระ/.test(k)) return "retention";
  if (/monitor|gauge|level|sensor|telemetry|station|cctv|ตรวจ|วัด/.test(k)) return "monitoring";
  return "other";
}

/** Official register (BMA Drainage and Sewerage Department, source ids "bma-dds…") vs OSM vs other. */
export function drainOrigin(p: Props): DrainOrigin {
  const src = str(p, "source", "sourceId", "provider", "dataset", "origin") ?? "";
  if (/bma[-_ ]?dds|^dds\b|สำนักการระบายน้ำ|drainage and sewerage/i.test(src)) return "official";
  if (/osm|openstreetmap/i.test(src) || str(p, "osmId", "osm_id", "@id")) return "osm";
  return "other";
}

export function normalizeDrainage(
  src: FeatureCollection | null | undefined,
  locate: (pt: [number, number] | null) => string | null,
): NormalizedDrainage | null {
  if (!src || !Array.isArray(src.features)) return null;
  const items: DrainageInfo[] = [];
  const features: Feature[] = [];
  const kinds = new Set<DrainKind>();
  const byArea = new Map<string, number[]>();
  const counts = Object.fromEntries(DRAIN_KINDS.map((k) => [k, { official: 0, osm: 0, other: 0 }])) as NormalizedDrainage["counts"];
  for (const f of src.features) {
    if (!f?.geometry) continue;
    const g = f.geometry;
    const geom: DrainageInfo["geom"] | null = isPoint(g) ? "point" : isLinear(g) ? "line" : isPolygonal(g) ? "area" : null;
    if (!geom) continue;
    const p = (f.properties ?? {}) as Props;
    const kind = drainKind(str(p, "kind", "type", "category", "class", "facility", "man_made", "waterway") ?? str(p, "nameEn", "name:en", "nameTh", "name"));
    const index = items.length;
    const areaId = locate(representativePoint(g));
    const origin = drainOrigin(p);
    counts[kind][origin]++;
    items.push({
      index,
      kind,
      origin,
      geom,
      areaId,
      nameTh: str(p, "nameTh", "name:th", "name_th", "name"),
      nameEn: str(p, "nameEn", "name:en", "name_en"),
      operator: str(p, "operator", "agency", "owner"),
    });
    kinds.add(kind);
    const key = areaId ?? "";
    const list = byArea.get(key);
    if (list) list.push(index);
    else byArea.set(key, [index]);
    features.push({ type: "Feature", properties: { _i: index, _k: kind, _g: geom, _o: origin }, geometry: g });
  }
  return { fc: { type: "FeatureCollection", features }, items, kinds, counts, byArea };
}

/* ------------------------------------------------------------------ rain stations */

export function stationsFC(stations: RainStation[] | null | undefined): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (stations ?? [])
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => Number.isFinite(s.lon) && Number.isFinite(s.lat))
      .map(({ s, i }) => {
        const m = s.rain24h;
        const has = !!m && m.value !== null && Number.isFinite(m.value) && m.provenance?.status !== "unavailable";
        return {
          type: "Feature" as const,
          properties: has ? { _i: i, v: m.value as number } : { _i: i },
          geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
        };
      }),
  };
}

/** Distinct statuses + latest observation time across stations (legend). */
export function stationsSummary(stations: RainStation[] | null | undefined) {
  const statuses = new Set<DataStatus>();
  let latest: string | null = null;
  let withValue = 0;
  for (const s of stations ?? []) {
    const st = s.rain24h?.provenance?.status ?? "unavailable";
    statuses.add(s.rain24h?.value === null ? "unavailable" : st);
    if (s.rain24h?.value !== null && s.rain24h?.value !== undefined) withValue++;
    const t = s.observedAt ?? s.rain24h?.provenance?.observedTo ?? null;
    if (t && (!latest || t > latest)) latest = t;
  }
  return { statuses: [...statuses], latest, withValue, total: stations?.length ?? 0 };
}

/* ------------------------------------------------------------------ reanalysis rain grid */

export interface RainGridModel {
  fc: FeatureCollection;
  mode: "date" | "mean-annual" | "missing-date";
  date: string | null;
  min: number | null;
  max: number | null;
  unit: "mm" | "mm/year";
  status: DataStatus;
  points: number;
  sourceName?: string;
}

/**
 * Heatmap points for one day (ISO date) — or, with no date selected, the mean annual rate
 * derived from the daily series (mean of available days × 365.25). Weights are normalised to the
 * day's / period's maximum so the colour ramp always spans the data.
 */
export function rainGridModel(grid: RainSeries | null | undefined, date: string | null): RainGridModel | null {
  if (!grid || !Array.isArray(grid.series) || !grid.series.length) return null;
  const status = grid.provenance?.status ?? "estimated";
  const idx = date ? grid.dates.indexOf(date) : -1;
  if (date && idx < 0) {
    return { fc: EMPTY_FC, mode: "missing-date", date, min: null, max: null, unit: "mm", status, points: 0, sourceName: grid.provenance?.sourceName };
  }
  const vals: { lon: number; lat: number; v: number }[] = [];
  for (const s of grid.series) {
    if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat)) continue;
    let v: number | null = null;
    if (date) {
      const x = s.values[idx];
      v = x === null || x === undefined || !Number.isFinite(x) ? null : x;
    } else {
      let sum = 0,
        n = 0;
      for (const x of s.values) {
        if (x !== null && Number.isFinite(x)) {
          sum += x;
          n++;
        }
      }
      v = n ? (sum / n) * 365.25 : null;
    }
    if (v !== null) vals.push({ lon: s.lon, lat: s.lat, v });
  }
  const max = vals.length ? Math.max(...vals.map((x) => x.v)) : null;
  const min = vals.length ? Math.min(...vals.map((x) => x.v)) : null;
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: vals.map((x) => ({
      type: "Feature",
      properties: { v: x.v, w: max && max > 0 ? Math.max(0, x.v / max) : 0 },
      geometry: { type: "Point", coordinates: [x.lon, x.lat] },
    })),
  };
  return {
    fc,
    mode: date ? "date" : "mean-annual",
    date,
    min,
    max,
    unit: date ? "mm" : "mm/year",
    status,
    points: vals.length,
    sourceName: grid.provenance?.sourceName,
  };
}

/* ------------------------------------------------------------------ illustrative hotspots */

export interface HotspotModel {
  fc: FeatureCollection;
  metricId: "wasteAccumulated" | "wasteDensity";
  statuses: DataStatus[];
  count: number;
  /** fids that pulse (top quintile) — the rest stay as calm static rings. */
  pulsing: number[];
}

const hasValue = (m: MetricValue | undefined) => !!m && m.value !== null && Number.isFinite(m.value) && m.provenance?.status !== "unavailable";

/**
 * Area-level waste hotspots: one ring per area anchor (never a fabricated site location), sized by
 * the modelled accumulation stock when the dataset carries it, otherwise by waste density.
 */
export function hotspotModel(areas: AreaRecord[]): HotspotModel | null {
  if (!areas.length) return null;
  const nAcc = areas.filter((a) => hasValue(a.metrics.wasteAccumulated)).length;
  const nDen = areas.filter((a) => hasValue(a.metrics.wasteDensity)).length;
  if (!nAcc && !nDen) return null;
  const metricId: HotspotModel["metricId"] = nAcc >= Math.max(1, nDen / 2) ? "wasteAccumulated" : "wasteDensity";
  const rows = areas
    .filter((a) => hasValue(a.metrics[metricId]) && (a.metrics[metricId].value as number) > 0 && Array.isArray(a.anchor))
    .map((a) => ({ a, v: a.metrics[metricId].value as number }));
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.v));
  const sorted = [...rows].sort((x, y) => y.v - x.v);
  const pulseN = Math.max(1, Math.round(rows.length * 0.2));
  const pulsing = new Set(sorted.slice(0, pulseN).map((r) => r.a.fid));
  const statuses = new Set<DataStatus>(rows.map((r) => r.a.metrics[metricId].provenance.status));
  return {
    metricId,
    statuses: [...statuses],
    count: rows.length,
    pulsing: [...pulsing],
    fc: {
      type: "FeatureCollection",
      features: rows.map(({ a, v }) => ({
        type: "Feature",
        properties: { fid: a.fid, r: 4 + 14 * Math.sqrt(v / max), p: pulsing.has(a.fid) ? 1 : 0 },
        geometry: { type: "Point", coordinates: [a.anchor[0], a.anchor[1]] },
      })),
    },
  };
}
