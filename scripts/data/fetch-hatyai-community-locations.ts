/**
 * Hat Yai community locations (เทศบาลนครหาดใหญ่, 103 official communities).
 *
 *   npx tsx scripts/data/fetch-hatyai-community-locations.ts             # fetch (cache-first) + build
 *   npx tsx scripts/data/fetch-hatyai-community-locations.ts --offline   # use cached raw files only
 *   npx tsx scripts/data/fetch-hatyai-community-locations.ts --refresh   # re-download everything
 *
 * 1. VERIFY: look for OpenStreetMap features whose own name matches an official community name
 *    (Overpass: every named feature in the municipality bbox; Nominatim: one bounded search per community).
 *    A match is accepted only if (a) the name rule passes (see NAME RULES), (b) the point lies inside the
 *    OSM municipality polygon AND inside — or within 150 m of — the community's assigned zone polygon,
 *    (c) the feature is compact enough to stand for a place (ways/relations: bbox diagonal <= 800 m), and
 *    (d) the match is unambiguous (all accepted candidates for a community lie within 300 m of each other,
 *    and the feature does not match an equally specific name of another community).
 * 2. ILLUSTRATIVE: every other community gets a deterministic demonstration placement inside its own
 *    (approximate) zone polygon: discrete centroidal-Voronoi relaxation of a 25 m hexagonal candidate lattice
 *    (>= 60 m from the zone edge), >= 120 m from every other point (verified points are fixed obstacles),
 *    with a small jitter seeded by SHA-256 of the community name, and a hash-ordered (non-geographic)
 *    assignment of communities to positions. These are NOT real locations.
 * 3. Writes public/data/hatyai/communities.geojson (Point features, CommunityProps + match/placement
 *    details, FeatureCollection-level `metadata`), plus staged report / sources / notes.
 *
 * Inputs (read-only): data/staged/hatyai-communities.json, public/data/hatyai/zones.geojson,
 * public/data/hatyai/municipality.geojson.
 * Raw cache: data/raw/hatyai-community-locations/ (untrusted data, never executed).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FeatureCollection, Geometry, Position } from "geojson";

// ---------------------------------------------------------------------------
// Paths, flags, constants
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..");
const RAW_DIR = path.join(ROOT, "data", "raw", "hatyai-community-locations");
const MANIFEST = path.join(ROOT, "data", "raw", "_manifests", "fetch-hatyai-community-locations.json");
const STAGED = path.join(ROOT, "data", "staged");
const PUBLIC_HY = path.join(ROOT, "public", "data", "hatyai");

const ARGS = new Set(process.argv.slice(2));
const OFFLINE = ARGS.has("--offline");
const REFRESH = ARGS.has("--refresh");

const UA = "UrbanIntelligenceDemo/0.1 (research prototype)";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const HOST_MIN_INTERVAL_MS = 1_100; // <= 1 request/s per host (Nominatim usage policy)
const OVERPASS_PAUSE_MS = 2_500;

/** acceptance thresholds */
const ZONE_TOLERANCE_M = 150;
const MAX_FEATURE_EXTENT_M = 800;
const AMBIGUITY_RADIUS_M = 300;
/** illustrative placement parameters */
const LATTICE_STEP_M = 25;
const EDGE_MIN_M = 60;
const SPACING_MIN_M = 120;
const LLOYD_ITERATIONS = 12;
const JITTER_FRACTION = 0.12;
const JITTER_TRIES = 8;

const SRC = {
  overpass: "osm-overpass-hatyai-named-features",
  nominatim: "osm-nominatim-hatyai-community-search",
  verified: "osm-hatyai-community-location-match",
  illustrative: "hatyai-community-illustrative-placement",
  list: "hatyaicity-community-list",
  notices: "hatyaicity-boundary-notices",
  zones: "hatyai-zones-approx",
  muni: "osm-hatyai-municipality",
} as const;

const RUN_STARTED = new Date().toISOString();
const log = (...a: unknown[]) => console.log("[hy-communities]", ...a);
const warn = (...a: unknown[]) => console.warn("[hy-communities][warn]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}
function writeJson(file: string, obj: unknown) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function readJson<T = unknown>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
const rel = (p: string) => path.relative(ROOT, p);
const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Fetch layer: cache-first, per-host politeness, retries, manifest
// ---------------------------------------------------------------------------

interface FetchRec {
  key: string;
  url: string;
  file: string;
  status: "fetched" | "cached" | "failed";
  httpStatus?: number;
  bytes?: number;
  sha256?: string;
  retrievedAt?: string;
  attemptedAt?: string;
  error?: string;
}
const manifestPrev: Record<string, FetchRec> = fs.existsSync(MANIFEST) ? (readJson<{ files?: Record<string, FetchRec> }>(MANIFEST).files ?? {}) : {};
const fetchLog: Record<string, FetchRec> = {};
const lastHit = new Map<string, number>();

async function politeWait(host: string, minMs: number) {
  const wait = (lastHit.get(host) ?? 0) + minMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

/** Returns parsed JSON (cached file if present unless --refresh), or null when unavailable. */
async function getJson(opts: { key: string; urls: string[]; file: string; body?: string; minIntervalMs: number }): Promise<unknown> {
  const { key, urls, file, body, minIntervalMs } = opts;
  const prev = manifestPrev[key];
  const useCache = fs.existsSync(file) && (OFFLINE || !REFRESH);
  if (useCache) {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      // keep the original retrieval metadata (url, HTTP status, retrievedAt, sha256) of the cached file
      fetchLog[key] = { ...(prev ?? { key, url: urls[0] }), key, file: rel(file), status: "cached" };
      return data;
    } catch {
      warn(`cache unreadable for ${key}; refetching`);
    }
  }
  if (OFFLINE) {
    fetchLog[key] = { key, url: urls[0], file: rel(file), status: "failed", error: "offline and no cached file" };
    return null;
  }
  let lastErr = "";
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < 3 * urls.length; attempt++) {
    const url = urls[attempt % urls.length];
    const host = new URL(url).host;
    await politeWait(host, minIntervalMs);
    const attemptedAt = new Date().toISOString();
    try {
      const res = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          "Accept-Language": "th,en",
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: body ? `data=${encodeURIComponent(body)}` : undefined,
        signal: AbortSignal.timeout(200_000),
      });
      lastStatus = res.status;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        warn(`${key}: ${url} -> HTTP ${res.status}`);
        await sleep(2_000 * (attempt + 1) + (urls.length > 1 ? OVERPASS_PAUSE_MS : 0));
        continue;
      }
      const data: unknown = JSON.parse(buf.toString("utf8"));
      const remark = data && typeof data === "object" && "remark" in data ? String((data as { remark: unknown }).remark) : "";
      if (/runtime error|timed out/i.test(remark)) {
        lastErr = `Overpass remark: ${remark}`;
        warn(`${key}: ${lastErr}`);
        await sleep(OVERPASS_PAUSE_MS * (attempt + 1));
        continue;
      }
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, buf);
      fetchLog[key] = { key, url, file: rel(file), status: "fetched", httpStatus: res.status, bytes: buf.length, sha256: sha256(buf), retrievedAt: attemptedAt };
      return data;
    } catch (e) {
      lastErr = (e as Error).message;
      warn(`${key}: ${url} -> ${lastErr}`);
      await sleep(2_000 * (attempt + 1));
    }
  }
  fetchLog[key] = { key, url: urls[0], file: rel(file), status: "failed", httpStatus: lastStatus, error: lastErr, attemptedAt: new Date().toISOString() };
  if (fs.existsSync(file)) {
    warn(`${key}: network failed, falling back to cached file`);
    fetchLog[key].status = "cached";
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Thai name normalisation
// ---------------------------------------------------------------------------

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
/** Abbreviations used in official community names, expanded identically on both sides. */
const ABBREV: [RegExp, string][] = [
  [/ร\s*\.\s*พ\s*\./g, "โรงพยาบาล"],
  [/ร\s*\.\s*ร\s*\./g, "โรงเรียน"],
];
/** keeps single spaces (token boundaries) */
function normSpaced(s: string): string {
  let t = s.normalize("NFC").replace(/[​-‍⁠﻿]/g, "");
  t = t.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
  t = t.replace(/ํา/g, "ำ"); // ํ + า -> ำ
  for (const [re, rep] of ABBREV) t = t.replace(re, rep);
  t = t.replace(/[.\-–—_,()'"“”‘’/]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return t;
}
/** compact key (no spaces) */
const key = (s: string) => normSpaced(s).replace(/ /g, "");
/** tone-mark / diacritic-insensitive key: drops ็ ่ ้ ๊ ๋ ์ ํ ๎ */
const markless = (s: string) => key(s).replace(/[็-๎]/g, "");
const stripChumchon = (k: string) => k.replace(/^ชุมชน/, "");

// ---------------------------------------------------------------------------
// Planar geometry (local equirectangular metres around Hat Yai)
// ---------------------------------------------------------------------------

type XY = [number, number];
type LonLat = [number, number];
const LAT0 = 7.01;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110_574;
const LON0 = 100.47;
const toXY = ([lon, lat]: LonLat): XY => [(lon - LON0) * KX, (lat - LAT0) * KY];
const toLonLat = ([x, y]: XY): LonLat => [x / KX + LON0, y / KY + LAT0];
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

interface PlanarPoly {
  rings: XY[][];
  bbox: [number, number, number, number];
}
function toPlanarPoly(geom: Geometry): PlanarPoly[] {
  const polys: Position[][][] = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  return polys.map((rings) => {
    const r = rings.map((ring) => ring.map((p): XY => toXY([p[0], p[1]])));
    const xs = r[0].map((p) => p[0]);
    const ys = r[0].map((p) => p[1]);
    return { rings: r, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
}
function inRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolys(p: XY, polys: PlanarPoly[]): boolean {
  return polys.some((pl) => inRing(p, pl.rings[0]) && !pl.rings.slice(1).some((h) => inRing(p, h)));
}
function segDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function edgeDist(p: XY, polys: PlanarPoly[]): number {
  let d = Infinity;
  for (const pl of polys) for (const ring of pl.rings) for (let i = 1; i < ring.length; i++) d = Math.min(d, segDist(p, ring[i - 1], ring[i]));
  return d;
}
/** signed: <= 0 inside (negative depth), > 0 = distance outside */
function outsideDist(p: XY, polys: PlanarPoly[]): number {
  return inPolys(p, polys) ? -edgeDist(p, polys) : edgeDist(p, polys);
}
function ringAreaM2(ring: XY[]): number {
  let a = 0;
  for (let i = 1; i < ring.length; i++) a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return Math.abs(a) / 2;
}
const polysArea = (polys: PlanarPoly[]) => polys.reduce((s, pl) => s + ringAreaM2(pl.rings[0]) - pl.rings.slice(1).reduce((h, r) => h + ringAreaM2(r), 0), 0);

/** deterministic PRNG */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

interface Community {
  stagedId: string;
  id: string;
  zoneNo: number;
  zoneId: string;
  seqInZone: number;
  nameTh: string;
  nameEn: string | null;
  boundaryNoticeNameTh: string | null;
  population: number | null;
  households: number | null;
  statsStatus: string;
  statsAnomalies: string[];
  statsSourcePdf: string | null;
  statsSourcePage: number | null;
  key: string;
  bareKey: string;
  marklessKey: string;
  altKeys: string[];
}

/** subset of data/staged/hatyai-communities.json used here */
interface StagedCommunity {
  id: string;
  zoneNo: number;
  zoneId: string;
  seqInZone: number;
  nameTh: string;
  nameEn?: string | null;
  boundaryNoticeNameTh?: string | null;
  stats?: { status?: string; population?: number | null; households?: number | null; anomalies?: string[]; sourcePdf?: string; sourcePage?: number } | null;
}
interface StagedCommunities {
  structure?: { totalCommunities?: number; perZone?: Record<string, number> };
  communities: StagedCommunity[];
}
interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  tags?: Record<string, string>;
}
interface OverpassResponse {
  osm3s?: { timestamp_osm_base?: string };
  elements?: OverpassElement[];
}
interface NominatimResult {
  osm_type?: "node" | "way" | "relation";
  osm_id?: number | string;
  lat: string;
  lon: string;
  name?: string;
  category?: string;
  type?: string;
  boundingbox?: string[];
  namedetails?: Record<string, string> | null;
  extratags?: Record<string, string> | null;
}
interface NameRejection {
  community: string;
  communityId: string;
  osmId: string;
  osmName: string;
  origin: string;
  kind: string;
  reason: string;
}

const stagedCommunities = readJson<StagedCommunities>(path.join(STAGED, "hatyai-communities.json"));
const zonesFC = readJson<FeatureCollection<Geometry, { zoneNo: number }>>(path.join(PUBLIC_HY, "zones.geojson"));
const muniFC = readJson<FeatureCollection<Geometry>>(path.join(PUBLIC_HY, "municipality.geojson"));

const communities: Community[] = stagedCommunities.communities.map((c) => {
  const st = c.stats ?? {};
  const observed = st.status === "observed";
  const names = [c.nameTh, c.boundaryNoticeNameTh].filter(Boolean) as string[];
  return {
    stagedId: c.id,
    id: `hy-c-${c.zoneNo}-${String(c.seqInZone).padStart(2, "0")}`,
    zoneNo: c.zoneNo,
    zoneId: c.zoneId,
    seqInZone: c.seqInZone,
    nameTh: c.nameTh,
    nameEn: c.nameEn ?? null,
    boundaryNoticeNameTh: c.boundaryNoticeNameTh ?? null,
    population: observed && typeof st.population === "number" && Number.isFinite(st.population) ? st.population : null,
    households: observed && typeof st.households === "number" && Number.isFinite(st.households) ? st.households : null,
    statsStatus: observed ? "observed" : "unavailable",
    statsAnomalies: Array.isArray(st.anomalies) ? st.anomalies : [],
    statsSourcePdf: st.sourcePdf ?? null,
    statsSourcePage: st.sourcePage ?? null,
    key: key(c.nameTh),
    bareKey: stripChumchon(key(c.nameTh)),
    marklessKey: markless(c.nameTh),
    altKeys: [...new Set(names.map((n) => key(n)))],
  } satisfies Community;
});

const zonePolys = new Map<number, PlanarPoly[]>();
for (const f of zonesFC.features) zonePolys.set(f.properties.zoneNo, toPlanarPoly(f.geometry));
const muniPolys = toPlanarPoly(muniFC.features[0].geometry);
const muniGeom = muniFC.features[0].geometry;
const muniLonLat: Position[] = muniGeom.type === "Polygon" ? muniGeom.coordinates[0] : muniGeom.type === "MultiPolygon" ? muniGeom.coordinates.flatMap((pl) => pl[0]) : [];
if (!muniLonLat.length) throw new Error("municipality.geojson: expected a (Multi)Polygon");
const MBB = [
  Math.min(...muniLonLat.map((p) => p[0])),
  Math.min(...muniLonLat.map((p) => p[1])),
  Math.max(...muniLonLat.map((p) => p[0])),
  Math.max(...muniLonLat.map((p) => p[1])),
];
const BUF = 0.005;
const QBB = [round(MBB[0] - BUF, 4), round(MBB[1] - BUF, 4), round(MBB[2] + BUF, 4), round(MBB[3] + BUF, 4)];

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

interface Candidate {
  origin: "overpass" | "nominatim";
  osmType: "node" | "way" | "relation";
  osmId: number;
  name: string; // the name variant that matched
  nameTag: string;
  tags: Record<string, string>;
  lon: number;
  lat: number;
  extentM: number | null; // bbox diagonal for ways/relations
}

const NAME_TAGS = ["name", "name:th", "official_name", "alt_name", "old_name", "short_name", "loc_name"];
const PLACE_VALUES = new Set(["neighbourhood", "quarter", "suburb", "hamlet", "village", "isolated_dwelling", "locality", "city_block", "plot"]);

function kindOf(tags: Record<string, string>): { rank: number; kind: string } {
  if (tags.place && PLACE_VALUES.has(tags.place)) return { rank: 1, kind: `place=${tags.place}` };
  if (tags.landuse === "residential") return { rank: 2, kind: "landuse=residential" };
  if (tags.amenity === "community_centre" || tags.office === "community" || tags.office === "government") return { rank: 3, kind: tags.amenity ? `amenity=${tags.amenity}` : `office=${tags.office}` };
  if (tags.highway) return { rank: 5, kind: `highway=${tags.highway}` };
  const k = ["amenity", "healthcare", "building", "shop", "leisure", "tourism", "office", "landuse", "place"].find((t) => tags[t]);
  return { rank: 4, kind: k ? `${k}=${tags[k]}` : "named feature" };
}

function overpassCandidates(data: OverpassResponse | null): Candidate[] {
  const out: Candidate[] = [];
  for (const e of data?.elements ?? []) {
    const tags: Record<string, string> = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let extentM: number | null = null;
    if (e.bounds) extentM = dist(toXY([e.bounds.minlon, e.bounds.minlat]), toXY([e.bounds.maxlon, e.bounds.maxlat]));
    for (const t of NAME_TAGS) {
      if (!tags[t]) continue;
      for (const n of tags[t].split(";").map((s) => s.trim()).filter(Boolean)) {
        if (!/[฀-๿]/.test(n)) continue;
        out.push({ origin: "overpass", osmType: e.type, osmId: e.id, name: n, nameTag: t, tags, lon, lat, extentM });
      }
    }
  }
  return out;
}

function nominatimCandidates(results: NominatimResult[]): Candidate[] {
  const out: Candidate[] = [];
  for (const r of results ?? []) {
    if (!r.osm_type || !r.osm_id) continue;
    const tags: Record<string, string> = { ...(r.extratags ?? {}) };
    if (r.category && r.type && !tags[r.category]) tags[r.category] = r.type;
    const nd: Record<string, string> = r.namedetails ?? {};
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    let extentM: number | null = null;
    if (Array.isArray(r.boundingbox) && r.osm_type !== "node") {
      const [s, n, w, e] = r.boundingbox.map(Number);
      extentM = dist(toXY([w, s]), toXY([e, n]));
    }
    const names: [string, string][] = Object.entries(nd).filter(([t]) => NAME_TAGS.includes(t));
    if (!names.length && r.name) names.push(["name", r.name]);
    for (const [t, v] of names)
      for (const n of String(v).split(";").map((s) => s.trim()).filter(Boolean)) {
        if (!/[฀-๿]/.test(n)) continue;
        out.push({ origin: "nominatim", osmType: r.osm_type, osmId: Number(r.osm_id), name: n, nameTag: t, tags, lon, lat, extentM });
      }
  }
  return out;
}

// ---------------------------------------------------------------------------
// NAME RULES
//  N1 "osm-name-equals-official-community-name"       feature name == official name (with ชุมชน)        -> high
//  N2 "osm-place-name-equals-bare-community-name"      place=* / landuse=residential named exactly the
//                                                      official name without the ชุมชน prefix              -> high
//  N3 "osm-name-contains-official-community-name"      feature name contains the full official name
//                                                      (with ชุมชน) ending at a token boundary              -> medium
//  Each rule is tried mark-sensitive first; a tone/diacritic-insensitive-only match lowers confidence by one
//  level (high->medium, medium->low). Only high/medium are accepted. Everything else is logged and rejected
//  (bare-name-only matches of facilities/temples/roads, names continuing past the official name, ...).
// ---------------------------------------------------------------------------

type Confidence = "high" | "medium" | "low";
interface NameMatch {
  rule: "N1" | "N2" | "N3";
  method: string;
  confidence: Confidence;
  marksExact: boolean;
  matchedLen: number;
}
function containsAtBoundary(hay: string, needle: string): "end" | "token" | "prefix" | null {
  // hay/needle: normSpaced strings; we compare with spaces removed but keep a map back to token boundaries
  const hk = hay.replace(/ /g, "");
  const nk = needle.replace(/ /g, "");
  const i = hk.indexOf(nk);
  if (i < 0) return null;
  const endIdx = i + nk.length;
  if (endIdx === hk.length) return "end";
  // find whether a space follows position endIdx in the spaced string
  let count = 0;
  for (let j = 0; j < hay.length; j++) {
    if (hay[j] === " ") continue;
    count++;
    if (count === endIdx) return hay[j + 1] === " " ? "token" : "prefix";
  }
  return "prefix";
}

function matchName(c: Community, cand: Candidate): NameMatch | { rejected: string } | null {
  const isPlaceLike = kindOf(cand.tags).rank <= 2;
  for (const pass of ["exact", "markless"] as const) {
    const f = pass === "exact" ? key : markless;
    const fk = f(cand.name);
    const names = [c.nameTh, ...(c.boundaryNoticeNameTh ? [c.boundaryNoticeNameTh] : [])];
    for (const official of names) {
      const ok = f(official);
      const bare = stripChumchon(ok);
      if (fk === ok) return { rule: "N1", method: "osm-name-equals-official-community-name", confidence: pass === "exact" ? "high" : "medium", marksExact: pass === "exact", matchedLen: ok.length };
      if (isPlaceLike && fk === bare) return { rule: "N2", method: "osm-place-name-equals-bare-community-name", confidence: pass === "exact" ? "high" : "medium", marksExact: pass === "exact", matchedLen: ok.length };
      const hay = pass === "exact" ? normSpaced(cand.name) : normSpaced(cand.name).replace(/[็-๎]/g, "");
      const needle = pass === "exact" ? normSpaced(official) : normSpaced(official).replace(/[็-๎]/g, "");
      const b = containsAtBoundary(hay, needle);
      if (b === "end" || b === "token") {
        const conf: Confidence = pass === "exact" ? "medium" : "low";
        return { rule: "N3", method: "osm-name-contains-official-community-name", confidence: conf, marksExact: pass === "exact", matchedLen: ok.length };
      }
      if (b === "prefix") return { rejected: `feature name continues past the official name without a word break ("${cand.name}"): may name a different community or place` };
    }
  }
  // bare-name-only evidence (logged, never accepted)
  if (c.bareKey.length >= 4 && markless(cand.name).includes(stripChumchon(c.marklessKey))) {
    return { rejected: `only the bare place name "${stripChumchon(c.key)}" occurs in a ${kindOf(cand.tags).kind} name ("${cand.name}"); a facility, temple, road or village named after the place is not evidence of the community's location` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureDir(RAW_DIR);
  log(`${communities.length} official communities; municipality bbox ${MBB.map((v) => round(v, 4)).join(",")}${OFFLINE ? " [offline]" : ""}`);

  // ---- 1a. Overpass: every named feature in the buffered municipality bbox
  const bboxQ = `${QBB[1]},${QBB[0]},${QBB[3]},${QBB[2]}`;
  const overpassQuery = `[out:json][timeout:180];(${NAME_TAGS.map((t) => `nwr["${t}"](${bboxQ});`).join("")});out tags center bb;`;
  const ov = (await getJson({ key: "overpass-named-features", urls: OVERPASS, file: path.join(RAW_DIR, "overpass-named-features.json"), body: overpassQuery, minIntervalMs: OVERPASS_PAUSE_MS })) as OverpassResponse | null;
  const ovCands = ov ? overpassCandidates(ov) : [];
  log(`overpass: ${ov?.elements?.length ?? "n/a"} named elements, ${ovCands.length} Thai name variants`);

  // ---- 1b. Nominatim: one bounded search per community (official name incl. ชุมชน)
  const viewbox = `${QBB[0]},${QBB[3]},${QBB[2]},${QBB[1]}`;
  const nomCands = new Map<string, Candidate[]>();
  const nomStatus = { queried: 0, ok: 0, failed: 0, results: 0 };
  for (const c of communities) {
    const q = c.nameTh.replace(/\s+/g, " ").trim();
    const url = `${NOMINATIM}?${new URLSearchParams({ q, format: "jsonv2", limit: "10", viewbox, bounded: "1", countrycodes: "th", namedetails: "1", extratags: "1", "accept-language": "th" }).toString()}`;
    const file = path.join(RAW_DIR, "nominatim", `${c.stagedId}.json`);
    nomStatus.queried++;
    const res = await getJson({ key: `nominatim:${c.stagedId}`, urls: [url], file, minIntervalMs: HOST_MIN_INTERVAL_MS });
    if (!Array.isArray(res)) {
      nomStatus.failed++;
      continue;
    }
    nomStatus.ok++;
    nomStatus.results += res.length;
    nomCands.set(c.stagedId, nominatimCandidates(res as NominatimResult[]));
  }
  log(`nominatim: ${nomStatus.ok}/${nomStatus.queried} queries ok, ${nomStatus.results} results`);

  // ---- 2. Match
  interface Evaluated {
    community: Community;
    cand: Candidate;
    match: NameMatch;
    insideMunicipality: boolean;
    zoneDistM: number; // <= 0 inside
    inZoneNo: number | null;
    kind: string;
    rank: number;
    accepted: boolean;
    reason?: string;
  }
  const evaluated: Evaluated[] = [];
  const nameRejections: NameRejection[] = [];
  const seenReject = new Set<string>();
  const allCands = (c: Community) => [...ovCands, ...(nomCands.get(c.stagedId) ?? [])];

  for (const c of communities) {
    for (const cand of allCands(c)) {
      const m = matchName(c, cand);
      if (!m) continue;
      const osmRef = `${cand.osmType}/${cand.osmId}`;
      if ("rejected" in m) {
        const k = `${c.stagedId}|${osmRef}`;
        if (!seenReject.has(k)) {
          seenReject.add(k);
          nameRejections.push({ community: c.nameTh, communityId: c.id, osmId: osmRef, osmName: cand.name, origin: cand.origin, kind: kindOf(cand.tags).kind, reason: m.rejected });
        }
        continue;
      }
      const p = toXY([cand.lon, cand.lat]);
      const insideMunicipality = inPolys(p, muniPolys);
      const zoneDistM = outsideDist(p, zonePolys.get(c.zoneNo)!);
      let inZoneNo: number | null = null;
      for (const [zn, zp] of zonePolys) if (inPolys(p, zp)) inZoneNo = zn;
      const { rank, kind } = kindOf(cand.tags);
      const ev: Evaluated = { community: c, cand, match: m, insideMunicipality, zoneDistM, inZoneNo, kind, rank, accepted: true };
      if (m.confidence === "low") {
        ev.accepted = false;
        ev.reason = "low-confidence name match (tone/diacritic-insensitive containment only)";
      } else if (!insideMunicipality) {
        ev.accepted = false;
        ev.reason = "point outside the municipality boundary";
      } else if (zoneDistM > ZONE_TOLERANCE_M) {
        ev.accepted = false;
        ev.reason = `point ${Math.round(zoneDistM)} m outside the community's assigned zone (เขต ${c.zoneNo}); tolerance ${ZONE_TOLERANCE_M} m`;
      } else if (cand.extentM !== null && cand.extentM > MAX_FEATURE_EXTENT_M) {
        ev.accepted = false;
        ev.reason = `feature too extensive to stand for a location (bbox diagonal ${Math.round(cand.extentM)} m > ${MAX_FEATURE_EXTENT_M} m)`;
      }
      evaluated.push(ev);
    }
  }

  // dedupe (same community + same OSM object): keep the strongest name match
  const confScore = { high: 3, medium: 2, low: 1 } as const;
  const byPair = new Map<string, Evaluated>();
  const foundBy = new Map<string, Set<string>>();
  for (const e of evaluated) {
    const k = `${e.community.stagedId}|${e.cand.osmType}/${e.cand.osmId}`;
    foundBy.set(k, (foundBy.get(k) ?? new Set()).add(e.cand.origin));
    const prev = byPair.get(k);
    const better =
      !prev ||
      (e.accepted && !prev.accepted) ||
      (e.accepted === prev.accepted && confScore[e.match.confidence] > confScore[prev.match.confidence]) ||
      (e.accepted === prev.accepted && e.match.confidence === prev.match.confidence && e.cand.origin === "overpass" && prev.cand.origin !== "overpass");
    if (better) byPair.set(k, e);
  }
  const pairs = [...byPair.values()];
  const foundByOf = (e: Evaluated) => [...(foundBy.get(`${e.community.stagedId}|${e.cand.osmType}/${e.cand.osmId}`) ?? [e.cand.origin])].sort();

  // cross-community conflicts: one OSM object accepted for several communities -> keep the most specific
  const byObj = new Map<string, Evaluated[]>();
  for (const e of pairs.filter((x) => x.accepted)) {
    const k = `${e.cand.osmType}/${e.cand.osmId}`;
    byObj.set(k, [...(byObj.get(k) ?? []), e]);
  }
  for (const [, list] of byObj) {
    if (list.length < 2) continue;
    const maxLen = Math.max(...list.map((e) => e.match.matchedLen));
    const top = list.filter((e) => e.match.matchedLen === maxLen);
    for (const e of list) {
      if (top.length > 1) {
        e.accepted = false;
        e.reason = `ambiguous: the same OSM object matches ${list.length} communities equally (${list.map((x) => x.community.nameTh).join(", ")})`;
      } else if (e.match.matchedLen < maxLen) {
        e.accepted = false;
        e.reason = `the OSM object matches the longer, more specific community name ${top[0].community.nameTh}`;
      }
    }
  }

  // per-community decision
  interface Decision {
    community: Community;
    status: "verified" | "illustrative";
    chosen?: Evaluated;
    candidates: Evaluated[];
    reason: string;
  }
  const decisions: Decision[] = [];
  for (const c of communities) {
    const cands = pairs.filter((e) => e.community.stagedId === c.stagedId);
    const acc = cands.filter((e) => e.accepted);
    if (!acc.length) {
      decisions.push({ community: c, status: "illustrative", candidates: cands, reason: cands.length ? "no candidate passed the name + location rules" : "no OSM feature with a matching name" });
      continue;
    }
    let spread = 0;
    for (const a of acc) for (const b of acc) spread = Math.max(spread, dist(toXY([a.cand.lon, a.cand.lat]), toXY([b.cand.lon, b.cand.lat])));
    if (spread > AMBIGUITY_RADIUS_M) {
      for (const a of acc) {
        a.accepted = false;
        a.reason = `ambiguous: ${acc.length} matching features up to ${Math.round(spread)} m apart (> ${AMBIGUITY_RADIUS_M} m)`;
      }
      decisions.push({ community: c, status: "illustrative", candidates: cands, reason: `ambiguous: ${acc.length} accepted candidates spread over ${Math.round(spread)} m` });
      continue;
    }
    acc.sort((a, b) => confScore[b.match.confidence] - confScore[a.match.confidence] || a.rank - b.rank || (a.cand.osmType + a.cand.osmId).localeCompare(b.cand.osmType + b.cand.osmId));
    decisions.push({ community: c, status: "verified", chosen: acc[0], candidates: cands, reason: acc.length > 1 ? `${acc.length} consistent candidates within ${Math.round(spread)} m; best-ranked chosen` : "single matching feature" });
  }
  const verified = decisions.filter((d) => d.status === "verified");
  log(`verified: ${verified.length}; illustrative: ${decisions.length - verified.length}`);

  // ---- 3. Illustrative placement per zone
  const fixed: { xy: XY; id: string }[] = verified.map((d) => ({ xy: toXY([d.chosen!.cand.lon, d.chosen!.cand.lat]), id: d.community.id }));
  const placements = new Map<string, { lonlat: LonLat; jitterM: number; edgeM: number; nearestM: number; slot: number }>();
  const zoneReports: Record<string, number | boolean>[] = [];

  for (const [zoneNo, polys] of [...zonePolys.entries()].sort((a, b) => a[0] - b[0])) {
    const todo = decisions
      .filter((d) => d.status === "illustrative" && d.community.zoneNo === zoneNo)
      .map((d) => d.community)
      .sort((a, b) => sha256(a.nameTh).localeCompare(sha256(b.nameTh)));
    if (!todo.length) continue;
    // hexagonal lattice of admissible positions
    const bb = polys.reduce((acc, p) => [Math.min(acc[0], p.bbox[0]), Math.min(acc[1], p.bbox[1]), Math.max(acc[2], p.bbox[2]), Math.max(acc[3], p.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    const lattice: { xy: XY; edge: number }[] = [];
    const dy = (LATTICE_STEP_M * Math.sqrt(3)) / 2;
    for (let row = 0, y = bb[1]; y <= bb[3]; row++, y += dy)
      for (let x = bb[0] + (row % 2 ? LATTICE_STEP_M / 2 : 0); x <= bb[2]; x += LATTICE_STEP_M) {
        const p: XY = [x, y];
        if (!inPolys(p, polys) || !inPolys(p, muniPolys)) continue;
        const edge = Math.min(edgeDist(p, polys), edgeDist(p, muniPolys));
        if (edge < EDGE_MIN_M) continue;
        if (fixed.some((f) => dist(f.xy, p) < SPACING_MIN_M)) continue;
        lattice.push({ xy: p, edge });
      }
    const fixedHere = fixed.filter((f) => outsideDist(f.xy, polys) <= ZONE_TOLERANCE_M + 1).map((f) => f.xy);
    const areaM2 = polysArea(polys);
    const nominal = Math.sqrt(areaM2 / (todo.length + fixedHere.length));

    // farthest-point (maximin) initialisation; the boundary counts as half a spacing
    const sites: number[] = [];
    const dSel = lattice.map((l) => Math.min(Infinity, ...fixedHere.map((f) => dist(f, l.xy))));
    for (let k = 0; k < todo.length; k++) {
      let best = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < lattice.length; i++) {
        const s = Math.min(dSel[i], 2 * lattice[i].edge);
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      }
      if (best < 0) throw new Error(`zone ${zoneNo}: no admissible lattice position left`);
      sites.push(best);
      for (let i = 0; i < lattice.length; i++) dSel[i] = Math.min(dSel[i], dist(lattice[i].xy, lattice[best].xy));
    }
    const minSpacing = (idx: number[]) => {
      let m = Infinity;
      const pts = [...idx.map((i) => lattice[i].xy), ...fixedHere];
      for (let i = 0; i < idx.length; i++) for (let j = 0; j < pts.length; j++) if (i !== j) m = Math.min(m, dist(pts[i], pts[j]));
      return m;
    };
    const maximinSpacing = minSpacing(sites);

    // discrete centroidal Voronoi relaxation (Lloyd) over the lattice; fixed (verified) sites do not move
    let relaxed = [...sites];
    for (let it = 0; it < LLOYD_ITERATIONS; it++) {
      const sum = relaxed.map(() => [0, 0, 0]);
      for (const l of lattice) {
        let bi = -1;
        let bd = Infinity;
        for (let s = 0; s < relaxed.length; s++) {
          const d = dist(l.xy, lattice[relaxed[s]].xy);
          if (d < bd) {
            bd = d;
            bi = s;
          }
        }
        if (fixedHere.some((f) => dist(f, l.xy) < bd)) continue; // belongs to a verified point's cell
        sum[bi][0] += l.xy[0];
        sum[bi][1] += l.xy[1];
        sum[bi][2]++;
      }
      const next = relaxed.map((cur, s) => {
        if (!sum[s][2]) return cur;
        const cxy: XY = [sum[s][0] / sum[s][2], sum[s][1] / sum[s][2]];
        let bi = cur;
        let bd = Infinity;
        for (let i = 0; i < lattice.length; i++) {
          const d = dist(lattice[i].xy, cxy);
          if (d < bd) {
            bd = d;
            bi = i;
          }
        }
        return bi;
      });
      if (new Set(next).size !== next.length) break;
      relaxed = next;
    }
    const relaxedSpacing = minSpacing(relaxed);
    const chosen = relaxedSpacing >= SPACING_MIN_M && relaxedSpacing >= 0.8 * maximinSpacing ? relaxed : sites;
    if (minSpacing(chosen) < SPACING_MIN_M) throw new Error(`zone ${zoneNo}: cannot keep ${SPACING_MIN_M} m spacing`);

    // hash-seeded jitter, constraint-checked
    const finalXY: XY[] = chosen.map((i) => lattice[i].xy);
    const jitterM: number[] = finalXY.map(() => 0);
    todo.forEach((c, s) => {
      const rnd = mulberry32(parseInt(sha256(c.nameTh).slice(0, 8), 16));
      for (let t = 0; t < JITTER_TRIES; t++) {
        const ang = rnd() * 2 * Math.PI;
        const r = rnd() * JITTER_FRACTION * nominal * (1 - t / JITTER_TRIES);
        const p: XY = [finalXY[s][0] + r * Math.cos(ang), finalXY[s][1] + r * Math.sin(ang)];
        if (!inPolys(p, polys) || !inPolys(p, muniPolys)) continue;
        if (Math.min(edgeDist(p, polys), edgeDist(p, muniPolys)) < EDGE_MIN_M) continue;
        const others = [...finalXY.filter((_, j) => j !== s), ...fixed.map((f) => f.xy)];
        if (others.some((o) => dist(o, p) < SPACING_MIN_M)) continue;
        finalXY[s] = p;
        jitterM[s] = r;
        break;
      }
    });
    todo.forEach((c, s) => {
      const p = finalXY[s];
      const others = [...finalXY.filter((_, j) => j !== s), ...fixed.map((f) => f.xy)];
      const ll = toLonLat(p);
      placements.set(c.stagedId, {
        lonlat: [round(ll[0], 6), round(ll[1], 6)],
        jitterM: round(jitterM[s], 1),
        edgeM: round(Math.min(edgeDist(p, polys), edgeDist(p, muniPolys)), 1),
        nearestM: round(Math.min(...others.map((o) => dist(o, p))), 1),
        slot: s + 1,
      });
    });
    zoneReports.push({
      zoneNo,
      zoneAreaKm2: round(areaM2 / 1e6, 3),
      latticeCandidates: lattice.length,
      illustrative: todo.length,
      verifiedFixedPointsNearZone: fixedHere.length,
      nominalSpacingM: Math.round(nominal),
      maximinMinSpacingM: Math.round(maximinSpacing),
      relaxedMinSpacingM: Math.round(relaxedSpacing),
      usedRelaxation: chosen === relaxed,
    });
  }

  // ---- 4. Final global checks (after rounding)
  const allPts: { id: string; xy: XY; zoneNo: number; status: string }[] = [];
  for (const d of decisions) {
    const ll: LonLat = d.status === "verified" ? [d.chosen!.cand.lon, d.chosen!.cand.lat] : placements.get(d.community.stagedId)!.lonlat;
    allPts.push({ id: d.community.id, xy: toXY(ll), zoneNo: d.community.zoneNo, status: d.status });
  }
  let globalMin = Infinity;
  const tooClose: string[] = [];
  for (let i = 0; i < allPts.length; i++)
    for (let j = i + 1; j < allPts.length; j++) {
      const d = dist(allPts[i].xy, allPts[j].xy);
      globalMin = Math.min(globalMin, d);
      if (d < SPACING_MIN_M && (allPts[i].status === "illustrative" || allPts[j].status === "illustrative")) tooClose.push(`${allPts[i].id}~${allPts[j].id}:${Math.round(d)}m`);
    }
  const illustrativeChecks = allPts
    .filter((p) => p.status === "illustrative")
    .map((p) => {
      const zp = zonePolys.get(p.zoneNo)!;
      return { id: p.id, inOwnZone: inPolys(p.xy, zp), inMunicipality: inPolys(p.xy, muniPolys), edgeM: Math.min(edgeDist(p.xy, zp), edgeDist(p.xy, muniPolys)) };
    });
  const checks = {
    totalFeatures: allPts.length,
    expectedTotal: stagedCommunities.structure?.totalCommunities ?? null,
    uniqueIds: new Set(allPts.map((p) => p.id)).size === allPts.length,
    perZone: Object.fromEntries([1, 2, 3, 4].map((z) => [z, allPts.filter((p) => p.zoneNo === z).length])),
    perZoneExpected: stagedCommunities.structure?.perZone ?? null,
    illustrativeAllInOwnZone: illustrativeChecks.every((c) => c.inOwnZone),
    illustrativeAllInMunicipality: illustrativeChecks.every((c) => c.inMunicipality),
    illustrativeMinEdgeM: round(Math.min(...illustrativeChecks.map((c) => c.edgeM)), 1),
    minSpacingInvolvingIllustrativeM: round(
      Math.min(
        ...allPts.flatMap((a, i) => allPts.slice(i + 1).filter((b) => a.status === "illustrative" || b.status === "illustrative").map((b) => dist(a.xy, b.xy))),
      ),
      1,
    ),
    globalMinSpacingM: round(globalMin, 1),
    spacingViolations: tooClose,
  };
  const pass =
    checks.totalFeatures === communities.length &&
    checks.uniqueIds &&
    checks.illustrativeAllInOwnZone &&
    checks.illustrativeAllInMunicipality &&
    checks.illustrativeMinEdgeM >= EDGE_MIN_M - 0.5 &&
    checks.spacingViolations.length === 0;
  log("checks", JSON.stringify(checks));
  if (!pass) throw new Error("placement checks failed — not writing outputs");

  // ---- 5. Write communities.geojson
  const now = new Date().toISOString();
  const overpassRec = fetchLog["overpass-named-features"];
  const osmBase = ov?.osm3s?.timestamp_osm_base ?? null;
  const VERIFIED_METHOD = (e: Evaluated) =>
    `Verified against OpenStreetMap: ${e.cand.osmType}/${e.cand.osmId} "${e.cand.name}" (${e.kind}; tag ${e.cand.nameTag}) — rule ${e.match.rule} ${e.match.method}${e.match.marksExact ? "" : " (tone/diacritic-insensitive)"}, confidence ${e.match.confidence}; point inside the municipality and ${e.zoneDistM <= 0 ? "inside" : `${Math.round(e.zoneDistM)} m from`} the approximate เขต ${e.community.zoneNo} polygon. ${e.rank <= 2 ? "The OSM feature represents the place itself." : "The OSM feature is a facility named after the community (not a surveyed community centroid)."}`;
  const ILLUSTRATIVE_METHOD = (c: Community) =>
    `ILLUSTRATIVE demonstration placement — not a real location. No OpenStreetMap feature or authoritative coordinate could be verified for this community; the point is a deterministic, evenly spread position inside its assigned zone (approximate เขต ${c.zoneNo} polygon), >= ${EDGE_MIN_M} m from the zone edge and >= ${SPACING_MIN_M} m from every other community point (see metadata.methods.illustrative). Only the zone membership is real.`;

  const features = decisions.map((d) => {
    const c = d.community;
    const base = {
      id: c.id,
      nameTh: c.nameTh,
      nameEn: c.nameEn,
      zoneId: c.zoneId,
      zoneNo: c.zoneNo,
      locationStatus: d.status,
      method: "",
      households: c.households,
      population: c.population,
      sourceId: d.status === "verified" ? SRC.verified : SRC.illustrative,
    };
    const statsProps = {
      stagedId: c.stagedId,
      seqInZone: c.seqInZone,
      statsStatus: c.statsStatus,
      statsSourceId: SRC.notices,
      statsSourceUrl: c.statsSourcePdf,
      statsSourcePage: c.statsSourcePage,
      statsNote:
        c.statsStatus === "observed"
          ? "households/population as printed in the municipal community-boundary announcement (Nov 2022 – May 2023); reference date and counting method not stated; not DOPA registration counts."
          : "no information page for this community in the boundary announcement: households/population unavailable.",
      ...(c.statsAnomalies.length ? { statsAnomalies: c.statsAnomalies } : {}),
      ...(c.boundaryNoticeNameTh ? { boundaryNoticeNameTh: c.boundaryNoticeNameTh } : {}),
    };
    if (d.status === "verified") {
      const e = d.chosen!;
      return {
        type: "Feature",
        properties: {
          ...base,
          method: VERIFIED_METHOD(e),
          ...statsProps,
          osmId: `${e.cand.osmType}/${e.cand.osmId}`,
          osmName: e.cand.name,
          osmNameTag: e.cand.nameTag,
          osmKind: e.kind,
          matchMethod: e.match.method,
          matchRule: e.match.rule,
          confidence: e.match.confidence,
          foundBy: foundByOf(e),
          locationKind: e.rank <= 2 ? "osm-place" : "community-facility (OSM feature named after the community; not a surveyed centroid)",
          zoneDistanceM: round(Math.max(0, e.zoneDistM), 1),
          insideAssignedZone: e.zoneDistM <= 0,
          insideMunicipality: e.insideMunicipality,
          license: "ODbL-1.0 © OpenStreetMap contributors",
          labelTh: "ตำแหน่งจาก OpenStreetMap (ตรวจชื่อและเขตแล้ว)",
          labelEn: "Location from OpenStreetMap (name and zone checked)",
        },
        geometry: { type: "Point", coordinates: [round(e.cand.lon, 7), round(e.cand.lat, 7)] },
      };
    }
    const pl = placements.get(c.stagedId)!;
    return {
      type: "Feature",
      properties: {
        ...base,
        method: ILLUSTRATIVE_METHOD(c),
        ...statsProps,
        placement: { slot: pl.slot, jitterM: pl.jitterM, edgeDistanceM: pl.edgeM, nearestNeighbourM: pl.nearestM, seed: `sha256(nameTh)[0:8]=${sha256(c.nameTh).slice(0, 8)}` },
        labelTh: "ตำแหน่งสาธิต ไม่ใช่พิกัดจริง",
        labelEn: "Illustrative position — not a real location",
      },
      geometry: { type: "Point", coordinates: pl.lonlat },
    };
  });

  const nVer = verified.length;
  const fc = {
    type: "FeatureCollection",
    metadata: {
      title: "Hat Yai City Municipality — community points (103 official communities)",
      titleTh: "ชุมชนในเขตเทศบาลนครหาดใหญ่ (103 ชุมชน)",
      generatedAt: now,
      generator: "scripts/data/fetch-hatyai-community-locations.ts",
      counts: { total: features.length, verified: nVer, illustrative: features.length - nVer, perZone: checks.perZone },
      communityList: { sourceId: SRC.list, url: "https://www.hatyaicity.go.th/content/cate/258", note: "Names and zone assignment from the official community lists (data as of 1 Oct 2026, 2569 BE)." },
      statistics: { sourceId: SRC.notices, url: "https://www.hatyaicity.go.th/content/cate/259", note: "households / population as printed in the 2022–2023 community-boundary announcements (status observed; reference date not stated)." },
      methods: {
        verified: {
          locationStatus: "verified",
          sourceId: SRC.verified,
          description: `Point of an OpenStreetMap feature whose own name matches the official community name (Overpass: all named features in the municipality bbox, OSM base ${osmBase ?? "n/a"}; Nominatim bounded search per community). Name rules after Thai normalisation (NFC, Thai digits -> Arabic, ร.พ./รพ. -> โรงพยาบาล, punctuation/whitespace removed): N1 name equals the official name; N2 place=*/landuse=residential named the official name without 'ชุมชน'; N3 name contains the full official name ending at a word break. A tone/diacritic-insensitive-only match lowers confidence one level; only high/medium are accepted. Location rules: inside the OSM municipality polygon AND inside or within ${ZONE_TOLERANCE_M} m of the assigned (approximate) zone polygon; ways/relations must have a bbox diagonal <= ${MAX_FEATURE_EXTENT_M} m. Ambiguity: rejected when accepted candidates are > ${AMBIGUITY_RADIUS_M} m apart or one OSM object matches several communities equally.`,
          license: "ODbL-1.0 © OpenStreetMap contributors",
        },
        illustrative: {
          locationStatus: "illustrative",
          sourceId: SRC.illustrative,
          description: `DEMONSTRATION PLACEMENT, NOT A LOCATION: deterministic, evenly spread points inside each community's assigned zone polygon (the zones themselves are an approximate demonstration partition, ${SRC.zones}). ${LATTICE_STEP_M} m hexagonal candidate lattice restricted to >= ${EDGE_MIN_M} m from the zone and municipality edges and >= ${SPACING_MIN_M} m from verified points; farthest-point (maximin) initialisation with the boundary weighted as half a spacing; ${LLOYD_ITERATIONS} iterations of discrete centroidal-Voronoi (Lloyd) relaxation with verified points held fixed; communities assigned to positions in SHA-256(nameTh) order (deliberately non-geographic); a jitter of up to ${JITTER_FRACTION * 100}% of the nominal spacing seeded by SHA-256(nameTh), accepted only if all constraints still hold. Only the zone membership of these points is real.`,
          displayLabelTh: "ตำแหน่งสาธิต ไม่ใช่พิกัดจริง",
          displayLabelEn: "Illustrative position — not a real location",
        },
      },
      checks,
      limitations: [
        "Illustrative points carry no information about where a community actually is inside its zone; do not use them for distance, exposure or routing analysis.",
        "Zone polygons are an approximate demonstration partition (not official legal boundaries), so even zone membership near zone edges is approximate.",
        "Verified points may be facilities named after the community (e.g. a community health post) rather than a surveyed community centroid; see properties.locationKind.",
        "households/population are printed figures from the 2022–2023 boundary announcements (some flagged anomalies are kept as published, see properties.statsAnomalies).",
      ],
      license: "Feature geometry: verified points ODbL-1.0 © OpenStreetMap contributors; illustrative points derived (no real-world claim).",
    },
    features,
  };
  // compact: served to the browser
  fs.writeFileSync(path.join(PUBLIC_HY, "communities.geojson"), JSON.stringify(fc) + "\n", "utf8");

  // ---- 6. Staged report, sources, manifest
  const report = {
    generatedAt: now,
    runStarted: RUN_STARTED,
    offline: OFFLINE,
    inputs: ["data/staged/hatyai-communities.json", "public/data/hatyai/zones.geojson", "public/data/hatyai/municipality.geojson"],
    queryBbox: { minLon: QBB[0], minLat: QBB[1], maxLon: QBB[2], maxLat: QBB[3] },
    overpass: { query: overpassQuery, elements: ov?.elements?.length ?? null, thaiNameVariants: ovCands.length, osmBase, fetch: overpassRec ?? null },
    nominatim: { ...nomStatus, params: { format: "jsonv2", limit: 10, viewbox, bounded: 1, countrycodes: "th", namedetails: 1, extratags: 1 } },
    thresholds: { ZONE_TOLERANCE_M, MAX_FEATURE_EXTENT_M, AMBIGUITY_RADIUS_M, LATTICE_STEP_M, EDGE_MIN_M, SPACING_MIN_M, LLOYD_ITERATIONS, JITTER_FRACTION },
    counts: { total: features.length, verified: nVer, illustrative: features.length - nVer },
    verified: verified.map((d) => ({
      id: d.community.id,
      nameTh: d.community.nameTh,
      zoneNo: d.community.zoneNo,
      osmId: `${d.chosen!.cand.osmType}/${d.chosen!.cand.osmId}`,
      osmName: d.chosen!.cand.name,
      kind: d.chosen!.kind,
      rule: d.chosen!.match.rule,
      confidence: d.chosen!.match.confidence,
      zoneDistanceM: round(Math.max(0, d.chosen!.zoneDistM), 1),
      lon: d.chosen!.cand.lon,
      lat: d.chosen!.cand.lat,
      decision: d.reason,
    })),
    rejectedCandidates: pairs
      .filter((e) => !e.accepted || (verified.find((v) => v.community.stagedId === e.community.stagedId)?.chosen !== e && e.accepted))
      .map((e) => ({
        community: e.community.nameTh,
        communityId: e.community.id,
        zoneNo: e.community.zoneNo,
        osmId: `${e.cand.osmType}/${e.cand.osmId}`,
        osmName: e.cand.name,
        kind: e.kind,
        rule: e.match.rule,
        confidence: e.match.confidence,
        insideMunicipality: e.insideMunicipality,
        inZoneNo: e.inZoneNo,
        zoneDistanceM: round(e.zoneDistM, 1),
        extentM: e.cand.extentM === null ? null : Math.round(e.cand.extentM),
        reason: e.accepted ? "consistent alternative candidate (not chosen)" : e.reason,
      })),
    nameRuleRejections: nameRejections,
    illustrativePlacement: { zones: zoneReports },
    checks,
  };
  writeJson(path.join(STAGED, "hatyai-community-locations-report.json"), report);

  const nomFetched = Object.values(fetchLog).filter((r) => r.key.startsWith("nominatim:"));
  const nomLatest = nomFetched.map((r) => r.retrievedAt).filter(Boolean).sort().pop() ?? null;
  const ovStatus = ov ? "retrieved" : "failed";
  const nomAccess = nomStatus.ok === nomStatus.queried ? "retrieved" : nomStatus.ok > 0 ? "partial" : "failed";
  const sources: Record<string, unknown>[] = [
    {
      id: SRC.overpass,
      nameEn: "OpenStreetMap — all named features in the Hat Yai municipality bbox (Overpass API)",
      nameTh: "OpenStreetMap — วัตถุที่มีชื่อทั้งหมดในกรอบพื้นที่เทศบาลนครหาดใหญ่ (Overpass API)",
      url: overpassRec?.url ?? OVERPASS[0],
      publisher: "OpenStreetMap contributors (via Overpass API)",
      license: "ODbL-1.0",
      retrievedAt: overpassRec?.retrievedAt ?? undefined,
      accessStatus: ovStatus,
      notes: `Query: ${overpassQuery} — ${ov?.elements?.length ?? 0} elements, OSM base ${osmBase ?? "n/a"}. Raw: data/raw/hatyai-community-locations/overpass-named-features.json.`,
    },
    {
      id: SRC.nominatim,
      nameEn: "OpenStreetMap Nominatim — bounded search for each official community name",
      nameTh: "OpenStreetMap Nominatim — ค้นหาชื่อชุมชนทางการทีละชุมชนในกรอบพื้นที่เทศบาล",
      url: "https://nominatim.openstreetmap.org/search",
      publisher: "OpenStreetMap Foundation (Nominatim)",
      license: "ODbL-1.0",
      retrievedAt: nomLatest ?? undefined,
      accessStatus: nomAccess,
      notes: `${nomStatus.ok}/${nomStatus.queried} queries answered (${nomStatus.results} results in total), <= 1 request/s, viewbox ${viewbox} bounded=1. Raw: data/raw/hatyai-community-locations/nominatim/<staged id>.json.`,
    },
    {
      id: SRC.verified,
      nameEn: "Verified community locations — OpenStreetMap features matched by official community name (derived)",
      nameTh: "ตำแหน่งชุมชนที่ตรวจสอบแล้ว — วัตถุ OpenStreetMap ที่ชื่อตรงกับชื่อชุมชนทางการ",
      url: "https://www.openstreetmap.org/",
      publisher: "Derived by this project from OpenStreetMap",
      license: "ODbL-1.0",
      retrievedAt: overpassRec?.retrievedAt ?? undefined,
      accessStatus: nVer > 0 ? "retrieved" : "failed",
      notes: `${nVer} of ${features.length} communities verified. Rules: see data/staged/hatyai-community-locations-notes.md.`,
    },
    {
      id: SRC.illustrative,
      nameEn: "Illustrative community placements inside the approximate zones (deterministic demonstration, not real locations)",
      nameTh: "ตำแหน่งสาธิตของชุมชนภายในเขต (คำนวณแบบกำหนดได้ ไม่ใช่พิกัดจริง)",
      url: "https://www.hatyaicity.go.th/content/cate/258",
      publisher: "Derived by this project (community list: เทศบาลนครหาดใหญ่; zone polygons: approximate demonstration partition)",
      accessStatus: "retrieved",
      notes: `${features.length - nVer} communities. Positions carry no real-world meaning beyond zone membership; method in communities.geojson metadata.methods.illustrative and the notes file.`,
    },
  ];
  // inputs defined in hatyai-sources.json: copied verbatim so this file is self-contained (identical ids/content -> safe to de-duplicate)
  const reused = [SRC.list, SRC.notices, SRC.zones, SRC.muni];
  const hySources = fs.existsSync(path.join(STAGED, "hatyai-sources.json")) ? readJson<{ id: string }[]>(path.join(STAGED, "hatyai-sources.json")) : [];
  for (const id of reused) {
    const ref = hySources.find((x) => x.id === id);
    if (ref) sources.push(ref);
    else warn(`source ${id} not found in hatyai-sources.json`);
  }
  writeJson(path.join(STAGED, "hatyai-community-locations-sources.json"), sources);
  writeJson(MANIFEST, { script: "scripts/data/fetch-hatyai-community-locations.ts", updatedAt: now, files: { ...manifestPrev, ...fetchLog } });
  log(`wrote ${rel(path.join(PUBLIC_HY, "communities.geojson"))} (${features.length} features: ${nVer} verified, ${features.length - nVer} illustrative)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
