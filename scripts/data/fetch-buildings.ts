/**
 * fetch-buildings.ts — OpenStreetMap building windows for the 3D neighbourhood
 * view (Urban Intelligence — Waste & Flood Observatory).
 *
 * Data: © OpenStreetMap contributors, ODbL-1.0 (https://www.openstreetmap.org/copyright)
 *
 * Usage (from the repo root):
 *   npx tsx scripts/data/fetch-buildings.ts bangkok            # fetch missing windows, rebuild all outputs
 *   npx tsx scripts/data/fetch-buildings.ts bangkok --force    # re-query Overpass for every area (and the townhall list)
 *   npx tsx scripts/data/fetch-buildings.ts bangkok --offline  # rebuild outputs from cached raw files only
 *   npx tsx scripts/data/fetch-buildings.ts bangkok --only=bkk-1001,bkk-1004   # restrict to these areas
 *   npx tsx scripts/data/fetch-buildings.ts hatyai [--areas=public/data/hatyai/<file>.geojson]
 *                                                   [--id-prop=<property>] [--id-prefix=hy-]
 *
 * Everything is city-scoped: a run for one city never reads, rewrites or
 * deletes the other city's outputs, so the two cities can be processed by
 * separate (even concurrent) runs.
 *
 * Per area polygon:
 *  1. Anchor = OSM amenity=townhall whose name is "สำนักงานเขต<district nameTh>"
 *     (whitespace-insensitive) and whose position (node, or Overpass `center`
 *     of a way/relation) lies inside the polygon; otherwise turf.pointOnFeature
 *     (rounded to 6 decimals). anchorSource = "osm-townhall:<type>/<id>" or
 *     "point-on-surface".
 *  2. One Overpass query per area for the square window of half-size 450 m
 *     around the anchor: building ways + building multipolygon relations,
 *     highways motorway..residential (+ *_link; service/living_street/paths
 *     excluded), waterways and water areas; `out tags geom`.
 *  3. Local ENU metres: x = (lon − lon0)·cos(lat0)·111320, y = (lat − lat0)·110574,
 *     rounded to 0.1 m; closing vertex dropped; rings normalised to CCW.
 *     Roads/water lines clipped per segment (Liang–Barsky) and water areas
 *     clipped (Sutherland–Hodgman) to the window; buildings kept when their
 *     area centroid lies inside the window.
 *  4. Height: numeric `height` (units stripped; ft → m) → hs "height";
 *     else `building:levels` × 3.2 m → hs "levels"; else
 *     h = clamp(4 + 2.2·√A/6 + (fnv1a32(String(osmId)) mod 7), 4, 24) → hs "estimated".
 *     At most 6000 buildings per window (smallest footprints dropped).
 *  5. Writes public/data/buildings/<areaId>.json (BuildingWindow, minified).
 *  6. Writes data/staged/<city>-anchors.json, data/staged/<city>-buildings-report.json,
 *     data/staged/<city>-buildings-sources.json, data/staged/<city>-buildings-notes.md
 *     and data/raw/_manifests/fetch-buildings-<city>.json.
 *
 * Raw Overpass responses (untrusted data) are cached verbatim in
 * data/raw/overpass-buildings/<areaId>.json with a sidecar <areaId>.meta.json
 * (endpoint, HTTP status, retrievedAt, query, anchor, sha256, OSM base
 * timestamp, attempt log). Areas whose cache matches the current anchor are
 * not re-queried unless --force. Outputs are a pure function of the area
 * polygons + cached raw files, so re-running reproduces them byte-for-byte.
 *
 * Network etiquette: strictly sequential queries, >= 3 s between requests
 * (also coordinated across concurrent runs through a shared timestamp file),
 * exponential backoff on 429/5xx/timeouts, rotating the three public Overpass
 * endpoints, descriptive User-Agent.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as turf from "@turf/turf";
import type { BuildingWindow } from "../../src/lib/types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..");
const RAW_DIR = path.join(ROOT, "data", "raw", "overpass-buildings");
const OUT_DIR = path.join(ROOT, "public", "data", "buildings");
const STAGED_DIR = path.join(ROOT, "data", "staged");
const MANIFEST_DIR = path.join(ROOT, "data", "raw", "_manifests");
const THROTTLE_FILE = path.join(RAW_DIR, ".last-request");

const USER_AGENT = "UrbanIntelligenceDemo/0.1 (research prototype)";
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const MAX_ATTEMPTS = 9;
const REQUEST_TIMEOUT_MS = 150_000;
const MIN_GAP_MS = 3_000;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 120_000;
const QUERY_TIMEOUT_S = 180;

const SOURCE_ID = "osm-overpass";
const HALF_SIZE_M = 450;
const MAX_BUILDINGS = 6000;
const LEVEL_HEIGHT_M = 3.2;
const M_PER_DEG_LON_EQ = 111320;
const M_PER_DEG_LAT = 110574;
const MAX_PLAUSIBLE_HEIGHT_M = 500; // tallest buildings in Thailand are < 320 m
const MAX_PLAUSIBLE_LEVELS = 150;

const HIGHWAY_CLASSES = [
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential",
];
const WATERWAY_LINES = ["river", "canal", "stream", "drain", "ditch", "tidal_channel", "brook"];
const WATERWAY_AREAS = ["riverbank", "dock"];
const LANDUSE_WATER = ["reservoir", "basin"];
const TOWNHALL_PREFIX = "สำนักงานเขต";

type CityId = "bangkok" | "hatyai";

interface CityCfg {
  /** GeoJSON FeatureCollection of area polygons, relative to ROOT. */
  areasFile: string;
  /** Property holding the area code; areaId = idPrefix + code (unless the feature already has an `id` property with the prefix). */
  idProp: string;
  idPrefix: string;
  /** Thai name property used to match "สำนักงานเขต<name>". */
  nameThProp: string;
  nameEnProp: string;
}

const CITIES: Record<CityId, CityCfg> = {
  bangkok: {
    areasFile: "public/data/bangkok/districts.geojson",
    idProp: "code",
    idPrefix: "bkk-",
    nameThProp: "nameTh",
    nameEnProp: "nameEn",
  },
  // Hat Yai community-management zones (approximate polygons written by
  // fetch-hatyai.ts with properties id "hy-z<N>", zoneNo N). Override with
  // --areas= / --id-prop= / --id-prefix= if that file changes.
  hatyai: {
    areasFile: "public/data/hatyai/zones.geojson",
    idProp: "zoneNo",
    idPrefix: "hy-z",
    nameThProp: "nameTh",
    nameEnProp: "nameEn",
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LatLon = { lat: number; lon: number };
type Tags = Record<string, string>;
interface OsmMember { type: string; ref: number; role: string; geometry?: (LatLon | null)[] }
interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: LatLon;
  tags?: Tags;
  geometry?: (LatLon | null)[];
  members?: OsmMember[];
}
interface OsmResponse { osm3s?: { timestamp_osm_base?: string; copyright?: string }; remark?: string; elements: OsmElement[] }

interface Attempt { endpoint: string; startedAt: string; durationMs: number; httpStatus: number | null; error: string | null }
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
  /** window caches only */
  anchor?: [number, number];
  anchorSource?: string;
  halfSizeM?: number;
}

interface Area {
  areaId: string;
  code: string;
  nameTh: string;
  nameEn: string;
  feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
}

type Pt = [number, number];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const city = argv.find((a) => !a.startsWith("--")) as CityId | undefined;
  if (!city || !(city in CITIES)) {
    console.error("usage: npx tsx scripts/data/fetch-buildings.ts <bangkok|hatyai> [--force] [--offline] [--only=id1,id2] [--areas=path] [--id-prop=prop] [--id-prefix=prefix]");
    process.exit(2);
  }
  const flag = (n: string) => argv.includes(`--${n}`);
  const opt = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const cfg: CityCfg = { ...CITIES[city] };
  if (opt("areas")) cfg.areasFile = opt("areas")!;
  if (opt("id-prop")) cfg.idProp = opt("id-prop")!;
  if (opt("id-prefix")) cfg.idPrefix = opt("id-prefix")!;
  const only = opt("only") ? new Set(opt("only")!.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  return { city, cfg, force: flag("force"), offline: flag("offline"), only };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const r1 = (v: number) => {
  const x = Math.round(v * 10) / 10;
  return Object.is(x, -0) ? 0 : x;
};
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r7 = (v: number) => Math.round(v * 1e7) / 1e7;
const fx = (v: number) => v.toFixed(7);
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

/** FNV-1a 32-bit hash of a UTF-8 string (unsigned). */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function writeIfChanged(file: string, content: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return false;
  fs.writeFileSync(file, content, "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// Overpass fetch with polite retry, rotation and cache
// ---------------------------------------------------------------------------

let endpointCursor = Number(process.env.OVERPASS_START_ENDPOINT ?? 0) || 0; // lets two sequential streams start on different mirrors

async function politeGap() {
  // Coordinated across concurrent runs (e.g. bangkok + hatyai) via a shared timestamp file.
  for (;;) {
    let last = 0;
    try {
      last = Number(fs.readFileSync(THROTTLE_FILE, "utf8")) || 0;
    } catch {
      /* first request */
    }
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait <= 0) break;
    await sleep(wait + Math.floor(Math.random() * 250));
  }
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(THROTTLE_FILE, String(Date.now()), "utf8");
}

function validateOverpass(text: string): { ok: true; data: OsmResponse } | { ok: false; reason: string } {
  let data: OsmResponse;
  try {
    data = JSON.parse(text) as OsmResponse;
  } catch {
    return { ok: false, reason: `response is not JSON (starts ${JSON.stringify(text.slice(0, 60))})` };
  }
  if (!data || !Array.isArray(data.elements)) return { ok: false, reason: "no elements[] in response" };
  if (data.remark && /error|timed out|out of memory|runtime/i.test(data.remark)) {
    return { ok: false, reason: `Overpass remark: ${data.remark.slice(0, 200)}` };
  }
  return { ok: true, data };
}

async function fetchOverpass(key: string, query: string): Promise<{ text: string; meta: RawMeta } | { error: string; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  let backoff = BACKOFF_START_MS;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    // stay on a healthy endpoint; rotate only after a failed attempt (see `endpointCursor++` below)
    const endpoint = ENDPOINTS[endpointCursor % ENDPOINTS.length];
    await politeGap();
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
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      const text = await res.text();
      if (res.status === 200) {
        const v = validateOverpass(text);
        if (v.ok) {
          attempts.push({ endpoint, startedAt, durationMs: Date.now() - t0, httpStatus: status, error: null });
          return {
            text,
            meta: {
              key,
              endpoint,
              httpStatus: status,
              retrievedAt: new Date().toISOString(),
              osmBaseTimestamp: v.data.osm3s?.timestamp_osm_base ?? null,
              bytes: Buffer.byteLength(text, "utf8"),
              sha256: sha256(text),
              elementCount: v.data.elements.length,
              userAgent: USER_AGENT,
              query,
              attempts,
            },
          };
        }
        error = v.reason;
      } else {
        error = `HTTP ${res.status}`;
      }
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    attempts.push({ endpoint, startedAt, durationMs: Date.now() - t0, httpStatus: status, error });
    console.warn(`    attempt ${i + 1}/${MAX_ATTEMPTS} ${endpoint} -> ${error}`);
    endpointCursor++;
    if (i < MAX_ATTEMPTS - 1) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }
  return { error: `all ${MAX_ATTEMPTS} attempts failed`, attempts };
}

const rawPaths = (key: string) => ({ data: path.join(RAW_DIR, `${key}.json`), meta: path.join(RAW_DIR, `${key}.meta.json`) });

function readCache(key: string): { data: OsmResponse; meta: RawMeta } | null {
  const p = rawPaths(key);
  if (!fs.existsSync(p.data) || !fs.existsSync(p.meta)) return null;
  const text = fs.readFileSync(p.data, "utf8");
  const v = validateOverpass(text);
  if (!v.ok) {
    console.warn(`  [${key}] cached raw file invalid: ${v.reason}`);
    return null;
  }
  const meta = JSON.parse(fs.readFileSync(p.meta, "utf8")) as RawMeta;
  if (meta.sha256 !== sha256(text)) console.warn(`  [${key}] WARNING cached file sha256 differs from meta`);
  return { data: v.data, meta };
}

function writeCache(key: string, text: string, meta: RawMeta) {
  const p = rawPaths(key);
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(p.data, text, "utf8");
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

function loadAreas(cfg: CityCfg): Area[] {
  const file = path.join(ROOT, cfg.areasFile);
  if (!fs.existsSync(file)) throw new Error(`area polygons missing: ${cfg.areasFile}`);
  let fc: GeoJSON.FeatureCollection;
  try {
    fc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`area polygons not valid JSON: ${cfg.areasFile} (${(e as Error).message})`);
  }
  if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features) || fc.features.length === 0) {
    throw new Error(`area polygons not a non-empty FeatureCollection: ${cfg.areasFile}`);
  }
  const areas: Area[] = [];
  const seen = new Set<string>();
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) throw new Error(`feature without (Multi)Polygon geometry in ${cfg.areasFile}`);
    const p = (f.properties ?? {}) as Record<string, unknown>;
    let areaId: string;
    if (typeof p.id === "string" && p.id.startsWith(cfg.idPrefix)) areaId = p.id;
    else if (p[cfg.idProp] !== undefined && p[cfg.idProp] !== null && String(p[cfg.idProp]) !== "") areaId = cfg.idPrefix + String(p[cfg.idProp]);
    else throw new Error(`feature without "${cfg.idProp}" property in ${cfg.areasFile}`);
    if (seen.has(areaId)) throw new Error(`duplicate area id ${areaId}`);
    seen.add(areaId);
    const bb = turf.bbox(f);
    if (!bb.every(Number.isFinite) || bb[0] < -180 || bb[2] > 180 || bb[1] < -90 || bb[3] > 90) throw new Error(`area ${areaId} has non-geographic coordinates`);
    areas.push({
      areaId,
      code: String(p[cfg.idProp] ?? areaId.slice(cfg.idPrefix.length)),
      nameTh: String(p[cfg.nameThProp] ?? ""),
      nameEn: String(p[cfg.nameEnProp] ?? ""),
      feature: f as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
    });
  }
  areas.sort((a, b) => (a.areaId < b.areaId ? -1 : a.areaId > b.areaId ? 1 : 0));
  return areas;
}

// ---------------------------------------------------------------------------
// Anchors (district office townhalls)
// ---------------------------------------------------------------------------

const normName = (s: string) => s.normalize("NFC").replace(/\s+/g, "");

interface TownhallCandidate { ref: string; type: string; id: number; lon: number; lat: number; name: string }

function townhallCandidates(res: OsmResponse | null): TownhallCandidate[] {
  if (!res) return [];
  const out: TownhallCandidate[] = [];
  for (const e of res.elements) {
    const pos = e.type === "node" ? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null) : e.center ?? null;
    if (!pos || !e.tags) continue;
    const names = [e.tags.name, e.tags["name:th"], e.tags.official_name, e.tags["official_name:th"], e.tags.alt_name].filter((n): n is string => !!n);
    const name = names.find((n) => normName(n).includes(TOWNHALL_PREFIX));
    if (!name) continue;
    out.push({ ref: `${e.type}/${e.id}`, type: e.type, id: e.id, lon: pos.lon, lat: pos.lat, name });
  }
  return out;
}

interface AnchorChoice { anchor: [number, number]; anchorSource: string; townhallName: string | null; note: string }

function chooseAnchor(area: Area, cands: TownhallCandidate[]): AnchorChoice {
  const target = normName(TOWNHALL_PREFIX + area.nameTh);
  const typeRank: Record<string, number> = { way: 0, node: 1, relation: 2 };
  const nameMatches = area.nameTh ? cands.filter((c) => normName(c.name).includes(target)) : [];
  const inside = nameMatches.filter((c) => turf.booleanPointInPolygon(turf.point([c.lon, c.lat]), area.feature));
  const rank = (c: TownhallCandidate) => {
    const n = normName(c.name);
    return n === target ? 0 : n.startsWith(target) ? 1 : 2;
  };
  inside.sort((a, b) => rank(a) - rank(b) || typeRank[a.type] - typeRank[b.type] || a.id - b.id);
  if (inside.length > 0) {
    const c = inside[0];
    const others = inside.length > 1 ? `; ${inside.length - 1} other matching candidate(s): ${inside.slice(1).map((o) => o.ref).join(", ")}` : "";
    return {
      anchor: [r7(c.lon), r7(c.lat)],
      anchorSource: `osm-townhall:${c.ref}`,
      townhallName: c.name,
      note: `amenity=townhall "${c.name}" (${c.type === "node" ? "node position" : "Overpass bbox centre"}) inside polygon${others}`,
    };
  }
  const p = turf.pointOnFeature(area.feature).geometry.coordinates;
  const outsideNote = nameMatches.length
    ? `name-matching townhall(s) found outside the polygon: ${nameMatches.map((c) => `${c.ref} "${c.name}" @ ${r6(c.lon)},${r6(c.lat)}`).join("; ")}`
    : "no amenity=townhall named " + JSON.stringify(TOWNHALL_PREFIX + area.nameTh) + " found";
  return { anchor: [r6(p[0]), r6(p[1])], anchorSource: "point-on-surface", townhallName: null, note: `turf.pointOnFeature; ${outsideNote}` };
}

// ---------------------------------------------------------------------------
// Window query
// ---------------------------------------------------------------------------

function windowBbox(anchor: [number, number]) {
  const [lon0, lat0] = anchor;
  const dLat = HALF_SIZE_M / M_PER_DEG_LAT;
  const dLon = HALF_SIZE_M / (M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180));
  return { s: lat0 - dLat, w: lon0 - dLon, n: lat0 + dLat, e: lon0 + dLon };
}

function windowQuery(anchor: [number, number]): string {
  const b = windowBbox(anchor);
  const bb = `${fx(b.s)},${fx(b.w)},${fx(b.n)},${fx(b.e)}`;
  // Ways: `out tags geom` (tags + coordinates, no node ids). Relations need
  // verbosity `body` so that members (with their geometry) are printed.
  return `[out:json][timeout:${QUERY_TIMEOUT_S}];
way["building"](${bb});
out tags geom;
relation["type"="multipolygon"]["building"](${bb});
out geom;
way["highway"~"^(${HIGHWAY_CLASSES.join("|")})$"](${bb});
out tags geom;
(
  way["waterway"](${bb});
  way["natural"="water"](${bb});
  way["water"](${bb});
  way["landuse"~"^(${LANDUSE_WATER.join("|")})$"](${bb});
);
out tags geom;
(
  relation["natural"="water"](${bb});
  relation["type"="multipolygon"]["water"](${bb});
  relation["type"="multipolygon"]["waterway"~"^(${WATERWAY_AREAS.join("|")})$"](${bb});
  relation["type"="multipolygon"]["landuse"~"^(${LANDUSE_WATER.join("|")})$"](${bb});
);
out geom;`;
}

function townhallQuery(areas: Area[]): string {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const a of areas) {
    const b = turf.bbox(a.feature);
    w = Math.min(w, b[0]);
    s = Math.min(s, b[1]);
    e = Math.max(e, b[2]);
    n = Math.max(n, b[3]);
  }
  const m = 0.005;
  return `[out:json][timeout:${QUERY_TIMEOUT_S}];
nwr["amenity"="townhall"](${(s - m).toFixed(4)},${(w - m).toFixed(4)},${(n + m).toFixed(4)},${(e + m).toFixed(4)});
out center tags;`;
}

// ---------------------------------------------------------------------------
// Geometry: local ENU, rings, clipping
// ---------------------------------------------------------------------------

interface Frame { lon0: number; lat0: number; kx: number }
const makeFrame = (anchor: [number, number]): Frame => ({ lon0: anchor[0], lat0: anchor[1], kx: Math.cos((anchor[1] * Math.PI) / 180) * M_PER_DEG_LON_EQ });
const toLocal = (f: Frame, g: LatLon): Pt => [(g.lon - f.lon0) * f.kx, (g.lat - f.lat0) * M_PER_DEG_LAT];

function signedArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

function centroid(r: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const cr = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += cr;
    cx += (r[j][0] + r[i][0]) * cr;
    cy += (r[j][1] + r[i][1]) * cr;
  }
  if (Math.abs(a) < 1e-9) {
    const n = r.length;
    return [r.reduce((s, p) => s + p[0], 0) / n, r.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Round to 0.1 m and remove consecutive duplicates (and the closing duplicate for rings). */
function roundPts(pts: Pt[], ring: boolean): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q: Pt = [r1(p[0]), r1(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  if (ring) while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

const sameLL = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon;

/** Ways' geometry with no null vertices, else null. */
function fullGeom(g: (LatLon | null)[] | undefined): LatLon[] | null {
  if (!g || g.length < 2 || g.some((p) => !p)) return null;
  return g as LatLon[];
}

/** Assemble closed rings from member way geometries by joining shared endpoints. */
function assembleRings(parts: LatLon[][]): { rings: LatLon[][]; open: number } {
  const pool = parts.map((p) => p.slice());
  const rings: LatLon[][] = [];
  let open = 0;
  while (pool.length) {
    let cur = pool.shift()!;
    let progress = true;
    while (!sameLL(cur[0], cur[cur.length - 1]) && progress) {
      progress = false;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        const end = cur[cur.length - 1];
        if (sameLL(p[0], end)) cur = cur.concat(p.slice(1));
        else if (sameLL(p[p.length - 1], end)) cur = cur.concat(p.slice(0, -1).reverse());
        else if (sameLL(p[p.length - 1], cur[0])) cur = p.slice(0, -1).concat(cur);
        else if (sameLL(p[0], cur[0])) cur = p.slice(1).reverse().concat(cur);
        else continue;
        pool.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (cur.length >= 4 && sameLL(cur[0], cur[cur.length - 1])) rings.push(cur);
    else open++;
  }
  return { rings, open };
}

function outerRingsOf(e: OsmElement): { rings: LatLon[][]; open: number; missing: number } {
  const parts: LatLon[][] = [];
  let missing = 0;
  for (const m of e.members ?? []) {
    if (m.type !== "way" || (m.role !== "outer" && m.role !== "")) continue;
    const g = fullGeom(m.geometry);
    if (!g) {
      missing++;
      continue;
    }
    parts.push(g);
  }
  const r = assembleRings(parts);
  return { ...r, missing };
}

/** Liang–Barsky clip of a polyline to the square [-H, H]², returning the inside pieces. */
function clipPolyline(pts: Pt[], H: number): Pt[][] {
  const pieces: Pt[][] = [];
  let cur: Pt[] = [];
  const flush = () => {
    if (cur.length >= 2) pieces.push(cur);
    cur = [];
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1;
    let ok = true;
    for (const [p, q] of [[-dx, x0 + H], [dx, H - x0], [-dy, y0 + H], [dy, H - y0]] as const) {
      if (p === 0) {
        if (q < 0) { ok = false; break; }
      } else {
        const t = q / p;
        if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; }
        else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
      }
    }
    if (!ok) { flush(); continue; }
    const a: Pt = [x0 + t0 * dx, y0 + t0 * dy];
    const b: Pt = [x0 + t1 * dx, y0 + t1 * dy];
    if (cur.length === 0) cur.push(a);
    else {
      const last = cur[cur.length - 1];
      if (Math.abs(last[0] - a[0]) > 1e-9 || Math.abs(last[1] - a[1]) > 1e-9) { flush(); cur.push(a); }
    }
    cur.push(b);
    if (t1 < 1) flush();
  }
  flush();
  return pieces;
}

/** Sutherland–Hodgman clip of a ring (not closed) to the square [-H, H]². */
function clipRing(ring: Pt[], H: number): Pt[] {
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= -H, (a, b) => { const t = (-H - a[0]) / (b[0] - a[0]); return [-H, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[0] <= H, (a, b) => { const t = (H - a[0]) / (b[0] - a[0]); return [H, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[1] >= -H, (a, b) => { const t = (-H - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), -H]; }],
    [(p) => p[1] <= H, (a, b) => { const t = (H - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), H]; }],
  ];
  let out = ring;
  for (const [inside, inter] of edges) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) {
        if (!pi) out.push(inter(prev, cur));
        out.push(cur);
      } else if (pi) out.push(inter(prev, cur));
    }
  }
  return out;
}

const ccw = (r: Pt[]): Pt[] => (signedArea(r) < 0 ? r.slice().reverse() : r);

// ---------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------

function parseHeight(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim().toLowerCase().replace(/(\d),(\d)/, "$1.$2");
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|meters?|metres?|ม\.?|เมตร|ft|feet|foot|')?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] && /^(ft|feet|foot|')$/.test(m[2])) n *= 0.3048;
  return n > 0 && n <= MAX_PLAUSIBLE_HEIGHT_M ? n : null;
}

function parseLevels(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n > 0 && n <= MAX_PLAUSIBLE_LEVELS ? n : null;
}

function estimateHeight(areaM2: number, osmId: number): number {
  const h = 4 + (2.2 * Math.sqrt(Math.max(areaM2, 0))) / 6 + (fnv1a32(String(osmId)) % 7);
  return Math.min(24, Math.max(4, h));
}

// ---------------------------------------------------------------------------
// Window processing
// ---------------------------------------------------------------------------

interface WindowStats {
  buildingElements: number;
  buildingsKept: number;
  buildingsOutsideWindow: number;
  buildingsInvalidGeometry: number;
  buildingsTaggedNo: number;
  buildingRelations: number;
  buildingRelationsMultiOuter: number;
  taggedHeightCount: number;
  levelsCount: number;
  estimatedCount: number;
  droppedCount: number;
  droppedMaxAreaM2: number | null;
  rejectedHeightTags: number;
  rejectedLevelTags: number;
  roadWays: number;
  roadPieces: number;
  roadLengthM: number;
  roadsByClass: Record<string, number>;
  waterLineWays: number;
  waterLinePieces: number;
  waterAreaFeatures: number;
  waterAreaPieces: number;
  waterAreaOpenRings: number;
  heightMinM: number | null;
  heightMedianM: number | null;
  heightMaxM: number | null;
}

function processWindow(areaId: string, anchor: [number, number], res: OsmResponse, retrievedAt: string): { win: BuildingWindow; stats: WindowStats } {
  const H = HALF_SIZE_M;
  const frame = makeFrame(anchor);
  const st: WindowStats = {
    buildingElements: 0, buildingsKept: 0, buildingsOutsideWindow: 0, buildingsInvalidGeometry: 0, buildingsTaggedNo: 0,
    buildingRelations: 0, buildingRelationsMultiOuter: 0, taggedHeightCount: 0, levelsCount: 0, estimatedCount: 0,
    droppedCount: 0, droppedMaxAreaM2: null, rejectedHeightTags: 0, rejectedLevelTags: 0, roadWays: 0, roadPieces: 0,
    roadLengthM: 0, roadsByClass: {}, waterLineWays: 0, waterLinePieces: 0, waterAreaFeatures: 0, waterAreaPieces: 0,
    waterAreaOpenRings: 0, heightMinM: null, heightMedianM: null, heightMaxM: null,
  };

  // De-duplicate elements (a way can be returned by several statements).
  const seen = new Set<string>();
  const elements = res.elements.filter((e) => {
    const k = `${e.type}/${e.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  type B = BuildingWindow["buildings"][number] & { area: number };
  const buildings: B[] = [];
  const roads: (BuildingWindow["roads"][number] & { k: number })[] = [];
  const water: (BuildingWindow["water"][number] & { k: number })[] = [];

  for (const e of elements) {
    const t = e.tags ?? {};

    // ---- buildings
    if (t.building !== undefined && (e.type === "way" || e.type === "relation")) {
      st.buildingElements++;
      if (t.building === "no" || t.building === "none") { st.buildingsTaggedNo++; continue; }
      let ringLL: LatLon[] | null = null;
      if (e.type === "way") {
        const g = fullGeom(e.geometry);
        if (g && g.length >= 4 && sameLL(g[0], g[g.length - 1])) ringLL = g;
      } else {
        st.buildingRelations++;
        const { rings } = outerRingsOf(e);
        if (rings.length > 1) st.buildingRelationsMultiOuter++;
        let best = -1;
        for (const r of rings) {
          const a = Math.abs(signedArea(r.map((p) => toLocal(frame, p))));
          if (a > best) { best = a; ringLL = r; }
        }
      }
      if (!ringLL) { st.buildingsInvalidGeometry++; continue; }
      const local = ringLL.slice(0, -1).map((p) => toLocal(frame, p));
      const areaM2 = Math.abs(signedArea(local));
      const c = centroid(local);
      if (Math.abs(c[0]) > H || Math.abs(c[1]) > H) { st.buildingsOutsideWindow++; continue; }
      const fp = roundPts(ccw(local), true);
      if (fp.length < 3 || Math.abs(signedArea(fp)) < 0.01) { st.buildingsInvalidGeometry++; continue; }

      let h: number, hs: "height" | "levels" | "estimated";
      const th = parseHeight(t.height);
      const tl = th === null ? parseLevels(t["building:levels"]) : null;
      if (t.height !== undefined && th === null) st.rejectedHeightTags++;
      if (th === null && t["building:levels"] !== undefined && tl === null) st.rejectedLevelTags++;
      if (th !== null) { h = th; hs = "height"; }
      else if (tl !== null) { h = tl * LEVEL_HEIGHT_M; hs = "levels"; }
      else { h = estimateHeight(areaM2, e.id); hs = "estimated"; }
      buildings.push({ id: e.type === "relation" ? -e.id : e.id, h: r1(h), hs, fp, area: areaM2 });
      continue;
    }

    // ---- roads
    if (e.type === "way" && t.highway !== undefined && HIGHWAY_CLASSES.includes(t.highway)) {
      const g = fullGeom(e.geometry);
      if (!g) continue;
      st.roadWays++;
      for (const piece of clipPolyline(g.map((p) => toLocal(frame, p)), H)) {
        const pts = roundPts(piece, false);
        if (pts.length < 2) continue;
        roads.push({ t: t.highway, pts, k: e.id });
      }
      continue;
    }

    // ---- water
    const isWaterArea =
      t.natural === "water" ||
      (t.waterway !== undefined && WATERWAY_AREAS.includes(t.waterway)) ||
      (t.landuse !== undefined && LANDUSE_WATER.includes(t.landuse)) ||
      (t.water !== undefined && t.natural !== "wetland" && t.highway === undefined && t.building === undefined);
    const isWaterLine = !isWaterArea && e.type === "way" && t.waterway !== undefined && WATERWAY_LINES.includes(t.waterway);
    if (isWaterLine) {
      const g = fullGeom(e.geometry);
      if (!g) continue;
      st.waterLineWays++;
      for (const piece of clipPolyline(g.map((p) => toLocal(frame, p)), H)) {
        const pts = roundPts(piece, false);
        if (pts.length < 2) continue;
        water.push({ t: t.waterway, kind: "line", pts, k: e.id });
      }
      continue;
    }
    if (isWaterArea) {
      let rings: LatLon[][] = [];
      if (e.type === "way") {
        const g = fullGeom(e.geometry);
        if (g && g.length >= 4 && sameLL(g[0], g[g.length - 1])) rings = [g];
        else { st.waterAreaOpenRings++; continue; }
      } else if (e.type === "relation") {
        const r = outerRingsOf(e);
        rings = r.rings;
        st.waterAreaOpenRings += r.open;
      }
      if (rings.length === 0) continue;
      st.waterAreaFeatures++;
      const kind = t.water ?? (t.waterway && WATERWAY_AREAS.includes(t.waterway) ? t.waterway : undefined) ?? (t.landuse && LANDUSE_WATER.includes(t.landuse) ? t.landuse : undefined) ?? "water";
      const key = e.type === "relation" ? -e.id : e.id;
      for (const r of rings) {
        const clipped = clipRing(ccw(r.slice(0, -1).map((p) => toLocal(frame, p))), H);
        if (clipped.length < 3) continue;
        const pts = roundPts(clipped, true);
        if (pts.length < 3 || Math.abs(signedArea(pts)) < 1) continue;
        water.push({ t: kind, kind: "area", pts, k: key });
      }
    }
  }

  // ---- cap
  if (buildings.length > MAX_BUILDINGS) {
    buildings.sort((a, b) => b.area - a.area || a.id - b.id);
    const dropped = buildings.splice(MAX_BUILDINGS);
    st.droppedCount = dropped.length;
    st.droppedMaxAreaM2 = Math.round(dropped[0].area * 10) / 10;
  }
  buildings.sort((a, b) => a.id - b.id);
  for (const b of buildings) {
    if (b.hs === "height") st.taggedHeightCount++;
    else if (b.hs === "levels") st.levelsCount++;
    else st.estimatedCount++;
  }
  st.buildingsKept = buildings.length;
  const hs = buildings.map((b) => b.h).sort((a, b) => a - b);
  if (hs.length) {
    st.heightMinM = hs[0];
    st.heightMaxM = hs[hs.length - 1];
    st.heightMedianM = hs[Math.floor(hs.length / 2)];
  }

  roads.sort((a, b) => a.k - b.k);
  water.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "area" ? -1 : 1) || a.k - b.k);
  for (const r of roads) {
    st.roadsByClass[r.t] = (st.roadsByClass[r.t] ?? 0) + 1;
    for (let i = 1; i < r.pts.length; i++) st.roadLengthM += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]);
  }
  st.roadLengthM = Math.round(st.roadLengthM);
  st.roadPieces = roads.length;
  st.waterLinePieces = water.filter((w) => w.kind === "line").length;
  st.waterAreaPieces = water.filter((w) => w.kind === "area").length;
  st.roadsByClass = Object.fromEntries(Object.entries(st.roadsByClass).sort(([a], [b]) => (a < b ? -1 : 1)));

  const win: BuildingWindow = {
    areaId,
    origin: anchor,
    halfSizeM: HALF_SIZE_M,
    retrievedAt,
    sourceId: SOURCE_ID,
    buildings: buildings.map(({ id, h, hs, fp }) => ({ id, h, hs, fp })),
    roads: roads.map(({ t, pts }) => ({ t, pts })),
    water: water.map(({ t, kind, pts }) => ({ t, kind, pts })),
  };
  return { win, stats: st };
}

/** Structural check of a written window against the BuildingWindow contract. */
function validateWindow(w: BuildingWindow): string[] {
  const errs: string[] = [];
  const keys = Object.keys(w).sort().join(",");
  if (keys !== "areaId,buildings,halfSizeM,origin,retrievedAt,roads,sourceId,water") errs.push(`unexpected keys ${keys}`);
  if (!Array.isArray(w.origin) || w.origin.length !== 2 || !w.origin.every(Number.isFinite)) errs.push("bad origin");
  const ids = new Set<number>();
  for (const b of w.buildings) {
    if (!Number.isInteger(b.id) || ids.has(b.id)) errs.push(`bad/duplicate building id ${b.id}`);
    ids.add(b.id);
    if (!(b.h >= 0.1 && b.h <= MAX_PLAUSIBLE_HEIGHT_M)) errs.push(`bad h ${b.id}`);
    if (!["height", "levels", "estimated"].includes(b.hs)) errs.push(`bad hs ${b.id}`);
    if (b.fp.length < 3) errs.push(`short fp ${b.id}`);
    const f = b.fp[0], l = b.fp[b.fp.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) errs.push(`closed fp ${b.id}`);
  }
  for (const r of w.roads) if (r.pts.length < 2 || r.pts.some((p) => Math.abs(p[0]) > HALF_SIZE_M + 0.05 || Math.abs(p[1]) > HALF_SIZE_M + 0.05)) errs.push(`road outside window`);
  for (const x of w.water) if (x.pts.length < (x.kind === "area" ? 3 : 2) || x.pts.some((p) => Math.abs(p[0]) > HALF_SIZE_M + 0.05 || Math.abs(p[1]) > HALF_SIZE_M + 0.05)) errs.push(`water outside window`);
  return errs.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface AreaResult {
  areaId: string;
  code: string;
  nameTh: string;
  nameEn: string;
  anchor: [number, number];
  anchorSource: string;
  anchorNote: string;
  townhallName: string | null;
  rawOrigin: "live" | "cache" | "missing";
  rawFile: string | null;
  rawRetrievedAt: string | null;
  rawEndpoint: string | null;
  osmBaseTimestamp: string | null;
  rawBytes: number | null;
  rawSha256: string | null;
  liveError: string | null;
  liveAttempts: Attempt[];
  output: string | null;
  outputBytes: number | null;
  stats: WindowStats | null;
  validationErrors: string[];
}

async function main() {
  const { city, cfg, force, offline, only } = parseArgs();
  console.log(`fetch-buildings: city=${city} areas=${cfg.areasFile} force=${force} offline=${offline}${only ? ` only=${[...only].join(",")}` : ""}`);

  let areas: Area[];
  try {
    areas = loadAreas(cfg);
  } catch (e) {
    console.error(`FATAL: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`  ${areas.length} area polygons loaded`);
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- 1. townhall candidates (one query per city)
  const thKey = `_townhalls-${city}`;
  const thQuery = townhallQuery(areas);
  let thCache = readCache(thKey);
  let townhallError: string | null = null;
  let townhallOrigin: "live" | "cache" | "missing" = thCache ? "cache" : "missing";
  if (!offline && (force || !thCache)) {
    console.log(`- townhall query …`);
    const r = await fetchOverpass(thKey, thQuery);
    if ("text" in r) {
      writeCache(thKey, r.text, r.meta);
      thCache = { data: JSON.parse(r.text), meta: r.meta };
      townhallOrigin = "live";
      console.log(`  ok: ${r.meta.elementCount} townhall elements from ${r.meta.endpoint}`);
    } else {
      townhallError = r.error + ": " + r.attempts.map((a) => `${a.endpoint} ${a.httpStatus ?? ""} ${a.error ?? ""}`.trim()).join(" | ");
      console.warn(`  townhall query failed (${r.error}); ${thCache ? "using cache" : "anchors fall back to point-on-surface"}`);
    }
  }
  const cands = townhallCandidates(thCache?.data ?? null);
  console.log(`  ${cands.length} townhall candidates with "${TOWNHALL_PREFIX}" in a name tag`);

  // ---- 2..5 per area
  const results: AreaResult[] = [];
  for (const area of areas) {
    const outFile = path.join(OUT_DIR, `${area.areaId}.json`);
    if (only && !only.has(area.areaId)) {
      continue;
    }
    let choice = chooseAnchor(area, cands);
    const cache = readCache(area.areaId);
    // A cache is reused only when it was produced by exactly the current query (same anchor, window and filters).
    const cacheMatches = !!cache && cache.meta.halfSizeM === HALF_SIZE_M && !!cache.meta.anchor &&
      cache.meta.anchor[0] === choice.anchor[0] && cache.meta.anchor[1] === choice.anchor[1] &&
      cache.meta.query === windowQuery(choice.anchor);
    let data: OsmResponse | null = null;
    let meta: RawMeta | null = null;
    let origin: AreaResult["rawOrigin"] = "missing";
    let liveError: string | null = null;
    let liveAttempts: Attempt[] = [];

    if (cache && (cacheMatches || offline) && !(force && !offline)) {
      data = cache.data;
      meta = cache.meta;
      origin = "cache";
      if (!cacheMatches) {
        console.warn(`  [${area.areaId}] offline: cached window anchor ${JSON.stringify(cache.meta.anchor)} differs from computed ${JSON.stringify(choice.anchor)}; using cached anchor`);
      }
    } else if (!offline) {
      const query = windowQuery(choice.anchor);
      console.log(`- ${area.areaId} ${area.nameEn} (${choice.anchorSource}) querying Overpass …`);
      const r = await fetchOverpass(area.areaId, query);
      if ("text" in r) {
        r.meta.anchor = choice.anchor;
        r.meta.anchorSource = choice.anchorSource;
        r.meta.halfSizeM = HALF_SIZE_M;
        writeCache(area.areaId, r.text, r.meta);
        data = JSON.parse(r.text);
        meta = r.meta;
        origin = "live";
        liveAttempts = r.meta.attempts;
        console.log(`  ok: ${r.meta.elementCount} elements, ${(r.meta.bytes / 1e6).toFixed(2)} MB from ${r.meta.endpoint}`);
      } else {
        liveError = r.error;
        liveAttempts = r.attempts;
        console.warn(`  [${area.areaId}] live fetch failed (${r.error}); ${cache ? "falling back to cached raw file" : "no cache — no window written"}`);
        if (cache) {
          data = cache.data;
          meta = cache.meta;
          origin = "cache";
        }
      }
    }
    // A cached window built around a different anchor stays consistent with its own anchor.
    if (meta?.anchor && (meta.anchor[0] !== choice.anchor[0] || meta.anchor[1] !== choice.anchor[1])) {
      choice = { anchor: meta.anchor, anchorSource: meta.anchorSource ?? "cached", townhallName: null, note: `anchor taken from cached raw window (current choice would be ${choice.anchorSource})` };
    }

    const res: AreaResult = {
      areaId: area.areaId, code: area.code, nameTh: area.nameTh, nameEn: area.nameEn,
      anchor: choice.anchor, anchorSource: choice.anchorSource, anchorNote: choice.note, townhallName: choice.townhallName,
      rawOrigin: origin, rawFile: meta ? rel(rawPaths(area.areaId).data) : null, rawRetrievedAt: meta?.retrievedAt ?? null,
      rawEndpoint: meta?.endpoint ?? null, osmBaseTimestamp: meta?.osmBaseTimestamp ?? null, rawBytes: meta?.bytes ?? null,
      rawSha256: meta?.sha256 ?? null, liveError, liveAttempts, output: null, outputBytes: null, stats: null, validationErrors: [],
    };
    if (data && meta) {
      const { win, stats } = processWindow(area.areaId, choice.anchor, data, meta.retrievedAt);
      const text = JSON.stringify(win);
      writeIfChanged(outFile, text);
      res.output = rel(outFile);
      res.outputBytes = Buffer.byteLength(text, "utf8");
      res.stats = stats;
      res.validationErrors = validateWindow(JSON.parse(text));
      console.log(`  ${area.areaId}: ${stats.buildingsKept} buildings (height ${stats.taggedHeightCount}, levels ${stats.levelsCount}, est ${stats.estimatedCount}, dropped ${stats.droppedCount}), ${stats.roadPieces} road pieces, ${stats.waterAreaPieces}+${stats.waterLinePieces} water, ${(res.outputBytes / 1e6).toFixed(2)} MB${res.validationErrors.length ? " VALIDATION: " + res.validationErrors.join("; ") : ""}`);
    }
    results.push(res);
  }

  if (only) {
    console.log("--only given: per-area outputs written; city-level staged files not rewritten (run without --only to refresh them).");
    return;
  }

  // ---- 6. staged outputs
  const anchors = results.map((r) => ({
    areaId: r.areaId,
    anchor: r.anchor,
    anchorSource: r.anchorSource,
    buildingCount: r.stats ? r.stats.buildingsKept : null,
    taggedHeightCount: r.stats ? r.stats.taggedHeightCount : null,
    levelsCount: r.stats ? r.stats.levelsCount : null,
    estimatedCount: r.stats ? r.stats.estimatedCount : null,
    droppedCount: r.stats ? r.stats.droppedCount : null,
  }));
  const anchorsFile = path.join(STAGED_DIR, `${city}-anchors.json`);
  writeIfChanged(anchorsFile, JSON.stringify(anchors, null, 1) + "\n");

  const retrievedTimes = results.map((r) => r.rawRetrievedAt).filter((x): x is string => !!x).sort();
  const osmBase = [...new Set(results.map((r) => r.osmBaseTimestamp).filter((x): x is string => !!x))].sort();
  const sourceRef = {
    id: SOURCE_ID,
    nameTh: "OpenStreetMap (ผ่าน Overpass API) — อาคาร ถนน และแหล่งน้ำ",
    nameEn: "OpenStreetMap via Overpass API — buildings, roads and water",
    url: "https://www.openstreetmap.org/copyright",
    publisher: "OpenStreetMap contributors (queried through public Overpass API instances)",
    license: "ODbL-1.0 (https://opendatacommons.org/licenses/odbl/1-0/) — attribution “© OpenStreetMap contributors”",
    retrievedAt: retrievedTimes[retrievedTimes.length - 1] ?? undefined,
    accessStatus: results.every((r) => r.stats) ? "retrieved" : results.some((r) => r.stats) ? "partial" : "failed",
    notes: `Building footprints/heights, roads (motorway..residential) and water within ±${HALF_SIZE_M} m windows around one anchor per area (${city}). Raw responses retrieved ${retrievedTimes[0] ?? "n/a"} .. ${retrievedTimes[retrievedTimes.length - 1] ?? "n/a"}; OSM base timestamps ${osmBase[0] ?? "n/a"} .. ${osmBase[osmBase.length - 1] ?? "n/a"}. Heights: tagged height, building:levels × ${LEVEL_HEIGHT_M} m, or a deterministic estimate (not observed).`,
  };
  writeIfChanged(path.join(STAGED_DIR, `${city}-buildings-sources.json`), JSON.stringify([sourceRef], null, 2) + "\n");

  const totals = {
    areas: results.length,
    windowsWritten: results.filter((r) => r.stats).length,
    windowsMissing: results.filter((r) => !r.stats).map((r) => r.areaId),
    townhallAnchors: results.filter((r) => r.anchorSource.startsWith("osm-townhall:")).length,
    pointOnSurfaceAnchors: results.filter((r) => r.anchorSource === "point-on-surface").length,
    buildings: results.reduce((s, r) => s + (r.stats?.buildingsKept ?? 0), 0),
    taggedHeight: results.reduce((s, r) => s + (r.stats?.taggedHeightCount ?? 0), 0),
    levels: results.reduce((s, r) => s + (r.stats?.levelsCount ?? 0), 0),
    estimated: results.reduce((s, r) => s + (r.stats?.estimatedCount ?? 0), 0),
    dropped: results.reduce((s, r) => s + (r.stats?.droppedCount ?? 0), 0),
    roadPieces: results.reduce((s, r) => s + (r.stats?.roadPieces ?? 0), 0),
    waterAreaPieces: results.reduce((s, r) => s + (r.stats?.waterAreaPieces ?? 0), 0),
    waterLinePieces: results.reduce((s, r) => s + (r.stats?.waterLinePieces ?? 0), 0),
    outputBytes: results.reduce((s, r) => s + (r.outputBytes ?? 0), 0),
    validationErrors: results.reduce((s, r) => s + r.validationErrors.length, 0),
  };
  const report = {
    city,
    areasFile: cfg.areasFile,
    method: {
      halfSizeM: HALF_SIZE_M,
      maxBuildings: MAX_BUILDINGS,
      levelHeightM: LEVEL_HEIGHT_M,
      enu: `x = (lon - lon0) * cos(lat0) * ${M_PER_DEG_LON_EQ}; y = (lat - lat0) * ${M_PER_DEG_LAT}; rounded to 0.1 m`,
      estimatedHeight: "h = clamp(4 + 2.2*sqrt(areaM2)/6 + (fnv1a32(String(osmId)) % 7), 4, 24), rounded to 0.1 m; areaM2 from the unrounded local footprint (shoelace)",
      highwayClasses: HIGHWAY_CLASSES,
      waterwayLines: WATERWAY_LINES,
      waterAreas: "natural=water, waterway=riverbank|dock, landuse=reservoir|basin, or any water=* (not wetland/highway/building); outer rings only",
      buildingIds: "OSM way id; building multipolygon relations use the negative relation id and their largest outer ring",
    },
    townhalls: {
      key: thKey,
      origin: townhallOrigin,
      retrievedAt: thCache?.meta.retrievedAt ?? null,
      endpoint: thCache?.meta.endpoint ?? null,
      osmBaseTimestamp: thCache?.meta.osmBaseTimestamp ?? null,
      elements: thCache?.meta.elementCount ?? null,
      candidatesWithPrefix: cands.length,
      error: townhallError,
    },
    totals,
    areas: results,
  };
  writeIfChanged(path.join(STAGED_DIR, `${city}-buildings-report.json`), JSON.stringify(report, null, 1) + "\n");

  // manifest of raw files
  const manifest: Record<string, unknown> = {};
  const keys = [thKey, ...results.map((r) => r.areaId)];
  for (const k of keys) {
    const p = rawPaths(k);
    if (!fs.existsSync(p.meta)) continue;
    const m = JSON.parse(fs.readFileSync(p.meta, "utf8")) as RawMeta;
    manifest[`overpass-buildings/${k}.json`] = {
      url: m.endpoint,
      method: "POST data=<Overpass QL in sidecar .meta.json>",
      retrievedAt: m.retrievedAt,
      httpStatus: m.httpStatus,
      bytes: m.bytes,
      sha256: m.sha256,
      contentType: "application/json",
      osmBaseTimestamp: m.osmBaseTimestamp,
      elementCount: m.elementCount,
    };
  }
  writeIfChanged(path.join(MANIFEST_DIR, `fetch-buildings-${city}.json`), JSON.stringify(manifest, null, 2) + "\n");

  writeIfChanged(path.join(STAGED_DIR, `${city}-buildings-notes.md`), renderNotes(city, cfg, report as unknown as Report));
  console.log(`done: ${totals.windowsWritten}/${totals.areas} windows, ${totals.buildings} buildings (${totals.taggedHeight} height, ${totals.levels} levels, ${totals.estimated} estimated, ${totals.dropped} dropped), ${(totals.outputBytes / 1e6).toFixed(1)} MB; validation errors ${totals.validationErrors}`);
  if (totals.windowsMissing.length) {
    console.warn(`missing windows: ${totals.windowsMissing.join(", ")}`);
    process.exitCode = 3;
  }
}

// ---------------------------------------------------------------------------
// Notes (generated, deterministic)
// ---------------------------------------------------------------------------

interface Report {
  city: string;
  areasFile: string;
  townhalls: { key: string; origin: string; retrievedAt: string | null; endpoint: string | null; osmBaseTimestamp: string | null; elements: number | null; candidatesWithPrefix: number; error: string | null };
  totals: Record<string, unknown> & { areas: number; windowsWritten: number; windowsMissing: string[]; townhallAnchors: number; pointOnSurfaceAnchors: number; buildings: number; taggedHeight: number; levels: number; estimated: number; dropped: number; outputBytes: number; validationErrors: number };
  areas: AreaResult[];
}

function renderNotes(city: string, cfg: CityCfg, rep: Report): string {
  const t = rep.totals;
  const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + "%" : "n/a");
  const times = rep.areas.map((a) => a.rawRetrievedAt).filter((x): x is string => !!x).sort();
  const bases = [...new Set(rep.areas.map((a) => a.osmBaseTimestamp).filter((x): x is string => !!x))].sort();
  const L: string[] = [];
  L.push(`# OSM building windows — ${city}`);
  L.push("");
  L.push(`Generated by \`npx tsx scripts/data/fetch-buildings.ts ${city}\` (deterministic from the cached raw Overpass responses). Do not edit by hand.`);
  L.push("");
  L.push("## Source");
  L.push("");
  L.push("- **Data**: OpenStreetMap, © OpenStreetMap contributors, licensed **ODbL-1.0** (https://www.openstreetmap.org/copyright). Attribution must be shown wherever the 3D view renders these features.");
  L.push(`- **Access**: public Overpass API instances (${ENDPOINTS.join(", ")}), POST, User-Agent \`${USER_AGENT}\`, sequential, ≥ ${MIN_GAP_MS / 1000} s between requests, exponential backoff ${BACKOFF_START_MS / 1000}–${BACKOFF_MAX_MS / 1000} s, ≤ ${MAX_ATTEMPTS} attempts per query, endpoint rotation.`);
  L.push(`- **Retrieved**: ${times[0] ?? "n/a"} → ${times[times.length - 1] ?? "n/a"} (UTC). OSM database snapshot (\`timestamp_osm_base\`): ${bases.length ? bases.join(", ") : "n/a"}.`);
  L.push(`- **Reference period**: OSM is a continuously edited crowd-sourced database; geometry reflects the snapshot above, not a survey date. Building tags (height, levels) were added by contributors at unknown dates.`);
  L.push(`- **Area polygons**: \`${cfg.areasFile}\` (areaId = \`${cfg.idPrefix}\` + \`${cfg.idProp}\`).`);
  L.push("");
  L.push("## Outputs");
  L.push("");
  L.push(`- \`public/data/buildings/<areaId>.json\` — one \`BuildingWindow\` (src/lib/types.ts) per area, minified: ${t.windowsWritten}/${t.areas} written, ${(t.outputBytes / 1e6).toFixed(1)} MB in total.`);
  L.push(`- \`data/staged/${city}-anchors.json\` — \`[{ areaId, anchor:[lon,lat], anchorSource, buildingCount, taggedHeightCount, levelsCount, estimatedCount, droppedCount }]\`.`);
  L.push(`- \`data/staged/${city}-buildings-report.json\` — per-area diagnostics (anchor reasoning, raw file, endpoint, sha256, counts, road/water stats, attempt log of live fetches).`);
  L.push(`- \`data/staged/${city}-buildings-sources.json\` — \`SourceRef[]\` for sourceId \`${SOURCE_ID}\`.`);
  L.push(`- \`data/raw/overpass-buildings/<areaId>.json\` (+ \`.meta.json\` with the exact Overpass QL, endpoint, HTTP status, retrievedAt, sha256, attempts) and \`data/raw/overpass-buildings/_townhalls-${city}.json\`; manifest \`data/raw/_manifests/fetch-buildings-${city}.json\`.`);
  L.push("");
  L.push("## Method");
  L.push("");
  L.push(`1. **Anchor**: the OSM \`amenity=townhall\` whose \`name\`/\`name:th\`/\`official_name\`/\`alt_name\` contains \`${TOWNHALL_PREFIX}<nameTh>\` (whitespace-insensitive) and whose position lies inside the area polygon (node position, or Overpass \`out center\` = bounding-box centre for ways/relations). Ranking: exact name > prefix > contains; way > node > relation; lowest id. Otherwise \`turf.pointOnFeature\` (6 decimals) → \`point-on-surface\`.`);
  L.push(`2. **Window**: square of half-size ${HALF_SIZE_M} m around the anchor (lat ± ${HALF_SIZE_M}/${M_PER_DEG_LAT}°, lon ± ${HALF_SIZE_M}/(${M_PER_DEG_LON_EQ}·cos lat0)°). One Overpass query per area: \`way["building"]\`, \`relation["type"="multipolygon"]["building"]\`, \`way["highway"~"^(${HIGHWAY_CLASSES.join("|")})$"]\`, \`way["waterway"]\`, natural=water / water=* / waterway=riverbank|dock / landuse=reservoir|basin ways and multipolygon relations; \`out tags geom\` (full member geometry).`);
  L.push(`3. **Local ENU metres**: x = (lon − lon0)·cos(lat0)·${M_PER_DEG_LON_EQ}, y = (lat − lat0)·${M_PER_DEG_LAT}, rounded to 0.1 m; closing vertex dropped; consecutive duplicates removed; footprint and water rings normalised to counter-clockwise. Equirectangular approximation: error < 0.1 m within ±${HALF_SIZE_M} m at these latitudes.`);
  L.push(`4. **Buildings**: \`building=no|none\` skipped; ways must be closed; multipolygon relations keep only their largest assembled outer ring (inner courtyards ignored), id = −relationId. Kept when the polygon area centroid is inside the window (footprints may extend beyond it). At most ${MAX_BUILDINGS} per window — smallest footprints dropped first.`);
  L.push(`5. **Heights** (rounded to 0.1 m): numeric \`height\` (units m/ม./เมตร stripped, ft/' × 0.3048; accepted 0 < h ≤ ${MAX_PLAUSIBLE_HEIGHT_M} m) → \`hs:"height"\`; else first number of \`building:levels\` (0 < n ≤ ${MAX_PLAUSIBLE_LEVELS}) × ${LEVEL_HEIGHT_M} m → \`hs:"levels"\`; else deterministic **estimate** h = clamp(4 + 2.2·√A/6 + (FNV-1a-32(String(osmId)) mod 7), 4, 24) with A = footprint area m² → \`hs:"estimated"\`. Estimated heights are illustrative only and must not be presented as observed.`);
  L.push(`6. **Roads / water**: polylines clipped segment-wise (Liang–Barsky) to the window, polygons clipped with Sutherland–Hodgman (may leave zero-width slivers along the window edge for concave shapes). \`t\` = highway class / waterway value / water kind (\`water\` tag, else riverbank|dock|reservoir|basin, else "water"). Water-area inner rings (islands) are ignored.`);
  L.push("");
  L.push("## Results");
  L.push("");
  L.push(`- Anchors: ${t.townhallAnchors} district-office townhalls, ${t.pointOnSurfaceAnchors} point-on-surface. Townhall query: ${rep.townhalls.origin}, ${rep.townhalls.elements ?? "n/a"} amenity=townhall elements in the city bbox, ${rep.townhalls.candidatesWithPrefix} with “${TOWNHALL_PREFIX}” in a name; retrieved ${rep.townhalls.retrievedAt ?? "n/a"} from ${rep.townhalls.endpoint ?? "n/a"}${rep.townhalls.error ? `; live error: ${rep.townhalls.error}` : ""}.`);
  L.push(`- Buildings: ${t.buildings} total — tagged height ${t.taggedHeight} (${pct(t.taggedHeight, t.buildings)}), levels ${t.levels} (${pct(t.levels, t.buildings)}), estimated ${t.estimated} (${pct(t.estimated, t.buildings)}); dropped by the ${MAX_BUILDINGS} cap: ${t.dropped}.`);
  L.push(`- Windows missing: ${t.windowsMissing.length ? t.windowsMissing.join(", ") : "none"}. Contract validation errors: ${t.validationErrors}.`);
  L.push("");
  L.push("| areaId | name | anchor [lon, lat] | anchorSource | buildings | height | levels | est. | dropped | roads | water a/l | raw | retrievedAt |");
  L.push("|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|");
  for (const a of rep.areas) {
    const s = a.stats;
    L.push(`| ${a.areaId} | ${a.nameTh} / ${a.nameEn} | ${a.anchor[0]}, ${a.anchor[1]} | ${a.anchorSource} | ${s?.buildingsKept ?? "—"} | ${s?.taggedHeightCount ?? "—"} | ${s?.levelsCount ?? "—"} | ${s?.estimatedCount ?? "—"} | ${s?.droppedCount ?? "—"} | ${s?.roadPieces ?? "—"} | ${s ? `${s.waterAreaPieces}/${s.waterLinePieces}` : "—"} | ${a.rawOrigin} | ${a.rawRetrievedAt ?? "—"} |`);
  }
  L.push("");
  const fallbacks = rep.areas.filter((a) => a.anchorSource === "point-on-surface");
  if (fallbacks.length) {
    L.push("### Point-on-surface anchors (why)");
    L.push("");
    for (const a of fallbacks) L.push(`- ${a.areaId} ${a.nameTh} / ${a.nameEn}: ${a.anchorNote}`);
    L.push("");
  }
  const failed = rep.areas.filter((a) => a.liveError);
  if (failed.length) {
    L.push("### Live fetch failures");
    L.push("");
    for (const a of failed) L.push(`- ${a.areaId}: ${a.liveError} — ${a.liveAttempts.map((x) => `${x.endpoint} → ${x.httpStatus ?? "no response"}${x.error ? ` (${x.error})` : ""}`).join("; ")}${a.rawOrigin === "cache" ? " — fell back to cache" : ""}`);
    L.push("");
  }
  L.push("## Caveats");
  L.push("");
  L.push("- OSM building coverage in Thai cities is uneven: some blocks are fully traced (often from imagery imports), others are partly or entirely missing. Building counts are **not** a census and must not be used as a density statistic.");
  L.push("- Only a small share of buildings carry `height` or `building:levels`; the majority of heights are deterministic placeholders (`hs:\"estimated\"`) and are clamped to 4–24 m, so towers without tags are rendered far too low. The UI should label estimated heights.");
  L.push("- `building:levels` × 3.2 m ignores roof levels, podium/tower splits and `min_height`; `building:part` objects are not used.");
  L.push("- The window is a fixed 900 m × 900 m square in local metres around one anchor; it covers only a small part of each district and is not representative of the whole district.");
  L.push("- Roads exclude `service`, `living_street`, tracks, paths and footways; Bangkok sois tagged as `service` therefore do not appear.");
  L.push("- Overpass `out center` for a townhall way/relation is the bounding-box centre, which can sit a few tens of metres from the building itself.");
  L.push("- Water covers OSM waterways and water polygons only; the sea (OSM `natural=coastline`) is not included, and water polygons lose their islands (inner rings).");
  L.push("- `retrievedAt` is when the raw Overpass response was downloaded; the OSM data itself is as of the `timestamp_osm_base` recorded per area in the report. Windows fetched at different times can reflect slightly different OSM snapshots.");
  L.push("");
  return L.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
