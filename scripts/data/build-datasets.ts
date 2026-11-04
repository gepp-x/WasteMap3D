/**
 * build-datasets.ts — assemble the contract-conformant datasets the UI reads, from the staged
 * research outputs (data/staged/*) and the public layers already written by the fetch scripts.
 *
 *   npx tsx scripts/data/build-datasets.ts
 *
 * Deterministic and re-runnable: no network, no randomness, no wall-clock values in the outputs.
 * `generatedAt` is the newest input snapshot time (latest `retrievedAt` among the merged sources and
 * the building windows present), or SOURCE_DATE_EPOCH (seconds) when that env var is set.
 *
 * Writes
 *   public/data/<city>/areas.json          CityDataset (src/lib/types.ts)
 *   public/data/<city>/areas.geojson       polygons with { fid, id, nameTh, nameEn, geometryStatus }
 *   public/data/<city>/rain-areas.json     RainSeries kind "area" (IDW of the reanalysis lattice at each anchor)
 *   public/data/<city>/flood-events.json   FloodEvent[]
 *   public/data/sources.json               merged, de-duplicated SourceRef[]
 *   public/data/manifest.json              every public data file with bytes + sha256
 *   data/staged/osm-waterway-density.json  per-area waterway proximity / length-density inputs (E, W)
 *   data/staged/build-datasets-report.json anchors used, index inputs, warnings
 *
 * Formulas for the risk model are imported from src/lib/simulation/model.ts (never re-implemented).
 * Methodology: docs/DATA_METHODOLOGY.md. Sources: docs/DATA_SOURCES.md.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type {
  AreaMetrics,
  AreaRecord,
  City,
  CityDataset,
  CityId,
  DataProvenance,
  FloodEvent,
  GeometryStatus,
  MetricValue,
  RainSeries,
  SourceRef,
  WasteComposition,
  YearValue,
} from "../../src/lib/types";
import {
  BASELINE_SCENARIO,
  DEFAULT_ASSUMPTIONS,
  MODEL_VERSION,
  computeAreaRisk,
  simulateAccumulation,
  steadyStateAccumulation,
} from "../../src/lib/simulation/model";

/* ============================================================== paths & io */

const ROOT = path.resolve(__dirname, "..", "..");
const PUB = path.join(ROOT, "public", "data");
const STAGED = path.join(ROOT, "data", "staged");
const rel = (p: string) => path.relative(ROOT, p);

const WARNINGS: string[] = [];
const warn = (msg: string) => {
  WARNINGS.push(msg);
  console.warn(`  ! ${msg}`);
};

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}
function tryReadJson<T>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    return readJson<T>(p);
  } catch (e) {
    warn(`${rel(p)} could not be parsed (${(e as Error).message}); ignored`);
    return null;
  }
}
function writeIfChanged(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p) && fs.readFileSync(p, "utf8") === content) return false;
  fs.writeFileSync(p, content, "utf8");
  return true;
}
const minified = (o: unknown) => JSON.stringify(o) + "\n";
const pretty = (o: unknown) => JSON.stringify(o, null, 1) + "\n";

/* ============================================================== small helpers */

const round = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f + (v >= 0 ? 1e-9 : -1e-9)) / f;
};
const nonNull = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;
const fmt = (v: number, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtInt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Largest-remainder allocation of `total` (in integer units of 10^-decimals) by non-negative weights. */
function largestRemainder(total: number, weights: number[], decimals: number): number[] {
  const unit = 10 ** decimals;
  const T = Math.round(total * unit);
  const W = weights.reduce((s, w) => s + w, 0);
  if (W <= 0) throw new Error("largestRemainder: weights sum to 0");
  const exact = weights.map((w) => (T * w) / W);
  const floors = exact.map((x) => Math.floor(x + 1e-9));
  let rest = T - floors.reduce((s, v) => s + v, 0);
  const order = exact.map((x, i) => ({ i, r: x - floors[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) floors[order[k].i] += 1;
  return floors.map((u) => u / unit);
}

const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymd = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return { y, m, d };
};
const thDate = (iso: string) => {
  const { y, m, d } = ymd(iso);
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
};
const enDate = (iso: string) => {
  const { y, m, d } = ymd(iso);
  return `${d} ${EN_MONTHS[m - 1]} ${y}`;
};
const enMonthYear = (iso: string) => {
  const { y, m } = ymd(iso);
  return `${EN_MONTHS[m - 1]} ${y}`;
};
const daysInclusive = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;

/* ============================================================== staged input types (only the parts used) */

interface StagedBkkPopulation {
  sourceId: string;
  sourceUrl: string;
  definition: string;
  latestYear: number;
  latestReferenceDate: string;
  cityTotals: { year: number; yearBE: number; sumOfDistricts: number; publishedTotal: number; sumEqualsPublished: boolean }[];
  districts: { code: string; nameTh: string; nameEn: string; latest: { year: number; value: number | null; status: string } }[];
}
interface StagedWasteHistoryRow {
  year: number;
  fiscalYearBE: number;
  periodFrom: string | null;
  periodTo: string | null;
  tonnesPerDay: number | null;
  status: string;
  sourceId: string;
  daysDivisor: number | null;
  flags: string[];
}
interface StagedBkkWaste {
  definitions: { collected: string; others: string };
  latest: { year: number; fiscalYearBE: number; periodFrom: string; periodTo: string; cityTotalTonnes: number; cityTonnesPerDay: number; sumOfDistrictsTonnes: number; othersTonnes: number };
  districts: {
    code: string;
    nameTh: string;
    nameEn: string;
    latest: { year: number; fiscalYearBE: number; periodFrom: string; periodTo: string; tonnesPerDay: number | null; totalTonnes: number | null; definition: string; sourceId: string };
    history: StagedWasteHistoryRow[];
  }[];
  others: StagedWasteHistoryRow[];
  cityTotals: { collected: { year: number; fiscalYearBE: number; periodFrom: string; periodTo: string; tonnesPerDay: number | null; totalTonnes: number | null; status: string; sourceId: string }[] };
}
interface StagedComposition {
  composition: { shares: Record<string, number>; provenance: DataProvenance };
  primary: { sampleScope: string; fiscalYearBE: number };
  mappingRationale: string[];
}
interface StagedFloodSeries {
  id: string;
  nameEn: string;
  nameTh: string;
  referenceYear: number | null;
  sourceId: string;
  sourceUrl: string;
  total: number;
  countsByDistrict: Record<string, number | null>;
}
interface StagedFloodPoints {
  primarySeriesId: string;
  series: StagedFloodSeries[];
}
interface StagedHyPopulation {
  municipality: {
    nameTh: string;
    nameEn: string;
    latest: MetricValue;
    timeSeries: { referenceDate: string; referenceYear: number; total: number }[];
  };
  zones: { id: string; zoneNo: number; nameTh: string; population: MetricValue; households: { value: number } }[];
  communityPopulationSum: { value: number };
}
interface StagedHyWasteRow {
  fiscalYearBE: number;
  observedFrom: string;
  observedTo: string;
  metric: string;
  definition: string;
  valueTonPerYear: number | null;
  unitPublished: string;
  status: string;
}
interface StagedHyWaste {
  songkhlaLaoDatasets: {
    scope: string;
    datasets: Record<string, { url: string; name: string }>;
    generated: StagedHyWasteRow[];
    collected: StagedHyWasteRow[];
  };
  pmc12247160: { householdWasteClaim: { value: number; unit: string; citedSource: string } };
  composition: { shares: null | Record<string, number>; status: string; note: string };
}
interface StagedHyFlood {
  event: FloodEvent;
  earlierFloods: { id: string; year: number; from: string | null; to: string | null }[];
}
interface StagedRainNormals {
  source: { sourceId: string; url: string };
  stations: { cityId: CityId; id: string; wmoIndex: string; nameEn: string; period: string; annualRainfall: { value: number; unit: string } }[];
}
interface StagedAnchor {
  areaId: string;
  anchor: [number, number];
  anchorSource?: string;
  buildingCount?: number;
}
interface StagedDrainageCapacity {
  statements: { id: string; cityId: CityId; value: number | null; unit: string | null; subject: string }[];
}
/** data/staged/bangkok-generated.json (scripts/data/fetch-waste-gaps.ts) — PCD generated + district allocation. */
interface StagedBkkGenerated {
  definition: string;
  periodNote: string;
  city: { wasteGenerated: MetricValue; latestYearBE: number; yearsNotYetReportedBE: number[] };
  citySeries: { yearBE: number; year: number; generatedTPerDay: number | null; status: string; sourceId: string; sourceUrl?: string }[];
  allocationMethod: { summary: string; status: string };
  latestAllocation: { yearBE: number; pcdGeneratedTPerDay: number; sumOfDistrictValuesTPerDay: number; othersShareOfGrandTotal: number };
  districts: {
    code: string;
    areaId: string;
    wasteGenerated: MetricValue;
    allocationInputs: { bmaFiscalYearBE: number; shareOf50Districts: number; bmaSourceId: string };
    history: { year: number; yearBE: number; value: number | null; unit: string; status: string; bmaFiscalYearBE: number }[];
  }[];
  checks: { latestSumEqualsCityTotal: boolean; everyYearSumEqualsCityTotal: boolean };
}
/** data/staged/bangkok-district-composition.json — citywide composition applied per district (estimated). */
interface StagedBkkDistrictComposition {
  method: string;
  status: string;
  districts: { code: string; areaId: string; composition: { shares: Record<string, number>; provenance: DataProvenance } }[];
  checks: { districtCount: number; everyDistrictSumsTo100: boolean };
}
/** data/staged/hatyai-composition.json — Hat Yai-specific composition (PSU/TSRI report). */
interface StagedHyComposition {
  composition: { shares: Record<string, number>; provenance: DataProvenance };
  status: string;
  primary: { asOf: string; quoteTh: string };
}
/** data/staged/bangkok-flood-events.json (scripts/data/fetch-hydrology.ts) — FloodEvent + documented extras. */
type StagedFloodEvent = FloodEvent & { sourceIds?: string[]; peakValues?: { sourceId?: string }[]; eventWindowNote?: string };

/* ============================================================== sources registry */

const STAGED_SOURCE_FILES = [
  "bangkok-sources.json",
  "hatyai-sources.json",
  "rain-sources.json",
  "osm-sources.json",
  "bangkok-buildings-sources.json",
  "hatyai-buildings-sources.json",
  // second-round research (each re-lists a few pointer records already registered above; the first entry wins)
  "waste-gaps-sources.json",
  "hydrology-sources.json",
  "hatyai-community-locations-sources.json",
];

function buildSources(): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Map<string, string>();
  const dupes = new Map<string, string[]>();
  for (const f of STAGED_SOURCE_FILES) {
    const list = tryReadJson<SourceRef[]>(path.join(STAGED, f));
    if (!list) continue;
    for (const s of list) {
      if (!s || !s.id) continue;
      if (seen.has(s.id)) {
        const prev = out.find((x) => x.id === s.id)!;
        if (f.endsWith("-buildings-sources.json") && (seen.get(s.id) ?? "").endsWith("-buildings-sources.json")) {
          // the per-city building registries share id "osm-overpass": merge them
          const city = f.split("-")[0];
          const prevCity = (seen.get(s.id) ?? "").split("-")[0];
          const st = [prev.accessStatus, s.accessStatus];
          const merged: SourceRef["accessStatus"] = st.every((x) => x === "retrieved")
            ? "retrieved"
            : st.every((x) => x === "failed")
              ? "failed"
              : st.some((x) => x === "retrieved" || x === "partial")
                ? "partial"
                : prev.accessStatus;
          const times = [prev.retrievedAt, s.retrievedAt].filter((x): x is string => !!x).sort();
          Object.assign(prev, {
            retrievedAt: times[times.length - 1],
            accessStatus: merged,
            notes: `${prev.notes?.startsWith(prevCity + ":") ? prev.notes : `${prevCity}: ${prev.notes ?? ""}`} | ${city}: ${s.notes ?? ""}`,
          });
          seen.set(s.id, f);
        } else if (seen.get(s.id) !== f) dupes.set(f, [...(dupes.get(f) ?? []), `${s.id} (← ${seen.get(s.id)})`]);
        continue;
      }
      seen.set(s.id, f);
      out.push(s);
    }
  }
  for (const [f, ids] of dupes) console.log(`  sources: ${f} re-lists ${ids.length} id(s) already registered — kept the first entry: ${ids.join(", ")}`);
  const add = (s: SourceRef) => {
    if (seen.has(s.id)) return;
    seen.set(s.id, "build-datasets");
    out.push(s);
  };
  add({
    id: "osm-overpass",
    nameEn: "OpenStreetMap buildings, roads and water features via the Overpass API (3D neighbourhood windows)",
    nameTh: "ข้อมูลอาคาร ถนน และแหล่งน้ำจาก OpenStreetMap (ผ่าน Overpass API)",
    url: "https://overpass-api.de/api/interpreter",
    publisher: "OpenStreetMap contributors (served by Overpass API instances)",
    license: "ODbL-1.0 — © OpenStreetMap contributors (https://www.openstreetmap.org/copyright)",
    accessStatus: "retrieved",
    notes: "Building windows written by scripts/data/fetch-buildings.ts (public/data/buildings/<areaId>.json). Retrieval time per window is stored in each file (retrievedAt).",
  });
  add({
    id: "openfreemap-basemap",
    nameEn: "OpenFreeMap vector basemap tiles",
    url: "https://openfreemap.org",
    publisher: "OpenFreeMap",
    license: "Free public tile service; attribution “© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors” required. Map data ODbL-1.0.",
    accessStatus: "manual-reference",
    notes: "Basemap only, loaded by the browser at runtime (https://tiles.openfreemap.org/planet); not processed by the data pipeline.",
  });
  add({
    id: "openmaptiles-schema",
    nameEn: "OpenMapTiles vector tile schema (basemap layers)",
    url: "https://openmaptiles.org",
    publisher: "OpenMapTiles",
    license: "Attribution “© OpenMapTiles” required; underlying data © OpenStreetMap contributors (ODbL-1.0).",
    accessStatus: "manual-reference",
    notes: "Schema of the OpenFreeMap basemap tiles; basemap only.",
  });
  add({
    id: "urban-intel-derived",
    nameEn: "Urban Intelligence data pipeline — derived and estimated indicators",
    nameTh: "ตัวชี้วัดที่คำนวณ/ประมาณการโดยกระบวนการข้อมูลของโครงการ",
    url: "docs/DATA_METHODOLOGY.md",
    publisher: "Urban Intelligence — Waste & Flood Observatory (this project)",
    license: "Derived from the cited sources; their licences apply.",
    accessStatus: "manual-reference",
    notes: "Densities, per-capita values, allocations, IDW rainfall, exposure (E) and obstruction (W) indices computed deterministically by scripts/data/build-datasets.ts. Inputs are named in each value's sourceName/methodology.",
  });
  add({
    id: "urban-intel-simulation-model",
    nameEn: `Urban Intelligence illustrative flood-risk / accumulation model v${MODEL_VERSION}`,
    nameTh: "แบบจำลองเชิงสาธิตของโครงการ (ไม่ใช่การพยากรณ์อย่างเป็นทางการ)",
    url: "docs/SIMULATION_MODEL.md",
    publisher: "Urban Intelligence — Waste & Flood Observatory (this project)",
    license: "Project code",
    accessStatus: "manual-reference",
    notes: "src/lib/simulation/model.ts — deterministic, illustrative; weights and capacity are demo assumptions, not an official forecast.",
  });
  return out;
}

/* ============================================================== geometry helpers */

type AreaGeom = Polygon | MultiPolygon;

interface Projector {
  lon0: number;
  lat0: number;
  kx: number;
  ky: number;
  fwd: (lon: number, lat: number) => [number, number];
}
function makeProjector(lon0: number, lat0: number): Projector {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110574;
  return { lon0, lat0, kx, ky, fwd: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky] };
}

/** polygons → rings → [x,y] in local metres */
type ProjPolys = number[][][][];
function projectGeom(g: AreaGeom, P: Projector): ProjPolys {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.map((rings) => rings.map((ring) => ring.map(([lon, lat]) => P.fwd(lon, lat))));
}
function bboxOfProj(pp: ProjPolys): [number, number, number, number] {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity;
  for (const rings of pp)
    for (const p of rings[0]) {
      if (p[0] < a) a = p[0];
      if (p[1] < b) b = p[1];
      if (p[0] > c) c = p[0];
      if (p[1] > d) d = p[1];
    }
  return [a, b, c, d];
}
/** Even-odd point-in-polygon over all rings of each polygon (holes handled), any polygon of a multipolygon. */
function pipProj(x: number, y: number, pp: ProjPolys): boolean {
  for (const rings of pp) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0],
          yi = ring[i][1],
          xj = ring[j][0],
          yj = ring[j][1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax,
    dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px,
    qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

class SegIndex {
  private cells = new Map<string, number[]>();
  readonly segs: number[] = []; // flat ax,ay,bx,by
  constructor(private cell: number) {}
  add(ax: number, ay: number, bx: number, by: number) {
    const k = this.segs.length / 4;
    this.segs.push(ax, ay, bx, by);
    const c = this.cell;
    const i0 = Math.floor(Math.min(ax, bx) / c),
      i1 = Math.floor(Math.max(ax, bx) / c);
    const j0 = Math.floor(Math.min(ay, by) / c),
      j1 = Math.floor(Math.max(ay, by) / c);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const key = i + "," + j;
        const arr = this.cells.get(key);
        if (arr) arr.push(k);
        else this.cells.set(key, [k]);
      }
  }
  get size() {
    return this.segs.length / 4;
  }
  within(px: number, py: number, r: number): boolean {
    const c = this.cell;
    const r2 = r * r;
    const s = this.segs;
    for (let i = Math.floor((px - r) / c); i <= Math.floor((px + r) / c); i++)
      for (let j = Math.floor((py - r) / c); j <= Math.floor((py + r) / c); j++) {
        const arr = this.cells.get(i + "," + j);
        if (!arr) continue;
        for (const k of arr) if (segDist2(px, py, s[4 * k], s[4 * k + 1], s[4 * k + 2], s[4 * k + 3]) <= r2) return true;
      }
    return false;
  }
}

/* ============================================================== city metadata */

const CITY_META: Record<CityId, Omit<City, "bbox" | "periodLabelTh" | "periodLabelEn">> = {
  bangkok: {
    id: "bangkok",
    nameTh: "กรุงเทพมหานคร",
    nameEn: "Bangkok",
    center: [100.5605, 13.7367],
    zoom: 10.15,
    areaKindTh: "เขต",
    areaKindEn: "District",
  },
  hatyai: {
    id: "hatyai",
    nameTh: "เทศบาลนครหาดใหญ่",
    nameEn: "Hat Yai Municipality",
    center: [100.4745, 7.0085],
    zoom: 13.1,
    areaKindTh: "เขตชุมชน",
    areaKindEn: "Community zone",
  },
};

/* ============================================================== area skeleton */

interface AreaInput {
  id: string;
  fid: number;
  code?: string;
  nameTh: string;
  nameEn: string;
  kind: AreaRecord["kind"];
  geometryStatus: GeometryStatus;
  geometry: AreaGeom;
  geometrySourceId: string;
  areaKm2: number; // turf.area of the published polygon, 3 dp
  extra: Record<string, unknown>;
}

interface AnchorInfo {
  anchor: [number, number];
  source: string; // machine-readable
  sourceEn: string;
  sourceTh: string;
}

/** Strictly inside (boundary excluded) after rounding to 6 decimals. */
function strictlyInside(p: [number, number], g: AreaGeom) {
  return turf.booleanPointInPolygon(turf.point([round(p[0], 6), round(p[1], 6)]), turf.feature(g), { ignoreBoundary: true });
}

/**
 * Deterministic interior label point: the centroid when it is inside and ≥ 150 m from the edge,
 * otherwise the point of a 60 × 60 lattice over the bbox that is farthest from the edge.
 * (turf.pointOnFeature can return a boundary vertex for concave polygons, which is a poor label anchor.)
 */
function interiorLabelPoint(g: AreaGeom): [number, number] {
  const f = turf.feature(g);
  const [w, s, e, n] = turf.bbox(f);
  const P = makeProjector((w + e) / 2, (s + n) / 2);
  const pp = projectGeom(g, P);
  const edgeDist = (x: number, y: number) => {
    let best = Infinity;
    for (const rings of pp)
      for (const ring of rings)
        for (let i = 1; i < ring.length; i++) {
          const d = segDist2(x, y, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]);
          if (d < best) best = d;
        }
    return Math.sqrt(best);
  };
  const c = turf.centroid(f).geometry.coordinates as [number, number];
  const [cx, cy] = P.fwd(c[0], c[1]);
  if (pipProj(cx, cy, pp) && edgeDist(cx, cy) >= 150) return [round(c[0], 6), round(c[1], 6)];
  let bestP: [number, number] | null = null;
  let bestD = -1;
  const N = 60;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const lon = w + ((i + 0.5) / N) * (e - w);
      const lat = s + ((j + 0.5) / N) * (n - s);
      const [x, y] = P.fwd(lon, lat);
      if (!pipProj(x, y, pp)) continue;
      const d = edgeDist(x, y);
      if (d > bestD) {
        bestD = d;
        bestP = [round(lon, 6), round(lat, 6)];
      }
    }
  if (bestP) return bestP;
  const p = turf.pointOnFeature(f).geometry.coordinates;
  return [round(p[0], 6), round(p[1], 6)];
}

function resolveAnchors(city: CityId, areas: AreaInput[]): Map<string, AnchorInfo> {
  const staged = tryReadJson<StagedAnchor[]>(path.join(STAGED, `${city}-anchors.json`));
  const byId = new Map<string, StagedAnchor>();
  if (Array.isArray(staged)) for (const a of staged) if (a && a.areaId && Array.isArray(a.anchor)) byId.set(a.areaId, a);
  const out = new Map<string, AnchorInfo>();
  const valid = (p: unknown): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  for (const a of areas) {
    const skipped: string[] = [];
    const s = byId.get(a.id);
    if (s && valid(s.anchor)) {
      const src = s.anchorSource ?? "unspecified";
      if (strictlyInside(s.anchor, a.geometry)) {
        out.set(a.id, {
          anchor: [round(s.anchor[0], 6), round(s.anchor[1], 6)],
          source: `staged-anchors:${src}`,
          sourceEn: `Anchor from data/staged/${city}-anchors.json (= building-window origin; ${src}).`,
          sourceTh: `จุดอ้างอิงจาก data/staged/${city}-anchors.json (= จุดกำเนิดหน้าต่างอาคาร 3 มิติ; ${src})`,
        });
        continue;
      }
      skipped.push("staged anchor");
    }
    const bw = tryReadJson<{ origin?: unknown }>(path.join(PUB, "buildings", `${a.id}.json`));
    if (bw && valid(bw.origin)) {
      if (strictlyInside(bw.origin, a.geometry)) {
        out.set(a.id, {
          anchor: [round(bw.origin[0], 6), round(bw.origin[1], 6)],
          source: "building-window-origin",
          sourceEn: `Anchor = origin of public/data/buildings/${a.id}.json (staged anchors file has no entry for this area yet).`,
          sourceTh: `จุดอ้างอิง = จุดกำเนิดของหน้าต่างอาคาร public/data/buildings/${a.id}.json`,
        });
        continue;
      }
      skipped.push("building-window origin");
    }
    const why = skipped.length ? ` The ${skipped.join(" and ")} lies on or outside the polygon edge, so it was not used as the label anchor (the 3D window keeps its own origin).` : "";
    const whyTh = skipped.length ? " (จุดกำเนิดหน้าต่างอาคารอยู่บน/นอกขอบรูปแปลง จึงไม่ใช้เป็นจุดอ้างอิงป้ายชื่อ)" : "";
    const prop = a.extra.anchor;
    if (valid(prop) && strictlyInside(prop, a.geometry)) {
      out.set(a.id, {
        anchor: [round(prop[0], 6), round(prop[1], 6)],
        source: "geometry-anchor-property",
        sourceEn: `Anchor = interior label point stored with the zone polygon (zones.geojson 'anchor').${why}`,
        sourceTh: `จุดอ้างอิง = จุดภายในรูปแปลงที่บันทึกไว้ใน zones.geojson${whyTh}`,
      });
      continue;
    }
    out.set(a.id, {
      anchor: interiorLabelPoint(a.geometry),
      source: "interior-label-point",
      sourceEn: `Anchor = interior label point (centroid if ≥150 m inside, else the point of a 60×60 lattice farthest from the edge); no building window yet.${why}`,
      sourceTh: `จุดอ้างอิง = จุดภายในรูปแปลง (centroid หรือจุดที่ไกลจากขอบมากที่สุด) เนื่องจากยังไม่มีหน้าต่างอาคาร${whyTh}`,
    });
  }
  return out;
}

/* ============================================================== rainfall (IDW of the reanalysis lattice) */

const RAIN_COARSE_LIMITATION =
  "ERA5 reanalysis cells are 0.25° (≈27–28 km): neighbouring areas mostly share the same cell(s), so rainfall differences between neighbouring areas are mostly NOT resolved — the IDW only smooths between cell values and adds no local detail.";

interface RainIdw {
  values: (number | null)[];
  neighbours: { id: string; distM: number; weight: number }[];
}
function idwSeries(grid: RainSeries, anchor: [number, number], P: Projector, k = 4, power = 2): RainIdw {
  const [ax, ay] = P.fwd(anchor[0], anchor[1]);
  const cand = grid.series
    .map((s, i) => {
      const [x, y] = P.fwd(s.lon, s.lat);
      return { i, id: s.id, d: Math.hypot(x - ax, y - ay) };
    })
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, k);
  const exact = cand.find((c) => c.d < 1);
  const use = exact ? [exact] : cand;
  const w = use.map((c) => (exact ? 1 : 1 / c.d ** power));
  const wsum = w.reduce((s, v) => s + v, 0);
  const values: (number | null)[] = grid.dates.map((_, t) => {
    let num = 0,
      den = 0;
    use.forEach((c, j) => {
      const v = grid.series[c.i].values[t];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        num += w[j] * v;
        den += w[j];
      }
    });
    return den > 0 ? round(num / den, 1) : null;
  });
  return { values, neighbours: use.map((c, j) => ({ id: c.id, distM: round(c.d, 1), weight: round(w[j] / wsum, 4) })) };
}

/** Mean annual total over complete calendar years (every day present and non-null). */
function annualMean(dates: string[], values: (number | null)[]) {
  const byYear = new Map<number, { sum: number; n: number; nulls: number }>();
  dates.forEach((d, i) => {
    const y = Number(d.slice(0, 4));
    const e = byYear.get(y) ?? { sum: 0, n: 0, nulls: 0 };
    const v = values[i];
    if (v === null || v === undefined) e.nulls++;
    else e.sum += v;
    e.n++;
    byYear.set(y, e);
  });
  const years: { year: number; total: number }[] = [];
  for (const [y, e] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const daysInYear = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
    if (e.n === daysInYear && e.nulls === 0) years.push({ year: y, total: round(e.sum, 1) });
  }
  if (!years.length) return null;
  return { mean: round(years.reduce((s, x) => s + x.total, 0) / years.length, 1), years };
}

/* ============================================================== waterway indices (E, W inputs) */

interface WaterwayStats {
  samples: number;
  within300: number;
  withinPrincipal: number;
  share300: number | null;
  sharePrincipal: number | null;
  lengthKm: number;
  lengthDensityKmPerKm2: number | null;
}

function ensureWaterwayKinds(city: CityId): FeatureCollection | null {
  const p = path.join(PUB, city, "waterways.geojson");
  const fc = tryReadJson<FeatureCollection>(p);
  if (!fc) {
    warn(`${rel(p)} missing — waterway indices unavailable`);
    return null;
  }
  let fixed = 0;
  for (const f of fc.features) {
    const pr = (f.properties ?? (f.properties = {})) as Record<string, unknown>;
    if (typeof pr.kind === "string" && pr.kind) continue;
    const tags = (pr.tags ?? {}) as Record<string, unknown>;
    const ww = (pr.waterway ?? tags.waterway) as string | undefined;
    const gt = f.geometry?.type;
    pr.kind =
      gt === "Polygon" || gt === "MultiPolygon" ? "water-area" : ww === "river" || ww === "canal" || ww === "stream" || ww === "drain" ? ww : ww === "ditch" ? "drain" : "canal";
    fixed++;
  }
  if (fixed) {
    writeIfChanged(p, JSON.stringify(fc) + "\n");
    console.log(`  waterways: added 'kind' to ${fixed} ${city} features (geometry unchanged)`);
  }
  return fc;
}

function waterwayStats(
  city: CityId,
  areas: AreaInput[],
  fc: FeatureCollection | null,
  P: Projector,
  sampleSpacingM: number,
  principal: (props: Record<string, unknown>) => boolean,
): Map<string, WaterwayStats> {
  const out = new Map<string, WaterwayStats>();
  const proj = areas.map((a) => {
    const pp = projectGeom(a.geometry, P);
    return { a, pp, bb: bboxOfProj(pp) };
  });
  if (!fc) {
    for (const a of areas) out.set(a.id, { samples: 0, within300: 0, withinPrincipal: 0, share300: null, sharePrincipal: null, lengthKm: 0, lengthDensityKmPerKm2: null });
    return out;
  }
  const R = 300;
  const anyIdx = new SegIndex(R);
  const prinIdx = new SegIndex(R);
  const waterPolys: ProjPolys[] = [];
  const lengths = new Map<string, number>(areas.map((a) => [a.id, 0]));
  const PIECE = 20; // m

  const addLine = (coords: number[][], isPrincipal: boolean, countLength: boolean) => {
    for (let i = 1; i < coords.length; i++) {
      const [ax, ay] = P.fwd(coords[i - 1][0], coords[i - 1][1]);
      const [bx, by] = P.fwd(coords[i][0], coords[i][1]);
      anyIdx.add(ax, ay, bx, by);
      if (isPrincipal) prinIdx.add(ax, ay, bx, by);
      if (!countLength) continue;
      const L = Math.hypot(bx - ax, by - ay);
      if (L === 0) continue;
      const n = Math.max(1, Math.ceil(L / PIECE));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const mx = ax + (bx - ax) * t,
          my = ay + (by - ay) * t;
        for (const q of proj) {
          if (mx < q.bb[0] || mx > q.bb[2] || my < q.bb[1] || my > q.bb[3]) continue;
          if (pipProj(mx, my, q.pp)) {
            lengths.set(q.a.id, (lengths.get(q.a.id) ?? 0) + L / n);
            break;
          }
        }
      }
    }
  };

  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const isP = principal(props);
    if (g.type === "LineString") addLine(g.coordinates, isP, true);
    else if (g.type === "MultiLineString") for (const l of g.coordinates) addLine(l, isP, true);
    else if (g.type === "Polygon" || g.type === "MultiPolygon") {
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      for (const rings of polys) for (const ring of rings) addLine(ring, isP, false); // banks count for proximity, not for length
      waterPolys.push(projectGeom(g, P));
    }
  }

  // regular sample lattice aligned on the city-wide origin
  const ox = Math.min(...proj.map((q) => q.bb[0]));
  const oy = Math.min(...proj.map((q) => q.bb[1]));
  const S = sampleSpacingM;
  for (const q of proj) {
    let n = 0,
      w = 0,
      wp = 0;
    const i0 = Math.floor((q.bb[0] - ox) / S),
      i1 = Math.ceil((q.bb[2] - ox) / S);
    const j0 = Math.floor((q.bb[1] - oy) / S),
      j1 = Math.ceil((q.bb[3] - oy) / S);
    for (let i = i0; i <= i1; i++) {
      const x = ox + (i + 0.5) * S;
      for (let j = j0; j <= j1; j++) {
        const y = oy + (j + 0.5) * S;
        if (!pipProj(x, y, q.pp)) continue;
        n++;
        const inWater = waterPolys.some((wpoly) => pipProj(x, y, wpoly));
        if (inWater || anyIdx.within(x, y, R)) w++;
        if (prinIdx.size && prinIdx.within(x, y, R)) wp++;
      }
    }
    const lengthKm = (lengths.get(q.a.id) ?? 0) / 1000;
    out.set(q.a.id, {
      samples: n,
      within300: w,
      withinPrincipal: wp,
      share300: n ? round(w / n, 4) : null,
      sharePrincipal: n ? round(wp / n, 4) : null,
      lengthKm: round(lengthKm, 3),
      lengthDensityKmPerKm2: q.a.areaKm2 > 0 ? round(lengthKm / q.a.areaKm2, 4) : null,
    });
  }
  console.log(`  ${city}: waterway index built from ${anyIdx.size} segments (${prinIdx.size} principal), ${waterPolys.length} water-area polygons, sample spacing ${S} m`);
  return out;
}

function minMax(vals: (number | null)[]): (number | null)[] {
  const v = vals.filter(nonNull);
  if (!v.length) return vals.map(() => null);
  const lo = Math.min(...v),
    hi = Math.max(...v);
  return vals.map((x) => (x === null ? null : hi > lo ? (x - lo) / (hi - lo) : 0));
}
function maxScale(vals: (number | null)[]): (number | null)[] {
  const v = vals.filter(nonNull);
  if (!v.length) return vals.map(() => null);
  const hi = Math.max(...v);
  return vals.map((x) => (x === null ? null : hi > 0 ? x / hi : 0));
}

/* ============================================================== metric builders */

function mv(value: number | null | undefined, unit: string, prov: DataProvenance): MetricValue {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { value: null, unit, provenance: { ...prov, status: "unavailable" } };
  }
  return { value, unit, provenance: prov };
}

function weightedMean(pairs: { v: number | null; w: number | null }[]): number | null {
  let s = 0,
    ws = 0;
  for (const p of pairs) if (p.v !== null && p.w !== null && p.w > 0) {
    s += p.v * p.w;
    ws += p.w;
  }
  return ws > 0 ? s / ws : null;
}

/* ============================================================== shared context */

interface Ctx {
  sources: Map<string, SourceRef>;
  normals: StagedRainNormals | null;
  capacity: StagedDrainageCapacity | null;
}
function srcProv(ctx: Ctx, sourceId: string | undefined, rest: Omit<DataProvenance, "sourceId" | "sourceName" | "sourceUrl"> & { sourceName?: string; sourceUrl?: string }): DataProvenance {
  const s = sourceId ? ctx.sources.get(sourceId) : undefined;
  if (sourceId && !s) warn(`provenance references unknown sourceId "${sourceId}"`);
  const { sourceName, sourceUrl, status, ...others } = rest;
  return {
    status,
    sourceId,
    sourceName: sourceName ?? s?.nameEn,
    sourceUrl: sourceUrl ?? s?.url,
    ...others,
  };
}

/* ============================================================== common metric assembly (rain, indices, model) */

interface CityCore {
  city: CityId;
  areas: AreaInput[];
  anchors: Map<string, AnchorInfo>;
  population: Map<string, MetricValue>;
  wasteCollected: Map<string, MetricValue>;
  wasteGenerated: Map<string, MetricValue>;
  /** status of the waste inputs feeding per-capita/density ("observed" → derived, "estimated" → estimated) */
  wasteDerivedStatus: "derived" | "estimated";
  perCapitaLimitations: string[];
  perCapitaContext: string;
  densitySourceName: string;
}

function areaKm2Metric(ctx: Ctx, a: AreaInput): MetricValue {
  const approx = a.geometryStatus === "approximate";
  return mv(
    a.areaKm2,
    "km2",
    srcProv(ctx, a.geometrySourceId, {
      status: "derived",
      geographicScope: `${a.nameEn} polygon (${a.geometryStatus})`,
      methodology: "Geodesic area of the published polygon (turf.area, WGS84), rounded to 0.001 km².",
      limitations: approx
        ? ["The polygon is an APPROXIMATE demonstration partition, not an official boundary; its area is indicative only."]
        : typeof a.extra.areaKm2Official === "number"
          ? [`BMA's published area table gives ${fmt(a.extra.areaKm2Official as number, 3)} km² for this district; the polygon area is used here so that densities match the mapped geometry.`]
          : undefined,
    }),
  );
}

/* ============================================================== Bangkok */

function buildBangkokAreas(): AreaInput[] {
  const fc = readJson<FeatureCollection<AreaGeom>>(path.join(PUB, "bangkok", "districts.geojson"));
  const feats = [...fc.features].sort((a, b) => String(a.properties?.code).localeCompare(String(b.properties?.code)));
  return feats.map((f, i) => {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const code = String(p.code);
    return {
      id: `bkk-${code}`,
      fid: i + 1,
      code,
      nameTh: String(p.nameTh),
      nameEn: String(p.nameEn),
      kind: "district" as const,
      geometryStatus: (p.geometryStatus as GeometryStatus) ?? "official",
      geometry: f.geometry,
      geometrySourceId: String(p.sourceId ?? "bma-gis-district-boundaries"),
      areaKm2: round(turf.area(f) / 1e6, 3),
      extra: { areaKm2Official: p.areaKm2Official, areaKm2Geodesic: p.areaKm2Geodesic },
    };
  });
}

function buildHatyaiAreas(): AreaInput[] {
  const fc = readJson<FeatureCollection<AreaGeom>>(path.join(PUB, "hatyai", "zones.geojson"));
  const feats = [...fc.features].sort((a, b) => String(a.properties?.id).localeCompare(String(b.properties?.id)));
  return feats.map((f, i) => {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    return {
      id: String(p.id),
      fid: i + 1,
      nameTh: String(p.nameTh),
      nameEn: String(p.nameEn),
      kind: "community-zone" as const,
      geometryStatus: (p.geometryStatus as GeometryStatus) ?? "approximate",
      geometry: f.geometry,
      geometrySourceId: String(p.sourceId ?? "hatyai-zones-approx"),
      areaKm2: round(turf.area(f) / 1e6, 3),
      extra: { zoneNo: p.zoneNo, communityCount: p.communityCount, nameThOfficialAlt: p.nameThOfficialAlt, anchor: p.anchor },
    };
  });
}

/**
 * Per-capita and density always use COLLECTED waste (the measure observed in both cities), so values stay
 * comparable across areas and with the obstruction index W. When a separate GENERATED figure exists, say so.
 */
function collectedOnlyNote(gen: MetricValue, pop?: number | null): string[] {
  if (gen.value === null) return [];
  const yr = gen.provenance.referenceYear ? ` (${gen.provenance.referenceYear})` : "";
  const pc = pop ? `; generated per capita would be ${fmt((gen.value * 1000) / pop, 3)} kg/person/day` : "";
  return [`Uses collected waste only. A separate generated-waste figure (${fmt(gen.value, 2)} t/day${yr}, status ${gen.provenance.status}) exists but is a different measure and is not mixed in${pc}.`];
}

/* ============================================================== main per-city assembly */

interface CityBuildResult {
  dataset: CityDataset;
  areasGeo: FeatureCollection;
  rainAreas: RainSeries | null;
  floodEvents: FloodEvent[];
  report: Record<string, unknown>;
  waterwayDensity: Record<string, unknown>;
}

function assembleCity(
  ctx: Ctx,
  core: CityCore,
  opts: {
    rainGrid: RainSeries | null;
    exposure: Map<string, { value: number | null; prov: DataProvenance }>;
    obstruction: Map<string, { value: number | null; prov: DataProvenance }>;
    composition: WasteComposition;
    areaComposition?: Map<string, WasteComposition>;
    wasteHistory: Map<string, YearValue[]>;
    cityWasteHistory: YearValue[];
    /** Waste GENERATED history (separate measure; omitted when no generation series exists). */
    wasteGeneratedHistory?: Map<string, YearValue[]>;
    cityWasteGeneratedHistory?: YearValue[];
    totalsBase: {
      population: MetricValue;
      areaKm2: MetricValue;
      wasteCollected: MetricValue;
      wasteGenerated: MetricValue;
      perCapitaLimitations: string[];
      perCapitaSourceName: string;
    };
    notes: Map<string, { th: string[]; en: string[] }>;
    periodLabelTh: string;
    periodLabelEn: string;
    limitations: string[];
    floodEvents: FloodEvent[];
    generatedAt: string;
    report: Record<string, unknown>;
    waterwayDensity: Record<string, unknown>;
    normalStation?: { id: string; nameEn: string; annual: number; period: string };
  },
): CityBuildResult {
  const { city, areas, anchors } = core;
  const P = makeProjector(CITY_META[city].center[0], CITY_META[city].center[1]);

  /* ---- rainfall per area */
  const rain = new Map<string, { idw: RainIdw; annual: ReturnType<typeof annualMean> }>();
  let rainAreas: RainSeries | null = null;
  const grid = opts.rainGrid;
  if (grid) {
    for (const a of areas) {
      const idw = idwSeries(grid, anchors.get(a.id)!.anchor, P);
      rain.set(a.id, { idw, annual: annualMean(grid.dates, idw.values) });
    }
    const gp = grid.provenance;
    rainAreas = {
      cityId: city,
      kind: "area",
      dates: grid.dates,
      series: areas.map((a) => ({
        id: a.id,
        nameEn: a.nameEn,
        nameTh: a.nameTh,
        lon: anchors.get(a.id)!.anchor[0],
        lat: anchors.get(a.id)!.anchor[1],
        values: rain.get(a.id)!.idw.values,
      })),
      provenance: {
        status: "estimated",
        sourceId: gp.sourceId,
        sourceName: gp.sourceName,
        sourceUrl: gp.sourceUrl,
        observedFrom: grid.dates[0],
        observedTo: grid.dates[grid.dates.length - 1],
        geographicScope: `${areas.length} ${CITY_META[city].areaKindEn.toLowerCase()} anchors (${CITY_META[city].nameEn}); one series per area id`,
        methodology:
          "Daily precipitation at each area anchor by inverse-distance weighting (power 2) of the 4 nearest points of the reanalysis lattice in rain-grid.json (distances in local metres; a lattice point closer than 1 m is used alone; null inputs are skipped and weights renormalised); rounded to 0.1 mm. The lattice values are ECMWF ERA5 reanalysis daily totals served by Open-Meteo (models=era5): " +
          (gp.methodology ?? ""),
        limitations: [RAIN_COARSE_LIMITATION, ...(gp.limitations ?? [])],
      },
    };
  } else {
    warn(`${city}: rain-grid.json missing — rainfall metrics unavailable`);
  }
  const lastDate = grid ? grid.dates[grid.dates.length - 1] : undefined;
  const annualVals = areas.map((a) => rain.get(a.id)?.annual?.mean ?? null);
  const annualMeanCity = (() => {
    const v = annualVals.filter(nonNull);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  })();
  const spatial = (id: string) => {
    const v = rain.get(id)?.annual?.mean ?? null;
    return annualMeanCity && v ? v / annualMeanCity : 1;
  };
  const normalNote = opts.normalStation
    ? `For scale: the TMD ${opts.normalStation.period} climatological normal at station ${opts.normalStation.id} (${opts.normalStation.nameEn}) is ${fmt(opts.normalStation.annual, 1)} mm/year (gauge statistic, different period and method).`
    : null;

  const rainAnnualProv = (a: AreaInput): DataProvenance => {
    const r = rain.get(a.id);
    const yrs = r?.annual?.years ?? [];
    return srcProv(ctx, grid?.provenance.sourceId, {
      status: "estimated",
      observedFrom: yrs.length ? `${yrs[0].year}-01-01` : undefined,
      observedTo: yrs.length ? `${yrs[yrs.length - 1].year}-12-31` : undefined,
      referenceYear: yrs.length ? yrs[yrs.length - 1].year : undefined,
      geographicScope: `Area anchor of ${a.nameEn} (IDW of 4 nearest ERA5 lattice points)`,
      methodology: `Mean of the annual totals of the area's IDW daily series (rain-areas.json) over complete calendar years: ${yrs.map((y) => `${y.year} ${fmt(y.total, 1)} mm`).join(", ")}.`,
      limitations: [RAIN_COARSE_LIMITATION, "Modelled reanalysis, not rain-gauge observations; ERA5 smooths convective storms.", ...(normalNote ? [normalNote] : [])],
    });
  };
  const rain24Prov = (scope: string): DataProvenance =>
    srcProv(ctx, grid?.provenance.sourceId, {
      status: "estimated",
      observedFrom: lastDate,
      observedTo: lastDate,
      referenceYear: lastDate ? Number(lastDate.slice(0, 4)) : undefined,
      geographicScope: scope,
      methodology: `Daily reanalysis total for the latest date in the series (${lastDate}, local day ≈ 23:00–23:00), from rain-areas.json (IDW of the ERA5 lattice).`,
      limitations: [
        RAIN_COARSE_LIMITATION,
        "Latest COMPLETE ERA5 day at retrieval (≈5-day latency) — not a real-time reading; preliminary ERA5T data may be revised. Real-time gauge snapshots are in stations.json.",
      ],
    });

  /* ---- per-area metrics */
  const records: AreaRecord[] = [];
  const modelRows: Record<string, unknown>[] = [];
  for (const a of areas) {
    const pop = core.population.get(a.id)!;
    const areaM = areaKm2Metric(ctx, a);
    const col = core.wasteCollected.get(a.id)!;
    const gen = core.wasteGenerated.get(a.id)!;
    const popV = pop.value;
    const areaV = areaM.value;

    const density = mv(
      popV !== null && areaV ? round(popV / areaV, 1) : null,
      "persons/km2",
      srcProv(ctx, "urban-intel-derived", {
        status: "derived",
        sourceName: `Derived: ${pop.provenance.sourceName ?? pop.provenance.sourceId} ÷ polygon area`,
        observedTo: pop.provenance.observedTo,
        referenceYear: pop.provenance.referenceYear,
        geographicScope: a.nameEn,
        methodology: `population (${popV === null ? "n/a" : fmtInt(popV)}) ÷ areaKm2 (${areaV === null ? "n/a" : fmt(areaV, 3)} km²), rounded to 0.1 persons/km².`,
        limitations: [
          ...(pop.provenance.limitations ?? []),
          ...(a.geometryStatus === "approximate" ? ["Area comes from an approximate demonstration polygon."] : []),
        ],
      }),
    );
    const colV = col.value;
    const perCap = mv(
      colV !== null && popV ? round((colV * 1000) / popV, 3) : null,
      "kg/person/day",
      srcProv(ctx, "urban-intel-derived", {
        status: core.wasteDerivedStatus,
        sourceName: core.densitySourceName,
        observedFrom: col.provenance.observedFrom,
        observedTo: col.provenance.observedTo,
        referenceYear: col.provenance.referenceYear,
        geographicScope: a.nameEn,
        methodology: `Measure: COLLECTED waste (not generated). wasteCollected (${colV === null ? "n/a" : fmt(colV, 2)} t/day) × 1000 ÷ population (${popV === null ? "n/a" : fmtInt(popV)}). ${core.perCapitaContext}`,
        limitations: [...core.perCapitaLimitations, ...collectedOnlyNote(gen)],
      }),
    );
    const wDensity = mv(
      colV !== null && areaV ? round(colV / areaV, 3) : null,
      "t/day/km2",
      srcProv(ctx, "urban-intel-derived", {
        status: core.wasteDerivedStatus,
        sourceName: `Derived: collected waste (${col.provenance.sourceName ?? col.provenance.sourceId ?? "n/a"}) ÷ polygon area`,
        observedFrom: col.provenance.observedFrom,
        observedTo: col.provenance.observedTo,
        referenceYear: col.provenance.referenceYear,
        geographicScope: a.nameEn,
        methodology: `Measure: COLLECTED waste (not generated). wasteCollected (${colV === null ? "n/a" : fmt(colV, 2)} t/day) ÷ areaKm2 (${areaV === null ? "n/a" : fmt(areaV, 3)} km²).`,
        limitations: [...(a.geometryStatus === "approximate" ? ["Area comes from an approximate demonstration polygon."] : []), ...collectedOnlyNote(gen)],
      }),
    );

    // accumulation (simulated) — inflow = generated where available, else collected as a proxy
    const inflow = gen.value ?? colV;
    const inflowLabel = gen.value !== null ? "wasteGenerated" : "wasteCollected (proxy for generation)";
    const acc = simulateAccumulation(inflow, BASELINE_SCENARIO.collectionEfficiency, 30, 0);
    const accum = mv(
      acc ? round(acc.final, 2) : null,
      "t",
      srcProv(ctx, "urban-intel-simulation-model", {
        status: "simulated",
        geographicScope: a.nameEn,
        methodology: `simulateAccumulation(inflow = ${inflowLabel} ${inflow === null ? "n/a" : fmt(inflow, 2)} t/day, η = ${BASELINE_SCENARIO.collectionEfficiency} (baseline scenario), 30 daily steps, A₀ = 0) — final stock; steady state G·(1−η)/η = ${inflow === null ? "n/a" : fmt(steadyStateAccumulation(inflow, BASELINE_SCENARIO.collectionEfficiency) ?? 0, 2)} t. Model v${MODEL_VERSION}; see docs/SIMULATION_MODEL.md §13.`,
        limitations: [
          "Illustrative stock model, not a measured quantity of uncollected waste.",
          ...(gen.value === null ? ["No generation figure exists for this area; collected tonnage is used as the inflow, which understates generation."] : []),
        ],
      }),
    );

    const r = rain.get(a.id);
    const rainAnnual = mv(r?.annual?.mean ?? null, "mm/year", rainAnnualProv(a));
    const lastVal = r ? r.idw.values[r.idw.values.length - 1] : null;
    const rain24 = mv(lastVal, "mm", rain24Prov(`Area anchor of ${a.nameEn} (IDW of 4 nearest ERA5 lattice points)`));

    const E = opts.exposure.get(a.id)!;
    const W = opts.obstruction.get(a.id)!;
    const exposure = mv(E.value, "index", E.prov);
    const obstruction = mv(W.value, "index", W.prov);

    const s = spatial(a.id);
    const risk = computeAreaRisk({ floodExposure: E.value, obstructionSusceptibility: W.value, rainSpatialFactor: s }, BASELINE_SCENARIO, DEFAULT_ASSUMPTIONS);
    const modelProv = (what: string): DataProvenance =>
      srcProv(ctx, "urban-intel-simulation-model", {
        status: "simulated",
        geographicScope: a.nameEn,
        methodology: `${what} from computeAreaRisk(model v${MODEL_VERSION}) with the BASELINE scenario (${BASELINE_SCENARIO.rainIntensityMmH} mm/h × ${BASELINE_SCENARIO.rainDurationH} h, capacity reduction ${BASELINE_SCENARIO.drainageCapacityReduction}, obstruction ${BASELINE_SCENARIO.obstruction}, upstream ${BASELINE_SCENARIO.upstreamRunoff}, η ${BASELINE_SCENARIO.collectionEfficiency}), design intensity ${DEFAULT_ASSUMPTIONS.designIntensityMmH} mm/h, inputs E = ${E.value ?? "n/a"}, W = ${W.value ?? "n/a"}, rainSpatialFactor = ${round(s, 4)} (area annual rainfall ÷ mean over the city's areas). See docs/SIMULATION_MODEL.md.`,
        limitations: ["Illustrative scenario output — not an official flood forecast; weights and capacity are demo assumptions."],
      });
    const drainage = mv(risk.drainageStressPct, "%", modelProv("Modelled drainage stress (D × 100)"));
    const riskM = mv(risk.score, "score", modelProv(`Modelled flood-risk score (class ${risk.riskClass ?? "n/a"}, completeness ${risk.completeness})`));
    modelRows.push({ id: a.id, E: E.value, W: W.value, rainSpatialFactor: round(s, 4), score: risk.score, riskClass: risk.riskClass, drainageStressPct: risk.drainageStressPct, loadRatio: risk.loadRatio });

    const metrics: AreaMetrics = {
      population: pop,
      areaKm2: areaM,
      populationDensity: density,
      wasteGenerated: gen,
      wasteCollected: col,
      wasteAccumulated: accum,
      wastePerCapita: perCap,
      wasteDensity: wDensity,
      rainfallAnnual: rainAnnual,
      rainfall24h: rain24,
      drainageStress: drainage,
      floodExposure: exposure,
      obstructionSusceptibility: obstruction,
      modeledFloodRisk: riskM,
    };
    const anc = anchors.get(a.id)!;
    const n = opts.notes.get(a.id) ?? { th: [], en: [] };
    const rec: AreaRecord = {
      id: a.id,
      fid: a.fid,
      cityId: city,
      ...(a.code ? { code: a.code } : {}),
      nameTh: a.nameTh,
      nameEn: a.nameEn,
      kind: a.kind,
      anchor: anc.anchor,
      geometryStatus: a.geometryStatus,
      metrics,
      ...(opts.areaComposition?.get(a.id) ? { composition: opts.areaComposition.get(a.id)! } : {}),
      wasteHistory: opts.wasteHistory.get(a.id) ?? [],
      ...(opts.wasteGeneratedHistory?.get(a.id)?.length ? { wasteGeneratedHistory: opts.wasteGeneratedHistory.get(a.id)! } : {}),
      notesTh: [...n.th, anc.sourceTh],
      notesEn: [...n.en, anc.sourceEn],
    };
    records.push(rec);
  }

  /* ---- totals */
  const tb = opts.totalsBase;
  const tPop = tb.population.value;
  const tArea = tb.areaKm2.value;
  const tCol = tb.wasteCollected.value;
  const tGen = tb.wasteGenerated.value;
  const popW = (r: AreaRecord) => r.metrics.population.value;
  const areaW = (r: AreaRecord) => r.metrics.areaKm2.value;
  const derivedTotalProv = (methodology: string, extra: Partial<DataProvenance> = {}): DataProvenance =>
    srcProv(ctx, "urban-intel-derived", { status: "derived", geographicScope: `${CITY_META[city].nameEn} (city total)`, methodology, ...extra });

  const tAcc = simulateAccumulation(tGen ?? tCol, BASELINE_SCENARIO.collectionEfficiency, 30, 0);
  const meanOf = (key: keyof AreaMetrics, weight: (r: AreaRecord) => number | null) => weightedMean(records.map((r) => ({ v: r.metrics[key].value, w: weight(r) })));
  const tRainAnnual = meanOf("rainfallAnnual", areaW);
  const tRain24 = meanOf("rainfall24h", areaW);
  const tE = meanOf("floodExposure", areaW);
  const tW = meanOf("obstructionSusceptibility", areaW);
  const tD = meanOf("drainageStress", popW);
  const tR = meanOf("modeledFloodRisk", popW);
  const yrs = rain.get(areas[0].id)?.annual?.years ?? [];
  const ratioNote =
    opts.normalStation && tRainAnnual
      ? `ERA5 area-weighted mean (${fmt(round(tRainAnnual, 1), 1)} mm/year) is ${Math.round((tRainAnnual / opts.normalStation.annual) * 100)}% of the TMD ${opts.normalStation.period} normal at station ${opts.normalStation.id} ${opts.normalStation.nameEn} (${fmt(opts.normalStation.annual, 1)} mm/year); use reanalysis values for relative comparison and timing, not as absolute local depths.`
      : null;

  const totals: AreaMetrics = {
    population: tb.population,
    areaKm2: tb.areaKm2,
    populationDensity: mv(
      tPop !== null && tArea ? round(tPop / tArea, 1) : null,
      "persons/km2",
      derivedTotalProv(`City population (${tPop === null ? "n/a" : fmtInt(tPop)}) ÷ city area (${tArea === null ? "n/a" : fmt(tArea, 3)} km²).`, {
        observedTo: tb.population.provenance.observedTo,
        referenceYear: tb.population.provenance.referenceYear,
      }),
    ),
    wasteGenerated: tb.wasteGenerated,
    wasteCollected: tb.wasteCollected,
    wasteAccumulated: mv(
      tAcc ? round(tAcc.final, 2) : null,
      "t",
      srcProv(ctx, "urban-intel-simulation-model", {
        status: "simulated",
        geographicScope: `${CITY_META[city].nameEn} (city total)`,
        methodology: `simulateAccumulation(inflow = ${tGen !== null ? "city wasteGenerated" : "city wasteCollected (proxy for generation)"} ${fmt((tGen ?? tCol) ?? 0, 2)} t/day, η = ${BASELINE_SCENARIO.collectionEfficiency}, 30 daily steps, A₀ = 0) — final stock. Model v${MODEL_VERSION}.`,
        limitations: ["Illustrative stock model, not a measured quantity."],
      }),
    ),
    wastePerCapita: mv(
      tCol !== null && tPop ? round((tCol * 1000) / tPop, 3) : null,
      "kg/person/day",
      derivedTotalProv(`Measure: COLLECTED waste (not generated). City wasteCollected (${tCol === null ? "n/a" : fmt(tCol, 2)} t/day) × 1000 ÷ city population (${tPop === null ? "n/a" : fmtInt(tPop)}).`, {
        sourceName: tb.perCapitaSourceName,
        observedFrom: tb.wasteCollected.provenance.observedFrom,
        observedTo: tb.wasteCollected.provenance.observedTo,
        referenceYear: tb.wasteCollected.provenance.referenceYear,
        limitations: [...tb.perCapitaLimitations, ...collectedOnlyNote(tb.wasteGenerated, tPop)],
      }),
    ),
    wasteDensity: mv(
      tCol !== null && tArea ? round(tCol / tArea, 3) : null,
      "t/day/km2",
      derivedTotalProv(`Measure: COLLECTED waste (not generated). City wasteCollected (${tCol === null ? "n/a" : fmt(tCol, 2)} t/day) ÷ city area (${tArea === null ? "n/a" : fmt(tArea, 3)} km²).`, {
        observedFrom: tb.wasteCollected.provenance.observedFrom,
        observedTo: tb.wasteCollected.provenance.observedTo,
        referenceYear: tb.wasteCollected.provenance.referenceYear,
        limitations: collectedOnlyNote(tb.wasteGenerated),
      }),
    ),
    rainfallAnnual: mv(
      tRainAnnual === null ? null : round(tRainAnnual, 1),
      "mm/year",
      srcProv(ctx, grid?.provenance.sourceId, {
        status: "estimated",
        observedFrom: yrs.length ? `${yrs[0].year}-01-01` : undefined,
        observedTo: yrs.length ? `${yrs[yrs.length - 1].year}-12-31` : undefined,
        referenceYear: yrs.length ? yrs[yrs.length - 1].year : undefined,
        geographicScope: `${CITY_META[city].nameEn} — area-weighted mean of the ${records.length} areas`,
        methodology: "Area-weighted mean (weights = areaKm2) of the areas' ERA5 mean annual totals over complete calendar years.",
        limitations: [RAIN_COARSE_LIMITATION, ...(ratioNote ? [ratioNote] : [])],
      }),
    ),
    rainfall24h: mv(tRain24 === null ? null : round(tRain24, 1), "mm", {
      ...rain24Prov(`${CITY_META[city].nameEn} — area-weighted mean of the ${records.length} areas`),
      methodology: `Area-weighted mean (weights = areaKm2) of the areas' reanalysis totals for ${lastDate}.`,
    }),
    drainageStress: mv(
      tD === null ? null : round(tD, 1),
      "%",
      srcProv(ctx, "urban-intel-simulation-model", {
        status: "simulated",
        geographicScope: `${CITY_META[city].nameEn} — population-weighted mean of the areas`,
        methodology: `Population-weighted mean of the areas' baseline modelled drainage stress (model v${MODEL_VERSION}, BASELINE scenario).`,
        limitations: ["Illustrative scenario output — not an official forecast."],
      }),
    ),
    floodExposure: mv(
      tE === null ? null : round(tE, 3),
      "index",
      srcProv(ctx, "urban-intel-derived", {
        status: "estimated",
        geographicScope: `${CITY_META[city].nameEn} — area-weighted mean of the areas`,
        methodology: "Area-weighted mean of the per-area exposure index E (see area methodology).",
        limitations: ["Relative index within this city; not comparable between cities."],
      }),
    ),
    obstructionSusceptibility: mv(
      tW === null ? null : round(tW, 3),
      "index",
      srcProv(ctx, "urban-intel-derived", {
        status: "estimated",
        geographicScope: `${CITY_META[city].nameEn} — area-weighted mean of the areas`,
        methodology: "Area-weighted mean of the per-area obstruction susceptibility W (see area methodology).",
        limitations: ["Relative index within this city; not comparable between cities."],
      }),
    ),
    modeledFloodRisk: mv(
      tR === null ? null : round(tR, 1),
      "score",
      srcProv(ctx, "urban-intel-simulation-model", {
        status: "simulated",
        geographicScope: `${CITY_META[city].nameEn} — population-weighted mean of the areas`,
        methodology: `Population-weighted mean of the areas' baseline modelled risk scores (model v${MODEL_VERSION}, BASELINE scenario), matching the dashboard's city summary.`,
        limitations: ["Illustrative scenario output — not an official forecast."],
      }),
    ),
  };

  /* ---- city & dataset */
  const allBbox = turf.bbox(turf.featureCollection(areas.map((a) => turf.feature(a.geometry))));
  const bbox: [number, number, number, number] = [
    Math.floor(allBbox[0] * 1e4) / 1e4,
    Math.floor(allBbox[1] * 1e4) / 1e4,
    Math.ceil(allBbox[2] * 1e4) / 1e4,
    Math.ceil(allBbox[3] * 1e4) / 1e4,
  ];
  const cityObj: City = { ...CITY_META[city], bbox, periodLabelTh: opts.periodLabelTh, periodLabelEn: opts.periodLabelEn };
  const dataset: CityDataset = {
    city: cityObj,
    areas: records,
    totals,
    composition: opts.composition,
    wasteHistory: opts.cityWasteHistory,
    ...(opts.cityWasteGeneratedHistory?.length ? { wasteGeneratedHistory: opts.cityWasteGeneratedHistory } : {}),
    generatedAt: opts.generatedAt,
    limitations: opts.limitations,
  };

  const areasGeo: FeatureCollection = {
    type: "FeatureCollection",
    features: areas.map(
      (a): Feature => ({
        type: "Feature",
        properties: { fid: a.fid, id: a.id, nameTh: a.nameTh, nameEn: a.nameEn, geometryStatus: a.geometryStatus },
        geometry: a.geometry,
      }),
    ),
  };

  const report = {
    ...opts.report,
    anchors: areas.map((a) => ({ id: a.id, anchor: anchors.get(a.id)!.anchor, source: anchors.get(a.id)!.source })),
    anchorSourceCounts: areas.reduce<Record<string, number>>((acc, a) => {
      const k = anchors.get(a.id)!.source.split(":")[0];
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    rainIdw: areas.map((a) => ({ id: a.id, neighbours: rain.get(a.id)?.idw.neighbours ?? [], annual: rain.get(a.id)?.annual ?? null })),
    model: modelRows,
  };
  return { dataset, areasGeo, rainAreas, floodEvents: opts.floodEvents, report, waterwayDensity: opts.waterwayDensity };
}

/* ============================================================== Bangkok specifics */

function bangkok(ctx: Ctx, generatedAt: string): CityBuildResult {
  console.log("Bangkok");
  const areas = buildBangkokAreas();
  if (areas.length !== 50) warn(`Bangkok: expected 50 districts, found ${areas.length}`);
  const anchors = resolveAnchors("bangkok", areas);
  const popS = readJson<StagedBkkPopulation>(path.join(STAGED, "bangkok-population.json"));
  const wasteS = readJson<StagedBkkWaste>(path.join(STAGED, "bangkok-waste.json"));
  const compS = readJson<StagedComposition>(path.join(STAGED, "bangkok-composition.json"));
  const floodS = tryReadJson<StagedFloodPoints>(path.join(STAGED, "bangkok-flood-points.json"));
  const rainGrid = tryReadJson<RainSeries>(path.join(PUB, "bangkok", "rain-grid.json"));
  const genS = tryReadJson<StagedBkkGenerated>(path.join(STAGED, "bangkok-generated.json"));
  const dCompS = tryReadJson<StagedBkkDistrictComposition>(path.join(STAGED, "bangkok-district-composition.json"));
  const floodEventsS = tryReadJson<StagedFloodEvent[]>(path.join(STAGED, "bangkok-flood-events.json"));
  if (!genS) warn("Bangkok: data/staged/bangkok-generated.json missing — waste generated stays unavailable");
  if (!dCompS) warn("Bangkok: data/staged/bangkok-district-composition.json missing — no per-district composition");
  if (!floodEventsS) warn("Bangkok: data/staged/bangkok-flood-events.json missing — no Bangkok flood events");
  const genById = new Map((genS?.districts ?? []).map((d) => [d.areaId, d]));
  const genYearBE = genS?.latestAllocation.yearBE;
  const genCity = genS?.city.wasteGenerated ?? null;
  if (genS && !(genS.checks.latestSumEqualsCityTotal && genS.checks.everyYearSumEqualsCityTotal)) warn("Bangkok: staged generated allocation does not sum to the PCD total");

  const popDate = popS.latestReferenceDate;
  const popYear = popS.latestYear;
  const popById = new Map(popS.districts.map((d) => [`bkk-${d.code}`, d]));
  const wasteById = new Map(wasteS.districts.map((d) => [`bkk-${d.code}`, d]));
  const L = wasteS.latest;
  const othersRow = wasteS.others.find((o) => o.year === L.year);

  const population = new Map<string, MetricValue>();
  const wasteCollected = new Map<string, MetricValue>();
  const wasteGenerated = new Map<string, MetricValue>();
  const wasteHistory = new Map<string, YearValue[]>();
  const wasteGeneratedHistory = new Map<string, YearValue[]>();
  const areaComposition = new Map<string, WasteComposition>();
  const dCompById = new Map((dCompS?.districts ?? []).map((d) => [d.areaId, d]));
  const notes = new Map<string, { th: string[]; en: string[] }>();

  for (const a of areas) {
    const p = popById.get(a.id);
    population.set(
      a.id,
      mv(
        p?.latest.value ?? null,
        "persons",
        srcProv(ctx, popS.sourceId, {
          status: "observed",
          sourceUrl: popS.sourceUrl,
          observedTo: popDate,
          referenceYear: popYear,
          geographicScope: `District ${a.code} ${a.nameEn} (เขต${a.nameTh}) — DOPA registration`,
          methodology: `DOPA registered population at ${popDate} (BE ${popYear + 543}), as tabulated by NSO (table OS_0405_01_0005_01) and cross-checked against the DOPA stat_a files (all 50 districts equal).`,
          limitations: ["Registered (de jure) population; excludes unregistered residents, migrant workers, students and daytime commuters."],
        }),
      ),
    );
    const w = wasteById.get(a.id);
    const latest = w?.latest;
    const hrow = w?.history.find((h) => h.year === L.year);
    const days = hrow?.daysDivisor ?? daysInclusive(L.periodFrom, L.periodTo);
    wasteCollected.set(
      a.id,
      mv(
        latest?.tonnesPerDay ?? null,
        "t/day",
        srcProv(ctx, latest?.sourceId, {
          status: "observed",
          observedFrom: L.periodFrom,
          observedTo: L.periodTo,
          referenceYear: L.year,
          geographicScope: `District office ${a.code} ${a.nameEn} (สำนักงานเขต${a.nameTh})`,
          methodology: `Collected municipal solid waste (มูลฝอยที่จัดเก็บได้) delivered by the district office in FY BE ${L.fiscalYearBE} (${L.periodFrom} – ${L.periodTo}): ${latest?.totalTonnes === null || latest?.totalTonnes === undefined ? "n/a" : fmt(latest.totalTonnes, 2)} t ÷ ${days} days (as stated in the BMA table header) = ${latest?.tonnesPerDay ?? "n/a"} t/day; reproduces the publisher's own daily-average column. Year label = Gregorian year in which the fiscal year ends.`,
          limitations: [
            "Collected tonnage, not generation: excludes uncollected, informally recycled and self-disposed waste.",
            `Waste delivered by sources other than the 50 district offices ('Others', ${othersRow?.tonnesPerDay ?? "n/a"} t/day in FY BE ${L.fiscalYearBE}) is not allocated to any district.`,
          ],
        }),
      ),
    );
    const g = genById.get(a.id);
    wasteGenerated.set(
      a.id,
      g && g.wasteGenerated.value !== null
        ? mv(
            g.wasteGenerated.value,
            "t/day",
            srcProv(ctx, g.wasteGenerated.provenance.sourceId, {
              ...g.wasteGenerated.provenance,
              status: "estimated",
              limitations: [
                ...(g.wasteGenerated.provenance.limitations ?? []),
                `Different year from the collected figure: generated = PCD BE ${genYearBE} allocated with BMA FY BE ${g.allocationInputs.bmaFiscalYearBE} shares (district share ${fmt(g.allocationInputs.shareOf50Districts * 100, 3)}%); collected = BMA FY BE ${L.fiscalYearBE}. Do not subtract one from the other.`,
              ],
            }),
          )
        : mv(null, "t/day", {
            status: "unavailable",
            geographicScope: `District ${a.code} ${a.nameEn}`,
            methodology: "No district-level generation figure: BMA publishes collected tonnage by district office only, and the PCD Bangkok total could not be allocated to this district. Collected and generated waste are never mixed.",
          }),
    );
    if (g) {
      wasteGeneratedHistory.set(
        a.id,
        g.history
          .slice()
          .sort((x, y) => x.year - y.year)
          .map((h): YearValue => ({ year: h.year, value: h.value, unit: "t/day", status: h.value === null ? "unavailable" : "estimated" })),
      );
    }
    const dc = dCompById.get(a.id);
    if (dc) {
      areaComposition.set(a.id, {
        shares: {
          organic: dc.composition.shares.organic,
          plastic: dc.composition.shares.plastic,
          paper: dc.composition.shares.paper,
          glassMetal: dc.composition.shares.glassMetal,
          hazardous: dc.composition.shares.hazardous,
          other: dc.composition.shares.other,
        },
        provenance: srcProv(ctx, dc.composition.provenance.sourceId, { ...dc.composition.provenance, status: "estimated" }),
      });
    }
    wasteHistory.set(
      a.id,
      (w?.history ?? [])
        .slice()
        .sort((x, y) => x.year - y.year)
        .map((h): YearValue => ({ year: h.year, value: h.tonnesPerDay, unit: "t/day", status: h.tonnesPerDay === null ? "unavailable" : "observed" })),
    );
  }

  /* ---- flood-risk points + waterway proximity → E; waste density + waterway length density → W */
  const P = makeProjector(CITY_META.bangkok.center[0], CITY_META.bangkok.center[1]);
  const ww = ensureWaterwayKinds("bangkok");
  const wstats = waterwayStats("bangkok", areas, ww, P, 100, () => false);
  const primary = floodS?.series.find((s) => s.id === floodS.primarySeriesId) ?? null;
  const register = floodS?.series.find((s) => s.id === "bma-dds-flood-risk-register") ?? null;
  const ppk = areas.map((a) => {
    if (!primary) return null;
    const c = primary.countsByDistrict[a.code!];
    return c === null || c === undefined ? null : c / a.areaKm2;
  });
  const share = areas.map((a) => wstats.get(a.id)?.share300 ?? null);
  const nP = minMax(ppk),
    nS = minMax(share);
  const exposure = new Map<string, { value: number | null; prov: DataProvenance }>();
  areas.forEach((a, i) => {
    const hasPts = nP[i] !== null;
    const value = hasPts && nS[i] !== null ? round(0.7 * nP[i]! + 0.3 * nS[i]!, 3) : nS[i] !== null ? round(nS[i]!, 3) : null;
    const cnt = primary?.countsByDistrict[a.code!];
    exposure.set(a.id, {
      value,
      prov: srcProv(ctx, "urban-intel-derived", {
        status: "estimated",
        sourceName: `Derived: ${primary ? `BMA DDS flood-risk points ${primary.referenceYear ?? ""} (${primary.sourceId})` : "no flood-point data"} + OpenStreetMap waterways (osm-bkk-waterways)`,
        observedFrom: primary?.referenceYear ? `${primary.referenceYear}-01-01` : undefined,
        observedTo: primary?.referenceYear ? `${primary.referenceYear}-12-31` : undefined,
        referenceYear: primary?.referenceYear ?? undefined,
        geographicScope: `District ${a.code} ${a.nameEn}`,
        methodology: hasPts
          ? `E = 0.7 × minmax(flood-risk points per km²) + 0.3 × minmax(share of district area within 300 m of a mapped OSM waterway), min–max over the 50 districts. This district: ${cnt} points ÷ ${fmt(a.areaKm2, 3)} km² = ${fmt(ppk[i]!, 3)} /km²; waterway share ${share[i] === null ? "n/a" : fmt(share[i]! * 100, 1)}% (100 m sample lattice; river, canal, stream, drain lines and water-area polygons).`
          : `E = minmax(share of district area within 300 m of a mapped OSM waterway) (no flood-point data).`,
        limitations: [
          "Proxy index of relative exposure within Bangkok (0 = lowest district, 1 = highest); not a hydraulic flood hazard map and not comparable with Hat Yai.",
          "Flood-risk points are the DDS designated list for the season (counted by the district stated by the agency; 20 of 216 points plot in a neighbouring district). Point counts reflect administrative designation, not flood depth or frequency.",
          "OSM waterway mapping completeness varies; weights 0.7/0.3 are demonstration assumptions.",
        ],
      }),
    });
  });
  const wDens = areas.map((a) => {
    const c = wasteCollected.get(a.id)!.value;
    return c !== null ? c / a.areaKm2 : null;
  });
  const lDens = areas.map((a) => wstats.get(a.id)?.lengthDensityKmPerKm2 ?? null);
  const nWD = minMax(wDens),
    nLD = minMax(lDens);
  const obstruction = new Map<string, { value: number | null; prov: DataProvenance }>();
  areas.forEach((a, i) => {
    const value = nWD[i] !== null && nLD[i] !== null ? round(0.5 * nWD[i]! + 0.5 * nLD[i]!, 3) : null;
    obstruction.set(a.id, {
      value,
      prov: srcProv(ctx, "urban-intel-derived", {
        status: "estimated",
        sourceName: "Derived: BMA collected waste FY2569 by district + OpenStreetMap waterway length",
        observedFrom: L.periodFrom,
        observedTo: L.periodTo,
        referenceYear: L.year,
        geographicScope: `District ${a.code} ${a.nameEn}`,
        methodology: `W = 0.5 × minmax(collected waste density, t/day/km²) + 0.5 × minmax(OSM waterway line length density, km/km²), min–max over the 50 districts. This district: ${wDens[i] === null ? "n/a" : fmt(wDens[i]!, 3)} t/day/km²; ${wstats.get(a.id)?.lengthKm ?? "n/a"} km of mapped waterway lines = ${lDens[i] === null ? "n/a" : fmt(lDens[i]!, 3)} km/km² (lines split into ≤20 m pieces assigned by midpoint).`,
        limitations: [
          "Proxy for how much waste pressure coincides with open drainage channels; it does not measure actual blockage. Waste is a possible contributing factor, not a proven cause of flooding.",
          "Relative index within Bangkok; OSM waterway completeness varies; equal weights are a demonstration assumption.",
        ],
      }),
    });
  });

  for (const a of areas) {
    const ws = wstats.get(a.id);
    const pc = primary?.countsByDistrict[a.code!];
    const rc = register?.countsByDistrict[a.code!];
    const off = a.extra.areaKm2Official as number | undefined;
    notes.set(a.id, {
      en: [
        `Collected waste FY BE ${L.fiscalYearBE} (${L.periodFrom} – ${L.periodTo}); population = DOPA registration at ${popDate}.`,
        ...(genById.has(a.id) ? [`Waste generated = PCD Bangkok total BE ${genYearBE} allocated by this district's share of BMA collected tonnage (estimated).`] : []),
        ...(dCompById.has(a.id) ? ["Composition = Bangkok citywide FY BE 2565 shares applied to this district (estimated; no district survey exists)."] : []),
        ...(primary ? [`BMA DDS flood-risk points ${primary.referenceYear}: ${pc ?? "n/a"}${register ? `; DDS flood-risk register (all statuses): ${rc ?? "n/a"}` : ""}.`] : []),
        ...(ws ? [`Share within 300 m of a mapped OSM waterway: ${ws.share300 === null ? "n/a" : fmt(ws.share300 * 100, 1)}%; mapped waterway lines ${fmt(ws.lengthKm, 1)} km.`] : []),
        ...(typeof off === "number" ? [`BMA area table: ${fmt(off, 3)} km²; polygon area: ${fmt(a.areaKm2, 3)} km².`] : []),
      ],
      th: [
        `ขยะที่จัดเก็บได้ ปีงบประมาณ ${L.fiscalYearBE} (${thDate(L.periodFrom)} – ${thDate(L.periodTo)}); ประชากรตามทะเบียนราษฎร ณ ${thDate(popDate)}`,
        ...(genById.has(a.id) ? [`ขยะที่เกิดขึ้น = ยอดรวมกรุงเทพฯ ของกรมควบคุมมลพิษ ปี ${genYearBE} ปันส่วนตามสัดส่วนขยะที่จัดเก็บได้ของเขตนี้ (ข้อมูลประมาณการ)`] : []),
        ...(dCompById.has(a.id) ? ["องค์ประกอบขยะ = สัดส่วนระดับเมือง ปีงบประมาณ 2565 ที่นำมาใช้กับเขตนี้ (ข้อมูลประมาณการ ไม่มีการสำรวจรายเขต)"] : []),
        ...(primary ? [`จุดเสี่ยงน้ำท่วม สำนักการระบายน้ำ ปี ${(primary.referenceYear ?? 0) + 543}: ${pc ?? "ไม่มีข้อมูล"} จุด${register ? `; ทะเบียนจุดเสี่ยงน้ำท่วม (ทุกสถานะ): ${rc ?? "ไม่มีข้อมูล"} จุด` : ""}`] : []),
        ...(ws ? [`สัดส่วนพื้นที่ในระยะ 300 ม. จากทางน้ำใน OSM: ${ws.share300 === null ? "ไม่มีข้อมูล" : fmt(ws.share300 * 100, 1)}%; ความยาวทางน้ำที่ทำแผนที่ ${fmt(ws.lengthKm, 1)} กม.`] : []),
        ...(typeof off === "number" ? [`พื้นที่ตามตาราง กทม.: ${fmt(off, 3)} ตร.กม.; พื้นที่จากรูปแปลง: ${fmt(a.areaKm2, 3)} ตร.กม.`] : []),
      ],
    });
  }

  /* ---- totals */
  const ct = popS.cityTotals.find((t) => t.year === popYear);
  const sumAreas = round(areas.reduce((s, a) => s + a.areaKm2, 0), 3);
  const cityCol = wasteS.cityTotals.collected.find((c) => c.year === L.year);
  const sumDistrictTpd = round(areas.reduce((s, a) => s + (wasteCollected.get(a.id)!.value ?? 0), 0), 2);
  const totalsBase = {
    population: mv(
      ct?.publishedTotal ?? null,
      "persons",
      srcProv(ctx, popS.sourceId, {
        status: "observed",
        sourceUrl: popS.sourceUrl,
        observedTo: popDate,
        referenceYear: popYear,
        geographicScope: "Bangkok Metropolis (กรุงเทพมหานคร), 50 districts",
        methodology: `Published Bangkok total of DOPA registered population at ${popDate}; equals the sum of the 50 districts (${ct ? fmtInt(ct.sumOfDistricts) : "n/a"}).`,
        limitations: ["Registered (de jure) population; excludes unregistered residents, migrant workers and commuters."],
      }),
    ),
    areaKm2: mv(
      sumAreas,
      "km2",
      srcProv(ctx, "bma-gis-district-boundaries", {
        status: "derived",
        geographicScope: "Bangkok Metropolis, 50 district polygons",
        methodology: "Sum of the 50 district polygon areas (turf.area, geodesic).",
        limitations: [`BMA's official area is 1,568.737 km² (50district.csv); the polygon sum is ${fmt(sumAreas, 3)} km² (${fmt(((sumAreas - 1568.737) / 1568.737) * 100, 2)}%).`],
      }),
    ),
    wasteCollected: mv(
      cityCol?.tonnesPerDay ?? L.cityTonnesPerDay,
      "t/day",
      srcProv(ctx, cityCol?.sourceId ?? "bma-env-waste-fy2569", {
        status: "observed",
        observedFrom: L.periodFrom,
        observedTo: L.periodTo,
        referenceYear: L.year,
        geographicScope: "Bangkok Metropolis — all collection (50 district offices + 'Others')",
        methodology: `Published city total FY BE ${L.fiscalYearBE}: ${fmt(L.cityTotalTonnes, 2)} t ÷ ${daysInclusive(L.periodFrom, L.periodTo)} days = ${fmt(L.cityTonnesPerDay, 2)} t/day (publisher's average).`,
        limitations: [
          `The 50 districts sum to ${fmt(sumDistrictTpd, 2)} t/day — less than the city total because the 'Others' row (${othersRow?.tonnesPerDay ?? "n/a"} t/day; ${fmt(L.othersTonnes, 2)} t) is not allocated to any district.`,
          "Collected tonnage, not generation.",
        ],
      }),
    ),
    wasteGenerated:
      genCity && genCity.value !== null
        ? mv(
            genCity.value,
            "t/day",
            srcProv(ctx, genCity.provenance.sourceId, {
              ...genCity.provenance,
              status: "observed",
              limitations: [
                ...(genCity.provenance.limitations ?? []),
                `Different source, definition and year from the collected total (BMA FY BE ${L.fiscalYearBE}); the 50 district estimates sum exactly to this value.`,
              ],
            }),
          )
        : mv(null, "t/day", {
            status: "unavailable",
            geographicScope: "Bangkok Metropolis",
            methodology: "No sourced generation figure was available (data/staged/bangkok-generated.json missing). Collected and generated waste are never mixed.",
          }),
    perCapitaLimitations: [
      `Cross-period: waste FY BE ${L.fiscalYearBE} (${L.periodFrom} – ${L.periodTo}) ÷ registered population at ${popDate} (inside the fiscal year).`,
      "City total includes the unallocated 'Others' row; district per-capita values exclude it.",
      "Registered population understates the people actually served (commuters, unregistered residents), which inflates per-capita values, especially in central districts.",
    ],
    perCapitaSourceName: `Derived: BMA collected waste FY${L.year} ÷ DOPA registered population ${popYear}`,
  };

  /* ---- composition */
  const cs = compS.composition;
  const composition: WasteComposition = {
    shares: {
      organic: cs.shares.organic,
      plastic: cs.shares.plastic,
      paper: cs.shares.paper,
      glassMetal: cs.shares.glassMetal,
      hazardous: cs.shares.hazardous,
      other: cs.shares.other,
    },
    provenance: {
      ...cs.provenance,
      methodology: `${cs.provenance.methodology} Mapping: ${compS.mappingRationale.join(" ")}`,
      limitations: [
        ...(cs.provenance.limitations ?? []),
        `Sample scope: ${compS.primary.sampleScope}`,
        "City-level shares; BMA publishes no district-level (or district-group) composition. Each district carries these shares as an ESTIMATE.",
      ],
    },
  };

  /* ---- city history, normals, labels */
  const cityWasteHistory: YearValue[] = wasteS.cityTotals.collected
    .slice()
    .sort((a, b) => a.year - b.year)
    .map((c) => ({ year: c.year, value: c.tonnesPerDay, unit: "t/day", status: c.tonnesPerDay === null ? "unavailable" : "observed" }));
  // PCD generated series; PCD rows not yet reported (all-zero) are unavailable — kept only up to the collected series' last year.
  const cityWasteGeneratedHistory: YearValue[] = genS
    ? [
        ...genS.citySeries.map((c): YearValue => ({ year: c.year, value: c.generatedTPerDay, unit: "t/day", status: c.generatedTPerDay === null ? "unavailable" : "observed" })),
        ...genS.city.yearsNotYetReportedBE.map((be): YearValue => ({ year: be - 543, value: null, unit: "t/day", status: "unavailable" })),
      ]
        .filter((y) => y.year <= L.year)
        .sort((a, b) => a.year - b.year)
    : [];
  const ns = ctx.normals?.stations.find((s) => s.cityId === "bangkok");
  const normalStation = ns ? { id: ns.wmoIndex, nameEn: ns.nameEn, annual: ns.annualRainfall.value, period: ns.period } : undefined;
  const rFrom = rainGrid?.dates[0] ?? "";
  const rTo = rainGrid?.dates[rainGrid.dates.length - 1] ?? "";
  const periodLabelTh = `ประชากร ${thDate(popDate)} · ขยะ ปีงบ ${L.fiscalYearBE} · ฝน ERA5 ${rFrom ? Number(rFrom.slice(0, 4)) + 543 : "-"}–${rTo ? Number(rTo.slice(0, 4)) + 543 : "-"}`;
  const periodLabelEn = `Population ${enDate(popDate)} · Waste FY${L.year} (${enMonthYear(L.periodFrom)}–${enMonthYear(L.periodTo)}) · Rain ERA5 ${rFrom.slice(0, 4)}–${rTo.slice(0, 4)}`;
  const designStmt = ctx.capacity?.statements.find((s) => s.id === "bkk-design-intensity-60mmh-2025");

  const limitations = [
    `Waste figures are COLLECTED tonnage by district office (BMA Environment Department, FY BE ${L.fiscalYearBE} = ${L.periodFrom} – ${L.periodTo}), not generation. The city total (${fmt(L.cityTonnesPerDay, 2)} t/day) includes an unallocated 'Others' row (${othersRow?.tonnesPerDay ?? "n/a"} t/day), so the 50 districts sum to less (${fmt(sumDistrictTpd, 2)} t/day).`,
    `Population is DOPA registered population at ${popDate} (de jure), not resident or daytime population.`,
    ...(genCity && genCity.value !== null
      ? [
          `Waste GENERATED is a separate measure: Pollution Control Department Bangkok total ${fmt(genCity.value, 0)} t/day for BE ${genYearBE} (observed; PCD does not state calendar vs fiscal year). District generated values are ESTIMATES that allocate this total by each district's share of BMA collected tonnage (FY BE ${genYearBE}); the BMA 'Others' row (${fmt((genS?.latestAllocation.othersShareOfGrandTotal ?? 0) * 100, 2)}% of collected tonnage) is spread pro rata. Generated and collected values are never mixed: per-capita, density, the obstruction index W and rankings use collected waste; the modelled accumulation stock uses generated waste as inflow.`,
        ]
      : []),
    `Composition is citywide (BMA FY BE ${compS.primary.fiscalYearBE}); the source table has no hazardous-waste category, so hazardous = 0.0 means "not reported", not a measured zero.${dCompS ? " BMA publishes no district or district-group composition, so every district shows the citywide shares as an estimate." : ""}`,
    `Rainfall is ERA5 reanalysis (0.25° cells; ${rainGrid ? "11 distinct cells over the 42-point lattice" : "unavailable"}): differences between neighbouring districts are mostly not resolved, and ERA5 annual totals run below the TMD station normal${normalStation ? ` (${fmt(normalStation.annual, 1)} mm/year at ${normalStation.id}, ${normalStation.period})` : ""}. Real-time gauge readings are snapshots (stations.json).`,
    "Flood exposure (E) and obstruction susceptibility (W) are relative proxy indices built from BMA flood-risk point counts, waste density and OSM waterways; OSM drainage mapping is incomplete.",
    `Drainage stress and modelled flood risk are illustrative outputs of the demo model (baseline scenario; assumed design intensity ${DEFAULT_ASSUMPTIONS.designIntensityMmH} mm/h${designStmt ? ", cf. the BMA statement of 60 mm/h" : ""}) — not an official forecast.`,
    ...(floodEventsS?.length
      ? [
          `Flood events (${floodEventsS.length}) are documented historical events with cited sources (HII, World Bank, ThaiWater, BMA via Thai PBS); peak rainfall values are single-gauge maxima, not areal averages, and no flood-extent polygons are included.`,
        ]
      : ["No Bangkok flood event is documented in the staged sources, so flood-events.json is empty for Bangkok."]),
    "District polygons: BMA GIS (official, exported 2020); polygon areas differ from BMA's published area table for some districts.",
  ];

  const waterwayDensity = Object.fromEntries(areas.map((a) => [a.id, wstats.get(a.id)]));
  return assembleCity(
    ctx,
    {
      city: "bangkok",
      areas,
      anchors,
      population,
      wasteCollected,
      wasteGenerated,
      wasteDerivedStatus: "derived",
      perCapitaLimitations: totalsBase.perCapitaLimitations.filter((s) => !s.startsWith("City total")).concat("District values exclude the unallocated 'Others' row."),
      perCapitaContext: `Waste FY BE ${L.fiscalYearBE}; population at ${popDate}.`,
      densitySourceName: `Derived: BMA collected waste FY${L.year} ÷ DOPA registered population ${popYear}`,
    },
    {
      rainGrid,
      exposure,
      obstruction,
      composition,
      areaComposition,
      wasteHistory,
      cityWasteHistory,
      wasteGeneratedHistory,
      cityWasteGeneratedHistory,
      totalsBase,
      notes,
      periodLabelTh,
      periodLabelEn,
      limitations,
      floodEvents: (floodEventsS ?? []).map((e) => {
        if (e.cityId !== "bangkok") warn(`bangkok-flood-events.json: ${e.id} has cityId ${e.cityId}`);
        for (const id of [e.sourceId, ...(e.sourceIds ?? []), ...(e.peakValues ?? []).map((p) => p.sourceId)])
          if (id && !ctx.sources.has(id)) warn(`bangkok flood event ${e.id}: unknown sourceId "${id}"`);
        return e;
      }),
      generatedAt,
      normalStation,
      report: {
        floodPointsSeries: primary ? { id: primary.id, total: primary.total, referenceYear: primary.referenceYear } : null,
        exposureInputs: areas.map((a, i) => ({ id: a.id, pointsPerKm2: ppk[i] === null ? null : round(ppk[i]!, 4), share300: share[i], E: exposure.get(a.id)!.value })),
        obstructionInputs: areas.map((a, i) => ({ id: a.id, wasteDensity: wDens[i] === null ? null : round(wDens[i]!, 4), lengthDensity: lDens[i], W: obstruction.get(a.id)!.value })),
        sumDistrictWasteTpd: sumDistrictTpd,
        cityWasteTpd: L.cityTonnesPerDay,
        generated: genS
          ? {
              cityTPerDay: genCity?.value ?? null,
              yearBE: genYearBE,
              sumOfDistrictsTPerDay: round(areas.reduce((acc, a) => acc + (wasteGenerated.get(a.id)!.value ?? 0), 0), 2),
              districtsWithValue: areas.filter((a) => wasteGenerated.get(a.id)!.value !== null).length,
            }
          : null,
        districtCompositions: areaComposition.size,
      },
      waterwayDensity,
    },
  );
}

/* ============================================================== Hat Yai specifics */

function hatyai(ctx: Ctx, generatedAt: string): CityBuildResult {
  console.log("Hat Yai");
  const areas = buildHatyaiAreas();
  if (areas.length !== 4) warn(`Hat Yai: expected 4 zones, found ${areas.length}`);
  const anchors = resolveAnchors("hatyai", areas);
  const popS = readJson<StagedHyPopulation>(path.join(STAGED, "hatyai-population.json"));
  const wasteS = readJson<StagedHyWaste>(path.join(STAGED, "hatyai-waste.json"));
  const floodS = tryReadJson<StagedHyFlood>(path.join(STAGED, "hatyai-flood.json"));
  const compS = tryReadJson<StagedHyComposition>(path.join(STAGED, "hatyai-composition.json"));
  if (!compS) warn("Hat Yai: data/staged/hatyai-composition.json missing — composition stays unavailable");
  const rainGrid = tryReadJson<RainSeries>(path.join(PUB, "hatyai", "rain-grid.json"));
  const muni = tryReadJson<FeatureCollection>(path.join(PUB, "hatyai", "municipality.geojson"));
  const muniProps = (muni?.features[0]?.properties ?? {}) as Record<string, unknown>;

  const muniPop = popS.municipality.latest;
  const muniPopV = muniPop.value!;
  const popDate = muniPop.provenance.observedTo ?? "";
  const zonePop = new Map(popS.zones.map((z) => [z.id, z]));
  const sumZonePop = areas.reduce((s, a) => s + (zonePop.get(a.id)?.population.value ?? 0), 0);

  // --- municipality waste (Songkhla LAO survey), latest year with a value per definition
  const laoSrc = "songkhla-gdcatalog-lao-waste";
  const latestOf = (rows: StagedHyWasteRow[]) => rows.filter((r) => r.valueTonPerYear !== null).sort((a, b) => b.fiscalYearBE - a.fiscalYearBE)[0] ?? null;
  const tpd = (r: StagedHyWasteRow) => round(r.valueTonPerYear! / daysInclusive(r.observedFrom, r.observedTo), 2);
  const colRow = latestOf(wasteS.songkhlaLaoDatasets.collected);
  const genRow = latestOf(wasteS.songkhlaLaoDatasets.generated);
  const colTotal = colRow ? tpd(colRow) : null;
  const genTotal = genRow ? tpd(genRow) : null;
  const pmc = wasteS.pmc12247160.householdWasteClaim;

  const muniWasteProv = (r: StagedHyWasteRow, label: string): DataProvenance =>
    srcProv(ctx, laoSrc, {
      status: "observed",
      sourceUrl: label === "collected" ? wasteS.songkhlaLaoDatasets.datasets.dataset_10_33?.url : wasteS.songkhlaLaoDatasets.datasets.dataset_10_27?.url,
      observedFrom: r.observedFrom,
      observedTo: r.observedTo,
      referenceYear: Number(r.observedTo.slice(0, 4)),
      geographicScope: "เทศบาลนครหาดใหญ่ (Hat Yai City Municipality) — LAO total",
      methodology: `${r.definition}. FY BE ${r.fiscalYearBE} (${r.observedFrom} – ${r.observedTo}): ${fmt(r.valueTonPerYear!, 3)} ${r.unitPublished} (t/year) ÷ ${daysInclusive(r.observedFrom, r.observedTo)} days = ${fmt(tpd(r), 2)} t/day (unit conversion only). Source: DLA LAO solid-waste survey via the Songkhla provincial data catalog.`,
      limitations: [
        `Latest year with a published value; FY BE ${r.fiscalYearBE + 1}–${r.fiscalYearBE + 2} cells are empty in the catalog.`,
        label === "generated"
          ? `PMC12247160 cites ${pmc.value} ${pmc.unit} of household waste generation (secondary citation of ${pmc.citedSource}; period and method not stated) — not used as a metric.`
          : "Generated, collected and utilised quantities are reported independently by the LAO and are not mixed.",
      ],
    });

  // --- zone allocation by population share (largest remainder at 0.01 t/day so zones sum exactly)
  const weights = areas.map((a) => zonePop.get(a.id)?.population.value ?? 0);
  const allocCol = colTotal !== null ? largestRemainder(colTotal, weights, 2) : areas.map(() => null);
  const allocGen = genTotal !== null ? largestRemainder(genTotal, weights, 2) : areas.map(() => null);
  const allocMethod = (what: string, total: number | null, r: StagedHyWasteRow | null) =>
    `Municipality ${what} FY BE ${r?.fiscalYearBE ?? "n/a"} (${total === null ? "n/a" : fmt(total, 2)} t/day, Songkhla LAO survey) allocated to the 4 zones in proportion to zone population (sums of community figures printed in the 2022–2023 boundary announcements; total ${fmtInt(sumZonePop)}), with largest-remainder rounding to 0.01 t/day so the zones sum exactly to the municipality total.`;
  const allocLimits = [
    "ESTIMATED by allocation — no zone-level waste data is published; differences between zones only mirror population shares.",
    "Zone polygons are an approximate demonstration partition.",
  ];

  const population = new Map<string, MetricValue>();
  const wasteCollected = new Map<string, MetricValue>();
  const wasteGenerated = new Map<string, MetricValue>();
  const wasteHistory = new Map<string, YearValue[]>();
  const wasteGeneratedHistory = new Map<string, YearValue[]>();
  const notes = new Map<string, { th: string[]; en: string[] }>();
  const hySrc = "hatyaicity-boundary-notices";

  areas.forEach((a, i) => {
    const z = zonePop.get(a.id);
    const zp = z?.population;
    population.set(
      a.id,
      zp
        ? mv(zp.value, "persons", {
            ...srcProv(ctx, zp.provenance.sourceId ?? hySrc, {
              status: zp.provenance.status,
              referenceYear: zp.provenance.referenceYear,
              geographicScope: `${a.nameTh} (${a.nameEn}) — communities listed in the zone announcement`,
              methodology: zp.provenance.methodology,
              limitations: [
                ...(zp.provenance.limitations ?? []),
                `DOPA registered population of the whole municipality is ${fmtInt(muniPopV)} at ${popDate}; zone sums total ${fmtInt(sumZonePop)} (different source and date).`,
              ],
            }),
          })
        : mv(null, "persons", { status: "unavailable", methodology: "No zone population published." }),
    );
    wasteCollected.set(
      a.id,
      mv(
        allocCol[i],
        "t/day",
        srcProv(ctx, "urban-intel-derived", {
          status: "estimated",
          sourceName: `Allocated from Songkhla LAO survey (${laoSrc}) by zone population share`,
          observedFrom: colRow?.observedFrom,
          observedTo: colRow?.observedTo,
          referenceYear: colRow ? Number(colRow.observedTo.slice(0, 4)) : undefined,
          geographicScope: `${a.nameTh} (${a.nameEn})`,
          methodology: allocMethod("collected waste (เก็บขนได้)", colTotal, colRow),
          limitations: allocLimits,
        }),
      ),
    );
    wasteGenerated.set(
      a.id,
      mv(
        allocGen[i],
        "t/day",
        srcProv(ctx, "urban-intel-derived", {
          status: "estimated",
          sourceName: `Allocated from Songkhla LAO survey (${laoSrc}) by zone population share`,
          observedFrom: genRow?.observedFrom,
          observedTo: genRow?.observedTo,
          referenceYear: genRow ? Number(genRow.observedTo.slice(0, 4)) : undefined,
          geographicScope: `${a.nameTh} (${a.nameEn})`,
          methodology: allocMethod("generated waste (ที่เกิดขึ้น)", genTotal, genRow),
          limitations: allocLimits,
        }),
      ),
    );
    // history: each collected year allocated with the same shares
    const hist: YearValue[] = wasteS.songkhlaLaoDatasets.collected
      .slice()
      .sort((x, y) => x.fiscalYearBE - y.fiscalYearBE)
      .map((r) => {
        const year = Number(r.observedTo.slice(0, 4));
        if (r.valueTonPerYear === null) return { year, value: null, unit: "t/day", status: "unavailable" as const };
        const alloc = largestRemainder(tpd(r), weights, 2);
        return { year, value: alloc[i], unit: "t/day", status: "estimated" as const };
      });
    wasteHistory.set(a.id, hist);
    const genHist: YearValue[] = wasteS.songkhlaLaoDatasets.generated
      .slice()
      .sort((x, y) => x.fiscalYearBE - y.fiscalYearBE)
      .map((r) => {
        const year = Number(r.observedTo.slice(0, 4));
        if (r.valueTonPerYear === null) return { year, value: null, unit: "t/day", status: "unavailable" as const };
        return { year, value: largestRemainder(tpd(r), weights, 2)[i], unit: "t/day", status: "estimated" as const };
      });
    wasteGeneratedHistory.set(a.id, genHist);
  });

  /* ---- E (proximity to U-Taphao and to any mapped waterway) and W */
  const P = makeProjector(CITY_META.hatyai.center[0], CITY_META.hatyai.center[1]);
  const ww = ensureWaterwayKinds("hatyai");
  const isUTaphao = (p: Record<string, unknown>) => /ตะเภา/.test(String(p.name ?? "")) || /ta\s?-?phao/i.test(String(p.nameEn ?? ""));
  const wstats = waterwayStats("hatyai", areas, ww, P, 20, isUTaphao);
  const exposure = new Map<string, { value: number | null; prov: DataProvenance }>();
  const ev = floodS?.event;
  for (const a of areas) {
    const s = wstats.get(a.id)!;
    const value = s.sharePrincipal !== null && s.share300 !== null ? round(0.5 * s.sharePrincipal + 0.5 * s.share300, 3) : null;
    exposure.set(a.id, {
      value,
      prov: srcProv(ctx, "urban-intel-derived", {
        status: "estimated",
        sourceName: "Derived: OpenStreetMap waterways (osm-hy-waterways, osm-hy-water-areas)",
        geographicScope: `${a.nameTh} (${a.nameEn}) — approximate zone polygon`,
        methodology: `E = 0.5 × share of zone area within 300 m of Khlong U-Taphao (OSM ways named คลองอู่ตะเภา / คลองอุ่ตะเภา) + 0.5 × share within 300 m of any mapped OSM waterway (lines and water-area polygons); 20 m sample lattice; shares are absolute (0–1), not min–max scaled, because there are only 4 zones. This zone: ${s.sharePrincipal === null ? "n/a" : fmt(s.sharePrincipal * 100, 1)}% and ${s.share300 === null ? "n/a" : fmt(s.share300 * 100, 1)}%.`,
        limitations: [
          "Proxy index; no spatial flood-extent data for the November 2025 flood was available, so historical inundation is NOT included.",
          ...(ev ? [`The ${ev.titleEn} (${ev.from} – ${ev.to}) affected most of the municipality (see flood-events.json); this index does not reflect it spatially.`] : []),
          "Computed on approximate zone polygons; OSM waterway completeness varies; relative within Hat Yai only.",
        ],
      }),
    });
  }
  const wDens = areas.map((a) => {
    const c = wasteCollected.get(a.id)!.value;
    return c !== null ? c / a.areaKm2 : null;
  });
  const lDens = areas.map((a) => wstats.get(a.id)?.lengthDensityKmPerKm2 ?? null);
  const sWD = maxScale(wDens),
    sLD = maxScale(lDens);
  const obstruction = new Map<string, { value: number | null; prov: DataProvenance }>();
  areas.forEach((a, i) => {
    const value = sWD[i] !== null && sLD[i] !== null ? round(0.5 * sWD[i]! + 0.5 * sLD[i]!, 3) : null;
    obstruction.set(a.id, {
      value,
      prov: srcProv(ctx, "urban-intel-derived", {
        status: "estimated",
        sourceName: "Derived: allocated collected waste (Songkhla LAO survey) + OpenStreetMap waterway length",
        observedFrom: colRow?.observedFrom,
        observedTo: colRow?.observedTo,
        referenceYear: colRow ? Number(colRow.observedTo.slice(0, 4)) : undefined,
        geographicScope: `${a.nameTh} (${a.nameEn}) — approximate zone polygon`,
        methodology: `W = 0.5 × (waste density ÷ max over zones) + 0.5 × (OSM waterway line length density ÷ max over zones); ratio-to-max scaling (not min–max) because there are only 4 zones. This zone: ${wDens[i] === null ? "n/a" : fmt(wDens[i]!, 3)} t/day/km² (allocated); ${wstats.get(a.id)?.lengthKm ?? "n/a"} km of mapped waterway lines = ${lDens[i] === null ? "n/a" : fmt(lDens[i]!, 3)} km/km².`,
        limitations: [
          "Zone waste density is itself an allocation by population share, so this term mirrors population density.",
          "Proxy for co-location of waste pressure and open channels; it does not measure blockage. Relative within Hat Yai only.",
        ],
      }),
    });
  });

  for (const a of areas) {
    const ws = wstats.get(a.id)!;
    const z = zonePop.get(a.id);
    notes.set(a.id, {
      en: [
        `APPROXIMATE zone polygon (demonstration partition along the railway, Phetkasem, Sriphuwanat and Kanjanavanit roads) — not the official legal boundary.`,
        `${a.extra.communityCount ?? "n/a"} communities in the official list; zone population ${z?.population.value === null || z?.population.value === undefined ? "n/a" : fmtInt(z.population.value)} = sum of community figures printed in the 2022–2023 announcements.`,
        `Waste values are municipality totals (FY BE ${colRow?.fiscalYearBE ?? "n/a"}) allocated by population share — estimated, not measured per zone.`,
        `Within 300 m of Khlong U-Taphao: ${ws.sharePrincipal === null ? "n/a" : fmt(ws.sharePrincipal * 100, 1)}%; of any mapped waterway: ${ws.share300 === null ? "n/a" : fmt(ws.share300 * 100, 1)}%.`,
      ],
      th: [
        "ขอบเขตเขตชุมชนเป็นการแบ่งโดยประมาณเพื่อการสาธิต (ตามแนวทางรถไฟ ถนนเพชรเกษม ศรีภูวนารถ และกาญจนวณิชย์) — ไม่ใช่แนวเขตทางการ",
        `ชุมชนตามรายชื่อทางการ ${a.extra.communityCount ?? "-"} ชุมชน; ประชากรของเขต ${z?.population.value === null || z?.population.value === undefined ? "ไม่มีข้อมูล" : fmtInt(z.population.value)} คน = ผลรวมตัวเลขในประกาศแนวเขตชุมชน พ.ศ. 2565–2566`,
        `ปริมาณขยะเป็นค่ารวมของเทศบาล (ปีงบประมาณ ${colRow?.fiscalYearBE ?? "-"}) ที่ปันส่วนตามสัดส่วนประชากร — เป็นค่าประมาณ ไม่ใช่ค่าตรวจวัดรายเขต`,
        `พื้นที่ในระยะ 300 ม. จากคลองอู่ตะเภา: ${ws.sharePrincipal === null ? "-" : fmt(ws.sharePrincipal * 100, 1)}%; จากทางน้ำใดๆ ใน OSM: ${ws.share300 === null ? "-" : fmt(ws.share300 * 100, 1)}%`,
      ],
    });
  }

  /* ---- totals */
  const sumAreas = round(areas.reduce((s, a) => s + a.areaKm2, 0), 3);
  const dopa2022 = popS.municipality.timeSeries.find((t) => colRow && t.referenceDate.slice(0, 4) === colRow.observedTo.slice(0, 4));
  const totalsBase = {
    population: mv(muniPopV, "persons", {
      ...srcProv(ctx, muniPop.provenance.sourceId, {
        status: muniPop.provenance.status,
        sourceUrl: muniPop.provenance.sourceUrl,
        observedTo: muniPop.provenance.observedTo,
        referenceYear: muniPop.provenance.referenceYear,
        geographicScope: muniPop.provenance.geographicScope,
        methodology: muniPop.provenance.methodology,
        limitations: [
          ...(muniPop.provenance.limitations ?? []),
          `Zone populations (community announcements 2022–2023) sum to ${fmtInt(sumZonePop)}; the city total uses the DOPA figure instead.`,
        ],
      }),
    }),
    areaKm2: mv(
      sumAreas,
      "km2",
      srcProv(ctx, "osm-hatyai-municipality", {
        status: "derived",
        geographicScope: "Hat Yai City Municipality (sum of the 4 approximate zones tiling the OSM municipality polygon)",
        methodology: "Sum of the 4 zone polygon areas (turf.area, geodesic); the zones tile the OSM municipality polygon (relation 19981578).",
        limitations: [
          `OSM municipality polygon ${typeof muniProps.areaKm2 === "number" ? fmt(muniProps.areaKm2 as number, 3) : "n/a"} km² (tagged fixme "approximate please verify"); official area 21 km² (hatyaicity.go.th).`,
        ],
      }),
    ),
    wasteCollected: colRow ? mv(colTotal, "t/day", muniWasteProv(colRow, "collected")) : mv(null, "t/day", { status: "unavailable", methodology: "No collected-waste value published." }),
    wasteGenerated: genRow ? mv(genTotal, "t/day", muniWasteProv(genRow, "generated")) : mv(null, "t/day", { status: "unavailable", methodology: "No generated-waste value published." }),
    perCapitaLimitations: [
      `Cross-period: waste FY BE ${colRow?.fiscalYearBE ?? "n/a"} (${colRow?.observedFrom} – ${colRow?.observedTo}) ÷ DOPA registered population at ${popDate}.`,
      ...(dopa2022 && colTotal !== null
        ? [`With the DOPA population closest to the waste period (${fmtInt(dopa2022.total)} at ${dopa2022.referenceDate}) the value would be ${fmt((colTotal * 1000) / dopa2022.total, 3)} kg/person/day.`]
        : []),
      "Registered population understates the people served (students, migrant workers, tourists).",
    ],
    perCapitaSourceName: `Derived: Songkhla LAO survey collected waste FY${colRow ? colRow.observedTo.slice(0, 4) : ""} ÷ DOPA registered population ${muniPop.provenance.referenceYear}`,
  };

  /* ---- composition: Hat Yai-specific shares (PSU/TSRI report) when staged; otherwise unavailable (never substituted) */
  const cc = compS?.composition;
  const composition: WasteComposition = cc
    ? {
        shares: {
          organic: cc.shares.organic,
          plastic: cc.shares.plastic,
          paper: cc.shares.paper,
          glassMetal: cc.shares.glassMetal,
          hazardous: cc.shares.hazardous,
          other: cc.shares.other,
        },
        provenance: srcProv(ctx, cc.provenance.sourceId, {
          ...cc.provenance,
          limitations: [
            ...(cc.provenance.limitations ?? []),
            "PMC12247160 (cited for Hat Yai waste quantities) contains no composition table; Bangkok or national shares are NOT substituted.",
          ],
        }),
      }
    : {
        shares: { organic: null, plastic: null, paper: null, glassMetal: null, hazardous: null, other: null } as unknown as WasteComposition["shares"],
        provenance: {
          status: "unavailable",
          geographicScope: "Hat Yai City Municipality",
          methodology: wasteS.composition.note,
          limitations: [
            "No sourced Hat Yai composition table was retrieved; PMC12247160 contains no composition table. Bangkok or national shares are NOT substituted.",
          ],
        },
      };

  const cityWasteHistory: YearValue[] = wasteS.songkhlaLaoDatasets.collected
    .slice()
    .sort((a, b) => a.fiscalYearBE - b.fiscalYearBE)
    .map((r) => ({ year: Number(r.observedTo.slice(0, 4)), value: r.valueTonPerYear === null ? null : tpd(r), unit: "t/day", status: r.valueTonPerYear === null ? ("unavailable" as const) : ("observed" as const) }));
  const cityWasteGeneratedHistory: YearValue[] = wasteS.songkhlaLaoDatasets.generated
    .slice()
    .sort((a, b) => a.fiscalYearBE - b.fiscalYearBE)
    .map((r) => ({ year: Number(r.observedTo.slice(0, 4)), value: r.valueTonPerYear === null ? null : tpd(r), unit: "t/day", status: r.valueTonPerYear === null ? ("unavailable" as const) : ("observed" as const) }));

  const ns = ctx.normals?.stations.find((s) => s.cityId === "hatyai");
  const normalStation = ns ? { id: ns.wmoIndex, nameEn: ns.nameEn, annual: ns.annualRainfall.value, period: ns.period } : undefined;
  const rFrom = rainGrid?.dates[0] ?? "";
  const rTo = rainGrid?.dates[rainGrid.dates.length - 1] ?? "";
  const periodLabelTh = `ประชากร ${thDate(popDate)} · ขยะ ปีงบ ${colRow?.fiscalYearBE ?? "-"} · ฝน ERA5 ${rFrom ? Number(rFrom.slice(0, 4)) + 543 : "-"}–${rTo ? Number(rTo.slice(0, 4)) + 543 : "-"}`;
  const periodLabelEn = `Population ${enDate(popDate)} · Waste FY${colRow ? colRow.observedTo.slice(0, 4) : "-"} (${colRow ? `${enMonthYear(colRow.observedFrom)}–${enMonthYear(colRow.observedTo)}` : "-"}) · Rain ERA5 ${rFrom.slice(0, 4)}–${rTo.slice(0, 4)}`;

  const floodEvents: FloodEvent[] = [];
  if (ev && ev.from && ev.to) floodEvents.push(ev);
  const skipped = (floodS?.earlierFloods ?? []).filter((f) => !f.from || !f.to).map((f) => f.year);

  const limitations = [
    "The 4 community zones (เขต 1–4) are an APPROXIMATE demonstration partition built from OSM roads/railway following the municipality's community map — not official legal boundaries. The municipality polygon itself is an OSM trace tagged 'approximate please verify'.",
    `Zone populations are sums of per-community figures printed in the 2022–2023 boundary announcements (partial: 27/28 communities in เขต 1, 24/25 in เขต 3); the city total is DOPA registration (${fmtInt(muniPopV)} at ${popDate}).`,
    `Waste: the latest published Hat Yai values are FY BE ${colRow?.fiscalYearBE ?? "n/a"} (collected ${colTotal ?? "n/a"} t/day, generated ${genTotal ?? "n/a"} t/day; Songkhla LAO survey); later years are empty. Zone values are allocations by population share (estimated).`,
    `PMC12247160 cites ${pmc.value} t/day of household waste (secondary citation, period and method not stated); it is recorded in the sources but not used as a metric.`,
    cc
      ? `Composition is Hat Yai-specific (PSU/TSRI research report ENV6405051S, as of ${compS!.primary.asOf}): organic ${fmt(cc.shares.organic, 1)}%, plastic ${fmt(cc.shares.plastic, 1)}%, paper ${fmt(cc.shares.paper, 1)}%, glass & metal ${fmt(cc.shares.glassMetal, 1)}%, other ${fmt(cc.shares.other, 1)}% (status derived — 8 published categories mapped to 6). Sampling design and weight/volume basis are not stated; the plastic share is far above Bangkok's, so treat it as indicative. Hazardous 0.0 = no hazardous category in the source. Municipality-wide only; zones carry no own composition.`
      : "No sourced waste composition exists for Hat Yai; composition is shown as unavailable.",
    `Rainfall is ERA5 reanalysis: the whole municipality falls within essentially one 0.25° cell (the lattice holds 2 distinct cells), so zones are not distinguished by rainfall; ERA5 annual totals exceed the TMD normal${normalStation ? ` (${fmt(normalStation.annual, 1)} mm/year at ${normalStation.id}, ${normalStation.period})` : ""}.`,
    "Flood exposure (E) uses proximity to Khlong U-Taphao and mapped OSM waterways only — no spatial extent of the November 2025 flood was available.",
    "Drainage stress and modelled flood risk are illustrative outputs of the demo model (baseline scenario) — not an official forecast. No verifiable Hat Yai street-drainage design intensity (mm/h) was found; the model's default assumption is used.",
    ...(skipped.length ? [`Earlier floods (${skipped.join(", ")}) are cited only as manual references without dates and are not listed as events.`] : []),
  ];

  const waterwayDensity = Object.fromEntries(areas.map((a) => [a.id, wstats.get(a.id)]));
  return assembleCity(
    ctx,
    {
      city: "hatyai",
      areas,
      anchors,
      population,
      wasteCollected,
      wasteGenerated,
      wasteDerivedStatus: "estimated",
      perCapitaLimitations: [
        "Identical across zones by construction: zone waste is allocated by the same population figures it is divided by.",
        `Cross-period: waste FY BE ${colRow?.fiscalYearBE ?? "n/a"} ÷ community figures printed in 2022–2023 announcements.`,
      ],
      perCapitaContext: "Zone waste is an allocation by population share.",
      densitySourceName: "Derived: allocated municipality collected waste ÷ zone population",
    },
    {
      rainGrid,
      exposure,
      obstruction,
      composition,
      wasteHistory,
      cityWasteHistory,
      wasteGeneratedHistory,
      cityWasteGeneratedHistory,
      totalsBase,
      notes,
      periodLabelTh,
      periodLabelEn,
      limitations,
      floodEvents,
      generatedAt,
      normalStation,
      report: {
        zoneWasteAllocation: { collectedTotal: colTotal, generatedTotal: genTotal, weights, collected: allocCol, generated: allocGen },
        exposureInputs: areas.map((a) => ({ id: a.id, ...wstats.get(a.id), E: exposure.get(a.id)!.value })),
        obstructionInputs: areas.map((a, i) => ({ id: a.id, wasteDensity: wDens[i] === null ? null : round(wDens[i]!, 4), lengthDensity: lDens[i], W: obstruction.get(a.id)!.value })),
      },
      waterwayDensity,
    },
  );
}

/* ============================================================== manifest */

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function deterministicGeneratedAt(sources: SourceRef[]): string {
  const env = process.env.SOURCE_DATE_EPOCH;
  if (env && /^\d+$/.test(env)) return new Date(Number(env) * 1000).toISOString();
  let max = 0;
  for (const s of sources) {
    const t = s.retrievedAt ? Date.parse(s.retrievedAt) : NaN;
    if (Number.isFinite(t) && t > max) max = t;
  }
  const bdir = path.join(PUB, "buildings");
  if (fs.existsSync(bdir)) {
    for (const f of fs.readdirSync(bdir).filter((x) => x.endsWith(".json")).sort()) {
      // retrievedAt is near the start of each window file; read a small prefix only
      const fd = fs.openSync(path.join(bdir, f), "r");
      const buf = Buffer.alloc(400);
      fs.readSync(fd, buf, 0, 400, 0);
      fs.closeSync(fd);
      const m = /"retrievedAt"\s*:\s*"([^"]+)"/.exec(buf.toString("utf8"));
      const t = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(t) && t > max) max = t;
    }
  }
  return new Date(max || 0).toISOString();
}

/* ============================================================== main */

function main() {
  console.log("build-datasets: assembling public/data from data/staged");
  const sourcesList = buildSources();
  const ctx: Ctx = {
    sources: new Map(sourcesList.map((s) => [s.id, s])),
    normals: tryReadJson<StagedRainNormals>(path.join(STAGED, "rain-normals.json")),
    capacity: tryReadJson<StagedDrainageCapacity>(path.join(STAGED, "drainage-capacity.json")),
  };
  const generatedAt = deterministicGeneratedAt(sourcesList);

  const results: Record<CityId, CityBuildResult> = { bangkok: bangkok(ctx, generatedAt), hatyai: hatyai(ctx, generatedAt) };
  const written: string[] = [];
  const put = (p: string, content: string) => {
    if (writeIfChanged(p, content)) written.push(rel(p));
  };
  for (const city of ["bangkok", "hatyai"] as CityId[]) {
    const r = results[city];
    put(path.join(PUB, city, "areas.json"), minified(r.dataset));
    put(path.join(PUB, city, "areas.geojson"), minified(r.areasGeo));
    if (r.rainAreas) put(path.join(PUB, city, "rain-areas.json"), minified(r.rainAreas));
    put(path.join(PUB, city, "flood-events.json"), pretty(r.floodEvents));
  }
  put(path.join(PUB, "sources.json"), pretty(sourcesList));

  put(
    path.join(STAGED, "osm-waterway-density.json"),
    pretty({
      note: "Per-area OSM waterway inputs to the exposure (E) and obstruction (W) indices, computed by scripts/data/build-datasets.ts. share300 = share of the area's sample lattice points within 300 m of any mapped waterway (lines + water-area polygons); sharePrincipal = within 300 m of the principal channel (Hat Yai: Khlong U-Taphao; Bangkok: not used); lengthKm = mapped waterway LINE length inside the area (≤20 m pieces assigned by midpoint); lengthDensityKmPerKm2 = lengthKm ÷ polygon area.",
      sampleSpacingM: { bangkok: 100, hatyai: 20 },
      sourceIds: ["osm-bkk-waterways", "osm-bkk-chaophraya-water", "osm-hy-waterways", "osm-hy-water-areas"],
      bangkok: results.bangkok.waterwayDensity,
      hatyai: results.hatyai.waterwayDensity,
    }),
  );
  put(
    path.join(STAGED, "build-datasets-report.json"),
    pretty({ generatedAt, modelVersion: MODEL_VERSION, warnings: WARNINGS, bangkok: results.bangkok.report, hatyai: results.hatyai.report }),
  );

  // manifest last, over every public data file
  const files = listFiles(PUB)
    .filter((p) => path.basename(p) !== "manifest.json" && !path.basename(p).startsWith("."))
    .sort();
  const manifest = {
    generatedAt,
    note: "Every public data file with its byte size and sha256 at build time (scripts/data/build-datasets.ts). Building windows may be refreshed by scripts/data/fetch-buildings.ts after a build; re-run the build to refresh this manifest.",
    files: files.map((p) => {
      const buf = fs.readFileSync(p);
      return { path: path.relative(PUB, p).split(path.sep).join("/"), bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
    }),
  };
  put(path.join(PUB, "manifest.json"), pretty(manifest));

  for (const city of ["bangkok", "hatyai"] as CityId[]) {
    const d = results[city].dataset;
    const counts = (results[city].report.anchorSourceCounts ?? {}) as Record<string, number>;
    console.log(
      `  ${city}: ${d.areas.length} areas; population ${d.totals.population.value}; collected ${d.totals.wasteCollected.value} t/day; per-capita ${d.totals.wastePerCapita.value}; anchors ${JSON.stringify(counts)}`,
    );
  }
  console.log(`  generatedAt ${generatedAt}; ${sourcesList.length} sources; ${files.length} files in manifest`);
  console.log(written.length ? `  wrote: ${written.join(", ")}` : "  outputs unchanged");
  if (WARNINGS.length) console.log(`  ${WARNINGS.length} warning(s) — see data/staged/build-datasets-report.json`);
}

main();
