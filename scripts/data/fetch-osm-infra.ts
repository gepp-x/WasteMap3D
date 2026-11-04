/**
 * fetch-osm-infra.ts — OpenStreetMap waterways + drainage infrastructure
 * for Bangkok and Hat Yai (Urban Intelligence — Waste & Flood Observatory).
 *
 * Data: © OpenStreetMap contributors, ODbL-1.0 (https://www.openstreetmap.org/copyright)
 *
 * Usage (from the repo root):
 *   npx tsx scripts/data/fetch-osm-infra.ts             # query Overpass; fall back to cached raw files on failure
 *   npx tsx scripts/data/fetch-osm-infra.ts --offline   # rebuild every output from cached raw files only
 *   npx tsx scripts/data/fetch-osm-infra.ts --only=hy-waterways,hy-drainage
 *                                                      # live-fetch only these query keys; others use cache
 *
 * Network etiquette: queries run strictly sequentially with >= 2.5 s between
 * requests, exponential backoff on 429/5xx/timeouts, rotating between three
 * public Overpass endpoints, and a descriptive User-Agent.
 *
 * Raw responses (untrusted data) are cached verbatim in data/raw/osm/infra/<key>.json
 * with a sidecar <key>.meta.json (endpoint, HTTP status, retrievedAt, query,
 * sha256, OSM base timestamp, attempt log). Outputs are a pure function of the
 * cached raw files, so `--offline` reproduces them byte-for-byte.
 *
 * Outputs:
 *   public/data/bangkok/waterways.geojson, public/data/hatyai/waterways.geojson
 *   public/data/bangkok/drainage.geojson,  public/data/hatyai/drainage.geojson
 *   data/staged/osm-sources.json (SourceRef[]), data/staged/osm-notes.md
 *
 * Geometry processing: a small in-script OSM JSON (`out geom`) -> GeoJSON
 * converter (line merge by shared nodes, multipolygon ring assembly, centroids)
 * plus `npx mapshaper` for bbox clipping, simplification and 5-decimal rounding.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as turf from "@turf/turf";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..");
const RAW_DIR = path.join(ROOT, "data", "raw", "osm", "infra");
const STAGED_DIR = path.join(ROOT, "data", "staged");
const PUBLIC_DIR = path.join(ROOT, "public", "data");

const USER_AGENT = "UrbanIntelligenceDemo/0.1 (research prototype)";
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const MAX_ATTEMPTS = 14;
const REQUEST_TIMEOUT_MS = 360_000;
const PAUSE_BETWEEN_QUERIES_MS = 2_500;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 120_000;
/** A response whose OSM database snapshot is older than this is kept only as a fallback while other endpoints are tried. */
const MAX_SNAPSHOT_AGE_DAYS = 14;

const LICENSE = "ODbL-1.0";
const LICENSE_URL = "https://opendatacommons.org/licenses/odbl/1-0/";
const ATTRIBUTION = "© OpenStreetMap contributors";
const COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

type Bbox = [number, number, number, number]; // [west, south, east, north]
type Pos = [number, number]; // [lon, lat]
type CityId = "bangkok" | "hatyai";

interface CityCfg {
  id: CityId;
  nameEn: string;
  nameTh: string;
  bbox: Bbox;
  /** mapshaper Douglas-Peucker tolerance (metres) for waterway centrelines. */
  lineIntervalM: number;
  /** mapshaper tolerance (metres) for water-area polygons. */
  areaIntervalM: number;
  /** Minimum clipped length (km) of a named khlong group for widthClass 2. */
  majorCanalKm: number;
  /** Principal river of the city (widthClass 3 regardless of the OSM waterway value). */
  principalRiverRe: RegExp;
}

const CITIES: Record<CityId, CityCfg> = {
  bangkok: {
    id: "bangkok",
    nameEn: "Bangkok",
    nameTh: "กรุงเทพมหานคร",
    bbox: [100.32, 13.49, 100.94, 13.96],
    lineIntervalM: 8,
    areaIntervalM: 10,
    majorCanalKm: 8,
    principalRiverRe: /^แม่น้ำเจ้าพระยา/,
  },
  hatyai: {
    id: "hatyai",
    nameEn: "Hat Yai (municipality area + buffer)",
    nameTh: "เทศบาลนครหาดใหญ่ (พื้นที่ + แนวกันชน)",
    bbox: [100.4, 6.94, 100.54, 7.09],
    lineIntervalM: 4,
    areaIntervalM: 5,
    majorCanalKm: 3,
    principalRiverRe: /^คลองอ[ูุ]่ตะเภา/,
  },
};

/** Overpass bbox order is (south, west, north, east). */
const ovBbox = (b: Bbox): string => `${b[1]},${b[0]},${b[3]},${b[2]}`;

// ---------------------------------------------------------------------------
// Overpass queries
// ---------------------------------------------------------------------------

const qWaterways = (b: Bbox, timeout: number): string => `[out:json][timeout:${timeout}][bbox:${ovBbox(b)}];
(
  way["waterway"~"^(river|canal|stream|drain|ditch)$"]["name"];
  way["waterway"~"^(river|canal|stream|drain|ditch)$"]["name:th"];
  way["waterway"~"^(river|canal|stream|drain|ditch)$"]["name:en"];
  way["waterway"~"^(river|canal)$"];
)->.w;
.w out body geom;
rel(bw.w)["waterway"];
out body;`;

const qChaoPhrayaWater = (b: Bbox, timeout: number): string => `[out:json][timeout:${timeout}][bbox:${ovBbox(b)}];
way["waterway"="river"]["name"~"^แม่น้ำเจ้าพระยา"]->.c;
(
  way(around.c:400)["natural"="water"]["water"~"^(river|riverbank)$"];
  rel(around.c:400)["natural"="water"]["water"~"^(river|riverbank)$"];
  way(around.c:400)["waterway"="riverbank"];
  rel(around.c:400)["waterway"="riverbank"];
  way["natural"="water"]["name"~"เจ้าพระยา"];
  rel["natural"="water"]["name"~"เจ้าพระยา"];
)->.a;
.a out body geom;
.c out body geom;`;

const qHatYaiWater = (b: Bbox, timeout: number): string => `[out:json][timeout:${timeout}][bbox:${ovBbox(b)}];
(
  way["natural"="water"]["water"~"^(river|riverbank|canal|stream)$"];
  rel["natural"="water"]["water"~"^(river|riverbank|canal|stream)$"];
  way["waterway"="riverbank"];
  rel["waterway"="riverbank"];
);
out body geom;`;

const DRAINAGE_NAME_TH = "แก้มลิง|สถานีสูบน้ำ|บ่อสูบน้ำ|ประตูระบายน้ำ|บ่อหน่วงน้ำ|อุโมงค์ระบายน้ำ|วัดระดับน้ำ";
const DRAINAGE_NAME_EN =
  "pump(ing)? station|sluice|flood ?gate|retention pond|detention pond|monkey cheek|kaem ?ling|keam ?ling|water level station|drainage tunnel";

const qDrainage = (b: Bbox, timeout: number): string => `[out:json][timeout:${timeout}][bbox:${ovBbox(b)}];
(
  nwr["man_made"="pumping_station"];
  nwr["pumping_station"];
  nwr["waterway"~"^(sluice_gate|lock_gate|weir|dam|floodgate|flood_gate)$"];
  nwr["man_made"="monitoring_station"]["monitoring:water_level"="yes"];
  nwr["basin"~"retention|detention"];
  nwr["name"~"${DRAINAGE_NAME_TH}"];
  nwr["name:th"~"${DRAINAGE_NAME_TH}"];
  nwr["name:en"~"${DRAINAGE_NAME_EN}",i];
);
out body geom;
nwr["flood_prone"="yes"];
out count;`;

interface QueryDef {
  key: string;
  city: CityId;
  layer: "waterways" | "water-areas" | "drainage";
  nameEn: string;
  nameTh: string;
  query: string;
}

const QUERIES: QueryDef[] = [
  {
    key: "bkk-waterways",
    city: "bangkok",
    layer: "waterways",
    nameEn: "OpenStreetMap waterway centrelines — Bangkok bbox (Overpass API)",
    nameTh: "เส้นทางน้ำ OpenStreetMap — กรุงเทพมหานคร",
    query: qWaterways(CITIES.bangkok.bbox, 240),
  },
  {
    key: "bkk-chaophraya-water",
    city: "bangkok",
    layer: "water-areas",
    nameEn: "OpenStreetMap Chao Phraya River water-area polygons — Bangkok bbox (Overpass API)",
    nameTh: "พื้นที่ผิวน้ำแม่น้ำเจ้าพระยา OpenStreetMap — กรุงเทพมหานคร",
    query: qChaoPhrayaWater(CITIES.bangkok.bbox, 240),
  },
  {
    key: "bkk-drainage",
    city: "bangkok",
    layer: "drainage",
    nameEn: "OpenStreetMap drainage infrastructure (pumps, gates, gauges, retention) — Bangkok bbox (Overpass API)",
    nameTh: "โครงสร้างระบายน้ำ OpenStreetMap — กรุงเทพมหานคร",
    query: qDrainage(CITIES.bangkok.bbox, 180),
  },
  {
    key: "hy-waterways",
    city: "hatyai",
    layer: "waterways",
    nameEn: "OpenStreetMap waterway centrelines — Hat Yai buffered bbox (Overpass API)",
    nameTh: "เส้นทางน้ำ OpenStreetMap — หาดใหญ่",
    query: qWaterways(CITIES.hatyai.bbox, 90),
  },
  {
    key: "hy-water-areas",
    city: "hatyai",
    layer: "water-areas",
    nameEn: "OpenStreetMap river/canal water-area polygons — Hat Yai buffered bbox (Overpass API)",
    nameTh: "พื้นที่ผิวน้ำลำน้ำ/คลอง OpenStreetMap — หาดใหญ่",
    query: qHatYaiWater(CITIES.hatyai.bbox, 90),
  },
  {
    key: "hy-drainage",
    city: "hatyai",
    layer: "drainage",
    nameEn: "OpenStreetMap drainage infrastructure (pumps, gates, gauges, retention) — Hat Yai buffered bbox (Overpass API)",
    nameTh: "โครงสร้างระบายน้ำ OpenStreetMap — หาดใหญ่",
    query: qDrainage(CITIES.hatyai.bbox, 90),
  },
];

// ---------------------------------------------------------------------------
// OSM JSON types
// ---------------------------------------------------------------------------

type Tags = Record<string, string>;
interface LatLon {
  lat: number;
  lon: number;
}
interface OsmMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
  lat?: number;
  lon?: number;
  geometry?: (LatLon | null)[];
}
interface OsmElement {
  type: "node" | "way" | "relation" | "count";
  id: number;
  tags?: Tags;
  lat?: number;
  lon?: number;
  nodes?: number[];
  geometry?: (LatLon | null)[];
  members?: OsmMember[];
}
interface OsmResponse {
  version?: number;
  generator?: string;
  osm3s?: { timestamp_osm_base?: string; copyright?: string };
  elements: OsmElement[];
  remark?: string;
}

interface Attempt {
  endpoint: string;
  startedAt: string;
  durationMs: number;
  httpStatus: number | null;
  error: string | null;
}
interface RawMeta {
  key: string;
  endpoint: string;
  httpStatus: number;
  retrievedAt: string;
  osmBaseTimestamp: string | null;
  bytes: number;
  sha256: string;
  elementCount: number;
  userAgent: string;
  query: string;
  attempts: Attempt[];
}
interface LoadResult {
  def: QueryDef;
  data: OsmResponse | null;
  meta: RawMeta | null;
  /** "live" = fetched this run; "cache" = re-used cached raw file; "missing" = nothing usable. */
  origin: "live" | "cache" | "missing";
  liveAttempts: Attempt[];
  liveError: string | null;
}

// ---------------------------------------------------------------------------
// Fetch with polite retry + cache
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function validateOverpass(text: string): { ok: true; data: OsmResponse } | { ok: false; reason: string } {
  let data: OsmResponse;
  try {
    data = JSON.parse(text) as OsmResponse;
  } catch {
    return { ok: false, reason: "response is not JSON" };
  }
  if (!data || !Array.isArray(data.elements)) return { ok: false, reason: "no elements[] in response" };
  if (data.remark && /error|timed out|out of memory/i.test(data.remark)) {
    return { ok: false, reason: `Overpass remark: ${data.remark}` };
  }
  return { ok: true, data };
}

async function fetchOverpass(def: QueryDef): Promise<{ text: string; meta: RawMeta } | { error: string; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  let backoff = BACKOFF_START_MS;
  let staleBest: { text: string; meta: RawMeta } | null = null;
  const staleEndpoints = new Set<string>(); // mirrors that already answered with a lagging snapshot are not asked again
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const pool = ENDPOINTS.filter((e) => !staleEndpoints.has(e));
    if (!pool.length) break;
    const endpoint = pool[i % pool.length];
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json",
        },
        body: new URLSearchParams({ data: def.query }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      const text = await res.text();
      if (res.status === 200) {
        const v = validateOverpass(text);
        const base = v.ok ? v.data.osm3s?.timestamp_osm_base ?? null : null;
        const ageDays = base ? (Date.now() - Date.parse(base)) / 86_400_000 : Infinity;
        if (v.ok && ageDays > MAX_SNAPSHOT_AGE_DAYS) {
          // valid but served from a lagging mirror: keep as fallback, try the other endpoints for a fresher snapshot
          error = `stale snapshot (timestamp_osm_base ${base}, ${ageDays.toFixed(0)} days old) — kept as fallback`;
          staleEndpoints.add(endpoint);
          if (!staleBest || (staleBest.meta.osmBaseTimestamp ?? "") < (base ?? "")) {
            staleBest = {
              text,
              meta: {
                key: def.key,
                endpoint,
                httpStatus: status,
                retrievedAt: new Date().toISOString(),
                osmBaseTimestamp: base,
                bytes: Buffer.byteLength(text, "utf8"),
                sha256: sha256(text),
                elementCount: v.data.elements.length,
                userAgent: USER_AGENT,
                query: def.query,
                attempts: [],
              },
            };
          }
        } else if (v.ok) {
          attempts.push({ endpoint, startedAt, durationMs: Date.now() - t0, httpStatus: status, error: null });
          const meta: RawMeta = {
            key: def.key,
            endpoint,
            httpStatus: status,
            retrievedAt: new Date().toISOString(),
            osmBaseTimestamp: v.data.osm3s?.timestamp_osm_base ?? null,
            bytes: Buffer.byteLength(text, "utf8"),
            sha256: sha256(text),
            elementCount: v.data.elements.length,
            userAgent: USER_AGENT,
            query: def.query,
            attempts,
          };
          return { text, meta };
        } else {
          error = v.reason;
        }
      } else {
        error = `HTTP ${res.status}`;
      }
    } catch (e) {
      const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : "";
      error = e instanceof Error ? `${e.name}: ${e.message}${cause}` : String(e);
    }
    attempts.push({ endpoint, startedAt, durationMs: Date.now() - t0, httpStatus: status, error });
    console.warn(`  [${def.key}] attempt ${i + 1}/${MAX_ATTEMPTS} ${endpoint} -> ${error}`);
    if (i < MAX_ATTEMPTS - 1) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }
  if (staleBest) {
    console.warn(`  [${def.key}] no fresh snapshot after ${attempts.length} attempts; using stale snapshot ${staleBest.meta.osmBaseTimestamp}`);
    staleBest.meta.attempts = attempts;
    return staleBest;
  }
  return { error: `all ${attempts.length} attempts failed`, attempts };
}

function rawPaths(key: string) {
  return { data: path.join(RAW_DIR, `${key}.json`), meta: path.join(RAW_DIR, `${key}.meta.json`) };
}

function readCache(def: QueryDef): { data: OsmResponse; meta: RawMeta } | null {
  const p = rawPaths(def.key);
  if (!fs.existsSync(p.data) || !fs.existsSync(p.meta)) return null;
  const text = fs.readFileSync(p.data, "utf8");
  const v = validateOverpass(text);
  if (!v.ok) return null;
  const meta = JSON.parse(fs.readFileSync(p.meta, "utf8")) as RawMeta;
  if (meta.sha256 !== sha256(text)) console.warn(`  [${def.key}] WARNING cached file sha256 differs from meta`);
  if (meta.query !== def.query) console.warn(`  [${def.key}] WARNING cached raw file was produced by a different query text`);
  return { data: v.data, meta };
}

async function loadAll(offline: boolean, only: Set<string> | null): Promise<LoadResult[]> {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const out: LoadResult[] = [];
  let first = true;
  for (const def of QUERIES) {
    const cached = readCache(def);
    const wantLive = !offline && (only === null || only.has(def.key));
    if (!wantLive) {
      console.log(`- ${def.key}: using cached raw file${cached ? ` (retrieved ${cached.meta.retrievedAt})` : " — MISSING"}`);
      out.push({ def, data: cached?.data ?? null, meta: cached?.meta ?? null, origin: cached ? "cache" : "missing", liveAttempts: [], liveError: null });
      continue;
    }
    if (!first) await sleep(PAUSE_BETWEEN_QUERIES_MS);
    first = false;
    console.log(`- ${def.key}: querying Overpass …`);
    const r = await fetchOverpass(def);
    const emptyVsCache = "text" in r && r.meta.elementCount === 0 && !!cached && cached.meta.elementCount > 0 && cached.meta.query === def.query;
    const olderThanCache = "text" in r && !!cached && (cached.meta.osmBaseTimestamp ?? "") > (r.meta.osmBaseTimestamp ?? "");
    if ("text" in r && cached && (emptyVsCache || olderThanCache)) {
      const why = emptyVsCache
        ? `live response had 0 elements while the cached response to the same query had ${cached.meta.elementCount}`
        : `live response snapshot ${r.meta.osmBaseTimestamp} is older than cached snapshot ${cached.meta.osmBaseTimestamp}`;
      console.warn(`  ${why}; keeping cached raw file`);
      out.push({ def, data: cached.data, meta: cached.meta, origin: "cache", liveAttempts: r.meta.attempts, liveError: why });
    } else if ("text" in r) {
      const p = rawPaths(def.key);
      fs.writeFileSync(p.data, r.text, "utf8");
      fs.writeFileSync(p.meta, JSON.stringify(r.meta, null, 2) + "\n", "utf8");
      console.log(`  ok: ${r.meta.elementCount} elements, ${(r.meta.bytes / 1e6).toFixed(2)} MB from ${r.meta.endpoint}`);
      out.push({ def, data: JSON.parse(r.text) as OsmResponse, meta: r.meta, origin: "live", liveAttempts: r.meta.attempts, liveError: null });
    } else {
      console.warn(`  live fetch failed (${r.error}); ${cached ? "falling back to cached raw file" : "no cache available"}`);
      out.push({ def, data: cached?.data ?? null, meta: cached?.meta ?? null, origin: cached ? "cache" : "missing", liveAttempts: r.attempts, liveError: r.error });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small geometry helpers (OSM JSON `out geom` -> GeoJSON)
// ---------------------------------------------------------------------------

const toPos = (g: LatLon): Pos => [g.lon, g.lat];
const samePos = (a: Pos, b: Pos) => a[0] === b[0] && a[1] === b[1];
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const osmRef = (e: { type: string; id: number }) => `${e.type}/${e.id}`;

function geomCoords(g: (LatLon | null)[] | undefined): Pos[] | null {
  if (!g || g.length === 0) return null;
  const out: Pos[] = [];
  for (const p of g) {
    if (!p) return null; // incomplete geometry
    out.push(toPos(p));
  }
  return out;
}

/** Stitch way segments into closed rings by matching endpoints. */
function assembleRings(segments: Pos[][]): { rings: Pos[][]; open: number } {
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings: Pos[][] = [];
  let open = 0;
  while (pool.length) {
    let ring = pool.shift() as Pos[];
    while (!samePos(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const idx = pool.findIndex((s) => samePos(s[0], end) || samePos(s[s.length - 1], end));
      if (idx < 0) break;
      let s = pool.splice(idx, 1)[0];
      if (!samePos(s[0], end)) s = s.slice().reverse();
      ring = ring.concat(s.slice(1));
    }
    if (samePos(ring[0], ring[ring.length - 1]) && ring.length >= 4) rings.push(ring);
    else open++;
  }
  return { rings, open };
}

/** Build MultiPolygon coordinates from a multipolygon relation (members carry geometry). */
function relationToMultiPolygon(rel: OsmElement): { coords: Pos[][][]; open: number } | null {
  const outers: Pos[][] = [];
  const inners: Pos[][] = [];
  for (const m of rel.members ?? []) {
    if (m.type !== "way") continue;
    const c = geomCoords(m.geometry);
    if (!c) continue;
    if (m.role === "inner") inners.push(c);
    else outers.push(c); // "outer" or empty role
  }
  const o = assembleRings(outers);
  const i = assembleRings(inners);
  if (!o.rings.length) return null;
  const polys: Pos[][][] = o.rings.map((r) => [r]);
  for (const hole of i.rings) {
    const pt = turf.point(hole[0]);
    const host = polys.find((p) => turf.booleanPointInPolygon(pt, turf.polygon([p[0]])));
    if (host) host.push(hole);
  }
  return { coords: polys, open: o.open + i.open };
}

function isClosed(e: OsmElement): boolean {
  const n = e.nodes ?? [];
  return n.length >= 4 && n[0] === n[n.length - 1];
}

/** Representative point: node position, polygon centre of mass (or point-on-surface
 *  if the centre of mass falls outside a concave shape), or mid-length point of a line. */
function representativePoint(e: OsmElement): { pos: Pos; method: string } | null {
  if (e.type === "node" && e.lat !== undefined && e.lon !== undefined) return { pos: [e.lon, e.lat], method: "node" };
  if (e.type === "way") {
    const c = geomCoords(e.geometry);
    if (!c || c.length === 0) return null;
    if (c.length === 1) return { pos: c[0], method: "way-single-node" };
    if (isClosed(e)) return polygonPoint(turf.polygon([c]));
    const line = turf.lineString(c);
    const mid = turf.along(line, turf.length(line) / 2);
    return { pos: mid.geometry.coordinates as Pos, method: "line-midpoint" };
  }
  if (e.type === "relation") {
    const mp = e.tags?.type === "multipolygon" ? relationToMultiPolygon(e) : null;
    if (mp) return polygonPoint(turf.multiPolygon(mp.coords));
    const pts: Pos[] = [];
    for (const m of e.members ?? []) {
      if (m.lat !== undefined && m.lon !== undefined) pts.push([m.lon, m.lat]);
      const c = geomCoords(m.geometry);
      if (c) pts.push(...c);
    }
    if (!pts.length) return null;
    const ctr = turf.centroid(turf.multiPoint(pts));
    return { pos: ctr.geometry.coordinates as Pos, method: "relation-member-vertex-mean" };
  }
  return null;
}

function polygonPoint(f: ReturnType<typeof turf.polygon> | ReturnType<typeof turf.multiPolygon>): { pos: Pos; method: string } {
  const com = turf.centerOfMass(f);
  if (turf.booleanPointInPolygon(com, f.geometry)) return { pos: com.geometry.coordinates as Pos, method: "polygon-centre-of-mass" };
  const pof = turf.pointOnFeature(f);
  return { pos: pof.geometry.coordinates as Pos, method: "polygon-point-on-surface" };
}

// ---------------------------------------------------------------------------
// mapshaper (clip + simplify + round)
// ---------------------------------------------------------------------------

interface GjFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}
interface GjFC {
  type: "FeatureCollection";
  features: GjFeature[];
}

function runMapshaper(input: GjFC, bbox: Bbox, intervalM: number, tag: string, extra: string[] = []): GjFC {
  if (!input.features.length) return { type: "FeatureCollection", features: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `osm-infra-${tag}-`));
  const inPath = path.join(dir, "in.geojson");
  const outPath = path.join(dir, "out.geojson");
  fs.writeFileSync(inPath, JSON.stringify(input), "utf8");
  const args = [
    "mapshaper",
    "-i",
    inPath,
    "-clip",
    `bbox=${bbox.join(",")}`,
    ...extra,
    "-simplify",
    "dp",
    `interval=${intervalM}`,
    "keep-shapes",
    "-o",
    outPath,
    "format=geojson",
    "precision=0.00001",
    "rfc7946",
    "force",
  ];
  try {
    execFileSync("npx", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    if (!fs.existsSync(outPath)) return { type: "FeatureCollection", features: [] };
    return JSON.parse(fs.readFileSync(outPath, "utf8")) as GjFC;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Round to 5 dp and drop consecutive duplicate vertices (idempotent after mapshaper). */
function roundCoords(c: unknown): unknown {
  if (Array.isArray(c) && typeof c[0] === "number") return [r5(c[0] as number), r5(c[1] as number)];
  if (Array.isArray(c)) {
    const mapped = c.map(roundCoords);
    if (Array.isArray(mapped[0]) && typeof (mapped[0] as unknown[])[0] === "number") {
      const dedup: unknown[] = [];
      for (const p of mapped as Pos[]) {
        const prev = dedup[dedup.length - 1] as Pos | undefined;
        if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) dedup.push(p);
      }
      return dedup;
    }
    return mapped;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Waterways
// ---------------------------------------------------------------------------

type WaterKind = "river" | "canal" | "stream" | "drain" | "water-area";
const KIND_ORDER: Record<string, number> = { "water-area": 0, river: 1, canal: 2, stream: 3, drain: 4 };
const KHLONG_RE = /^(คลอง|ลำ|Kh?long\b|Klong\b)/i;
const RIVER_NAME_RE = /^แม่น้ำ/;
const RIVER_NAME_EN_RE = /\bRiver\b/i;

function waterwayKind(t: Tags): WaterKind | null {
  switch (t.waterway) {
    case "river":
      return "river";
    case "canal":
      return "canal";
    case "stream":
      return "stream";
    case "drain":
    case "ditch":
      return "drain";
    default:
      return null;
  }
}

const thName = (t: Tags | undefined): string | null => (t ? t["name:th"] ?? t.name ?? null : null);
const enName = (t: Tags | undefined): string | null => (t ? t["name:en"] ?? null : null);

interface Piece {
  ids: number[];
  nodes: number[];
  coords: Pos[];
}

/**
 * Greedy line merge (linear time): chain pieces through end nodes where exactly
 * two piece-ends meet (degree-2 joints). Junctions with 3+ ends and closed loops
 * are left as breaks. Pieces are visited in input order, so output is deterministic.
 */
function lineMerge(pieces: Piece[]): Piece[] {
  const first = (p: Piece) => p.nodes[0];
  const last = (p: Piece) => p.nodes[p.nodes.length - 1];
  const endsAt = new Map<number, number[]>();
  pieces.forEach((p, i) => {
    if (first(p) === last(p)) return; // closed loop: never chained
    for (const n of [first(p), last(p)]) {
      const l = endsAt.get(n);
      if (l) l.push(i);
      else endsAt.set(n, [i]);
    }
  });
  const used = new Array<boolean>(pieces.length).fill(false);
  /** the other piece meeting `cur` at node n, if n is a degree-2 joint and that piece is unused */
  const partner = (n: number, cur: number): number | null => {
    const l = endsAt.get(n);
    if (!l || l.length !== 2) return null;
    const j = l[0] === cur ? l[1] : l[0];
    return j === cur || used[j] ? null : j;
  };
  const out: Piece[] = [];
  pieces.forEach((p0, i) => {
    if (used[i]) return;
    used[i] = true;
    let nodes = p0.nodes.slice();
    let coords = p0.coords.slice();
    const ids = [...p0.ids];
    if (first(p0) !== last(p0)) {
      // extend forward from the tail
      let tailPiece = i;
      for (;;) {
        const n = nodes[nodes.length - 1];
        const j = partner(n, tailPiece);
        if (j === null) break;
        used[j] = true;
        const q = pieces[j];
        const fwd = first(q) === n;
        const qn = fwd ? q.nodes : q.nodes.slice().reverse();
        const qc = fwd ? q.coords : q.coords.slice().reverse();
        nodes = nodes.concat(qn.slice(1));
        coords = coords.concat(qc.slice(1));
        ids.push(...q.ids);
        tailPiece = j;
        if (nodes[0] === nodes[nodes.length - 1]) break; // became a loop
      }
      // extend backward from the head
      let headPiece = i;
      while (nodes[0] !== nodes[nodes.length - 1]) {
        const n = nodes[0];
        const j = partner(n, headPiece);
        if (j === null) break;
        used[j] = true;
        const q = pieces[j];
        const fwd = last(q) === n;
        const qn = fwd ? q.nodes : q.nodes.slice().reverse();
        const qc = fwd ? q.coords : q.coords.slice().reverse();
        nodes = qn.slice(0, -1).concat(nodes);
        coords = qc.slice(0, -1).concat(coords);
        ids.push(...q.ids);
        headPiece = j;
      }
    }
    out.push({ ids: ids.sort((a, b) => a - b), nodes, coords });
  });
  return out;
}

/** Union-find grouping of pieces that share any node. */
function components(pieces: Piece[]): Piece[][] {
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<number, number>();
  pieces.forEach((p, i) => {
    for (const n of p.nodes) {
      const o = owner.get(n);
      if (o === undefined) owner.set(n, i);
      else parent[find(i)] = find(o);
    }
  });
  const groups = new Map<number, Piece[]>();
  pieces.forEach((p, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(p);
    else groups.set(r, [p]);
  });
  return [...groups.values()];
}

interface WaterwayStats {
  waysIn: number;
  waysUsed: number;
  waysNamedViaRelation: number;
  waysNamedViaSibling: number;
  waysUnnamedKept: number;
  waysDroppedUnnamedSmall: number;
  areasIn: number;
  areasUsed: number;
  areasDropped: string[];
  openRings: number;
  featuresOut: Record<string, number>;
  namedGroups: number;
  bytes: number;
  majorCanals: string[];
  requiredNames: { pattern: string; found: string[] }[];
}

interface FeatureMeta {
  name: string | null;
  nameEn: string | null;
  kind: WaterKind;
  osmId: string;
  osmIds: string[];
  nameSource: "way" | "sibling" | "relation" | "none" | "centreline";
  maxWidthM: number | null;
  /** water-area only: 3 for river water (water=river|riverbank, waterway=riverbank), 2 for canal/stream water. */
  areaWidthClass?: 2 | 3;
}

function parseWidth(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(m)?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}

function buildWaterways(
  city: CityCfg,
  wwRes: OsmResponse | null,
  areaRes: OsmResponse | null,
  areaMode: "chaophraya" | "all",
): { fc: GjFC; stats: WaterwayStats } {
  const stats: WaterwayStats = {
    waysIn: 0,
    waysUsed: 0,
    waysNamedViaRelation: 0,
    waysNamedViaSibling: 0,
    waysUnnamedKept: 0,
    waysDroppedUnnamedSmall: 0,
    areasIn: 0,
    areasUsed: 0,
    areasDropped: [],
    openRings: 0,
    featuresOut: {},
    namedGroups: 0,
    bytes: 0,
    majorCanals: [],
    requiredNames: [],
  };
  const metas: FeatureMeta[] = [];
  const lineFeatures: GjFeature[] = [];
  const areaFeatures: GjFeature[] = [];

  // ---- centrelines
  if (wwRes) {
    const ways = wwRes.elements.filter((e) => e.type === "way");
    const rels = wwRes.elements.filter((e) => e.type === "relation").sort((a, b) => a.id - b.id);
    stats.waysIn = ways.length;
    const relOfWay = new Map<number, OsmElement>();
    for (const r of rels) {
      if (!thName(r.tags) && !enName(r.tags)) continue;
      for (const m of r.members ?? []) if (m.type === "way" && !relOfWay.has(m.ref)) relOfWay.set(m.ref, r);
    }
    interface Tagged {
      el: OsmElement;
      kind: WaterKind;
      name: string | null;
      nameEn: string | null;
      nameSource: "way" | "sibling" | "relation" | "none";
    }
    // `name` -> set of `name:th` seen on ways that carry both (to resolve ways tagged only with a romanised `name`)
    const thByName = new Map<string, Set<string>>();
    for (const w of ways) {
      const t = w.tags ?? {};
      if (t.name && t["name:th"] && t.name !== t["name:th"]) {
        const set = thByName.get(t.name) ?? new Set<string>();
        set.add(t["name:th"]);
        thByName.set(t.name, set);
      }
    }
    const tagged: Tagged[] = [];
    for (const w of ways) {
      const t = w.tags ?? {};
      const kind = waterwayKind(t);
      if (!kind) continue;
      let name = thName(t);
      let nameEn = enName(t);
      let nameSource: Tagged["nameSource"] = name || nameEn ? "way" : "none";
      if (!t["name:th"] && t.name && thByName.get(t.name)?.size === 1) {
        name = [...(thByName.get(t.name) as Set<string>)][0];
        nameSource = "sibling";
        stats.waysNamedViaSibling++;
      }
      if (nameSource === "none") {
        const r = relOfWay.get(w.id);
        if (r) {
          name = thName(r.tags);
          nameEn = enName(r.tags);
          nameSource = "relation";
          stats.waysNamedViaRelation++;
        }
      }
      if (nameSource === "none" && (kind === "stream" || kind === "drain")) {
        stats.waysDroppedUnnamedSmall++;
        continue;
      }
      if (nameSource === "none") stats.waysUnnamedKept++;
      tagged.push({ el: w, kind, name, nameEn, nameSource });
    }
    // group by kind + name (unnamed: per merged piece)
    const groups = new Map<string, Tagged[]>();
    for (const t of tagged) {
      const k = `${t.kind}\u0001${t.name ?? ""}\u0001${t.name ? "" : t.nameEn ?? ""}`;
      const g = groups.get(k);
      if (g) g.push(t);
      else groups.set(k, [t]);
    }
    const groupKeys = [...groups.keys()].sort();
    for (const gk of groupKeys) {
      const members = (groups.get(gk) as Tagged[]).sort((a, b) => a.el.id - b.el.id);
      const first = members[0];
      const named = first.nameSource !== "none";
      if (named) stats.namedGroups++;
      const pieces: Piece[] = [];
      const byId = new Map<number, Tagged>();
      for (const m of members) {
        const c = geomCoords(m.el.geometry);
        if (!c || c.length < 2 || !m.el.nodes) continue;
        pieces.push({ ids: [m.el.id], nodes: m.el.nodes, coords: c });
        byId.set(m.el.id, m);
        stats.waysUsed++;
      }
      const merged = lineMerge(pieces);
      const comps = named ? components(merged) : merged.map((p) => [p]);
      for (const comp of comps) {
        const ids = comp.flatMap((p) => p.ids).sort((a, b) => a - b);
        // most common non-null name:en among members (ties -> lexicographic)
        const enCount = new Map<string, number>();
        for (const id of ids) {
          const en = byId.get(id)?.nameEn;
          if (en) enCount.set(en, (enCount.get(en) ?? 0) + 1);
        }
        const nameEn = [...enCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
        const widths = ids.map((id) => parseWidth(byId.get(id)?.el.tags?.width)).filter((x): x is number => x !== null);
        const nameSources = new Set(ids.map((id) => byId.get(id)?.nameSource));
        const meta: FeatureMeta = {
          name: first.name,
          nameEn,
          kind: first.kind,
          osmId: `way/${ids[0]}`,
          osmIds: ids.map((id) => `way/${id}`),
          nameSource: nameSources.has("way") ? "way" : nameSources.has("sibling") ? "sibling" : nameSources.has("relation") ? "relation" : "none",
          maxWidthM: widths.length ? Math.max(...widths) : null,
        };
        const geometry =
          comp.length === 1
            ? { type: "LineString", coordinates: comp[0].coords }
            : { type: "MultiLineString", coordinates: comp.map((p) => p.coords) };
        lineFeatures.push({ type: "Feature", properties: { _i: metas.length }, geometry });
        metas.push(meta);
      }
    }
  }

  // ---- water-area polygons
  if (areaRes) {
    const isCentreline = (e: OsmElement) => e.type === "way" && e.tags?.waterway === "river" && /^แม่น้ำเจ้าพระยา/.test(thName(e.tags) ?? "");
    // centreline used to test which unnamed water polygons belong to the Chao Phraya (same snapshot as the polygons when present)
    let centre: Pos[][] = areaRes.elements.filter(isCentreline).map((e) => geomCoords(e.geometry)).filter((c): c is Pos[] => !!c && c.length >= 2);
    if (areaMode === "chaophraya" && !centre.length && wwRes) {
      centre = wwRes.elements.filter(isCentreline).map((e) => geomCoords(e.geometry)).filter((c): c is Pos[] => !!c && c.length >= 2);
    }
    const centreFeature = centre.length ? turf.multiLineString(centre) : null;
    const els = areaRes.elements
      .filter((e) => (e.type === "way" || e.type === "relation") && !isCentreline(e))
      .sort((a, b) => (a.type === b.type ? a.id - b.id : a.type.localeCompare(b.type)));
    stats.areasIn = els.length;
    interface AreaPart {
      el: OsmElement;
      coords: Pos[][][];
      name: string | null;
      nameEn: string | null;
      isRiver: boolean;
    }
    const parts: AreaPart[] = [];
    for (const e of els) {
      const t = e.tags ?? {};
      const name = thName(t);
      const nameEn = enName(t);
      if (areaMode === "chaophraya") {
        const isCp = (name && /เจ้าพระยา/.test(name)) || (nameEn && /chao\s*phraya/i.test(nameEn));
        if ((name || nameEn) && !isCp) {
          stats.areasDropped.push(`${osmRef(e)} (named "${name ?? nameEn}", not Chao Phraya)`);
          continue;
        }
      }
      let coords: Pos[][][] | null = null;
      if (e.type === "way") {
        const c = geomCoords(e.geometry);
        if (c && isClosed(e)) coords = [[c]];
      } else if (t.type === "multipolygon") {
        const mp = relationToMultiPolygon(e);
        if (mp) {
          coords = mp.coords;
          stats.openRings += mp.open;
        }
      }
      if (!coords) {
        stats.areasDropped.push(`${osmRef(e)} (not a closed way / assemblable multipolygon)`);
        continue;
      }
      if (areaMode === "chaophraya" && !(name || nameEn)) {
        // unnamed water polygon: keep only if the named Chao Phraya centreline actually runs through it
        if (!centreFeature || !turf.booleanIntersects(turf.multiPolygon(coords), centreFeature)) {
          stats.areasDropped.push(`${osmRef(e)} (unnamed, does not intersect the แม่น้ำเจ้าพระยา centreline)`);
          continue;
        }
      }
      parts.push({ el: e, coords, name, nameEn, isRiver: t.water === "river" || t.water === "riverbank" || t.waterway === "riverbank" });
    }
    // group: Chao Phraya -> single dissolved feature; Hat Yai -> by name (unnamed parts stay separate)
    const groups = new Map<string, AreaPart[]>();
    for (const p of parts) {
      const k = areaMode === "chaophraya" ? "chaophraya" : p.name ?? p.nameEn ?? osmRef(p.el);
      const g = groups.get(k);
      if (g) g.push(p);
      else groups.set(k, [p]);
    }
    for (const k of [...groups.keys()].sort()) {
      const g = groups.get(k) as AreaPart[];
      stats.areasUsed += g.length;
      const ids = g.map((p) => osmRef(p.el)).sort();
      const name = areaMode === "chaophraya" ? "แม่น้ำเจ้าพระยา" : g.find((p) => p.name)?.name ?? null;
      // Chao Phraya parts that are unnamed in OSM take name/name:en from the named centreline they were selected by (nameSource=centreline)
      const centrelineEn = metas.find((m) => m.kind === "river" && m.name === "แม่น้ำเจ้าพระยา")?.nameEn ?? null;
      const nameEn = g.find((p) => p.nameEn)?.nameEn ?? (areaMode === "chaophraya" ? centrelineEn : null);
      const idx = metas.length;
      metas.push({
        name,
        nameEn,
        kind: "water-area",
        osmId: ids[0],
        osmIds: ids,
        nameSource:
          areaMode === "chaophraya"
            ? g.every((p) => p.name || p.nameEn)
              ? "way"
              : "centreline"
            : g.some((p) => p.name || p.nameEn)
              ? "way"
              : "none",
        maxWidthM: null,
        areaWidthClass: g.some((p) => p.isRiver) ? 3 : 2,
      });
      for (const p of g) areaFeatures.push({ type: "Feature", properties: { _i: idx }, geometry: { type: "MultiPolygon", coordinates: p.coords } });
    }
  }

  // ---- clip + simplify + round (mapshaper), then re-attach attributes
  const linesOut = runMapshaper({ type: "FeatureCollection", features: lineFeatures }, city.bbox, city.lineIntervalM, `${city.id}-lines`);
  const areasOut = runMapshaper({ type: "FeatureCollection", features: areaFeatures }, city.bbox, city.areaIntervalM, `${city.id}-areas`, [
    "-dissolve2",
    "_i",
  ]);

  // clipped length per named khlong (for widthClass 2)
  const lenByName = new Map<string, number>();
  for (const f of linesOut.features) {
    if (!f.geometry) continue;
    const m = metas[f.properties._i as number];
    if (!m.name || m.kind === "drain") continue;
    const km = turf.length(f as unknown as Parameters<typeof turf.length>[0]);
    lenByName.set(m.name, (lenByName.get(m.name) ?? 0) + km);
  }
  const isRiverClass = (m: FeatureMeta): boolean =>
    !!m.name &&
    m.kind !== "drain" &&
    (city.principalRiverRe.test(m.name) || (m.kind === "river" && (RIVER_NAME_RE.test(m.name) || RIVER_NAME_EN_RE.test(m.nameEn ?? ""))));
  const majorCanal = (m: FeatureMeta): boolean =>
    !!m.name &&
    m.kind !== "drain" &&
    KHLONG_RE.test(m.name) &&
    ((lenByName.get(m.name) ?? 0) >= city.majorCanalKm || (m.maxWidthM ?? 0) >= 10);

  const features: GjFeature[] = [];
  for (const f of [...areasOut.features, ...linesOut.features]) {
    if (!f.geometry) continue;
    const m = metas[f.properties._i as number];
    const widthClass = m.kind === "water-area" ? (m.areaWidthClass ?? 3) : isRiverClass(m) ? 3 : majorCanal(m) ? 2 : 1;
    if (widthClass === 2 && m.name && !stats.majorCanals.includes(m.name)) stats.majorCanals.push(m.name);
    features.push({
      type: "Feature",
      properties: {
        name: m.name,
        nameEn: m.nameEn,
        kind: m.kind,
        osmId: m.osmId,
        widthClass,
        osmIds: m.osmIds,
        nameSource: m.nameSource,
      },
      geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
    });
  }
  features.sort((a, b) => {
    const pa = a.properties;
    const pb = b.properties;
    return (
      KIND_ORDER[pa.kind as string] - KIND_ORDER[pb.kind as string] ||
      String(pa.name ?? "\uffff").localeCompare(String(pb.name ?? "\uffff"), "th") ||
      String(pa.osmId).localeCompare(String(pb.osmId))
    );
  });
  stats.majorCanals.sort((a, b) => a.localeCompare(b, "th"));
  for (const f of features) {
    const k = String(f.properties.kind);
    stats.featuresOut[k] = (stats.featuresOut[k] ?? 0) + 1;
  }
  return { fc: { type: "FeatureCollection", features }, stats };
}

// ---------------------------------------------------------------------------
// Drainage infrastructure
// ---------------------------------------------------------------------------

type DrainKind = "pump-station" | "gate" | "monitoring" | "retention" | "other";
const DRAIN_ORDER: Record<DrainKind, number> = { "pump-station": 0, gate: 1, monitoring: 2, retention: 3, other: 4 };

const NAME_TH = {
  pump: /สถานีสูบน้ำ|บ่อสูบน้ำ/,
  gate: /ประตูระบายน้ำ/,
  monitoring: /วัดระดับน้ำ/,
  retention: /แก้มลิง|บ่อหน่วงน้ำ/,
  tunnel: /อุโมงค์ระบายน้ำ/,
};
const NAME_EN = {
  pump: /pump(ing)? station/i,
  gate: /sluice|flood ?gate/i,
  monitoring: /water level station/i,
  retention: /retention pond|detention pond|monkey cheek|kaem ?ling|keam ?ling/i,
  tunnel: /drainage tunnel/i,
};
/** Name-only matches carrying any of these keys are unrelated POIs (bus stops, shops, piers …). */
const NAME_ONLY_EXCLUDE_KEYS = ["highway", "public_transport", "railway", "shop", "tourism", "amenity", "office", "place", "boundary", "route", "healthcare", "craft", "leisure", "historic"];
const WATER_SUPPLY_RE = /ประปา|สูบจ่ายน้ำ|น้ำดิบ|แรงดันน้ำ|waterworks|water supply|raw water/i;

const TAG_KEEP = [
  "man_made",
  "pumping_station",
  "waterway",
  "basin",
  "landuse",
  "natural",
  "water",
  "reservoir_type",
  "monitoring:water_level",
  "operator",
  "operator:en",
  "operator:type",
  "ref",
  "substance",
  "building",
  "description",
  "start_date",
  "flood_prone",
  "lock",
  "name:th",
  "name:en",
];

interface DrainStats {
  elementsIn: number;
  floodProneCount: string | null;
  kept: Record<string, number>;
  excluded: string[];
  duplicatesMerged: string[];
  noGeometry: string[];
  methods: Record<string, number>;
  /** basin=retention points inside the Suvarnabhumi Airport box (100.72–100.77 E, 13.64–13.72 N). */
  airportRetention: number;
  bytes: number;
}

function classifyDrain(t: Tags): { kind: DrainKind; matchedBy: string } | { exclude: string } | null {
  const nm = `${t.name ?? ""} ${t["name:th"] ?? ""}`;
  const en = t["name:en"] ?? "";
  if (t.man_made === "monitoring_station" && t["monitoring:water_level"] === "yes")
    return { kind: "monitoring", matchedBy: "man_made=monitoring_station + monitoring:water_level=yes" };
  const ps = t.pumping_station ?? "";
  if (/^(gas|oil|fuel)$/.test(ps)) return { exclude: `non-water pumping station (pumping_station=${ps})` };
  // water-supply facilities (MWA/PWA raw-water intakes, boosters, waterworks) are not drainage, whatever else they are tagged as
  if (/^(water|drinking_water)$/.test(ps) || WATER_SUPPLY_RE.test(`${nm} ${en} ${t.operator ?? ""} ${t["operator:en"] ?? ""}`))
    return { exclude: `water-supply facility, not drainage (pumping_station=${ps || "-"}, operator=${t.operator ?? "-"})` };
  if (t.man_made === "pumping_station" || t.pumping_station)
    return { kind: "pump-station", matchedBy: t.man_made === "pumping_station" ? "man_made=pumping_station" : `pumping_station=${ps}` };
  if (t.waterway && /^(sluice_gate|lock_gate|weir|dam|floodgate|flood_gate)$/.test(t.waterway))
    return { kind: "gate", matchedBy: `waterway=${t.waterway}` };
  if (t.basin && /retention|detention/.test(t.basin)) return { kind: "retention", matchedBy: `basin=${t.basin}` };
  // name-only matches
  const nameHit =
    NAME_TH.pump.test(nm) || NAME_EN.pump.test(en)
      ? ("pump-station" as DrainKind)
      : NAME_TH.gate.test(nm) || NAME_EN.gate.test(en)
        ? ("gate" as DrainKind)
        : NAME_TH.monitoring.test(nm) || NAME_EN.monitoring.test(en)
          ? ("monitoring" as DrainKind)
          : NAME_TH.retention.test(nm) || NAME_EN.retention.test(en)
            ? ("retention" as DrainKind)
            : NAME_TH.tunnel.test(nm) || NAME_EN.tunnel.test(en)
              ? ("other" as DrainKind)
              : null;
  if (!nameHit) return null;
  const bad = NAME_ONLY_EXCLUDE_KEYS.find((k) => t[k] !== undefined);
  if (bad) return { exclude: `name match but tagged ${bad}=${t[bad]} (not infrastructure)` };
  return { kind: nameHit, matchedBy: "name" };
}

function buildDrainage(res: OsmResponse | null, bbox: Bbox): { fc: GjFC; stats: DrainStats } {
  const stats: DrainStats = { elementsIn: 0, floodProneCount: null, kept: {}, excluded: [], duplicatesMerged: [], noGeometry: [], methods: {}, airportRetention: 0, bytes: 0 };
  if (!res) return { fc: { type: "FeatureCollection", features: [] }, stats };
  const countEl = res.elements.find((e) => e.type === "count");
  if (countEl?.tags) stats.floodProneCount = `nodes=${countEl.tags.nodes}, ways=${countEl.tags.ways}, relations=${countEl.tags.relations}, total=${countEl.tags.total}`;
  const els = res.elements.filter((e) => e.type !== "count");
  stats.elementsIn = els.length;
  const typeRank = { relation: 0, way: 1, node: 2, count: 3 } as const;
  interface Cand {
    el: OsmElement;
    kind: DrainKind;
    matchedBy: string;
    pos: Pos;
    method: string;
  }
  const cands: Cand[] = [];
  const sorted = [...els].sort((a, b) => typeRank[a.type] - typeRank[b.type] || a.id - b.id);
  for (const e of sorted) {
    const t = e.tags ?? {};
    const c = classifyDrain(t);
    if (!c) {
      stats.excluded.push(`${osmRef(e)} (no rule matched; name="${t.name ?? ""}")`);
      continue;
    }
    if ("exclude" in c) {
      stats.excluded.push(`${osmRef(e)} "${t.name ?? t["name:en"] ?? ""}" — ${c.exclude}`);
      continue;
    }
    const rp = representativePoint(e);
    if (!rp) {
      stats.noGeometry.push(osmRef(e));
      continue;
    }
    const pos: Pos = [r5(rp.pos[0]), r5(rp.pos[1])];
    if (pos[0] < bbox[0] || pos[0] > bbox[2] || pos[1] < bbox[1] || pos[1] > bbox[3]) {
      stats.excluded.push(`${osmRef(e)} "${t.name ?? t["name:en"] ?? ""}" — representative point outside bbox`);
      continue;
    }
    cands.push({ el: e, kind: c.kind, matchedBy: c.matchedBy, pos, method: rp.method });
  }
  // de-duplicate: same kind + same non-empty name within 150 m -> keep tag-matched over name-only, then relation/way over node, then lowest id
  const prio = (c: Cand) => [c.matchedBy === "name" ? 1 : 0, typeRank[c.el.type], c.el.id];
  const ordered = [...cands].sort((a, b) => {
    const pa = prio(a);
    const pb = prio(b);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  });
  const kept: (Cand & { dups: string[] })[] = [];
  for (const c of ordered) {
    const nm = thName(c.el.tags) ?? enName(c.el.tags);
    const dupOf = nm
      ? kept.find(
          (k) =>
            k.kind === c.kind &&
            (thName(k.el.tags) ?? enName(k.el.tags)) === nm &&
            turf.distance(turf.point(k.pos), turf.point(c.pos), { units: "meters" }) < 150,
        )
      : undefined;
    if (dupOf) {
      dupOf.dups.push(osmRef(c.el));
      stats.duplicatesMerged.push(`${osmRef(c.el)} -> ${osmRef(dupOf.el)} ("${nm}")`);
      continue;
    }
    kept.push({ ...c, dups: [] });
  }
  const features: GjFeature[] = kept.map((c) => {
    const t = c.el.tags ?? {};
    const sub: Tags = {};
    for (const k of TAG_KEEP) if (t[k] !== undefined) sub[k] = t[k];
    stats.kept[c.kind] = (stats.kept[c.kind] ?? 0) + 1;
    stats.methods[c.method] = (stats.methods[c.method] ?? 0) + 1;
    if (c.matchedBy.startsWith("basin=") && c.pos[0] >= 100.72 && c.pos[0] <= 100.77 && c.pos[1] >= 13.64 && c.pos[1] <= 13.72) stats.airportRetention++;
    return {
      type: "Feature",
      properties: {
        name: thName(t),
        nameEn: enName(t),
        kind: c.kind,
        osmId: osmRef(c.el),
        status: "observed",
        matchedBy: c.matchedBy,
        pointMethod: c.method,
        duplicates: c.dups.sort(),
        tags: sub,
      },
      geometry: { type: "Point", coordinates: c.pos },
    };
  });
  features.sort((a, b) => {
    const pa = a.properties;
    const pb = b.properties;
    return DRAIN_ORDER[pa.kind as DrainKind] - DRAIN_ORDER[pb.kind as DrainKind] || String(pa.osmId).localeCompare(String(pb.osmId));
  });
  return { fc: { type: "FeatureCollection", features }, stats };
}

// ---------------------------------------------------------------------------
// Output writers
// ---------------------------------------------------------------------------

function writeGeoJSON(file: string, fc: GjFC, metadata: Record<string, unknown>): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = { type: "FeatureCollection", name: `${String(metadata.cityId)}-${path.basename(file, ".geojson")}`, metadata, features: fc.features };
  const text = JSON.stringify(doc) + "\n";
  fs.writeFileSync(file, text, "utf8");
  return Buffer.byteLength(text, "utf8");
}

function relPath(p: string) {
  return path.relative(ROOT, p);
}

const COMMON_LIMITATIONS = [
  "OpenStreetMap is volunteer-mapped: completeness and positional accuracy vary; absence of a feature in OSM does not mean absence on the ground.",
  "Names are as tagged in OSM (Thai `name:th` preferred, else `name`); some `name` values are romanised (e.g. 'Klong …') or contain typos.",
  "Coordinates are clipped to the city bbox, simplified with mapshaper (Douglas-Peucker) and rounded to 5 decimals (~1.1 m).",
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean)) : null;
  console.log(`fetch-osm-infra: mode=${offline ? "offline (cache only)" : only ? `live for ${[...only].join(",")}` : "live"}`);

  const loaded = await loadAll(offline, only);
  const L = (key: string) => loaded.find((l) => l.def.key === key) as LoadResult;

  const report: Record<string, unknown> = {};
  const outputs: { file: string; bytes: number; features: number }[] = [];

  for (const city of [CITIES.bangkok, CITIES.hatyai]) {
    const pre = city.id === "bangkok" ? "bkk" : "hy";
    const ww = L(`${pre}-waterways`);
    const ar = L(city.id === "bangkok" ? "bkk-chaophraya-water" : "hy-water-areas");
    const dr = L(`${pre}-drainage`);

    // ---- waterways
    if (ww.data) {
      const { fc, stats } = buildWaterways(city, ww.data, ar.data, city.id === "bangkok" ? "chaophraya" : "all");
      const required =
        city.id === "hatyai"
          ? ["อู่ตะเภา|อุ่ตะเภา|U-?Ta ?Phao", "ร\\.?\\s?1|Ror Nueng", "ร\\.?\\s?6|Ror Hok", "คลองเตย|Klong Toei", "คลองวาด|Klong Wat"]
          : ["เจ้าพระยา", "แสนแสบ", "พระโขนง", "บางกอกน้อย", "บางกอกใหญ่", "ลาดพร้าว", "เปรมประชากร", "ภาษีเจริญ"];
      stats.requiredNames = required.map((p) => {
        const re = new RegExp(p, "i");
        const found = [
          ...new Set(
            fc.features
              .filter((f) => re.test(String(f.properties.name ?? "")) || re.test(String(f.properties.nameEn ?? "")))
              .map((f) => `${f.properties.name ?? f.properties.nameEn} [${f.properties.kind}]`),
          ),
        ].sort();
        return { pattern: p, found };
      });
      const file = path.join(PUBLIC_DIR, city.id, "waterways.geojson");
      const srcIds = [`osm-${ww.def.key}`, ...(ar.data ? [`osm-${ar.def.key}`] : [])];
      stats.bytes = writeGeoJSON(file, fc, {
        cityId: city.id,
        layer: "waterways",
        status: "observed",
        statusNote: "Mapped OSM features (observed = present in OSM), not an authoritative drainage-network inventory.",
        sourceIds: srcIds,
        attribution: ATTRIBUTION,
        license: LICENSE,
        licenseUrl: LICENSE_URL,
        copyrightUrl: COPYRIGHT_URL,
        retrievedAt: ww.meta?.retrievedAt ?? null,
        osmBaseTimestamp: ww.meta?.osmBaseTimestamp ?? null,
        waterAreaRetrievedAt: ar.meta?.retrievedAt ?? null,
        bbox: city.bbox,
        properties: {
          name: "Thai name as tagged (name:th, else name); null if unnamed",
          nameEn: "name:en if tagged, else null",
          kind: "river | canal | stream | drain (waterway=drain|ditch) | water-area (natural=water polygons)",
          osmId: "representative OSM element (lowest id of merged members)",
          widthClass: `display class (not a measured width). 3 = the city's principal river (name matching ${city.principalRiverRe.source}), any waterway=river named แม่น้ำ… / '… River', or a river water-area (water=river|riverbank); 2 = a named khlong (name starting คลอง/ลำ/Khlong/Klong; waterway=river|canal|stream) whose same-name ways total >= ${city.majorCanalKm} km inside this bbox or carry a width tag >= 10 m, or a canal water-area; 1 = everything else (incl. unnamed ways)`,
          osmIds: "all OSM elements merged into this feature",
          nameSource:
            "way = name tagged on the OSM element (name:th preferred); sibling = way tagged only with a romanised `name` whose other ways with the identical `name` all carry the same `name:th` (that name:th is used); relation = name inherited from a waterway relation the way belongs to; centreline = Chao Phraya water-area whose parts are (partly) unnamed in OSM and were selected because the waterway=river centreline named แม่น้ำเจ้าพระยา runs through them; none = unnamed",
        },
        processing: `Overpass 'out geom' -> GeoJSON (in-script converter); ways merged by (kind, name) at shared end nodes, connected pieces grouped per feature; unnamed streams/drains/ditches dropped; unnamed rivers/canals kept with name=null; clipped to bbox, mapshaper -simplify dp interval=${city.lineIntervalM} m (lines) / ${city.areaIntervalM} m (areas), precision 1e-5.`,
        limitations: COMMON_LIMITATIONS,
      });
      outputs.push({ file: relPath(file), bytes: stats.bytes, features: fc.features.length });
      report[`${city.id}-waterways`] = stats;
    } else {
      console.warn(`! ${city.id} waterways: no raw data (live failed and no cache) — output NOT written`);
      report[`${city.id}-waterways`] = { error: "no raw data" };
    }

    // ---- drainage
    if (dr.data) {
      const { fc, stats } = buildDrainage(dr.data, city.bbox);
      const file = path.join(PUBLIC_DIR, city.id, "drainage.geojson");
      stats.bytes = writeGeoJSON(file, fc, {
        cityId: city.id,
        layer: "drainage",
        status: "observed",
        statusNote:
          "Each point is an OSM-mapped feature (observed = present in OSM). OSM coverage of drainage infrastructure is very incomplete; counts are NOT an inventory and must not be used as totals.",
        sourceIds: [`osm-${dr.def.key}`],
        attribution: ATTRIBUTION,
        license: LICENSE,
        licenseUrl: LICENSE_URL,
        copyrightUrl: COPYRIGHT_URL,
        retrievedAt: dr.meta?.retrievedAt ?? null,
        osmBaseTimestamp: dr.meta?.osmBaseTimestamp ?? null,
        bbox: city.bbox,
        properties: {
          name: "Thai name as tagged (name:th, else name); null if unnamed",
          nameEn: "name:en if tagged, else null",
          kind: "pump-station | gate (waterway=sluice_gate|lock_gate|weir|dam|floodgate) | monitoring (water-level station) | retention (basin=retention|detention or แก้มลิง/บ่อหน่วงน้ำ by name) | other (e.g. drainage tunnel by name)",
          osmId: "OSM element (node/way/relation)",
          status: "observed (mapped OSM feature)",
          matchedBy: "tag rule that selected the feature, or 'name' for Thai/English name-pattern matches",
          pointMethod: "node | polygon-centre-of-mass | polygon-point-on-surface | line-midpoint | relation-member-vertex-mean",
          duplicates: "other OSM elements with the same kind+name within 150 m that were folded into this point",
          tags: "subset of OSM tags",
        },
        floodProneElementsInBbox: stats.floodProneCount,
        limitations: [
          ...COMMON_LIMITATIONS,
          "Water-supply pumping stations (pumping_station=water, ประปา/สูบจ่ายน้ำ) are excluded; sewage/wastewater pumping stations are kept as pump-station (tags show pumping_station=*).",
          "flood_prone=yes elements (mostly roads) are counted in metadata.floodProneElementsInBbox but not emitted as points: they are hazard annotations, not infrastructure.",
        ],
      });
      outputs.push({ file: relPath(file), bytes: stats.bytes, features: fc.features.length });
      report[`${city.id}-drainage`] = stats;
    } else {
      console.warn(`! ${city.id} drainage: no raw data (live failed and no cache) — output NOT written`);
      report[`${city.id}-drainage`] = { error: "no raw data" };
    }
  }

  // ---- sources registry
  const sources = loaded.map((l) => {
    const status: "retrieved" | "partial" | "failed" = l.data ? "retrieved" : "failed";
    const lines = [
      `Overpass QL query (POST to ${l.meta?.endpoint ?? ENDPOINTS[0]}):`,
      l.def.query,
      "",
      l.meta
        ? `OSM base timestamp ${l.meta.osmBaseTimestamp}; ${l.meta.elementCount} elements; ${l.meta.bytes} bytes; sha256 ${l.meta.sha256}; cached raw file data/raw/osm/infra/${l.def.key}.json.`
        : "No raw data available.",
      l.origin === "cache" && l.liveError ? `Live refresh failed on this run (${l.liveError}); values built from the cached raw file.` : "",
      l.def.layer === "drainage"
        ? "Status of derived features: observed (mapped OSM features); OSM coverage of drainage infrastructure is very incomplete, so point counts are not an inventory. Pump-station points tagged pumping_station=wastewater or named สถานีสูบน้ำเสีย (if any) are sewage/wastewater pumping stations, kept as tagged."
        : "Status of derived features: observed (mapped OSM features); waterway names/classes follow OSM tagging, and many river/canal segments are unnamed in OSM.",
    ].filter(Boolean);
    return {
      id: `osm-${l.def.key}`,
      nameTh: l.def.nameTh,
      nameEn: l.def.nameEn,
      url: l.meta?.endpoint ?? ENDPOINTS[0],
      publisher: "OpenStreetMap contributors (OpenStreetMap Foundation); served via the public Overpass API",
      license: `${LICENSE} — ${ATTRIBUTION} (${COPYRIGHT_URL})`,
      retrievedAt: l.meta?.retrievedAt,
      accessStatus: status,
      notes: lines.join("\n"),
    };
  });
  fs.mkdirSync(STAGED_DIR, { recursive: true });
  fs.writeFileSync(path.join(STAGED_DIR, "osm-sources.json"), JSON.stringify(sources, null, 2) + "\n", "utf8");

  // ---- notes
  fs.writeFileSync(path.join(STAGED_DIR, "osm-notes.md"), renderNotes(loaded, report, outputs), "utf8");
  fs.writeFileSync(path.join(STAGED_DIR, "osm-build-report.json"), JSON.stringify({ outputs, report }, null, 2) + "\n", "utf8");

  console.log("\nOutputs:");
  for (const o of outputs) console.log(`  ${o.file}: ${o.features} features, ${(o.bytes / 1e6).toFixed(3)} MB`);
  const failed = loaded.filter((l) => !l.data).map((l) => l.def.key);
  if (failed.length) {
    console.error(`\nFAILED (no data): ${failed.join(", ")}`);
    process.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// Notes renderer
// ---------------------------------------------------------------------------

function renderNotes(loaded: LoadResult[], report: Record<string, unknown>, outputs: { file: string; bytes: number; features: number }[]): string {
  const md: string[] = [];
  md.push("# OSM waterways & drainage infrastructure — ingestion notes");
  md.push("");
  md.push("Generated by `npx tsx scripts/data/fetch-osm-infra.ts` (re-run with `--offline` to rebuild from cached raw files).");
  md.push("");
  md.push(`Data © OpenStreetMap contributors, licensed under the Open Database License (ODbL) 1.0 — ${COPYRIGHT_URL}. Any public display must show the attribution \"${ATTRIBUTION}\". Derived databases that are publicly redistributed must remain under ODbL (share-alike).`);
  md.push("");
  md.push("## Retrieval log");
  md.push("");
  md.push("| key | origin this run | endpoint | HTTP | retrievedAt (UTC) | OSM base timestamp | elements | bytes |");
  md.push("|---|---|---|---|---|---|---|---|");
  for (const l of loaded) {
    md.push(
      `| ${l.def.key} | ${l.origin}${l.liveError ? ` (live failed: ${l.liveError})` : ""} | ${l.meta?.endpoint ?? "-"} | ${l.meta?.httpStatus ?? "-"} | ${l.meta?.retrievedAt ?? "-"} | ${l.meta?.osmBaseTimestamp ?? "-"} | ${l.meta?.elementCount ?? "-"} | ${l.meta?.bytes ?? "-"} |`,
    );
  }
  md.push("");
  md.push("Failed / retried requests (attempt log of the request that produced each cached raw file, plus any failed live attempts on the latest run):");
  md.push("");
  for (const l of loaded) {
    const atts = [...(l.meta?.attempts ?? []), ...(l.origin !== "live" ? l.liveAttempts : [])];
    const bad = atts.filter((a) => a.error);
    if (!bad.length) continue;
    md.push(`- **${l.def.key}**: ` + bad.map((a) => `${a.startedAt} ${a.endpoint} → ${a.error}`).join("; "));
  }
  md.push("");
  md.push("## Outputs");
  md.push("");
  md.push("| file | features | size (MB) |");
  md.push("|---|---|---|");
  for (const o of outputs) md.push(`| \`${o.file}\` | ${o.features} | ${(o.bytes / 1e6).toFixed(3)} |`);
  md.push("");
  md.push("Also written: `data/staged/osm-sources.json` (SourceRef[] — one entry per Overpass query, query text in `notes`) and `data/staged/osm-build-report.json` (full per-layer statistics).");
  md.push("");
  md.push("## Per-layer statistics");
  md.push("");
  for (const [k, v] of Object.entries(report)) {
    md.push(`### ${k}`);
    md.push("");
    const s = v as Record<string, unknown>;
    if ("error" in s) {
      md.push(`- ERROR: ${String(s.error)}`);
      md.push("");
      continue;
    }
    if (k.endsWith("waterways")) {
      const w = s as unknown as WaterwayStats;
      md.push(`- Ways returned by Overpass: ${w.waysIn}; used: ${w.waysUsed}; named via waterway relation: ${w.waysNamedViaRelation}; Thai name taken from same-\`name\` sibling ways: ${w.waysNamedViaSibling}; unnamed river/canal ways kept (name=null): ${w.waysUnnamedKept}; unnamed stream/drain/ditch ways dropped: ${w.waysDroppedUnnamedSmall}.`);
      md.push(`- Named (kind, name) groups: ${w.namedGroups}. Output features by kind: ${Object.entries(w.featuresOut).map(([a, b]) => `${a}=${b}`).join(", ")}.`);
      md.push(`- Water-area elements returned: ${w.areasIn}; used: ${w.areasUsed}; open/unassemblable rings skipped: ${w.openRings}.`);
      if (w.areasDropped.length) md.push(`- Water-area elements dropped: ${w.areasDropped.slice(0, 30).join("; ")}${w.areasDropped.length > 30 ? ` … (+${w.areasDropped.length - 30} more)` : ""}.`);
      md.push(`- widthClass 2 (major named khlong): ${w.majorCanals.length ? w.majorCanals.join(", ") : "none"}.`);
      md.push(`- Check for expected names:`);
      for (const r of w.requiredNames) md.push(`  - \`${r.pattern}\`: ${r.found.length ? r.found.join("; ") : "**NOT FOUND in OSM data for this bbox**"}`);
    } else {
      const d = s as unknown as DrainStats;
      md.push(`- OSM elements returned: ${d.elementsIn}. Kept points by kind: ${Object.entries(d.kept).map(([a, b]) => `${a}=${b}`).join(", ") || "none"}.`);
      md.push(`- Representative-point method counts: ${Object.entries(d.methods).map(([a, b]) => `${a}=${b}`).join(", ") || "-"}.`);
      md.push(`- flood_prone=yes elements in bbox (counted, not emitted): ${d.floodProneCount ?? "n/a"}.`);
      md.push(`- Duplicates folded (${d.duplicatesMerged.length}): ${d.duplicatesMerged.slice(0, 40).join("; ") || "none"}${d.duplicatesMerged.length > 40 ? " …" : ""}`);
      md.push(`- Excluded (${d.excluded.length}): ${d.excluded.slice(0, 60).join("; ") || "none"}${d.excluded.length > 60 ? " …" : ""}`);
      if (d.noGeometry.length) md.push(`- Skipped, no geometry: ${d.noGeometry.join(", ")}`);
    }
    md.push("");
  }
  md.push("## Schemas");
  md.push("");
  md.push("**waterways.geojson** — FeatureCollection with a top-level `metadata` foreign member (status, sourceIds, attribution, license, retrievedAt, osmBaseTimestamp, bbox, processing, limitations). Feature geometry: LineString | MultiLineString (centrelines) | Polygon | MultiPolygon (water areas). Properties:");
  md.push("");
  md.push("```ts");
  md.push("{ name: string | null;        // Thai as tagged: name:th, else name (may be romanised as tagged)");
  md.push("  nameEn: string | null;      // name:en if tagged, else null");
  md.push('  kind: "river" | "canal" | "stream" | "drain" | "water-area";');
  md.push('  osmId: string;              // e.g. "way/123456" (lowest id of merged members)');
  md.push("  widthClass: 1 | 2 | 3;      // display class: 3 principal river / แม่น้ำ / river water-area, 2 major named khlong or canal water-area, 1 other");
  md.push("  osmIds: string[];           // all merged OSM members");
  md.push('  nameSource: "way" | "sibling" | "relation" | "centreline" | "none" }  // see Method details');
  md.push("```");
  md.push("");
  md.push("**drainage.geojson** — FeatureCollection (Point) with top-level `metadata`. Properties:");
  md.push("");
  md.push("```ts");
  md.push("{ name: string | null; nameEn: string | null;");
  md.push('  kind: "pump-station" | "gate" | "monitoring" | "retention" | "other";');
  md.push('  osmId: string;              // "node/…", "way/…", "relation/…"');
  md.push('  status: "observed";         // a mapped OSM feature — NOT a complete inventory');
  md.push("  matchedBy: string;          // tag rule or \"name\"");
  md.push("  pointMethod: string;        // node | polygon-centre-of-mass | polygon-point-on-surface | line-midpoint | relation-member-vertex-mean");
  md.push("  duplicates: string[];       // same kind+name within 150 m folded into this point");
  md.push("  tags: Record<string, string> }  // subset: man_made, pumping_station, waterway, basin, operator, ref, …");
  md.push("```");
  md.push("");
  md.push("Units: coordinates WGS84 lon/lat degrees (EPSG:4326), 5 decimals. No measured quantities are carried (OSM has no flow/capacity data here); widthClass is a display class, not a measured width.");
  md.push("");
  md.push("Reference period: OSM state at the `osmBaseTimestamp` listed above (a snapshot, not a time series). No Buddhist-Era dates involved.");
  md.push("");
  md.push("## Method details");
  md.push("");
  md.push("- **Waterway selection**: `waterway=river|canal|stream|drain|ditch` ways with `name`, `name:th` or `name:en`, plus all `waterway=river|canal` ways (named or not). Unnamed ways inherit a name only from a named `waterway` relation they are a member of (`nameSource=relation`). A way tagged only with a romanised `name` (no `name:th`) takes the Thai `name:th` that every other way with the identical `name` carries, if exactly one such value exists (`nameSource=sibling`, e.g. Hat Yai culvert way/243314050 'Klong Samsib Mate' -> คลองสามสิบเมตร). No names are inferred from geometry/proximity for centrelines; the only proximity-based naming is the Chao Phraya water-area (`nameSource=centreline`). Unnamed streams/drains/ditches are dropped (\"tiny drains\"). `ditch` is mapped to kind `drain`.");
  md.push("- **Merging**: ways with identical (kind, name) are line-merged at end nodes shared by exactly two pieces; pieces of the same name that touch at any node become one MultiLineString feature. Same-name canals that do not touch stay separate features. Unnamed ways are merged only end-to-end (never grouped).");
  md.push("- **widthClass** (display class, not a measured width): 3 = the city's principal river (Bangkok: name starts แม่น้ำเจ้าพระยา; Hat Yai: name starts คลองอู่ตะเภา or the tagged variant คลองอุ่ตะเภา), any `waterway=river` named แม่น้ำ… or '… River', and river water-areas; 2 = named khlong (name starts คลอง/ลำ/Khlong/Klong, any of waterway=river|canal|stream) whose same-name ways total ≥ " + CITIES.bangkok.majorCanalKm + " km (Bangkok) / ≥ " + CITIES.hatyai.majorCanalKm + " km (Hat Yai) inside the bbox after clipping, or that carry a `width` tag ≥ 10 m; canal water-areas; 1 = everything else, including unnamed ways. Many Bangkok khlongs are tagged `waterway=river` in OSM; they keep `kind: \"river\"` (the OSM tag) but get widthClass 2/1 unless they are the principal river.");
  md.push("- **Chao Phraya water area (Bangkok)**: candidates are `natural=water + water=river|riverbank` and legacy `waterway=riverbank` ways/multipolygons within 400 m of the `waterway=river` centreline named แม่น้ำเจ้าพระยา…, plus any `natural=water` element named *เจ้าพระยา*. Kept: parts named เจ้าพระยา / Chao Phraya, and unnamed parts that the centreline (returned by the same query/snapshot) actually intersects (turf.booleanIntersects). Parts named something else, and unnamed parts the centreline does not cross, are dropped (listed above). Kept parts are dissolved (mapshaper -dissolve2) into one feature, clipped to the bbox, and take name/name:en from the centreline (`nameSource=centreline`) when any part is unnamed.");
  md.push("- **Hat Yai water areas**: all `natural=water + water=river|riverbank|canal|stream` (and `waterway=riverbank`) polygons in the buffered bbox, grouped by name (unnamed parts stay separate, name=null).");
  md.push("- **Drainage selection**: `man_made=pumping_station`, `pumping_station=*`, `waterway=sluice_gate|lock_gate|weir|dam|floodgate|flood_gate`, `man_made=monitoring_station + monitoring:water_level=yes`, `basin~retention|detention`, plus Thai/English name patterns (" + "`" + DRAINAGE_NAME_TH + "` / `" + DRAINAGE_NAME_EN + "`). Name-only matches carrying POI keys (" + NAME_ONLY_EXCLUDE_KEYS.join(", ") + ") are excluded. Water-supply pumping stations (`pumping_station=water`, names with ประปา/สูบจ่ายน้ำ/น้ำดิบ) are excluded. Sewage/wastewater pumping stations (`pumping_station=wastewater`, or Thai names containing สถานีสูบน้ำเสีย) are kept as `pump-station` exactly as tagged — they are part of the BMA drainage-and-sewerage system but are not stormwater pumps; inspect `tags`/`name` before treating a point as flood-drainage capacity.");
  md.push("- **Representative points**: nodes as-is; closed ways and multipolygons → turf centre of mass, or point-on-surface if the centre falls outside the shape; open ways → point at half the line length; other relations → mean of member vertices.");
  md.push("- **Simplification**: mapshaper 0.7 `-clip bbox=… -simplify dp interval=<m> keep-shapes -o precision=0.00001 rfc7946`.");
  md.push("");
  md.push("## Caveats");
  md.push("");
  const snaps = loaded.filter((l) => l.meta?.osmBaseTimestamp).map((l) => `${l.def.key} = ${l.meta?.osmBaseTimestamp} (${l.meta?.endpoint})`);
  if (snaps.length) {
    const times = loaded.map((l) => (l.meta?.osmBaseTimestamp ? Date.parse(l.meta.osmBaseTimestamp) : NaN)).filter((x) => !Number.isNaN(x));
    const spreadDays = (Math.max(...times) - Math.min(...times)) / 86_400_000;
    md.push(
      `- OSM snapshot dates differ between queries because different Overpass mirrors served them (spread ${spreadDays.toFixed(1)} days): ${snaps.join("; ")}. A mirror's database can lag the main OSM database by weeks or months; edits made after a snapshot date are not included.`,
    );
  }
  {
    const bd = report["bangkok-drainage"] as DrainStats | undefined;
    const hd = report["hatyai-drainage"] as DrainStats | undefined;
    const fmt = (d: DrainStats | undefined) => (d && d.kept ? Object.entries(d.kept).map(([a, b]) => `${a}=${b}`).join(", ") || "none" : "n/a");
    md.push(
      `- OSM is crowd-sourced and drainage infrastructure is sparsely mapped: the Bangkok bbox yields only ${fmt(bd)}; the Hat Yai bbox yields ${fmt(hd)} (no pumping stations or sluice gates tagged). Bangkok's drainage system (BMA Drainage and Sewerage Department) is known to comprise far more pumping stations, floodgates and monkey-cheek (แก้มลิง) retention areas than this. Treat drainage points as *examples of mapped features*, never as counts, densities or coverage.`,
    );
    if (bd?.airportRetention)
      md.push(
        `- ${bd.airportRetention} of the Bangkok \`basin=retention\` points fall inside the box 100.72–100.77 E, 13.64–13.72 N, i.e. the Suvarnabhumi Airport area (Bang Phli, Samut Prakan — outside the BMA boundary): they are the airport's individually-mapped retention ponds, which dominates the 'retention' count.`,
      );
  }
  md.push("- Waterway names follow OSM tagging and are not corrected. Where a way has both a romanised `name` and a Thai `name:th` (e.g. Hat Yai name='Klong Ror Hok', name:th='คลอง ร6'), the output `name` is the Thai `name:th`; the romanised `name` is not copied into `nameEn` (nameEn = `name:en` only). Ways with only a romanised `name` keep it as `name` unless the sibling rule (Method details) resolves a Thai name. The Hat Yai downstream U-Taphao segment is tagged 'คลองอุ่ตะเภา' (sic, ุ่ instead of ู่) as waterway=stream, while the upstream segment is 'คลองอู่ตะเภา' waterway=river; unnamed waterway=river ways that join them end-to-end (e.g. way/502095133) are left unnamed.");
  md.push("- Many river/canal segments are unnamed in OSM; they are kept with `name: null` so the network is visually continuous, but they cannot be attributed to a specific khlong.");
  md.push("- `widthClass` is a display hint derived from tags/length, not a measured channel width or capacity.");
  md.push("- Clipping to the bbox cuts features at the bbox edge; the Bangkok bbox also covers parts of neighbouring provinces (Nonthaburi, Samut Prakan, Pathum Thani, Samut Sakhon).");
  md.push("");
  return md.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
