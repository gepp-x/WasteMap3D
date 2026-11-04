/**
 * fetch-hatyai.ts — Hat Yai City Municipality (เทศบาลนครหาดใหญ่, Songkhla):
 * geography, community-management structure, population, municipal solid
 * waste and flood history for Urban Intelligence — Waste & Flood Observatory.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/data/fetch-hatyai.ts               # network-first for small files, cache-first for large PDFs
 *   npx tsx scripts/data/fetch-hatyai.ts --offline     # rebuild every output from cached raw files only
 *   npx tsx scripts/data/fetch-hatyai.ts --refresh-all # re-download large PDFs as well
 *   npx tsx scripts/data/fetch-hatyai.ts --offline --fetch=key1,key2
 *                                                      # offline, except the listed fetch keys
 *                                                      # (e.g. community-candidates, pmc-html)
 *
 * Etiquette: descriptive User-Agent, <= 1 request/s per host, Overpass queries
 * strictly sequential with >= 2 s pause, retries with exponential backoff and
 * endpoint rotation. No authentication, CAPTCHA or paywall is circumvented: the
 * PMC article page can answer with a reCAPTCHA challenge (then it is logged as
 * failed and never retried); the article text is always read through NCBI's
 * public E-utilities API (efetch XML), the HTML is only cached when served normally.
 *
 * Raw downloads are untrusted data: they are saved verbatim under
 * data/raw/<source>/... and only parsed (never executed). PDF text layers are
 * extracted read-only with macOS PDFKit via scripts/data/lib/hatyai-pdftext.jxa.js
 * and cached under data/raw/hatyaicity/text/ so --offline also works elsewhere.
 *
 * Manual inputs (documented, verifiable against the raw PDFs):
 *   data/manual/hatyai-communities-official-list.json      names with Thai marks restored
 *   data/manual/hatyai-boundary-notice-transcriptions.json figures from scanned pages
 *
 * Outputs:
 *   public/data/hatyai/municipality.geojson, zones.geojson
 *   data/staged/hatyai-community-osm-candidates.geojson (OSM name matches; the public communities.geojson
 *     is built afterwards by scripts/data/fetch-hatyai-community-locations.ts)
 *   data/staged/hatyai-communities.json, hatyai-population.json, hatyai-waste.json,
 *   data/staged/hatyai-flood.json, hatyai-sources.json, hatyai-ingest-report.json
 *   data/raw/_manifests/fetch-hatyai.json (per-file retrieval log)
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- this scraper walks heterogeneous third-party JSON
   (Overpass, CKAN catalog packages, NCBI E-utilities, DOPA tables) whose shapes vary per source and year;
   its outputs are checked against the zod contract by scripts/data/validate-data.ts. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";

// ---------------------------------------------------------------------------
// Paths, flags, constants
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..");
const RAW = path.join(ROOT, "data", "raw");
const MANUAL = path.join(ROOT, "data", "manual");
const STAGED = path.join(ROOT, "data", "staged");
const PUBLIC_HY = path.join(ROOT, "public", "data", "hatyai");
const MANIFEST = path.join(RAW, "_manifests", "fetch-hatyai.json");
const JXA = path.join(ROOT, "scripts", "data", "lib", "hatyai-pdftext.jxa.js");

const ARGS = new Set(process.argv.slice(2));
const OFFLINE = ARGS.has("--offline");
const REFRESH_ALL = ARGS.has("--refresh-all");
/** with --offline: fetch keys that are still fetched online (comma-separated, e.g. --fetch=community-candidates) */
const FETCH_KEYS = new Set(
  ([...ARGS].find((a) => a.startsWith("--fetch="))?.slice("--fetch=".length) ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
const isOffline = (key: string) => OFFLINE && !FETCH_KEYS.has(key.replace(/@try\d+$/, ""));

const UA = "UrbanIntelligenceDemo/0.1 (research prototype)";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const HOST_MIN_INTERVAL_MS = 1_100;
const OVERPASS_PAUSE_MS = 2_500;
/** max gap (m) bridged between end nodes of same-name OSM ways when chaining divider lines */
const BRIDGE_M = 120;

const RUN_STARTED = new Date().toISOString();
const log = (...a: unknown[]) => console.log("[hatyai]", ...a);
const warn = (...a: unknown[]) => console.warn("[hatyai][warn]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}
function writeJson(file: string, obj: unknown) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function readJson<T = any>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function rel(p: string) {
  return path.relative(ROOT, p);
}
function sha256(buf: Buffer) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
/** Buddhist Era -> Gregorian */
const be2ce = (be: number) => be - 543;
/** Thai fiscal year (BE) -> [start, end] ISO dates. FY2565 = 2021-10-01 .. 2022-09-30 */
function thaiFiscalYear(be: number): { from: string; to: string; days: number } {
  const endYear = be2ce(be);
  const from = `${endYear - 1}-10-01`;
  const to = `${endYear}-09-30`;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return { from, to, days };
}

// ---------------------------------------------------------------------------
// Fetch layer with manifest, per-host rate limiting, retries and cache fallback
// ---------------------------------------------------------------------------

type FetchStatus = "fetched" | "cached" | "failed";
interface FetchRec {
  key: string;
  url: string;
  file: string | null;
  status: FetchStatus;
  httpStatus?: number;
  bytes?: number;
  sha256?: string;
  contentType?: string;
  retrievedAt?: string;
  /** time of the (failed) online attempt */
  attemptedAt?: string;
  error?: string;
  note?: string;
}
const manifestPrev: Record<string, FetchRec> = fs.existsSync(MANIFEST) ? readJson(MANIFEST).files ?? {} : {};
const fetchLog: Record<string, FetchRec> = {};
const lastHit = new Map<string, number>();

async function politeWait(host: string, minMs: number) {
  const last = lastHit.get(host) ?? 0;
  const wait = last + minMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

interface GetOpts {
  key: string;
  url: string;
  file: string; // absolute
  policy?: "network-first" | "cache-first";
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  validate?: (buf: Buffer, contentType: string) => string | null; // returns error message or null
  minIntervalMs?: number;
}

function readCachedFile(o: GetOpts, error?: string): FetchRec {
  const prev = manifestPrev[o.key];
  if (fs.existsSync(o.file)) {
    const buf = fs.readFileSync(o.file);
    const rec: FetchRec = {
      key: o.key,
      url: o.url,
      file: rel(o.file),
      status: "cached",
      bytes: buf.length,
      sha256: sha256(buf),
      httpStatus: prev?.httpStatus,
      contentType: prev?.contentType,
      retrievedAt: prev?.retrievedAt ?? fs.statSync(o.file).mtime.toISOString(),
      error,
      note: error ? "network failed; cached raw file reused" : "cache-first policy (or --offline); cached raw file reused",
    };
    return (fetchLog[o.key] = rec);
  }
  // Offline and nothing cached: keep the evidence of the last real online attempt (e.g. HTTP 404)
  // instead of overwriting it with "offline and no cache".
  if (!error && prev && prev.status === "failed" && prev.httpStatus != null && prev.url === o.url) {
    return (fetchLog[o.key] = { ...prev, note: "offline run; no cached file — failure record of the last online attempt kept" });
  }
  return (fetchLog[o.key] = { key: o.key, url: o.url, file: null, status: "failed", error: error ?? "offline and no cache" });
}

async function getFile(o: GetOpts): Promise<FetchRec> {
  const policy = o.policy ?? "network-first";
  if (isOffline(o.key) || (policy === "cache-first" && !REFRESH_ALL && fs.existsSync(o.file))) return readCachedFile(o);
  const host = new URL(o.url).host;
  const retries = o.retries ?? 3;
  let lastErr = "";
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(2_000 * 2 ** (attempt - 1), 30_000));
    await politeWait(host, o.minIntervalMs ?? HOST_MIN_INTERVAL_MS);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 120_000);
    try {
      const res = await fetch(o.url, {
        method: o.method ?? "GET",
        body: o.body,
        headers: { "User-Agent": UA, ...(o.headers ?? {}) },
        signal: ctrl.signal,
        redirect: "follow",
      });
      lastStatus = res.status;
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // not retryable
        continue;
      }
      const v = o.validate ? o.validate(buf, ct) : null;
      if (v) {
        lastErr = `HTTP ${res.status} but invalid content: ${v}`;
        if (/captcha/i.test(v)) break; // never retry/bypass a challenge
        continue;
      }
      ensureDir(path.dirname(o.file));
      const tmp = o.file + ".tmp";
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, o.file);
      return (fetchLog[o.key] = {
        key: o.key,
        url: o.url,
        file: rel(o.file),
        status: "fetched",
        httpStatus: res.status,
        bytes: buf.length,
        sha256: sha256(buf),
        contentType: ct,
        retrievedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      lastErr = e?.name === "AbortError" ? "timeout" : String(e?.message ?? e);
    } finally {
      clearTimeout(timer);
    }
  }
  const rec = readCachedFile(o, lastErr);
  if (rec.status === "failed") {
    rec.httpStatus = lastStatus;
    rec.attemptedAt = new Date().toISOString();
  }
  warn(`${o.key}: ${lastErr} -> ${rec.status}`);
  return rec;
}

const notHtml = (buf: Buffer, ct: string) =>
  /html/i.test(ct) || buf.subarray(0, 64).toString("latin1").toLowerCase().includes("<!doctype html") ? "HTML instead of data" : null;
const isPdf = (buf: Buffer) => (buf.subarray(0, 5).toString("latin1") === "%PDF-" ? null : "not a PDF");
const noCaptcha = (buf: Buffer) => (/recaptcha|captcha/i.test(buf.subarray(0, 4000).toString("utf8")) ? "captcha challenge page" : null);

let overpassTurn = 0;
async function overpass(key: string, query: string): Promise<{ rec: FetchRec; data: any | null }> {
  const file = path.join(RAW, "osm", "hatyai", `${key}.json`);
  let rec: FetchRec | null = null;
  if (!isOffline(key)) {
    const errors: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const endpoint = OVERPASS[(overpassTurn + attempt) % OVERPASS.length];
      if (attempt > 0) await sleep(Math.min(4_000 * 2 ** (attempt - 1), 40_000));
      await politeWait("overpass", OVERPASS_PAUSE_MS);
      const r = await getFile({
        key: `${key}@try${attempt}`,
        url: endpoint,
        file,
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeoutMs: 200_000,
        retries: 0,
        minIntervalMs: 0,
        validate: (buf) => {
          try {
            const j = JSON.parse(buf.toString("utf8"));
            if (!Array.isArray(j.elements)) return "no elements[]";
            if (typeof j.remark === "string" && /error|timed out/i.test(j.remark)) return `remark: ${j.remark}`;
            return null;
          } catch {
            return "not JSON";
          }
        },
      });
      delete fetchLog[`${key}@try${attempt}`];
      if (r.status === "fetched") {
        rec = { ...r, key, note: `endpoint ${endpoint}; query: ${query}` };
        overpassTurn = (overpassTurn + attempt + 1) % OVERPASS.length;
        break;
      }
      errors.push(`${endpoint}: ${r.error}`);
    }
    if (!rec) {
      rec = readCachedFile({ key, url: OVERPASS[0], file }, errors.join(" | "));
      rec.note = `all Overpass attempts failed; ${rec.status === "cached" ? "cached file reused" : "no cache"}; query: ${query}`;
    }
  } else {
    rec = readCachedFile({ key, url: OVERPASS[0], file });
    rec.note = `offline; query: ${query}`;
  }
  fetchLog[key] = rec;
  return { rec, data: rec.file ? readJson(path.join(ROOT, rec.file)) : null };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function htmlToLines(html: string): string[] {
  let s = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<(br|p|div|tr|li|h\d|td|th)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean);
}
function htmlTables(html: string): string[][][] {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  return tables.map((t) =>
    (t.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).map((r) =>
      [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => htmlToLines(m[1]).join(" ").trim()),
    ),
  );
}
function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += c;
  }
  if (f.length || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}
const num = (s: string | undefined | null): number | null => {
  if (s == null) return null;
  const t = thaiDigits(String(s)).replace(/,/g, "").trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
function thaiDigits(s: string) {
  return s.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50));
}
/**
 * Thai fonts such as TH Sarabun position upper/lower marks with Private-Use-Area glyph variants
 * (the de-facto Microsoft/Adobe Thai PUA, U+F700-U+F71A); PDF text layers then contain those PUA
 * code points instead of the standard marks. Map them back to standard Unicode Thai.
 */
const PUA_THAI: Record<number, string> = {
  0xf700: "\u0E10", 0xf701: "\u0E34", 0xf702: "\u0E35", 0xf703: "\u0E36", 0xf704: "\u0E37",
  0xf705: "\u0E48", 0xf706: "\u0E49", 0xf707: "\u0E4A", 0xf708: "\u0E4B", 0xf709: "\u0E4C",
  0xf70a: "\u0E48", 0xf70b: "\u0E49", 0xf70c: "\u0E4A", 0xf70d: "\u0E4B", 0xf70e: "\u0E4C",
  0xf70f: "\u0E0D", 0xf710: "\u0E31", 0xf711: "\u0E4D", 0xf712: "\u0E47", 0xf713: "\u0E48",
  0xf714: "\u0E49", 0xf715: "\u0E4A", 0xf716: "\u0E4B", 0xf717: "\u0E4C", 0xf718: "\u0E38",
  0xf719: "\u0E39", 0xf71a: "\u0E3A",
};
function puaToThai(s: string) {
  return s.replace(/[\uF700-\uF71A]/g, (c) => PUA_THAI[c.charCodeAt(0)] ?? "").replace(/\u0E4D\u0E32/g, "\u0E33");
}
/** Normalise a Thai name for display-independent comparison. */
function normName(s: string) {
  return thaiDigits(s)
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
/** Mark-insensitive key: removes upper/lower vowels & tone marks that the PDF text layer drops. */
function markKey(s: string) {
  return normName(puaToThai(s))
    .replace(/ำ/g, "ํา") // ำ -> ํ + า
    .replace(/[ัิ-ฺ็-๎]/g, "")
    .replace(/[\s.\-–]/g, "");
}
const stripPrefix = (k: string) => k.replace(/^ชมชน/, ""); // "ชุมชน" after markKey

// ---------------------------------------------------------------------------
// PDF text layer (macOS PDFKit via JXA), cached
// ---------------------------------------------------------------------------

function pdfText(pdfAbs: string): { text: string | null; how: string } {
  const cache = path.join(RAW, "hatyaicity", "text", path.basename(pdfAbs).replace(/\.pdf$/i, ".txt"));
  if (fs.existsSync(pdfAbs)) {
    try {
      const out = execFileSync("osascript", ["-l", "JavaScript", JXA, pdfAbs], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
      ensureDir(path.dirname(cache));
      fs.writeFileSync(cache, out, "utf8");
      return { text: puaToThai(out), how: "PDFKit text layer (osascript JXA), Thai PUA glyphs mapped to Unicode" };
    } catch (e: any) {
      if (fs.existsSync(cache)) return { text: puaToThai(fs.readFileSync(cache, "utf8")), how: `cached text layer (${e?.message ?? e})` };
      return { text: null, how: `text extraction unavailable: ${e?.message ?? e}` };
    }
  }
  if (fs.existsSync(cache)) return { text: puaToThai(fs.readFileSync(cache, "utf8")), how: "cached text layer (PDF missing)" };
  return { text: null, how: "PDF and text cache missing" };
}
function splitPages(t: string): Map<number, string> {
  const m = new Map<number, string>();
  const parts = t.split(/^=== page (\d+)$/m);
  for (let i = 1; i < parts.length; i += 2) m.set(Number(parts[i]), parts[i + 1]);
  return m;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type Poly = Feature<Polygon | MultiPolygon>;
const fc = (fs_: Poly[]) => turf.featureCollection(fs_);
const areaM2 = (f: Poly | null) => (f ? turf.area(f) : 0);
function inter(a: Poly | null, b: Poly | null): Poly | null {
  return a && b ? (turf.intersect(fc([a, b])) as Poly | null) : null;
}
function diff(a: Poly | null, b: Poly | null): Poly | null {
  if (!a) return null;
  return b ? (turf.difference(fc([a, b])) as Poly | null) : a;
}
function uni(a: Poly | null, b: Poly | null): Poly | null {
  if (!a) return b;
  if (!b) return a;
  return turf.union(fc([a, b])) as Poly | null;
}
function parts(f: Poly | null): Feature<Polygon>[] {
  if (!f) return [];
  if (f.geometry.type === "Polygon") return [f as Feature<Polygon>];
  return f.geometry.coordinates.map((c) => turf.polygon(c));
}
function fromParts(ps: Feature<Polygon>[]): Poly | null {
  if (!ps.length) return null;
  if (ps.length === 1) return turf.polygon(ps[0].geometry.coordinates);
  return turf.multiPolygon(ps.map((p) => p.geometry.coordinates));
}
function roundCoords<T extends Poly>(f: T, d = 6): T {
  return turf.truncate(f, { precision: d, coordinates: 2, mutate: false }) as T;
}
function hav(a: [number, number], b: [number, number]) {
  return turf.distance(turf.point(a), turf.point(b), { units: "meters" });
}
/**
 * Deterministic interior label point ("pole of inaccessibility" approximation): the rounded
 * centroid if it lies inside and >= 150 m from the boundary, otherwise the point of a 60x60 grid
 * over the bbox that is inside and farthest from the boundary. (turf.pointOnFeature falls back to
 * a boundary vertex for concave shapes, which is useless as a label/focus anchor.)
 */
function interiorAnchor(f: Poly, d = 6): [number, number] {
  const rings = f.geometry.type === "Polygon" ? f.geometry.coordinates : f.geometry.coordinates.flat();
  const lines = rings.map((r) => turf.lineString(r));
  const inside = (p: [number, number]) => turf.booleanPointInPolygon(turf.point(p), f, { ignoreBoundary: true });
  const clearance = (p: [number, number]) => Math.min(...lines.map((l) => turf.pointToLineDistance(turf.point(p), l, { units: "meters" })));
  const c = turf.centroid(f).geometry.coordinates;
  const rc: [number, number] = [round(c[0], d), round(c[1], d)];
  if (inside(rc) && clearance(rc) >= 150) return rc;
  const [w, s, e, n] = turf.bbox(f);
  const N = 60;
  let best: [number, number] | null = null;
  let bestD = -1;
  for (let i = 1; i < N; i++)
    for (let j = 1; j < N; j++) {
      const p: [number, number] = [round(w + ((e - w) * i) / N, d), round(s + ((n - s) * j) / N, d)];
      if (!inside(p)) continue;
      const dd = clearance(p);
      if (dd > bestD) [best, bestD] = [p, dd];
    }
  return best ?? rc;
}

/** Assemble closed rings from OSM relation member ways (`out geom`). */
function assembleRings(ways: Position[][]): Position[][] {
  const key = (p: Position) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const pool = ways.map((w) => w.slice());
  const rings: Position[][] = [];
  while (pool.length) {
    let cur = pool.shift()!;
    let grown = true;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i];
        const end = key(cur[cur.length - 1]);
        if (key(w[0]) === end) cur = cur.concat(w.slice(1));
        else if (key(w[w.length - 1]) === end) cur = cur.concat(w.slice().reverse().slice(1));
        else if (key(w[w.length - 1]) === key(cur[0])) cur = w.concat(cur.slice(1));
        else if (key(w[0]) === key(cur[0])) cur = w.slice().reverse().concat(cur.slice(1));
        else continue;
        pool.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (key(cur[0]) !== key(cur[cur.length - 1])) throw new Error(`unclosed ring (${cur.length} pts)`);
    rings.push(cur);
  }
  return rings;
}

/**
 * Shortest path (Dijkstra) over OSM ways that share node ids; returns [lon,lat][].
 * `to` is a node id, or a selector `(a, b) => boolean` ("a is better than b") applied to the
 * coordinates of all nodes reachable from `from` (so disconnected same-name pieces are ignored).
 */
function shortestPath(
  ways: any[],
  from: number,
  toSel: number | ((a: [number, number], b: [number, number]) => boolean),
  bridgeM = BRIDGE_M,
): [number, number][] | null {
  const to0 = typeof toSel === "number" ? toSel : null;
  const coord = new Map<number, [number, number]>();
  const adj = new Map<number, { n: number; w: number }[]>();
  for (const w of ways) {
    const ids: number[] = w.nodes;
    const g: { lat: number; lon: number }[] = w.geometry;
    for (let i = 0; i < ids.length; i++) {
      if (!g[i]) continue;
      coord.set(ids[i], [g[i].lon, g[i].lat]);
      if (i > 0 && g[i - 1]) {
        const d = hav([g[i - 1].lon, g[i - 1].lat], [g[i].lon, g[i].lat]);
        (adj.get(ids[i - 1]) ?? adj.set(ids[i - 1], []).get(ids[i - 1])!).push({ n: ids[i], w: d });
        (adj.get(ids[i]) ?? adj.set(ids[i], []).get(ids[i])!).push({ n: ids[i - 1], w: d });
      }
    }
  }
  // Bridge small gaps between way END nodes (e.g. an unnamed roundabout between two named
  // carriageway pieces) with straight edges, so a same-name road is treated as continuous.
  if (bridgeM > 0) {
    const ends: { id: number; way: number }[] = [];
    ways.forEach((w, wi) => {
      const ids: number[] = w.nodes;
      for (const id of [ids[0], ids[ids.length - 1]]) if (coord.has(id)) ends.push({ id, way: wi });
    });
    for (let i = 0; i < ends.length; i++)
      for (let k = i + 1; k < ends.length; k++) {
        const a = ends[i],
          b = ends[k];
        if (a.way === b.way || a.id === b.id) continue;
        const d = hav(coord.get(a.id)!, coord.get(b.id)!);
        if (d > bridgeM) continue;
        (adj.get(a.id) ?? adj.set(a.id, []).get(a.id)!).push({ n: b.id, w: d });
        (adj.get(b.id) ?? adj.set(b.id, []).get(b.id)!).push({ n: a.id, w: d });
      }
  }
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const heap: [number, number][] = [[0, from]];
  const push = (x: [number, number]) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, n] = pop();
    if (d > (dist.get(n) ?? Infinity)) continue;
    if (to0 !== null && n === to0) break;
    for (const e of adj.get(n) ?? []) {
      const nd = d + e.w;
      if (nd < (dist.get(e.n) ?? Infinity)) {
        dist.set(e.n, nd);
        prev.set(e.n, n);
        push([nd, e.n]);
      }
    }
  }
  let to = to0;
  if (to === null) {
    const sel = toSel as (a: [number, number], b: [number, number]) => boolean;
    for (const n of dist.keys()) if (to === null || sel(coord.get(n)!, coord.get(to)!)) to = n;
  }
  if (to === null || !dist.has(to)) return null;
  const out: [number, number][] = [];
  for (let n: number | undefined = to; n !== undefined; n = prev.get(n)) out.push(coord.get(n)!);
  return out.reverse();
}
function nodesOf(ways: any[]) {
  const m = new Map<number, [number, number]>();
  for (const w of ways) w.nodes.forEach((id: number, i: number) => w.geometry[i] && m.set(id, [w.geometry[i].lon, w.geometry[i].lat]));
  return m;
}

// ---------------------------------------------------------------------------
// Source registry (SourceRef[] per src/lib/types.ts)
// ---------------------------------------------------------------------------

interface SourceRef {
  id: string;
  nameTh?: string;
  nameEn: string;
  url: string;
  publisher: string;
  license?: string;
  retrievedAt?: string;
  accessStatus: "retrieved" | "partial" | "failed" | "manual-reference";
  notes?: string;
}
function statusOf(keys: string[]): { accessStatus: SourceRef["accessStatus"]; retrievedAt?: string } {
  const recs = keys.map((k) => fetchLog[k]).filter(Boolean);
  if (!recs.length) return { accessStatus: "failed" };
  const ok = recs.filter((r) => r.status !== "failed");
  const times = ok.map((r) => r.retrievedAt!).filter(Boolean).sort();
  return {
    accessStatus: ok.length === 0 ? "failed" : ok.length < recs.length ? "partial" : "retrieved",
    retrievedAt: times[times.length - 1],
  };
}

// ===========================================================================
// MAIN
// ===========================================================================

async function main() {
  ensureDir(PUBLIC_HY);
  ensureDir(STAGED);
  const report: any = { runStartedAt: RUN_STARTED, offline: OFFLINE, refreshAll: REFRESH_ALL, checks: {}, warnings: [] as string[] };

  // -------------------------------------------------------------------------
  // 1. Municipality website: community pages and PDFs
  // -------------------------------------------------------------------------
  const HYC = "https://www.hatyaicity.go.th";
  const hyDir = path.join(RAW, "hatyaicity");
  const pageRecs: Record<string, FetchRec> = {};
  for (const [k, u, f] of [
    ["hyc-cate-258", `${HYC}/content/cate/258`, "cate-258.html"],
    ["hyc-cate-259", `${HYC}/content/cate/259`, "cate-259.html"],
    ["hyc-general", `${HYC}/content/general`, "general.html"],
  ] as const) {
    pageRecs[k] = await getFile({ key: k, url: u, file: path.join(hyDir, f) });
  }
  // PDF links + titles from the pages (fallback to the known URLs)
  function pdfLinks(file: string): { url: string; title: string }[] {
    if (!fs.existsSync(file)) return [];
    const html = fs.readFileSync(file, "utf8");
    const out: { url: string; title: string }[] = [];
    for (const m of html.matchAll(/href="(https:\/\/www\.hatyaicity\.go\.th\/files\/com_content\/[^"]+\.pdf)"[\s\S]{0,400}?<div class="name">([^<]+)/g)) {
      out.push({ url: m[1], title: m[2].replace(/\s+/g, " ").trim() });
    }
    return out;
  }
  const links258 = pdfLinks(path.join(hyDir, "cate-258.html"));
  const links259 = pdfLinks(path.join(hyDir, "cate-259.html"));
  const official = readJson(path.join(MANUAL, "hatyai-communities-official-list.json"));
  const chairmenPdf: Record<number, { url: string; file: string; title: string | null }> = {};
  for (const z of official.zones) {
    const found = links258.find((l) => new RegExp(`ข้อมูลประธานกรรมการชุมชน เขต ${z.zoneNo}\\.pdf`).test(l.title));
    if (found && found.url !== z.pdfUrl) report.warnings.push(`cate/258 now links a different PDF for เขต ${z.zoneNo}: ${found.url}`);
    chairmenPdf[z.zoneNo] = { url: found?.url ?? z.pdfUrl, file: path.join(hyDir, `chairmen-zone${z.zoneNo}.pdf`), title: found?.title ?? null };
    await getFile({ key: `hyc-chairmen-z${z.zoneNo}`, url: chairmenPdf[z.zoneNo].url, file: chairmenPdf[z.zoneNo].file, validate: isPdf });
  }
  const noticeKnown: Record<number, string> = {
    1: `${HYC}/files/com_content/2025-12_b669812ea1f62f5.pdf`,
    2: `${HYC}/files/com_content/2025-12_24c7a280a9922fb.pdf`,
    3: `${HYC}/files/com_content/2025-12_a1c71e6b5ecf923.pdf`,
    4: `${HYC}/files/com_content/2025-12_daa83b95e68ae8f.pdf`,
  };
  const noticePdf: Record<number, { url: string; file: string; title: string | null }> = {};
  for (const z of [1, 2, 3, 4]) {
    const found = links259.find((l) => new RegExp(`แนวเขตชุมชน เขต ${z}\\.pdf`).test(l.title));
    noticePdf[z] = { url: found?.url ?? noticeKnown[z], file: path.join(hyDir, `boundary-notice-zone${z}.pdf`), title: found?.title ?? null };
    await getFile({ key: `hyc-notice-z${z}`, url: noticePdf[z].url, file: noticePdf[z].file, policy: "cache-first", validate: isPdf, timeoutMs: 600_000 });
  }
  const mapLink = links259.find((l) => /ผังรวม 103 ชุมชน/.test(l.title));
  const mapUrl = mapLink?.url ?? `${HYC}/files/com_content/2025-12_025a423a70b78d4.pdf`;
  await getFile({ key: "hyc-map-103", url: mapUrl, file: path.join(hyDir, "map-103-communities.pdf"), policy: "cache-first", validate: isPdf });

  // ---- official list verification against chairmen PDF text layers ----
  const nameChecks: any[] = [];
  const chairmenMeta: Record<number, any> = {};
  for (const z of official.zones) {
    const { text, how } = pdfText(chairmenPdf[z.zoneNo].file);
    const res: any = { zoneNo: z.zoneNo, extraction: how, listed: z.communities.length, textLayerRows: null, mismatches: [] as any[] };
    if (text) {
      const flat = text.replace(/\s+/g, " ");
      const zoneM = flat.match(/\(เขต (\d)\)/);
      const dateM = flat.match(/(\d{1,2}) ตุลาคม (25\d\d)/) ?? flat.match(/(\d{1,2}) (\S+) (25\d\d)/);
      chairmenMeta[z.zoneNo] = { zoneInHeader: zoneM ? Number(zoneM[1]) : null, dataDateTh: dateM ? dateM[0] : null };
      const segs = flat.split(/\sประธานกรรมการ\s/).slice(1);
      const names: string[] = segs.map((s, i) => {
        let t = s.trim();
        const nextSeq = new RegExp(`\\s${i + 2}\\s.*$`);
        if (i < segs.length - 1) t = t.replace(nextSeq, "");
        else t = t.replace(/\s\d{1,2}\s\S+\s25\d\d.*$/, "").replace(/\s+เบอร.*$/, "");
        return t.trim();
      });
      res.textLayerRows = names.length;
      z.communities.forEach((c: any, i: number) => {
        const tl = names[i];
        const exact = tl != null && normName(tl) === normName(c.nameTh);
        const loose = tl != null && markKey(tl) === markKey(c.nameTh);
        if (!exact) res.mismatches.push({ seq: c.seq, manual: c.nameTh, textLayer: tl ?? null, markInsensitiveMatch: loose });
        c._textLayer = tl ?? null;
        c._textLayerExact = exact;
        c._textLayerMatch = loose;
      });
    }
    nameChecks.push(res);
  }
  report.checks.officialNamesVsChairmenTextLayer = nameChecks;
  const totalListed = official.zones.reduce((s: number, z: any) => s + z.communities.length, 0);
  // The cate/259 map title states the total, the notices state the per-zone counts.
  const mapTotal = (() => {
    const t = links259.map((l) => l.title).join(" ");
    const m = t.match(/ผังรวม (\d+) ชุมชน/);
    return m ? Number(m[1]) : null;
  })();
  report.checks.communityCount = { listedInChairmenPdfs: totalListed, statedInMapTitle: mapTotal, perZone: Object.fromEntries(official.zones.map((z: any) => [z.zoneNo, z.communities.length])) };

  // ---- boundary notices: text-layer rows (zones 2, 4; zone 3 first page) ----
  interface StatRow {
    zoneNo: number;
    page: number;
    printedNameTh: string;
    areaM2: number | null;
    areaKm2Printed: number | null;
    population: number | null;
    male: number | null;
    female: number | null;
    households: number | null;
    boundaries?: Record<string, string | null> | null;
    extraction: string;
    printedAnomaly?: any;
  }
  const statRows: StatRow[] = [];
  const noticeText: Record<number, any> = {};
  for (const z of [1, 2, 3, 4]) {
    const { text, how } = pdfText(noticePdf[z].file);
    noticeText[z] = { extraction: how, pagesWithInfoText: 0 };
    if (!text) continue;
    for (const [page, body] of splitPages(text)) {
      if (!/ส.?วนที่ 1/.test(body)) continue;
      noticeText[z].pagesWithInfoText++;
      const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
      const area = body.match(/พื้นที่[^\d\n]*([\d,]+)\s*ตารางเมตร\s*([\d.]+)\s*ตาราง/);
      const pop = body.match(/([\d,]+)\s*คน\s*\(ชาย\s*([\d,]+)\s*คน\s*\/\s*หญิง\s*([\d,]+)\s*คน/);
      const hh = body.match(/ครัวเรือน[^\d\n]*([\d,]+)\s*ครัวเรือน/);
      const dir = (label: string) => {
        const m = body.match(new RegExp(`${label}[^\\n]*?ติด\\S*\\s*(?:กับ)?\\s*([^\\n]+)`));
        return m ? m[1].trim() : null;
      };
      statRows.push({
        zoneNo: z,
        page,
        printedNameTh: lines[0],
        areaM2: area ? num(area[1]) : null,
        areaKm2Printed: area ? num(area[2]) : null,
        population: pop ? num(pop[1]) : null,
        male: pop ? num(pop[2]) : null,
        female: pop ? num(pop[3]) : null,
        households: hh ? num(hh[1]) : null,
        boundaries: {
          north: dir("ทิศเหนือ"),
          south: dir("ทิศใต"),
          east: dir("ทิศตะวันออก"),
          west: dir("ทิศตะวันตก"),
        },
        extraction: "pdf-text-layer",
      });
    }
  }
  const transcribed = readJson(path.join(MANUAL, "hatyai-boundary-notice-transcriptions.json"));
  for (const r of transcribed.rows) {
    if (statRows.some((s) => s.zoneNo === r.zoneNo && s.page === r.page)) continue; // text layer wins if present
    statRows.push({ ...r, boundaries: null, extraction: "manual-transcription-of-scanned-page" });
  }
  report.checks.boundaryNoticeText = noticeText;

  // ---- join stats to official list ----
  const noticeMeta: Record<number, any> = {
    1: { announcedMonth: "2023-01", announcedTh: "ประกาศ ณ วันที่ ๑๘ (ลายมือ) มกราคม พ.ศ. ๒๕๖๖", titleTh: "ประกาศเทศบาลนครหาดใหญ่ เรื่อง การแบ่งแนวเขตพื้นที่ชุมชน เขต ๑" },
    2: { announcedMonth: "2022-11", announcedTh: "ประกาศ ณ วันที่ ๘ (ลายมือ) พฤศจิกายน พ.ศ. ๒๕๖๕", titleTh: "ประกาศเทศบาลนครหาดใหญ่ เรื่อง แนวเขตชุมชน เขต ๒" },
    3: { announcedMonth: "2023-01", announcedTh: "ประกาศ ณ วันที่ ๑๘ (ลายมือ) มกราคม พ.ศ. ๒๕๖๖", titleTh: "ประกาศเทศบาลนครหาดใหญ่ เรื่อง การแบ่งแนวเขตพื้นที่ชุมชน เขต ๓" },
    4: { announcedMonth: "2023-05", announcedTh: "ประกาศ ณ วันที่ ๒๒ (ลายมือ, ไม่ชัด) พฤษภาคม พ.ศ. ๒๕๖๖", titleTh: "ประกาศเทศบาลนครหาดใหญ่ เรื่อง การแบ่งแนวเขตพื้นที่ชุมชน เขต ๔" },
  };
  const communities: any[] = [];
  const unmatchedRows: StatRow[] = [];
  for (const z of official.zones) {
    const rowsZ = statRows.filter((r) => r.zoneNo === z.zoneNo);
    for (const c of z.communities) {
      const keys = [c.nameTh, c.boundaryNoticeNameTh].filter(Boolean).map((n: string) => stripPrefix(markKey(n)));
      const row = rowsZ.find((r) => keys.includes(stripPrefix(markKey(r.printedNameTh))));
      const anomalies: string[] = [];
      let stats: any = { status: "unavailable" };
      if (row) {
        const mfSum = row.male != null && row.female != null ? row.male + row.female : null;
        const popOk = row.population != null && mfSum != null ? row.population === mfSum : null;
        if (popOk === false) anomalies.push(`printed total ${row.population} != male+female ${mfSum}`);
        if (row.printedAnomaly) anomalies.push(`${row.printedAnomaly.field}: printed "${row.printedAnomaly.printed}" — ${row.printedAnomaly.note}`);
        const hhOk = row.households != null && row.population != null ? row.households <= row.population : null;
        if (hhOk === false) anomalies.push(`households (${row.households}) exceed population (${row.population})`);
        const areaOk = row.areaM2 != null && row.areaKm2Printed != null ? Math.abs(row.areaM2 / 1e6 - row.areaKm2Printed) < 0.011 : null;
        if (areaOk === false) anomalies.push(`area ${row.areaM2} m² inconsistent with printed ${row.areaKm2Printed} km²`);
        stats = {
          status: "observed",
          definition: "Figures as printed in the municipal community-boundary announcement (population = persons, households = ครัวเรือน, area = พื้นที่ (โดยประมาณ)). The announcement does not state the reference date or method of the counts.",
          areaM2: row.areaM2,
          areaKm2Printed: row.areaKm2Printed,
          population: row.population,
          male: row.male,
          female: row.female,
          households: row.households,
          maleFemaleSum: mfSum,
          checks: { populationEqualsMalePlusFemale: popOk, householdsNotAbovePopulation: hhOk, areaM2MatchesKm2: areaOk },
          anomalies,
          extraction: row.extraction,
          printedNameTh: row.printedNameTh,
          sourcePdf: noticePdf[z.zoneNo].url,
          sourcePage: row.page,
          announcement: noticeMeta[z.zoneNo],
          boundaryDescriptionTh: row.boundaries ?? null,
        };
      }
      communities.push({
        id: `hy-c${z.zoneNo}-${String(c.seq).padStart(2, "0")}`,
        zoneNo: z.zoneNo,
        zoneId: `hy-z${z.zoneNo}`,
        seqInZone: c.seq,
        nameTh: c.nameTh,
        nameThNormalized: normName(c.nameTh),
        nameEn: null,
        boundaryNoticeNameTh: c.boundaryNoticeNameTh ?? null,
        nameVerification: {
          chairmenPdfTextLayer: c._textLayer ?? null,
          exactMatch: c._textLayerExact ?? null,
          markInsensitiveMatch: c._textLayerMatch ?? null,
        },
        stats,
      });
    }
    for (const r of rowsZ) {
      const k = stripPrefix(markKey(r.printedNameTh));
      if (!z.communities.some((c: any) => [c.nameTh, c.boundaryNoticeNameTh].filter(Boolean).some((n: string) => stripPrefix(markKey(n)) === k))) unmatchedRows.push(r);
    }
  }
  report.checks.unmatchedNoticeRows = unmatchedRows.map((r) => ({ zoneNo: r.zoneNo, page: r.page, printedNameTh: r.printedNameTh }));

  // -------------------------------------------------------------------------
  // 2. OpenStreetMap: municipality boundary
  // -------------------------------------------------------------------------
  const cand = await overpass(
    "boundary-candidates",
    '[out:json][timeout:60];(relation["boundary"="administrative"](6.95,100.40,7.08,100.55);relation["boundary"="local_authority"](6.95,100.40,7.08,100.55););out tags;',
  );
  const candidates = (cand.data?.elements ?? []).map((e: any) => ({ id: e.id, adminLevel: e.tags?.admin_level, name: e.tags?.name, nameEn: e.tags?.["name:en"] }));
  const muniRelId: number =
    (cand.data?.elements ?? []).find((e: any) => e.tags?.name === "เทศบาลนครหาดใหญ่" && e.tags?.boundary === "administrative")?.id ?? 19981578;
  const relQ = await overpass(`relation-${muniRelId}-geom`, `[out:json][timeout:90];relation(${muniRelId});out geom;`);
  const relEl = relQ.data.elements.find((e: any) => e.type === "relation");
  const outer = relEl.members.filter((m: any) => m.type === "way" && m.role !== "inner").map((m: any) => m.geometry.map((p: any) => [p.lon, p.lat]));
  const inner = relEl.members.filter((m: any) => m.type === "way" && m.role === "inner").map((m: any) => m.geometry.map((p: any) => [p.lon, p.lat]));
  const outerRings = assembleRings(outer);
  const innerRings = inner.length ? assembleRings(inner) : [];
  let muni: Poly =
    outerRings.length === 1 ? turf.polygon([outerRings[0], ...innerRings]) : turf.multiPolygon(outerRings.map((r) => [r]));
  muni = turf.rewind(muni, { reverse: false }) as Poly;
  muni = roundCoords(muni, 7);
  const muniAreaKm2 = areaM2(muni) / 1e6;
  const muniFeature: Poly = {
    ...muni,
    properties: {
      id: "hy-muni",
      nameTh: relEl.tags.name ?? "เทศบาลนครหาดใหญ่",
      nameEn: "Hat Yai City Municipality",
      nameEnOsm: relEl.tags["name:en"] ?? null,
      geometryStatus: "osm",
      sourceId: "osm-hatyai-municipality",
      osmRelationId: muniRelId,
      osmAdminLevel: relEl.tags.admin_level ?? null,
      osmWikidata: relEl.tags.wikidata ?? null,
      osmFixme: relEl.tags.fixme ?? null,
      osmDescription: relEl.tags.description ?? null,
      areaKm2: round(muniAreaKm2, 3),
      areaKm2Official: 21,
      areaKm2OfficialSource: "https://www.hatyaicity.go.th/content/general (มีขนาดพื้นที่ 21 ตารางกิโลเมตร)",
      osmBaseTimestamp: relQ.data.osm3s?.timestamp_osm_base ?? null,
      retrievedAt: relQ.rec.retrievedAt ?? null,
      license: "ODbL-1.0 © OpenStreetMap contributors",
      note: "OSM relation tagged fixme='approximate please verify' and description='traceing from https://ratchakitcha.soc.go.th/documents/1658230.pdf' (Royal Gazette). Area is computed geodesically from this polygon.",
    },
  };
  writeJson(path.join(PUBLIC_HY, "municipality.geojson"), turf.featureCollection([muniFeature]));
  report.checks.municipality = { relationId: muniRelId, candidates, areaKm2: round(muniAreaKm2, 3), outerRings: outerRings.length, innerRings: innerRings.length };
  log(`municipality relation ${muniRelId}: ${round(muniAreaKm2, 2)} km²`);

  // -------------------------------------------------------------------------
  // 3. Zone partition (approximate) from OSM railway / roads
  // -------------------------------------------------------------------------
  const linesQ = await overpass(
    "zone-lines",
    '[out:json][timeout:180];(way["railway"="rail"](6.97,100.41,7.06,100.52);way["highway"]["name"~"^(ถนนเพชรเกษม|ถนนศรีภูวนารถ|ถนนกาญจนวณิชย์)$"](6.97,100.41,7.06,100.52););out body geom;',
  );
  const lw: any[] = linesQ.data.elements.filter((e: any) => e.type === "way" && Array.isArray(e.nodes));
  const rail = lw.filter((w) => w.tags.railway === "rail" && !w.tags.service);
  const phet = lw.filter((w) => w.tags.name === "ถนนเพชรเกษม" && w.tags.highway === "secondary");
  const sri = lw.filter((w) => w.tags.name === "ถนนศรีภูวนารถ");
  const kan = lw.filter((w) => w.tags.name === "ถนนกาญจนวณิชย์");
  const pick = (m: Map<number, [number, number]>, f: (a: [number, number], b: [number, number]) => boolean) => {
    let best: number | null = null;
    for (const [id, c] of m) if (best === null || f(c, m.get(best)!)) best = id;
    return best!;
  };
  // railway main line: northernmost node -> southernmost node of the Padang Besar line
  const railNodes = nodesOf(rail);
  const pbNodes = nodesOf(rail.filter((w) => /ปาดังเบซาร์|Padang Besar/i.test(w.tags.name ?? "")));
  const railStart = pick(railNodes, (a, b) => a[1] > b[1]);
  let railPath = pbNodes.size ? shortestPath(rail, railStart, pick(pbNodes, (a, b) => a[1] < b[1])) : null;
  if (!railPath) railPath = shortestPath(rail, railStart, (a, b) => a[1] < b[1]);
  // Phet Kasem (in-city, secondary): westernmost node -> junction with Kanchanawanit
  const phetNodes = nodesOf(phet);
  const kanNodes = nodesOf(kan);
  const junctions = [...phetNodes.keys()].filter((id) => kanNodes.has(id));
  const phetEnd = junctions.length ? junctions.reduce((a, b) => (phetNodes.get(a)![0] > phetNodes.get(b)![0] ? a : b)) : pick(phetNodes, (a, b) => a[0] > b[0]);
  // westernmost node connected to the junction (same-name pieces elsewhere are ignored), path reversed to run W->E
  const phetPath = shortestPath(phet, phetEnd, (a, b) => a[0] < b[0])?.reverse() ?? null;
  // Sri Phuwanat: westernmost -> easternmost; then Kanchanawanit from the node nearest that end -> southernmost
  const sriNodes = nodesOf(sri);
  const sriPath = shortestPath(sri, pick(sriNodes, (a, b) => a[0] < b[0]), (a, b) => a[0] > b[0]);
  const sriEndC = sriPath ? sriPath[sriPath.length - 1] : null;
  let kanSnap: number | null = null;
  let kanSnapDist = Infinity;
  if (sriEndC) for (const [id, c] of kanNodes) if (hav(c, sriEndC) < kanSnapDist) [kanSnap, kanSnapDist] = [id, hav(c, sriEndC)];
  const kanPath = kanSnap != null ? shortestPath(kan, kanSnap, (a, b) => a[1] < b[1]) : null;

  const zones: Record<number, Poly | null> = { 1: null, 2: null, 3: null, 4: null };
  const zoneDiag: any = {
    railPathPts: railPath?.length ?? 0,
    phetPathPts: phetPath?.length ?? 0,
    sriPathPts: sriPath?.length ?? 0,
    kanPathPts: kanPath?.length ?? 0,
    sriToKanSnapM: round(kanSnapDist, 1),
    phetEndOnKanchanawanit: junctions.length > 0,
  };
  let zoneMethodOk = !!(railPath && phetPath && sriPath && kanPath);
  if (zoneMethodOk) {
    const allPts = [...railPath!, ...phetPath!, ...sriPath!, ...kanPath!, ...turf.coordAll(muni)];
    const bb = turf.bbox(turf.multiPoint(allPts));
    const F = { minX: bb[0] - 0.01, minY: bb[1] - 0.01, maxX: bb[2] + 0.01, maxY: bb[3] + 0.01 };
    const ring = (pts: Position[]): Poly => {
      const r = turf.cleanCoords(turf.polygon([[...pts, pts[0]]])) as Feature<Polygon>;
      const k = turf.kinks(r);
      if (k.features.length) throw new Error(`half-plane polygon self-intersects (${k.features.length} kinks)`);
      return turf.rewind(r) as Poly;
    };
    const R = railPath!;
    const W = ring([[R[0][0], F.maxY], ...R, [R[R.length - 1][0], F.minY], [F.minX, F.minY], [F.minX, F.maxY]]);
    const P = phetPath!;
    const N = ring([[F.minX, P[0][1]], ...P, [F.maxX, P[P.length - 1][1]], [F.maxX, F.maxY], [F.minX, F.maxY]]);
    const Qp = [...sriPath!, ...kanPath!];
    const Q = ring([[F.minX, Qp[0][1]], ...Qp, [Qp[Qp.length - 1][0], F.minY], [F.minX, F.minY]]);
    const MN = inter(muni, N);
    const MS = diff(muni, N);
    zones[4] = inter(MN, W);
    zones[1] = diff(MN, W);
    const WQ = uni(W, Q);
    zones[3] = inter(MS, WQ);
    zones[2] = diff(MS, WQ);
    // Sliver clean-up: tiny/thin parts are merged into the neighbouring zone sharing the most boundary.
    const slivers: any[] = [];
    for (let pass = 0; pass < 2; pass++) {
      for (const z of [1, 2, 3, 4]) {
        const ps = parts(zones[z]);
        if (ps.length <= 1) continue;
        const keep: Feature<Polygon>[] = [];
        const biggest = Math.max(...ps.map((p) => turf.area(p)));
        for (const p of ps) {
          const a = turf.area(p);
          if (a === biggest || a > 20_000) {
            keep.push(p);
            continue;
          }
          const halo = turf.buffer(p, 3, { units: "meters" }) as Poly | undefined;
          if (!halo) {
            keep.push(p);
            continue;
          }
          let target = 0;
          let best = 0;
          for (const o of [1, 2, 3, 4]) {
            if (o === z) continue;
            const s = areaM2(inter(halo, zones[o]));
            if (s > best) [best, target] = [s, o];
          }
          if (!target) {
            keep.push(p);
            continue;
          }
          zones[target] = uni(zones[target], p);
          slivers.push({ fromZone: z, toZone: target, areaM2: round(a, 1) });
        }
        zones[z] = fromParts(keep);
      }
    }
    zoneDiag.sliversMerged = slivers;
  }
  // Tiling validation
  const zArea = Object.fromEntries([1, 2, 3, 4].map((z) => [z, areaM2(zones[z])]));
  let overlap = 0;
  for (const a of [1, 2, 3, 4]) for (const b of [1, 2, 3, 4]) if (a < b) overlap += areaM2(inter(zones[a], zones[b]));
  let unionAll: Poly | null = null;
  for (const z of [1, 2, 3, 4]) unionAll = uni(unionAll, zones[z]);
  const gap = areaM2(diff(muni, unionAll));
  const outside = areaM2(diff(unionAll, muni));
  zoneDiag.tiling = {
    municipalityAreaM2: round(areaM2(muni), 1),
    sumZoneAreaM2: round(Object.values(zArea).reduce((s, v) => s + v, 0), 1),
    pairwiseOverlapM2: round(overlap, 3),
    gapM2: round(gap, 3),
    outsideMunicipalityM2: round(outside, 3),
    partsPerZone: Object.fromEntries([1, 2, 3, 4].map((z) => [z, parts(zones[z]).length])),
  };
  zoneMethodOk = zoneMethodOk && [1, 2, 3, 4].every((z) => zones[z] && zArea[z] > 0);
  report.checks.zones = zoneDiag;

  const zoneMethod =
    "APPROXIMATE DEMONSTRATION PARTITION — not the official legal zone boundaries. Basis: the municipality's map 'แผนที่ชุมชนภายในเขตเทศบาลนครหาดใหญ่ จำนวน 103 ชุมชน' (PDF on hatyaicity.go.th/content/cate/259, revised 14 พ.ย. 2565) draws the limits of เขต 1-4 as thick lines along (a) the main southern railway line, (b) ถนนเพชรเกษม, and in the south-east (c) ถนนศรีภูวนารถ and (d) ถนนกาญจนวณิชย์; the community boundary announcements confirm these lines (e.g. ชุมชนบ้านพักรถไฟ, เขต 2: N ถนนเพชรเกษม, S ถนนศรีภูวนารถ, W แนวเขตรถไฟ; ชุมชนขนส่ง, เขต 3: E แนวถนนกาญจนวนิชย์). Deterministic construction: OSM ways (railway=rail without service tag; highway named ถนนเพชรเกษม [secondary], ถนนศรีภูวนารถ, ถนนกาญจนวณิชย์) are chained by shortest path over shared OSM nodes (gaps <= 120 m between way end nodes, e.g. unnamed roundabouts, are bridged by straight segments) (railway: northernmost node -> southernmost node of the Padang Besar line; ถนนเพชรเกษม: westernmost node connected to its junction with ถนนกาญจนวณิชย์ -> that junction; ถนนศรีภูวนารถ: westernmost node -> easternmost connected node, joined to the nearest ถนนกาญจนวณิชย์ node, then ถนนกาญจนวณิชย์ to its southernmost connected node), each path is closed into a half-plane polygon with a frame, and the OSM municipality polygon M is split: เขต4 = M∩N∩W, เขต1 = (M∩N)−W, เขต3 = (M−N)∩(W∪Q), เขต2 = (M−N)−(W∪Q), where N = north of ถนนเพชรเกษม, W = west of the railway main line, Q = south of ถนนศรีภูวนารถ and west of ถนนกาญจนวณิชย์. Parts < 20,000 m² that are not a zone's largest part are merged into the neighbouring zone with the largest shared 3 m halo. The tiling of M is verified in hatyai-ingest-report.json (checks.zones.tiling / tilingWritten): no overlaps, and gaps/outside areas only at coordinate-rounding level (a few m² in total out of ~20.9 km²). Validation only (not used to build the zones): named OSM landmarks whose zone can be read from the official 103-community map are tested against the partition (checks.zoneLandmarkValidation).";
  const zoneFeatures: Poly[] = [];
  for (const z of [1, 2, 3, 4]) {
    const zc = communities.filter((c) => c.zoneNo === z);
    const g = zones[z];
    if (!g) continue;
    const f = roundCoords(g, 7);
    const anchor = interiorAnchor(f, 6);
    zoneFeatures.push({
      ...f,
      properties: {
        id: `hy-z${z}`,
        zoneNo: z,
        nameTh: `เขต ${z}`,
        nameEn: `Zone ${z}`,
        nameThOfficialAlt: `เขตที่ ${"๑๒๓๔"[z - 1]} (เขตเลือกตั้ง)`,
        geometryStatus: "approximate",
        communityCount: zc.length,
        method: zoneMethod,
        sourceId: "hatyai-zones-approx",
        areaKm2: round(zArea[z] / 1e6, 3),
        anchor,
        anchorMethod: "interior label point: rounded centroid if inside and >= 150 m from the zone edge, else the farthest-from-edge point of a 60x60 grid over the zone bbox",
      },
    });
  }
  writeJson(path.join(PUBLIC_HY, "zones.geojson"), turf.featureCollection(zoneFeatures));
  // Tiling re-checked on the geometries exactly as written (coordinates rounded to 1e-7 deg ≈ 1 cm).
  {
    let ov = 0;
    for (let i = 0; i < zoneFeatures.length; i++) for (let k = i + 1; k < zoneFeatures.length; k++) ov += areaM2(inter(zoneFeatures[i], zoneFeatures[k]));
    let un: Poly | null = null;
    for (const f of zoneFeatures) un = uni(un, f);
    zoneDiag.tilingWritten = {
      note: "Same checks on the published (rounded) coordinates; residual gap/outside areas are rounding slivers along shared edges.",
      sumZoneAreaM2: round(zoneFeatures.reduce((t, f) => t + areaM2(f), 0), 1),
      pairwiseOverlapM2: round(ov, 3),
      gapM2: round(areaM2(diff(muni, un)), 3),
      outsideMunicipalityM2: round(areaM2(diff(un, muni)), 3),
      anchorsInside: zoneFeatures.every((f) => turf.booleanPointInPolygon(turf.point(f.properties!.anchor), f, { ignoreBoundary: true })),
    };
  }
  const zoneOf = (pt: [number, number]) => {
    for (const f of zoneFeatures) if (turf.booleanPointInPolygon(turf.point(pt), f)) return f.properties!.zoneNo as number;
    return null;
  };

  // -------------------------------------------------------------------------
  // 4. Community point locations (only verifiable OSM name matches)
  // -------------------------------------------------------------------------
  const bbM = turf.bbox(muni);
  const cq = await overpass(
    "community-candidates",
    `[out:json][timeout:120];(nwr["name"~"ชุมชน"](${bbM[1] - 0.005},${bbM[0] - 0.005},${bbM[3] + 0.005},${bbM[2] + 0.005});nwr["place"](${bbM[1] - 0.005},${bbM[0] - 0.005},${bbM[3] + 0.005},${bbM[2] + 0.005});nwr["amenity"="community_centre"](${bbM[1] - 0.005},${bbM[0] - 0.005},${bbM[3] + 0.005},${bbM[2] + 0.005}););out tags center;`,
  );
  const pointMatches: any[] = [];
  const rejected: any[] = [];
  for (const e of cq.data?.elements ?? []) {
    const nm: string | undefined = e.tags?.name;
    if (!nm) continue;
    const lon = e.lon ?? e.center?.lon;
    const lat = e.lat ?? e.center?.lat;
    if (lon == null || lat == null) continue;
    const kName = markKey(nm);
    const inside = turf.booleanPointInPolygon(turf.point([lon, lat]), muni);
    let matched = false;
    for (const c of communities) {
      const kFull = markKey(c.nameTh);
      const kBare = stripPrefix(kFull);
      const isPlace = !!e.tags.place;
      let method: string | null = null;
      if (kName.includes(kFull)) method = "osm-name-contains-full-official-community-name";
      else if (isPlace && (kName === kBare || kName === kFull)) method = "osm-place-name-equals-official-community-name";
      if (method) {
        matched = true;
        const z = zoneOf([lon, lat]);
        pointMatches.push({ community: c, e, lon, lat, inside, method, approxZone: z });
      } else if (kBare.length >= 4 && kName.includes(kBare)) {
        rejected.push({
          osmId: `${e.type}/${e.id}`,
          osmName: nm,
          tags: { place: e.tags.place ?? null, amenity: e.tags.amenity ?? null },
          nearCommunity: c.nameTh,
          insideMunicipality: inside,
          reason: "name only shares the bare place name (no 'ชุมชน…' match); a village/facility name is not evidence of the community's location",
        });
      }
    }
    if (!matched && /ชุมชน/.test(nm) && !rejected.some((r) => r.osmId === `${e.type}/${e.id}`))
      rejected.push({ osmId: `${e.type}/${e.id}`, osmName: nm, tags: { place: e.tags.place ?? null, amenity: e.tags.amenity ?? null }, nearCommunity: null, insideMunicipality: inside, reason: "contains the generic word ชุมชน but no official community name" });
  }
  const pointFeatures = pointMatches
    .filter((m) => m.inside)
    .map((m) =>
      turf.point([round(m.lon, 7), round(m.lat, 7)], {
        id: m.community.id,
        zoneNo: m.community.zoneNo,
        zoneId: m.community.zoneId,
        nameTh: m.community.nameTh,
        nameEn: null,
        osmId: `${m.e.type}/${m.e.id}`,
        osmName: m.e.tags.name,
        osmTags: { amenity: m.e.tags.amenity ?? null, healthcare: m.e.tags.healthcare ?? null, place: m.e.tags.place ?? null },
        matchMethod: m.method,
        locationKind:
          m.e.tags.place ? "osm-place-node" : "community-facility: OSM feature whose name contains the official community name (not a surveyed community centroid)",
        insideMunicipality: m.inside,
        approxZoneNo: m.approxZone,
        consistentWithOfficialZone: m.approxZone === m.community.zoneNo,
        geometryStatus: "osm",
        sourceId: "osm-hatyai-community-features",
        license: "ODbL-1.0 © OpenStreetMap contributors",
      }),
    );
  // Staged only: the public communities.geojson (all 103 communities, verified + labelled illustrative points)
  // is written by scripts/data/fetch-hatyai-community-locations.ts, which must run after this script.
  writeJson(path.join(STAGED, "hatyai-community-osm-candidates.geojson"), turf.featureCollection(pointFeatures));
  for (const c of communities) {
    const m = pointMatches.find((x) => x.community.id === c.id && x.inside);
    c.location = m
      ? { status: "osm", lon: round(m.lon, 7), lat: round(m.lat, 7), osmId: `${m.e.type}/${m.e.id}`, osmName: m.e.tags.name, matchMethod: m.method, approxZoneNo: m.approxZone }
      : { status: "unavailable", note: "no authoritative coordinate and no OSM feature with a matching name; not geocoded" };
  }
  report.checks.communityPoints = { candidatesReturned: (cq.data?.elements ?? []).length, matchedInside: pointFeatures.length, rejected };

  // ---- validation of the approximate zones with named landmarks (check only) ----
  const vq = await overpass(
    "zone-validation-pois",
    `[out:json][timeout:120];nwr["name"~"^(วัดโคกสมานคุณ|วัดหาดใหญ่ใน|วัดคลองเรียน|วัดปลักกริม|สนามกีฬาจิระนคร|โรงเรียนหาดใหญ่วิทยาลัย|โรงพยาบาลหาดใหญ่|สำนักงานเทศบาลนครหาดใหญ่|ตลาดกิมหยง)$"](${bbM[1]},${bbM[0]},${bbM[3]},${bbM[2]});out tags center;`,
  );
  // Expected zone = zone of the community whose area contains the landmark label on the official 103-community map.
  const expected: Record<string, { zone: number; why: string }> = {
    วัดโคกสมานคุณ: { zone: 4, why: "inside map polygon 100 ชุมชนวัดโคกสมานคุณ (เขต 4)" },
    วัดหาดใหญ่ใน: { zone: 4, why: "label inside map polygon 101 ชุมชนวัดหาดใหญ่ใน (เขต 4)" },
    วัดคลองเรียน: { zone: 2, why: "label inside map polygon 53 ชุมชนทุ่งคลองเรียน (เขต 2)" },
    วัดปลักกริม: { zone: 3, why: "boundary of ชุมชนดีแลนด์-ไทยเจริญ / ชุมชนปลักกริม (เขต 3)" },
    สนามกีฬาจิระนคร: { zone: 1, why: "label inside map polygon 16 ชุมชนหลังสนามกีฬากลาง (เขต 1)" },
    โรงเรียนหาดใหญ่วิทยาลัย: { zone: 1, why: "label inside map polygon 17 (เขต 1)" },
    โรงพยาบาลหาดใหญ่: { zone: 1, why: "label 'ร.พ.หาดใหญ่' inside map polygon 20 ชุมชนป้อม 6 (เขต 1)" },
    สำนักงานเทศบาลนครหาดใหญ่: { zone: 1, why: "label inside map polygon 18 ชุมชนศรีนิล (เขต 1)" },
    ตลาดกิมหยง: { zone: 2, why: "ชุมชนกิมหยงสันติสุข / ชุมชนซีกิมหยง are in เขต 2" },
  };
  const valid = (vq.data?.elements ?? [])
    .map((e: any) => {
      const lon = e.lon ?? e.center?.lon;
      const lat = e.lat ?? e.center?.lat;
      const z = lon != null ? zoneOf([lon, lat]) : null;
      const ex = expected[e.tags.name];
      return { osmId: `${e.type}/${e.id}`, name: e.tags.name, lon, lat, approxZone: z, expectedZone: ex?.zone ?? null, why: ex?.why ?? null, agrees: ex ? z === ex.zone : null };
    })
    .sort((a: any, b: any) => (a.name + a.osmId).localeCompare(b.name + b.osmId));
  report.checks.zoneLandmarkValidation = {
    note: "Landmarks are NOT used to build the zones; they only test the approximate partition against labels on the official 103-community map.",
    results: valid,
    agree: valid.filter((v: any) => v.agrees === true).length,
    disagree: valid.filter((v: any) => v.agrees === false).length,
  };

  // ---- staged communities JSON ----
  const zoneSummaries = [1, 2, 3, 4].map((z) => {
    const zc = communities.filter((c) => c.zoneNo === z);
    const withPop = zc.filter((c) => c.stats.status === "observed" && c.stats.population != null);
    const withHh = zc.filter((c) => c.stats.status === "observed" && c.stats.households != null);
    const withArea = zc.filter((c) => c.stats.status === "observed" && c.stats.areaM2 != null);
    return {
      zoneNo: z,
      id: `hy-z${z}`,
      nameTh: `เขต ${z}`,
      nameEn: `Zone ${z}`,
      communityCount: zc.length,
      communityCountStatedInAnnouncement: { 1: 28, 2: 29, 3: 25, 4: 21 }[z],
      printedPopulationSum: withPop.reduce((s, c) => s + c.stats.population, 0),
      communitiesWithPrintedPopulation: withPop.length,
      printedHouseholdsSum: withHh.reduce((s, c) => s + c.stats.households, 0),
      communitiesWithHouseholds: withHh.length,
      printedAreaSumKm2: round(withArea.reduce((s, c) => s + c.stats.areaM2, 0) / 1e6, 3),
      communitiesWithArea: withArea.length,
      note: "Sums of figures printed in the 2022-2023 community-boundary announcements; communities with a missing or malformed total are excluded from the population sum (see per-community anomalies). Status: derived.",
    };
  });
  writeJson(path.join(STAGED, "hatyai-communities.json"), {
    generatedAt: RUN_STARTED,
    municipality: { nameTh: "เทศบาลนครหาดใหญ่", nameEn: "Hat Yai City Municipality", province: "Songkhla (สงขลา)" },
    structure: {
      zoneTermTh: "เขต",
      zoneNamesTh: ["เขต 1", "เขต 2", "เขต 3", "เขต 4"],
      zoneTermNotes:
        "The community lists (cate/258) and the zone map (cate/259) name the zones 'เขต 1'…'เขต 4'. The 2022-2023 announcements state that the municipality consists of 4 electoral districts (ประกอบด้วยพื้นที่การเลือกตั้ง ๔ เขตเลือกตั้ง ๑๐๓ ชุมชน) and number them 'เขตที่ ๑'…'เขตที่ ๔'. 'Zone N' is our English rendering.",
      totalCommunities: totalListed,
      totalStatedInMapTitle: mapTotal,
      perZone: Object.fromEntries(official.zones.map((z: any) => [z.zoneNo, z.communities.length])),
      perZoneStatedInAnnouncements: { 1: 28, 2: 29, 3: 25, 4: 21 },
      countsVerified: totalListed === 103 && mapTotal === 103,
    },
    zones: zoneSummaries,
    communities,
    sources: {
      list: { page: "https://www.hatyaicity.go.th/content/cate/258", pdfs: Object.fromEntries(Object.entries(chairmenPdf).map(([k, v]) => [k, v.url])), referenceDate: "2026-10-01", chairmenPdfMeta: chairmenMeta },
      boundaryNotices: { page: "https://www.hatyaicity.go.th/content/cate/259", pdfs: Object.fromEntries(Object.entries(noticePdf).map(([k, v]) => [k, v.url])), announcements: noticeMeta },
      map: { url: mapUrl, titleTh: "แผนที่ชุมชนภายในเขตเทศบาลนครหาดใหญ่ จำนวน 103 ชุมชน", revisedTh: "ปรับปรุงเมื่อ 14 พ.ย. 2565", revised: "2022-11-14" },
      manualInputs: ["data/manual/hatyai-communities-official-list.json", "data/manual/hatyai-boundary-notice-transcriptions.json"],
    },
    privacy: "Chairperson names and phone numbers present in the source PDFs are intentionally not reproduced.",
    limitations: [
      "nameEn is null: the municipality publishes no English community names.",
      "Community figures come from the boundary announcements (Nov 2022 - May 2023); the reference date and counting method are not stated in the documents and the figures are not DOPA registration counts.",
      "All 28 zone-1 information pages and 23 of the 24 zone-3 information pages are scanned images; their figures (51 communities) are manual transcriptions (checked with total = male + female). Zones 2 and 4 and the first zone-3 page are parsed from the PDF text layer (51 communities).",
      "ชุมชนรัตนวิบูลย์ (เขต 3) has a map page but no information page in the announcement: statistics unavailable.",
      "Only communities with an OSM feature whose name contains the official community name have a point; no geocoding by guesswork.",
    ],
  });

  // -------------------------------------------------------------------------
  // 5. Population (DOPA registration statistics)
  // -------------------------------------------------------------------------
  const dopaDir = path.join(RAW, "dopa", "hatyai");
  await getFile({ key: "dopa-index", url: "https://stat.bora.dopa.go.th/new_stat/webPage/statByYear.php", file: path.join(dopaDir, "stat_index.html") });
  const idxHtml = fs.existsSync(path.join(dopaDir, "stat_index.html")) ? fs.readFileSync(path.join(dopaDir, "stat_index.html"), "utf8") : "";
  const years = [...new Set([...idxHtml.matchAll(/file\/(\d\d)\/stat_a\1\.txt/g)].map((m) => Number(m[1])))].sort((a, b) => b - a);
  const useYears = (years.length ? years : [68, 67, 66, 65, 64]).slice(0, 5);
  const dopaRows: any[] = [];
  for (const yy of useYears) {
    const file = path.join(dopaDir, `stat_a${yy}.txt`);
    const url = `https://stat.bora.dopa.go.th/new_stat/file/${yy}/stat_a${yy}.txt`;
    await getFile({ key: `dopa-stat_a${yy}`, url, file });
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    let txt = buf.toString("utf8");
    if (txt.includes("�")) txt = new TextDecoder("windows-874").decode(buf); // TIS-620 fallback
    for (const line of txt.replace(/^﻿/, "").split(/\r?\n/)) {
      const c = line.split("|");
      if (c[3] === "9098" && /เทศบาลนครหาดใหญ่/.test(c[4] ?? "")) {
        const yymm = c[0];
        const be = 2500 + Number(yymm.slice(0, 2));
        const mm = Number(yymm.slice(2, 4));
        const y = be2ce(be);
        const lastDay = new Date(Date.UTC(y, mm, 0)).getUTCDate();
        dopaRows.push({
          yymm,
          referenceDate: `${y}-${String(mm).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
          referenceYear: y,
          beYear: be,
          provinceTh: c[2].trim(),
          registrationOfficeCode: c[3],
          registrationOfficeTh: c[4].trim(),
          male: num(c[9]),
          female: num(c[10]),
          total: num(c[11]),
          houses: num(c[12]),
          sourceUrl: url,
          retrievedAt: fetchLog[`dopa-stat_a${yy}`]?.retrievedAt ?? null,
        });
      }
    }
  }
  dopaRows.sort((a, b) => b.yymm.localeCompare(a.yymm));
  const latest = dopaRows[0] ?? null;
  const commPopSum = zoneSummaries.reduce((s, z) => s + z.printedPopulationSum, 0);
  const pmcPop = 191696;
  writeJson(path.join(STAGED, "hatyai-population.json"), {
    generatedAt: RUN_STARTED,
    municipality: {
      nameTh: "เทศบาลนครหาดใหญ่",
      nameEn: "Hat Yai City Municipality",
      latest: latest
        ? {
            value: latest.total,
            unit: "persons",
            provenance: {
              status: "observed",
              sourceId: "dopa-stat-population",
              sourceName: "Department of Provincial Administration (DOPA) — registered population by registration office",
              sourceUrl: latest.sourceUrl,
              observedTo: latest.referenceDate,
              referenceYear: latest.referenceYear,
              geographicScope: "Registration office 9098 ท้องถิ่นเทศบาลนครหาดใหญ่ (Hat Yai City Municipality local registration office)",
              methodology: "Civil-registration count (persons with house registration in the municipality) at the end of the reference month (YYMM field).",
              limitations: ["Registered (de jure) population; excludes unregistered residents, students, migrant workers and tourists."],
            },
          }
        : null,
      timeSeries: dopaRows,
      density:
        latest && muniAreaKm2
          ? {
              valuePerKm2OsmArea: round(latest.total / muniAreaKm2, 1),
              valuePerKm2OfficialArea: round(latest.total / 21, 1),
              unit: "persons/km²",
              status: "derived",
              method: `DOPA total (${latest.referenceDate}) / area; OSM polygon area ${round(muniAreaKm2, 3)} km² or official 21 km²`,
            }
          : null,
      otherClaims: [
        {
          value: pmcPop,
          unit: "persons",
          referenceYear: 2024,
          status: "estimated",
          source: "PMC12247160 (RSC Advances 2025) citing 'Department of Provincial Administration, Statistical Yearbook Thailand 2024'",
          assessment: latest
            ? `Inconsistent with DOPA registered population for the same registration office (${dopaRows.find((r) => r.referenceYear === 2024)?.total ?? "n/a"} at 2024-12-31). Not used.`
            : "Not used.",
        },
        {
          value: null,
          unit: "persons/km²",
          status: "unavailable",
          source: "https://www.hatyaicity.go.th/content/general",
          assessment: "Municipality 'ข้อมูลพื้นฐาน' page (marked 'อยู่ระหว่างปรับปรุงข้อมูล') states ~20,000 persons/km² in the centre and ~7,542 persons/km² on average over 21 km² without a reference year; no population figure is given. Recorded as text only.",
        },
      ],
    },
    zones: zoneSummaries.map((z) => ({
      id: z.id,
      zoneNo: z.zoneNo,
      nameTh: z.nameTh,
      population: {
        value: z.printedPopulationSum,
        unit: "persons",
        provenance: {
          status: "derived",
          sourceId: "hatyaicity-boundary-notices",
          referenceYear: z.zoneNo === 2 ? 2022 : 2023,
          methodology: `Sum of the populations printed for ${z.communitiesWithPrintedPopulation} of ${z.communityCount} communities in the community-boundary announcement of เขต ${z.zoneNo}.`,
          limitations: ["Announcement figures, not DOPA registration counts; reference date not stated; some communities missing or malformed."],
        },
      },
      households: { value: z.printedHouseholdsSum, unit: "households", communities: z.communitiesWithHouseholds },
    })),
    communityPopulationSum: {
      value: commPopSum,
      unit: "persons",
      status: "derived",
      note: `Sum over communities with a printed total. Compare DOPA registered population ${dopaRows.find((r) => r.referenceYear === 2022)?.total ?? "n/a"} (2022-12-31) and ${dopaRows.find((r) => r.referenceYear === 2023)?.total ?? "n/a"} (2023-12-31).`,
    },
    communities: "Per-community population/households: see data/staged/hatyai-communities.json (communities[].stats).",
  });

  // -------------------------------------------------------------------------
  // 6. Waste
  // -------------------------------------------------------------------------
  const dgDir = path.join(RAW, "datagoth", "hatyai");
  await getFile({ key: "datagoth-dataset_sw_02", url: "https://data.go.th/api/3/action/package_show?id=dataset_sw_02", file: path.join(dgDir, "pkg-dataset_sw_02.json"), validate: notHtml });
  let sw02: any = null;
  try {
    sw02 = readJson(path.join(dgDir, "pkg-dataset_sw_02.json")).result;
  } catch {}
  let sw02Rows: string[][] = [];
  if (sw02?.resources?.[0]?.url) {
    await getFile({ key: "datagoth-dataset_sw_02-csv", url: sw02.resources[0].url, file: path.join(dgDir, "nst-dataset_sw_02.csv"), validate: notHtml });
    if (fs.existsSync(path.join(dgDir, "nst-dataset_sw_02.csv"))) sw02Rows = parseCsv(fs.readFileSync(path.join(dgDir, "nst-dataset_sw_02.csv"), "utf8"));
  }
  await getFile({ key: "songkhla-dataset_sw_02", url: "https://songkhla.gdcatalog.go.th/api/3/action/package_show?id=dataset_sw_02", file: path.join(dgDir, "songkhla-pkg-dataset_sw_02.json"), retries: 0 });
  const skPkgs: Record<string, any> = {};
  for (const id of ["dataset_10_27", "dataset_10_33", "dataset_10_34", "dataset_10_37"]) {
    await getFile({ key: `songkhla-${id}`, url: `https://songkhla.gdcatalog.go.th/api/3/action/package_show?id=${id}`, file: path.join(dgDir, `songkhla-pkg-${id}.json`), validate: notHtml });
    try {
      skPkgs[id] = readJson(path.join(dgDir, `songkhla-pkg-${id}.json`)).result;
    } catch {
      skPkgs[id] = null;
    }
  }
  const resFile: Record<string, string> = {
    dataset_10_27: "songkhla-waste-happen.csv",
    dataset_10_33: "songkhla-waste-remove-2564-2567.csv",
    dataset_10_34: "songkhla-recycle.csv",
    dataset_10_37: "songkhla-status-waste.csv",
  };
  const resPick: Record<string, (r: any) => boolean> = {
    dataset_10_27: () => true,
    dataset_10_33: (r) => /2564\s*-\s*2567/.test(r.name ?? ""),
    dataset_10_34: () => true,
    dataset_10_37: () => true,
  };
  const csv: Record<string, string[][]> = {};
  const resMeta: Record<string, any> = {};
  for (const id of Object.keys(resFile)) {
    const res = (skPkgs[id]?.resources ?? []).find(resPick[id]) ?? skPkgs[id]?.resources?.[0];
    const fallback: Record<string, string> = {
      dataset_10_27: "https://songkhla.gdcatalog.go.th/dataset/60342451-0da6-49f5-bcc6-aec5a2718590/resource/437f6ccb-3dd7-47ad-a921-2c0af1babb4b/download/waste.happen.csv",
      dataset_10_33: "https://songkhla.gdcatalog.go.th/dataset/b7ddcc41-80ff-48c1-8aca-e7b4a295e26c/resource/0ba29841-bc8d-4d7d-85ec-e292544cc531/download/waste.remove.csv",
      dataset_10_34: "https://songkhla.gdcatalog.go.th/dataset/6d87a941-36e5-4406-8422-f2d7496ad8da/resource/c70d1b44-975e-4143-bf29-35296c9150d5/download/recycle.csv",
      dataset_10_37: "https://songkhla.gdcatalog.go.th/dataset/ed53a742-d3c3-4606-9cea-934f2fe145c1/resource/cef85076-4bf1-4172-9dea-b1157689d31e/download/status.waste-.csv",
    };
    const url = res?.url ?? fallback[id];
    resMeta[id] = { url, name: res?.name ?? null, lastModified: res?.last_modified ?? null, title: skPkgs[id]?.title ?? null, license: skPkgs[id]?.license_title ?? null, organization: skPkgs[id]?.organization?.title ?? null, dataSource: skPkgs[id]?.data_source ?? null, geoCoverage: skPkgs[id]?.geo_coverage ?? null };
    const f = path.join(dgDir, resFile[id]);
    await getFile({ key: `songkhla-${id}-csv`, url, file: f, validate: notHtml });
    csv[id] = fs.existsSync(f) ? parseCsv(fs.readFileSync(f, "utf8")) : [];
  }
  const HY = "เทศบาลนครหาดใหญ่";
  const perDay = (tPerYear: number | null, fyBe: number) => {
    if (tPerYear == null) return null;
    return round(tPerYear / thaiFiscalYear(fyBe).days, 2);
  };
  const genRows = csv.dataset_10_27.slice(1).filter((r) => r[3] === HY);
  const colRows = csv.dataset_10_33.slice(1).filter((r) => r[3] === HY);
  const useRows = csv.dataset_10_34.slice(1).filter((r) => r[2] === HY);
  const popAt = (ceYear: number) => dopaRows.find((r) => r.referenceYear === ceYear)?.total ?? null;
  const generated = genRows.map((r) => {
    const fy = Number(r[0]);
    const t = num(r[5]);
    const fyr = thaiFiscalYear(fy);
    const pd = perDay(t, fy);
    const p = popAt(be2ce(fy) - 1); // DOPA at 31 Dec inside the fiscal year
    return {
      fiscalYearBE: fy,
      observedFrom: fyr.from,
      observedTo: fyr.to,
      metric: r[4],
      definition: "ปริมาณขยะมูลฝอยชุมชนที่เกิดขึ้น — municipal solid waste GENERATED in the LAO area, as reported by the LAO in the DLA solid-waste survey",
      valueTonPerYear: t,
      unitPublished: r[6],
      status: t == null ? "unavailable" : "observed",
      derivedTonPerDay: pd,
      derivedKgPerCapitaDay: pd != null && p ? round((pd * 1000) / p, 3) : null,
      perCapitaDenominator: p ? { dopaRegisteredPopulation: p, referenceDate: `${be2ce(fy) - 1}-12-31` } : null,
    };
  });
  const collected = colRows
    .filter((r) => r[6] === "ปริมาณขยะมูลฝอยชุมชนที่เก็บขนได้ในเขต อปท.")
    .map((r) => {
      const fy = Number(r[0]);
      const t = num(r[7]);
      const fyr = thaiFiscalYear(fy);
      return {
        fiscalYearBE: fy,
        observedFrom: fyr.from,
        observedTo: fyr.to,
        metric: r[6],
        definition: "ปริมาณขยะมูลฝอยชุมชนที่เก็บขนได้ในเขต อปท. — waste COLLECTED (and transported to disposal) within the LAO area",
        valueTonPerYear: t,
        unitPublished: r[8],
        status: t == null ? "unavailable" : "observed",
        derivedTonPerDay: perDay(t, fy),
        householdsServedPublished: num(r[4]),
        householdsServedNote:
          num(r[4]) != null
            ? `Column 'ครัวเรือนรับเก็บขยะ' = ${r[4]} — implausible as a household count (DOPA lists ~${dopaRows.find((d) => d.referenceYear === be2ce(fy))?.houses ?? "70,000"} houses); kept as published, not used.`
            : null,
        publisher: r[9],
      };
    });
  const otherCollectedRows = colRows.filter((r) => r[6] !== "ปริมาณขยะมูลฝอยชุมชนที่เก็บขนได้ในเขต อปท.").map((r) => ({ fiscalYearBE: Number(r[0]), metric: r[6], valueTonPerYear: num(r[7]), unit: r[8] }));
  const utilized = useRows.map((r) => {
    const fy = Number(r[4]);
    const t = num(r[5]);
    const fyr = thaiFiscalYear(fy);
    return {
      fiscalYearBE: fy,
      observedFrom: fyr.from,
      observedTo: fyr.to,
      metric: r[3],
      definition: "ปริมาณขยะมูลฝอยที่ถูกนำไปใช้ประโยชน์ — waste UTILISED (recycling/composting/energy), as reported by the LAO",
      valueTonPerYear: t,
      unitPublished: r[6],
      status: t == null ? "unavailable" : "observed",
      derivedTonPerDay: perDay(t, fy),
    };
  });
  const provRows = csv.dataset_10_37.slice(1).map((r) => ({
    yearBE: Number(r[0]),
    referenceYear: be2ce(Number(r[0])),
    metric: r[1],
    value: num(r[2]),
    unit: r[3],
    publisher: r[4],
    scope: "Songkhla province (all LAOs)",
  }));
  // PMC article
  const pmcFile = path.join(RAW, "pmc", "hatyai", "PMC12247160-efetch.xml");
  await getFile({
    key: "pmc-efetch",
    url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=12247160&retmode=xml",
    file: pmcFile,
    validate: (b) => (b.toString("utf8").includes("<article") ? null : "no <article>"),
  });
  // Article HTML: only as a cross-check of the XML (a CAPTCHA page is never retried or bypassed).
  const pmcHtmlFile = path.join(RAW, "pmc", "hatyai", "PMC12247160.html");
  // the record is kept in fetchLog / the manifest by getFile itself
  await getFile({
    key: "pmc-html",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC12247160/",
    file: pmcHtmlFile,
    retries: 0,
    validate: noCaptcha,
  });
  let pmc: any = { status: "unavailable" };
  if (fs.existsSync(pmcFile)) {
    const x = fs.readFileSync(pmcFile, "utf8");
    const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const meta = x.match(/<article-meta>[\s\S]*?<\/article-meta>/)?.[0] ?? "";
    const body = strip(x.match(/<body>[\s\S]*?<\/body>/)?.[0] ?? "");
    // sentence containing `core`; a '.' followed by a digit (decimal point, e.g. "21.00") does not end a sentence
    const sentenceWith = (core: string) => body.match(new RegExp(`(?:[^.]|\\.(?=\\d))*${core}(?:[^.]|\\.(?=\\d))*\\.`))?.[0]?.trim() ?? null;
    const sentence = sentenceWith("237\\.75");
    const sentencePop = sentenceWith("Covering an area of");
    const compSentence = sentenceWith("The major components of the municipal waste stream");
    const htmlHasClaim = fs.existsSync(pmcHtmlFile) && noCaptcha(fs.readFileSync(pmcHtmlFile)) === null && fs.readFileSync(pmcHtmlFile, "utf8").includes("237.75");
    const pop2024 = dopaRows.find((r) => r.referenceYear === 2024)?.total ?? null;
    const gen2565 = generated.find((g) => g.fiscalYearBE === 2565 && g.derivedTonPerDay != null) ?? null;
    const refs: Record<string, string> = {};
    for (const m of x.matchAll(/<ref id="(cit3[0-5])"[^>]*>([\s\S]*?)<\/ref>/g)) refs[m[1]] = strip(m[2]);
    const tableCaps = [...x.matchAll(/<table-wrap[\s\S]*?<caption>([\s\S]*?)<\/caption>/g)].map((m) => strip(m[1]));
    pmc = {
      status: sentence ? "verified-statement" : "statement-not-found",
      citation: {
        authors: [...meta.matchAll(/<surname>([^<]+)<\/surname>\s*<given-names[^>]*>([^<]+)<\/given-names>/g)].map((m) => `${m[2]} ${m[1]}`),
        title: strip(meta.match(/<article-title>([\s\S]*?)<\/article-title>/)?.[1] ?? ""),
        journal: strip(x.match(/<journal-title>([\s\S]*?)<\/journal-title>/)?.[1] ?? ""),
        volume: meta.match(/<volume>(\d+)<\/volume>/)?.[1] ?? null,
        issue: meta.match(/<issue>(\d+)<\/issue>/)?.[1] ?? null,
        pages: `${meta.match(/<fpage>(\d+)<\/fpage>/)?.[1] ?? ""}-${meta.match(/<lpage>(\d+)<\/lpage>/)?.[1] ?? ""}`,
        doi: meta.match(/<article-id pub-id-type="doi">([^<]+)<\/article-id>/)?.[1] ?? null,
        pmcid: "PMC12247160",
        pmid: meta.match(/<article-id pub-id-type="pmid">([^<]+)<\/article-id>/)?.[1] ?? null,
        published: meta.match(/date-type="pub" iso-8601-date="([\d-]+)"/)?.[1] ?? null,
        license: meta.match(/<ext-link[^>]*xlink:href="(https:\/\/creativecommons\.org\/licenses\/[^"]+)"/)?.[1] ?? strip(meta.match(/<license[\s\S]*?<\/license>/)?.[0] ?? ""),
      },
      householdWasteClaim: {
        value: 237.75,
        unit: "t/day",
        quote: sentence,
        quoteLocation: "Section 2.1 'Site specification' (efetch XML body); the same sentence is present in the article HTML: " + (htmlHasClaim ? "yes" : "not checked (HTML not cached)"),
        kind: "household waste generation as worded ('The city produces approximately 237.75 tons of household waste per day') — 'generated', not 'collected'",
        citedSource: refs.cit32 ?? null,
        citedReportYear: 2024,
        studyPeriod: null,
        referencePeriodNote:
          "Not stated. The article (published 2025-07-11) gives no reference date/period for the figure; it cites a municipal report titled 'Annual Waste Management Report 2024' (in Thai), so the figure presumably refers to 2024 or FY2567, but the article does not say so.",
        scope:
          "Hat Yai Municipality ('the city' in the site description of Hat Yai Municipality, 21.00 km²), household waste only; whether commercial/tourism waste is included is not stated.",
        methodology: null,
        methodologyNote:
          "Not stated: no weighing, sampling or per-capita factor is described for this number. It is background information in the site description, not a result of the study (which characterises commercial PE/PP/PET/PVC and PE recovered from a local landfill in Songkhla province).",
        status: "estimated",
        assessment:
          "Secondary citation only: verified that the article states 237.75 t/day and attributes it to 'Hat Yai Municipality, Annual Waste Management Report 2024 [in Thai]' (reference 32), which we could not locate online. Use as an 'estimated' (cited) generation figure with this caveat, never as 'observed'.",
        context: {
          status: "derived",
          kgPerCapitaDayUsingDopa2024: pop2024 ? round((237.75 * 1000) / pop2024, 3) : null,
          dopa2024RegisteredPopulation: pop2024,
          kgPerCapitaDayUsingArticlePopulation: round((237.75 * 1000) / pmcPop, 3),
          articlePopulation2024: pmcPop,
          songkhlaCatalogGeneratedFY2565TonPerDay: gen2565?.derivedTonPerDay ?? null,
          note: gen2565
            ? `For comparison only. The LAO survey (Songkhla catalog dataset_10_27) reports ${gen2565.valueTonPerYear} t/year generated in FY2565 (${gen2565.observedFrom}..${gen2565.observedTo}) = ${gen2565.derivedTonPerDay} t/day (derived); definitions and years differ, so the two figures are not interchangeable.`
            : "For comparison only.",
        },
      },
      populationClaim: { quote: sentencePop, citedSource: refs.cit30 ?? null },
      composition: {
        status: "unavailable",
        shares: null,
        quote: compSentence,
        citedSource: refs.cit33 ?? null,
        assessment:
          "No composition table for Hat Yai exists in the article; tables present: " +
          tableCaps.join(" | ") +
          ". The text only ranks components qualitatively (organic largest, then plastic, then glass and metal) citing a regional UNEP outlook. No percentage shares can be mapped to organic/plastic/paper/glassMetal/hazardous/other.",
        categoryMappingIfAvailable: { organic: "food scraps + garden residues", plastic: "plastic", paper: "paper/cardboard", glassMetal: "glass + metal", hazardous: "household hazardous", other: "all remaining" },
      },
      references: refs,
    };
  }
  const sw02Hdr = sw02Rows[0] ?? [];
  writeJson(path.join(STAGED, "hatyai-waste.json"), {
    generatedAt: RUN_STARTED,
    principle: "Generated, collected and utilised waste are different quantities and are kept strictly separate; derived t/day = published t/year ÷ days in the Thai fiscal year (Oct 1 - Sep 30).",
    datagoth_dataset_sw_02: {
      status: "not-applicable-to-hat-yai",
      packageUrl: "https://data.go.th/api/3/action/package_show?id=dataset_sw_02",
      title: sw02?.title ?? null,
      organization: sw02?.organization?.title ?? null,
      notes: sw02?.notes ?? null,
      geoCoverage: sw02?.geo_coverage ?? null,
      license: sw02?.license_title ?? null,
      dataYearBE: sw02?.last_year_of_data ?? null,
      dataSource: sw02?.data_source ?? null,
      resourceUrl: sw02?.resources?.[0]?.url ?? null,
      resourceLastModified: sw02?.resources?.[0]?.last_modified ?? null,
      columns: sw02Hdr,
      rowCount: Math.max(0, sw02Rows.length - 1),
      districts: [...new Set(sw02Rows.slice(1).map((r) => r[0]))].sort(),
      containsHatYai: sw02Rows.some((r) => r.join(",").includes("หาดใหญ่")),
      scopeAssessment:
        "dataset_sw_02 on data.go.th is published by สำนักงานจังหวัดนครศรีธรรมราช and lists LAOs of Nakhon Si Thammarat province only (year 2569); it contains no Songkhla/Hat Yai rows. The same id does not exist on the Songkhla provincial catalog (HTTP " +
        (fetchLog["songkhla-dataset_sw_02"]?.httpStatus ?? "n/a") +
        "). The Songkhla catalog's LAO-level equivalents (dataset_10_27/33/34) are used below.",
    },
    songkhlaLaoDatasets: {
      scope: "LAO = เทศบาลนครหาดใหญ่ (Hat Yai City Municipality), from the Songkhla provincial data catalog (source: DLA solid-waste survey of LAOs, via สำนักงานส่งเสริมการปกครองท้องถิ่นจังหวัดสงขลา)",
      datasets: resMeta,
      generated,
      collected,
      collectedOtherRows: otherCollectedRows,
      utilized,
      note: "FY2566-2567 cells for Hat Yai are empty in the published CSVs (status unavailable). Generated + collected + utilised are reported independently by the LAO and need not add up.",
    },
    songkhlaProvince: { source: "dataset_10_37 (PCD national MSW situation report, province scope)", rows: provRows },
    pmc12247160: pmc,
    municipalityStatistics: {
      status: "unavailable",
      note: "No machine-readable collected-waste statistics were found on hatyaicity.go.th; the 'Annual Waste Management Report 2024' cited by PMC12247160 was not located.",
    },
    composition: {
      shares: null,
      status: "unavailable",
      note: "No sourced Hat Yai composition with percentage shares was retrieved; do not display a composition for Hat Yai unless a cited table is added.",
    },
  });

  // -------------------------------------------------------------------------
  // 7. Flood (ThaiWater / HII record of the Nov 2025 event)
  // -------------------------------------------------------------------------
  const twDir = path.join(RAW, "thaiwater", "hatyai_nov2025");
  const twBase = "https://www.thaiwater.net/uploads/contents/current/2025/hatyai_nov2025/";
  for (const p of ["summary", "rain_tele", "waterlevel", "waterlevel_songkhla", "flood_area", "damage"]) {
    await getFile({ key: `thaiwater-${p}`, url: `${twBase}${p}.html`, file: path.join(twDir, `hatyai_nov2025_${p}.html`) });
  }
  const twText = (p: string) => {
    const f = path.join(twDir, `hatyai_nov2025_${p}.html`);
    return fs.existsSync(f) ? htmlToLines(fs.readFileSync(f, "utf8")).join("\n") : "";
  };
  const sum = twText("summary");
  const wls = twText("waterlevel_songkhla");
  const fa = twText("flood_area");
  const dmg = twText("damage");
  const grab = (t: string, re: RegExp) => t.match(re)?.[0]?.trim() ?? null;
  const rainHtml = fs.existsSync(path.join(twDir, "hatyai_nov2025_rain_tele.html")) ? fs.readFileSync(path.join(twDir, "hatyai_nov2025_rain_tele.html"), "utf8") : "";
  const [dailyT, tenT] = htmlTables(rainHtml);
  const daily = (dailyT ?? []).slice(1).filter((r) => r.length >= 7).map((r) => ({ date: r[0].split("/").reverse().join("-"), station: r[1], tambon: r[2], amphoe: r[3], province: r[4], agency: r[5], rainMm: num(r[6]) }));
  const ten = (tenT ?? []).slice(1).filter((r) => r.length >= 6).map((r) => ({ station: r[0], tambon: r[1], amphoe: r[2], province: r[3], agency: r[4], rain10dMm: num(r[5]) }));
  const hyDaily = daily.filter((r) => r.amphoe === "หาดใหญ่" || r.station === "หาดใหญ่");
  const hyTen = ten.filter((r) => r.amphoe === "หาดใหญ่" || r.station === "หาดใหญ่");
  const topDaily = [...daily].sort((a, b) => (b.rainMm ?? 0) - (a.rainMm ?? 0)).slice(0, 3);
  const topTen = [...ten].sort((a, b) => (b.rain10dMm ?? 0) - (a.rain10dMm ?? 0)).slice(0, 3);
  const hyPeak = [...hyDaily].sort((a, b) => (b.rainMm ?? 0) - (a.rainMm ?? 0))[0] ?? null;
  const tenHeader = (tenT?.[0] ?? []).join(" | ");
  const tenTitle = grab(twText("rain_tele"), /ตารางแสดงปริมาณฝนสะสม 7 วัน[^\n]*/);
  const floodEvent = {
    id: "hy-flood-2025-11",
    cityId: "hatyai",
    titleTh: "อุทกภัยหาดใหญ่ พฤศจิกายน 2568",
    titleEn: "Hat Yai flood, November 2025",
    from: "2025-11-19",
    to: "2025-11-28",
    summaryTh:
      "น้ำท่วม 2 ระลอก (19-21 และ 23-28 พ.ย. 2568) จากฝนตกหนักต่อเนื่องในลุ่มน้ำคลองอู่ตะเภา; ระดับน้ำคลองอู่ตะเภาที่สถานี X.44 บ้านหาดใหญ่ สูงสุด 9.97 ม.รทก. สูงกว่าปี 2543 และ 2553 (ThaiWater/สสน.)",
    summaryEn:
      "Two flood waves (19-21 and 23-28 Nov 2025) after persistent heavy rain over the U-Taphao basin; U-Taphao canal at station X.44 (Ban Hat Yai) peaked at 9.97 m above MSL, higher than the 2000 and 2010 floods (ThaiWater/HII).",
    peakRainMm: hyPeak
      ? {
          value: hyPeak.rainMm,
          unit: "mm/day",
          provenance: {
            status: "observed",
            sourceId: "thaiwater-hatyai-nov2025",
            sourceUrl: `${twBase}rain_tele.html`,
            observedFrom: hyPeak.date,
            observedTo: hyPeak.date,
            referenceYear: 2025,
            geographicScope: `Station '${hyPeak.station}' (${hyPeak.agency}), ต.${hyPeak.tambon} อ.${hyPeak.amphoe} จ.${hyPeak.province}`,
            methodology: "Maximum daily rainfall among the stations named หาดใหญ่ or located in อ.หาดใหญ่ in ThaiWater's table of stations with > 90 mm/day.",
            limitations: [
              hyDaily.some((r) => r.tambon === "หาดใหญ่")
                ? "Stations in ต.หาดใหญ่ (the municipality's sub-district) are included; others are in the surrounding district."
                : "No station in this table is located in ต.หาดใหญ่ (the municipality's sub-district); values are for stations in the surrounding district / nearby.",
              "The table lists only stations with > 90 mm/day.",
            ],
          },
        }
      : null,
    sourceId: "thaiwater-hatyai-nov2025",
  };
  writeJson(path.join(STAGED, "hatyai-flood.json"), {
    generatedAt: RUN_STARTED,
    event: floodEvent,
    details: {
      source: { url: `${twBase}summary.html`, publisher: "NHC Steering and Operations Center (NHCSOC) / Hydro Informatics Institute (สถาบันสารสนเทศทรัพยากรน้ำ, HII) — ThaiWater (คลังข้อมูลน้ำแห่งชาติ)", titleTh: "บันทึกเหตุการณ์น้ำท่วมอำเภอหาดใหญ่และพื้นที่ภาคใต้ตอนล่าง ช่วงเดือนพฤศจิกายน 2568" },
      floodWaves: { text: grab(wls, /อุทกภัยในเดือนพฤศจิกายน 2568 เกิดขึ้น 2 ครั้ง[^\n]*/), waves: [{ from: "2025-11-19", to: "2025-11-21" }, { from: "2025-11-23", to: "2025-11-28" }], source: `${twBase}waterlevel_songkhla.html` },
      uTaphaoX44: {
        station: "X.44 บ้านหาดใหญ่ (คลองอู่ตะเภา), ต.หาดใหญ่ อ.หาดใหญ่ จ.สงขลา",
        peakWaterLevel: { value: 9.97, unit: "m MSL (เมตร รทก.)", status: "observed", note: "Stated as the highest flood level compared with 2000 and 2010; time of peak not stated on the page." },
        overbank: { from: "2025-11-23 (late night)", to: "2025-11-27 (morning)", durationTh: "4 วัน 17 ชั่วโมง" },
        quoteTh: grab(wls, /จากการตรวจวัดระดับน้ำบริเวณคลองอู่ตะเภาที่สถานี X\.44[^\n]*/),
        quoteEn: grab(sum, /In Songkhla Province, water level monitoring at the U-Taphao Canal[^\n]*/),
        verifiedNumber: /9\.97 เมตร รทก/.test(wls) && /9\.97 meters above mean sea level/.test(sum),
      },
      otherStations: [
        { station: "X.174 บ้านคลองหวะ (คลองหวะ)", overbank: "from evening 2025-11-21 to morning 2025-11-27", durationTh: "5 วัน 14 ชั่วโมง" },
        { station: "X.90 บ้านบางศาลา (คลองอู่ตะเภา)", durationTh: "5 วัน 18 ชั่วโมง" },
        { station: "X.173A บ้านม่วงก็อง (คลองอู่ตะเภา, อ.สะเดา)", durationTh: "5 วัน 11 ชั่วโมง" },
      ],
      peakInflowsM3s: {
        source: `${twBase}waterlevel_songkhla.html (กรมชลประทาน)`,
        values: [
          { channel: "คลองวาด", wave1: ">145", wave2: ">145" },
          { channel: "คลองต่ำ", wave1: ">100", wave2: ">100" },
          { channel: "คลองอู่ตะเภา (จาก อ.สะเดา)", wave1: "624", wave2: "2,700" },
          { channel: "คลองหวะ", wave1: "443", wave2: ">465" },
          { channel: "เขาคอหงส์", wave1: ">90", wave2: ">90" },
        ],
        outletCapacity: { value: 1721, unit: "m³/s", note: "combined maximum drainage of คลอง ร.1 + คลองอู่ตะเภา" },
        verified: /2,700 ลูกบาศก์เมตรต่อวินาที/.test(wls) && /1,721 ลูกบาศก์เมตรต่อวินาที/.test(wls),
      },
      rainfall: {
        unit: "mm",
        hatYaiStationsDaily: hyDaily,
        hatYaiStations10Day: hyTen,
        tenDayTableHeader: tenHeader,
        tenDayTableTitle: tenTitle,
        regionalTopDaily: topDaily,
        regionalTop10Day: topTen,
        textCaveat:
          "ThaiWater's text says '10-day accumulation (17-20 Nov 2568)', the table title says '7 วัน (17-26 พฤศจิกายน 2568)' and the column header '10 วัน (17-26 พ.ย. 68)'. The column header (10 days, 17-26 Nov 2025) is used.",
        unattributedClaim: {
          quoteTh: grab(fa, /บางแหล่งข้อมูลระบุว่า[^\n]*/),
          note: "ThaiWater's flood-area page quotes 'some sources' for 630 mm in 3 days (19-21 Nov) vs 428 mm max in 2010; source not identified — not used as a metric.",
        },
      },
      affected: {
        reportDate: "2025-11-30",
        period: { from: "2025-11-17", to: "2025-11-30" },
        source: "กรมป้องกันและบรรเทาสาธารณภัย (DDPM) as summarised by ThaiWater",
        southernRegion: { provinces: 12, districts: 117, subdistricts: 778, villages: 5938, households: 1514895, persons: 3901155, deaths: 169 },
        stillAffectedOn20251130: { provinces: 9, districts: 81, subdistricts: 522, villages: 3504, households: 1108031, persons: 2789684 },
        songkhla: {
          districts: 16,
          subdistricts: 127,
          villages: 992,
          communities: 331,
          households: 633105,
          persons: 1319536,
          deaths: 131,
          quoteTh: grab(dmg, /6\) จ\.สงขลา[^\n]*/),
        },
        satelliteFloodArea: { value: 825365, unit: "rai", provinces: 9, songkhlaRai: 331821, source: "GISTDA via ThaiWater" },
        verified: /1,514,895/.test(sum) && /3,901,155/.test(sum) && /633,105/.test(dmg) && /1,319,536/.test(dmg) && /331,821/.test(sum),
      },
    },
    earlierFloods: [
      {
        id: "hy-flood-2000",
        year: 2000,
        yearBE: 2543,
        from: null,
        to: null,
        status: "manual-reference",
        evidence: "ThaiWater summary: the 2000 (2543) and 2010 (2553) Hat Yai floods are the most frequently cited major floods; the Nov 2025 peak at X.44 (9.97 m MSL) exceeded both.",
        sourceUrl: `${twBase}summary.html`,
        note: "Exact dates, rainfall and peak levels are not given on the cited page; left null.",
      },
      {
        id: "hy-flood-2010",
        year: 2010,
        yearBE: 2553,
        from: null,
        to: null,
        status: "manual-reference",
        evidence: "ThaiWater summary (as above). The flood-area page quotes an unattributed 428 mm 3-day maximum for 2010, which is not used.",
        sourceUrl: `${twBase}summary.html`,
        note: "Exact dates and peak levels not given on the cited page; left null.",
      },
    ],
  });

  // -------------------------------------------------------------------------
  // 8. Sources registry, manifest, report
  // -------------------------------------------------------------------------
  const s = (keys: string[]) => statusOf(keys);
  const sources: SourceRef[] = [
    {
      id: "hatyaicity-community-list",
      nameTh: "เทศบาลนครหาดใหญ่ — รายชื่อชุมชน / ข้อมูลประธานกรรมการชุมชน เขต 1-4",
      nameEn: "Hat Yai City Municipality — community list by zone (community-committee chairs, data as of 2026-10-01)",
      url: "https://www.hatyaicity.go.th/content/cate/258",
      publisher: "เทศบาลนครหาดใหญ่ (Hat Yai City Municipality)",
      license: "Government website; no open licence stated",
      ...s(["hyc-cate-258", "hyc-chairmen-z1", "hyc-chairmen-z2", "hyc-chairmen-z3", "hyc-chairmen-z4"]),
      notes: `Community names and zone assignment only; personal data (names, phones) not reproduced. Names transcribed visually (data/manual/hatyai-communities-official-list.json) and verified against the PDF text layer after mapping Thai PUA glyph variants to Unicode: ${nameChecks.reduce((n, z) => n + (z.textLayerRows == null ? 0 : z.listed - z.mismatches.length), 0)} of ${totalListed} exact matches.`,
    },
    {
      id: "hatyaicity-boundary-notices",
      nameTh: "ประกาศเทศบาลนครหาดใหญ่ เรื่อง การแบ่งแนวเขตพื้นที่ชุมชน / แนวเขตชุมชน เขต 1-4 และแผนที่ชุมชน 103 ชุมชน",
      nameEn: "Hat Yai City Municipality — community boundary announcements (zones 1-4, Nov 2022 - May 2023) and 103-community map (rev. 2022-11-14)",
      url: "https://www.hatyaicity.go.th/content/cate/259",
      publisher: "เทศบาลนครหาดใหญ่ (Hat Yai City Municipality)",
      license: "Government website; no open licence stated",
      ...s(["hyc-cate-259", "hyc-notice-z1", "hyc-notice-z2", "hyc-notice-z3", "hyc-notice-z4", "hyc-map-103"]),
      notes: "Per-community area, population (male/female), households and boundary descriptions; zones 2 & 4 text layer, zone 1 & most of zone 3 scanned (manual transcription). Map used only as visual basis for the approximate zone partition.",
    },
    {
      id: "hatyaicity-general",
      nameTh: "เทศบาลนครหาดใหญ่ — ข้อมูลพื้นฐาน",
      nameEn: "Hat Yai City Municipality — general information (area 21 km², history)",
      url: "https://www.hatyaicity.go.th/content/general",
      publisher: "เทศบาลนครหาดใหญ่",
      license: "Government website; no open licence stated",
      ...s(["hyc-general"]),
      notes: "Page marked 'อยู่ระหว่างปรับปรุงข้อมูล' (being updated). Area 21 km²; no current population figure.",
    },
    {
      id: "osm-hatyai-municipality",
      nameEn: `OpenStreetMap relation ${muniRelId} — เทศบาลนครหาดใหญ่ (admin_level 7)`,
      url: `https://www.openstreetmap.org/relation/${muniRelId}`,
      publisher: "OpenStreetMap contributors (via Overpass API)",
      license: "ODbL-1.0",
      ...s(["boundary-candidates", `relation-${muniRelId}-geom`]),
      notes: "Tagged fixme='approximate please verify'; traced from the Royal Gazette (ratchakitcha.soc.go.th/documents/1658230.pdf).",
    },
    {
      id: "osm-hatyai-community-features",
      nameEn: "OpenStreetMap features with community (ชุมชน) names around Hat Yai municipality",
      url: "https://www.openstreetmap.org/",
      publisher: "OpenStreetMap contributors (via Overpass API)",
      license: "ODbL-1.0",
      ...s(["community-candidates"]),
      notes: "Used only for exact-name matches; see hatyai-communities.json.",
    },
    {
      id: "hatyai-zones-approx",
      nameEn: "Approximate demonstration partition of Hat Yai municipality into zones 1-4 (derived)",
      url: "https://www.openstreetmap.org/",
      publisher: "Urban Intelligence demo (derived from OSM ways + municipal map)",
      license: "ODbL-1.0 (derived from OpenStreetMap)",
      ...s(["zone-lines", "zone-validation-pois"]),
      notes: "Not official boundaries. Method in zones.geojson properties.method.",
    },
    {
      id: "dopa-stat-population",
      nameTh: "กรมการปกครอง — สถิติจำนวนประชากร (ระดับอำเภอ/สำนักทะเบียน)",
      nameEn: "Department of Provincial Administration — registered population by registration office (yearly files)",
      url: "https://stat.bora.dopa.go.th/new_stat/webPage/statByYear.php",
      publisher: "กรมการปกครอง กระทรวงมหาดไทย (DOPA)",
      license: "Government open statistics; no explicit licence",
      ...s(["dopa-index", ...useYears.map((y) => `dopa-stat_a${y}`)]),
      notes: "Registration office 9098 ท้องถิ่นเทศบาลนครหาดใหญ่; year-end (December) counts.",
    },
    {
      id: "datagoth-dataset_sw_02",
      nameTh: "ปริมาณขยะมูลฝอยขององค์กรปกครองส่วนท้องถิ่น (dataset_sw_02)",
      nameEn: "data.go.th dataset_sw_02 — LAO solid waste (Nakhon Si Thammarat province)",
      url: "https://data.go.th/api/3/action/package_show?id=dataset_sw_02",
      publisher: "สำนักงานจังหวัดนครศรีธรรมราช",
      license: sw02?.license_title ?? "Open Data Common",
      ...s(["datagoth-dataset_sw_02", "datagoth-dataset_sw_02-csv"]),
      notes: "Scope is Nakhon Si Thammarat LAOs only; no Hat Yai data.",
    },
    {
      id: "songkhla-gdcatalog-lao-waste",
      nameTh: "ข้อมูลปริมาณขยะมูลฝอยชุมชนที่เกิดขึ้น / ที่เก็บขนไปกำจัด / ที่ถูกนำไปใช้ประโยชน์ (อปท. จ.สงขลา)",
      nameEn: "Songkhla provincial data catalog — LAO municipal solid waste generated / collected / utilised (dataset_10_27, _33, _34)",
      url: "https://songkhla.gdcatalog.go.th/dataset/?q=ขยะ",
      publisher: "สำนักงานท้องถิ่นจังหวัดสงขลา (Songkhla Provincial Office of Local Administration)",
      license: "Open Data Common",
      ...s(["songkhla-dataset_10_27", "songkhla-dataset_10_33", "songkhla-dataset_10_34", "songkhla-dataset_10_27-csv", "songkhla-dataset_10_33-csv", "songkhla-dataset_10_34-csv"]),
      notes: "Fiscal years 2564-2567 (Hat Yai values present for FY2564-2565 only).",
    },
    {
      id: "songkhla-gdcatalog-pcd-province",
      nameTh: "ข้อมูลสถานการณ์ขยะมูลฝอยของจังหวัดสงขลา (dataset_10_37)",
      nameEn: "Songkhla province MSW situation 2563-2567 (PCD figures, province scope)",
      url: "https://songkhla.gdcatalog.go.th/dataset/ed53a742-d3c3-4606-9cea-934f2fe145c1",
      publisher: "กรมควบคุมมลพิษ (PCD) via Songkhla provincial catalog",
      license: resMeta.dataset_10_37?.license ?? "License not specified",
      ...s(["songkhla-dataset_10_37", "songkhla-dataset_10_37-csv"]),
      notes: "Province-level context only.",
    },
    {
      id: "pmc-12247160",
      nameEn: "Thongham, Khongprom & Sangsubun (2025) Multiscale characterization of commercial and landfill-recovered plastics in Songkhla province, Thailand. RSC Advances 15(30):24424-24434",
      url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC12247160/",
      publisher: "Royal Society of Chemistry (via PubMed Central / NCBI E-utilities)",
      license: "CC BY 3.0",
      ...s(["pmc-efetch"]),
      notes:
        "Full text read via NCBI E-utilities efetch XML (" +
        (fetchLog["pmc-efetch"]?.status ?? "n/a") +
        "). Article HTML: " +
        (fetchLog["pmc-html"]?.status === "fetched"
          ? "served normally (HTTP 200, no CAPTCHA) and cached as a cross-check"
          : fetchLog["pmc-html"]?.status === "cached"
            ? `cached copy (no CAPTCHA) reused${fetchLog["pmc-html"]?.error ? ` — live request: ${fetchLog["pmc-html"]?.error}` : ""}`
            : `not retrieved (${fetchLog["pmc-html"]?.error ?? "n/a"}); CAPTCHA challenges are never bypassed`) +
        ". 237.75 t/day is a secondary citation of 'Hat Yai Municipality, Annual Waste Management Report 2024' without stated reference period or method.",
    },
    {
      id: "thaiwater-hatyai-nov2025",
      nameTh: "บันทึกเหตุการณ์น้ำท่วมอำเภอหาดใหญ่และพื้นที่ภาคใต้ตอนล่าง ช่วงเดือนพฤศจิกายน 2568",
      nameEn: "ThaiWater / HII — record of the Hat Yai and lower-south flood, November 2025",
      url: `${twBase}summary.html`,
      publisher: "NHCSOC / Hydro Informatics Institute (สสน.), ThaiWater",
      license: "No explicit licence stated on the page",
      ...s(["thaiwater-summary", "thaiwater-rain_tele", "thaiwater-waterlevel", "thaiwater-waterlevel_songkhla", "thaiwater-flood_area", "thaiwater-damage"]),
      notes: "Compiles DDPM, RID, GISTDA, TMD, DWR and HII data.",
    },
  ];
  writeJson(path.join(STAGED, "hatyai-sources.json"), sources);

  writeJson(MANIFEST, { generatedAt: RUN_STARTED, userAgent: UA, files: { ...manifestPrev, ...fetchLog } });
  report.fetch = Object.values(fetchLog).map((r) => ({ key: r.key, status: r.status, httpStatus: r.httpStatus ?? null, url: r.url, file: r.file, bytes: r.bytes ?? null, retrievedAt: r.retrievedAt ?? null, attemptedAt: r.attemptedAt ?? null, error: r.error ?? null, note: r.note ?? null }));
  report.outputs = [
    "public/data/hatyai/municipality.geojson",
    "public/data/hatyai/zones.geojson",
    "data/staged/hatyai-community-osm-candidates.geojson",
    "data/staged/hatyai-communities.json",
    "data/staged/hatyai-population.json",
    "data/staged/hatyai-waste.json",
    "data/staged/hatyai-flood.json",
    "data/staged/hatyai-sources.json",
  ];
  report.zoneMethodOk = zoneMethodOk;
  writeJson(path.join(STAGED, "hatyai-ingest-report.json"), report);
  log("done", JSON.stringify({ zones: zoneDiag.tiling, points: pointFeatures.length, dopaLatest: latest?.total, failed: report.fetch.filter((f: any) => f.status === "failed").map((f: any) => f.key) }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
