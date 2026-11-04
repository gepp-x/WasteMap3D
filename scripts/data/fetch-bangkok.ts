/**
 * Bangkok ingestion — administrative geography, registered population, solid
 * waste (collected, per district and citywide), waste composition and BMA
 * flood-risk points.
 *
 *   npx tsx scripts/data/fetch-bangkok.ts            # fetch (polite), fall back to cached raw files
 *   npx tsx scripts/data/fetch-bangkok.ts --offline  # use cached raw files only
 *
 * Inputs are written to data/raw/<source>/ and treated as untrusted data (parsed,
 * never executed). PDF text is extracted with macOS PDFKit (osascript/JXA); the
 * extracted text is cached next to the PDF so the parse can be re-run without it.
 *
 * Outputs (deterministic for the same raw inputs; timestamps come from the
 * fetch manifest, not the wall clock):
 *   public/data/bangkok/districts.geojson
 *   data/staged/bangkok-population.json
 *   data/staged/bangkok-waste.json
 *   data/staged/bangkok-composition.json
 *   data/staged/bangkok-flood-points.json
 *   data/staged/bangkok-sources.json
 *
 * Integrity rules: no value is invented. Where a source is unusable the value is
 * null with status "unavailable" and the reason is recorded.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from "geojson";
import type { SourceRef, WasteCategory } from "../../src/lib/types";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, "..", "..");
const RAW = path.join(ROOT, "data", "raw");
const STAGED = path.join(ROOT, "data", "staged");
const PUBLIC_OUT = path.join(ROOT, "public", "data", "bangkok");
const MANIFEST_PATH = path.join(RAW, "_manifests", "fetch-bangkok.json");
const MAPSHAPER = path.join(ROOT, "node_modules", ".bin", "mapshaper");
const UA = "UrbanIntelligenceDemo/0.1 (research prototype)";
const OFFLINE = process.argv.includes("--offline");
/** Official BMA land area of Bangkok (km²), used only as a validation target. */
const OFFICIAL_BKK_AREA_KM2 = 1568.737;
const SIMPLIFY_PCT = "20%";

const DATAGOTH = "https://data.go.th";
const BMA_CKAN = "https://data.bangkok.go.th";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const ensureDir = (p: string) => fs.mkdirSync(p, { recursive: true });
const round = (x: number, d: number) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
function writeJson(file: string, data: unknown, compact = false) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, compact ? undefined : 2) + "\n", "utf8");
}
function log(...args: unknown[]) {
  console.log("[fetch-bangkok]", ...args);
}
/** Gregorian year from a Buddhist Era year. */
const beToCe = (be: number) => be - 543;
/** Thai fiscal year (BE) → inclusive ISO date range Oct 1 – Sep 30. */
function fiscalRange(fyBE: number) {
  const end = beToCe(fyBE);
  return { from: `${end - 1}-10-01`, to: `${end}-09-30` };
}
function daysInclusive(fromIso: string, toIso: string) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000) + 1;
}

// ---------------------------------------------------------------------------
// Fetching with cache fallback + manifest
// ---------------------------------------------------------------------------
interface ManifestEntry {
  url: string;
  retrievedAt: string;
  httpStatus: number;
  bytes: number;
  sha256: string;
  contentType: string;
}
const manifest: Record<string, ManifestEntry> = fs.existsSync(MANIFEST_PATH)
  ? (JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Record<string, ManifestEntry>)
  : {};

interface FetchResult {
  url: string;
  file: string; // relative to data/raw
  ok: boolean;
  via: "network" | "cache" | "none";
  httpStatus?: number;
  error?: string;
  retrievedAt?: string;
  bytes?: number;
  sha256?: string;
}
const fetchResults: FetchResult[] = [];
const lastHit = new Map<string, number>();

async function politeWait(host: string) {
  const prev = lastHit.get(host) ?? 0;
  const wait = prev + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

async function httpGet(url: string): Promise<{ status: number; buf: Buffer; contentType: string }> {
  const host = new URL(url).host;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await politeWait(host);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180_000);
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "*/*" },
        redirect: "follow",
        signal: ctrl.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      return { status: res.status, buf, contentType: res.headers.get("content-type") ?? "" };
    } catch (e) {
      lastErr = e;
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

type Kind = "pdf" | "zip" | "csv" | "json" | "html" | "docx";
function looksValid(buf: Buffer, kind: Kind): string | null {
  if (buf.length === 0) return "empty body";
  const head = buf.subarray(0, 64).toString("latin1");
  if (kind === "pdf" && !head.startsWith("%PDF")) return "not a PDF (missing %PDF header)";
  if ((kind === "zip" || kind === "docx") && !head.startsWith("PK")) return "not a ZIP archive";
  if (kind === "csv" && /^\s*<(!doctype|html)/i.test(head)) return "HTML returned instead of CSV";
  if (kind === "json") {
    try {
      JSON.parse(buf.toString("utf8"));
    } catch {
      return "invalid JSON";
    }
  }
  return null;
}

/** Download `url` to data/raw/<rel>; on failure fall back to the cached copy. */
async function getRaw(url: string, rel: string, kind: Kind): Promise<Buffer | null> {
  const dest = path.join(RAW, rel);
  const result: FetchResult = { url, file: rel, ok: false, via: "none" };
  if (!OFFLINE) {
    try {
      const { status, buf, contentType } = await httpGet(url);
      result.httpStatus = status;
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
      const bad = looksValid(buf, kind);
      if (bad) throw new Error(`HTTP ${status} but ${bad}`);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, buf);
      const entry: ManifestEntry = {
        url,
        retrievedAt: new Date().toISOString(),
        httpStatus: status,
        bytes: buf.length,
        sha256: sha256(buf),
        contentType,
      };
      manifest[rel] = entry;
      Object.assign(result, { ok: true, via: "network", retrievedAt: entry.retrievedAt, bytes: buf.length, sha256: entry.sha256 });
      fetchResults.push(result);
      return buf;
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }
  }
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    const buf = fs.readFileSync(dest);
    if (!looksValid(buf, kind)) {
      const m = manifest[rel];
      Object.assign(result, {
        ok: true,
        via: "cache",
        retrievedAt: m?.retrievedAt ?? new Date(fs.statSync(dest).mtimeMs).toISOString(),
        bytes: buf.length,
        sha256: sha256(buf),
      });
      fetchResults.push(result);
      return buf;
    }
  }
  fetchResults.push(result);
  log("FAILED", url, result.error ?? "no cache");
  return null;
}
const retrievedAt = (rel: string) =>
  fetchResults.find((r) => r.file === rel && r.ok)?.retrievedAt ?? manifest[rel]?.retrievedAt;

// ---------------------------------------------------------------------------
// CKAN metadata
// ---------------------------------------------------------------------------
interface CkanResource {
  id: string;
  name: string;
  url: string;
  format: string;
  last_modified?: string | null;
  size?: number | null;
  description?: string | null;
}
interface CkanPackage {
  id: string;
  name: string;
  title: string;
  notes?: string | null;
  license_title?: string | null;
  maintainer?: string | null;
  metadata_modified: string;
  organization?: { title: string } | null;
  resources: CkanResource[];
}
async function ckanPackage(base: string, id: string, rel: string): Promise<CkanPackage | null> {
  const url = `${base}/api/3/action/package_show?id=${encodeURIComponent(id)}`;
  const buf = await getRaw(url, rel, "json");
  if (!buf) return null;
  const j = JSON.parse(buf.toString("utf8")) as { success: boolean; result?: CkanPackage };
  return j.success && j.result ? j.result : null;
}

// ---------------------------------------------------------------------------
// CSV / text helpers
// ---------------------------------------------------------------------------
function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}
function csvObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}
function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.replace(/,/g, "").trim();
  if (!t || /^null$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
function decodeText(buf: Buffer): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-874").decode(buf), encoding: "windows-874 (TIS-620 superset)" };
  }
}

/**
 * Matching skeleton for Thai district names: drops whitespace, vowel/tone
 * marks above/below the line, the "สำนักงานเขต"/"เขต" prefix and folds ฏ→ฎ.
 * PDF text extraction loses or splits combining marks, so names are compared
 * on this skeleton only (never written to outputs).
 */
function skel(s: string): string {
  let t = s.normalize("NFC").replace(/[\s​]+/g, "");
  t = t
    .replace(/[ัิ-ฺ็-๎]/g, "")
    .replace(/ำ/g, "า")
    .replace(/ฏ/g, "ฎ");
  const i = t.indexOf("เขต");
  if (i >= 0 && i <= 12) t = t.slice(i + 3);
  return t;
}
function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// ---------------------------------------------------------------------------
// District registry
// ---------------------------------------------------------------------------
/** RTGS romanisation (Royal Institute system) used as nameEn; source spellings kept separately. */
const RTGS: Record<string, string> = {
  "1001": "Phra Nakhon", "1002": "Dusit", "1003": "Nong Chok", "1004": "Bang Rak", "1005": "Bang Khen",
  "1006": "Bang Kapi", "1007": "Pathum Wan", "1008": "Pom Prap Sattru Phai", "1009": "Phra Khanong",
  "1010": "Min Buri", "1011": "Lat Krabang", "1012": "Yan Nawa", "1013": "Samphanthawong", "1014": "Phaya Thai",
  "1015": "Thon Buri", "1016": "Bangkok Yai", "1017": "Huai Khwang", "1018": "Khlong San", "1019": "Taling Chan",
  "1020": "Bangkok Noi", "1021": "Bang Khun Thian", "1022": "Phasi Charoen", "1023": "Nong Khaem",
  "1024": "Rat Burana", "1025": "Bang Phlat", "1026": "Din Daeng", "1027": "Bueng Kum", "1028": "Sathon",
  "1029": "Bang Sue", "1030": "Chatuchak", "1031": "Bang Kho Laem", "1032": "Prawet", "1033": "Khlong Toei",
  "1034": "Suan Luang", "1035": "Chom Thong", "1036": "Don Mueang", "1037": "Ratchathewi", "1038": "Lat Phrao",
  "1039": "Watthana", "1040": "Bang Khae", "1041": "Lak Si", "1042": "Sai Mai", "1043": "Khan Na Yao",
  "1044": "Saphan Sung", "1045": "Wang Thonglang", "1046": "Khlong Sam Wa", "1047": "Bang Na",
  "1048": "Thawi Watthana", "1049": "Thung Khru", "1050": "Bang Bon",
};
/** Known spelling defects in source attribute tables (documented in notes). */
const THAI_NAME_FIXES: [RegExp, string][] = [[/ราษฏร์บูรณะ/g, "ราษฎร์บูรณะ"]];

interface District {
  code: string;
  nameTh: string;
  nameEn: string;
  nameThSource: string;
  nameEnSource: string;
  skel: string;
}
let REGISTRY: District[] = [];
const bySkel = new Map<string, District>();
const byCode = new Map<string, District>();

function setRegistry(list: District[]) {
  REGISTRY = [...list].sort((a, b) => a.code.localeCompare(b.code));
  bySkel.clear();
  byCode.clear();
  for (const d of REGISTRY) {
    if (bySkel.has(d.skel)) throw new Error(`Name skeleton collision: ${d.skel}`);
    bySkel.set(d.skel, d);
    byCode.set(d.code, d);
  }
}
interface MatchResult {
  district: District | null;
  method: "exact" | "fuzzy" | "none";
}
function matchDistrict(name: string): MatchResult {
  const s = skel(name);
  const exact = bySkel.get(s);
  if (exact) return { district: exact, method: "exact" };
  const cands = REGISTRY.map((d) => ({ d, dist: levenshtein(d.skel, s) })).filter((x) => x.dist <= 1);
  if (cands.length === 1 && s.length >= 4) return { district: cands[0].d, method: "fuzzy" };
  return { district: null, method: "none" };
}
const fuzzyMatches: { dataset: string; input: string; matched: string }[] = [];
function matchOrLog(name: string, dataset: string): District | null {
  const m = matchDistrict(name);
  if (m.method === "fuzzy" && m.district) fuzzyMatches.push({ dataset, input: name, matched: `${m.district.code} ${m.district.nameTh}` });
  return m.district;
}

// ---------------------------------------------------------------------------
// Shell helpers (system unzip + local mapshaper only)
// ---------------------------------------------------------------------------
function unzip(zipFile: string, outDir: string) {
  ensureDir(outDir);
  execFileSync("unzip", ["-o", "-q", zipFile, "-d", outDir], { stdio: "pipe" });
}
function mapshaper(args: string[]) {
  execFileSync(MAPSHAPER, args, { stdio: "pipe", maxBuffer: 256 * 1024 * 1024 });
}

const JXA_PDF_TEXT = `ObjC.import('PDFKit');
function run(argv) {
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) { return 'ERROR: cannot open PDF'; }
  var out = [];
  for (var i = 0; i < doc.pageCount; i++) {
    out.push('=====PAGE ' + (i + 1) + '=====\\n' + ObjC.unwrap(doc.pageAtIndex(i).string));
  }
  return out.join('\\n');
}`;
/** Extract the PDF text layer (macOS PDFKit). Cached as .txt beside the PDF. */
function pdfToText(pdfFile: string): { text: string | null; via: string } {
  const txt = path.join(path.dirname(pdfFile), "text", path.basename(pdfFile).replace(/\.pdf$/i, ".txt"));
  if (fs.existsSync(txt)) {
    const cached = fs.readFileSync(txt, "utf8");
    const m = /^#sha256:([0-9a-f]{64})\n/.exec(cached);
    if (m && m[1] === sha256(fs.readFileSync(pdfFile))) return { text: cached.slice(m[0].length), via: "cached text layer" };
  }
  if (process.platform !== "darwin") return { text: null, via: "no PDF text extractor (needs macOS PDFKit)" };
  try {
    const out = execFileSync("osascript", ["-l", "JavaScript", "-e", JXA_PDF_TEXT, pdfFile], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (out.startsWith("ERROR")) return { text: null, via: out.trim() };
    ensureDir(path.dirname(txt));
    fs.writeFileSync(txt, `#sha256:${sha256(fs.readFileSync(pdfFile))}\n${out}`, "utf8");
    return { text: out, via: "macOS PDFKit text layer" };
  } catch (e) {
    return { text: null, via: `PDFKit extraction failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Source registry (SourceRef[])
// ---------------------------------------------------------------------------
const sources = new Map<string, SourceRef>();
function addSource(s: SourceRef) {
  sources.set(s.id, s);
}
function statusFor(rels: string[]): SourceRef["accessStatus"] {
  const res = rels.map((r) => fetchResults.find((f) => f.file === r));
  if (res.every((r) => r?.ok)) return "retrieved";
  if (res.some((r) => r?.ok)) return "partial";
  return "failed";
}
function fetchNote(rels: string[]): string {
  return rels
    .map((r) => {
      const f = fetchResults.find((x) => x.file === r);
      if (!f) return `${r}: not requested`;
      if (f.via === "network") return `${r}: HTTP ${f.httpStatus}, ${f.bytes} bytes, sha256 ${f.sha256?.slice(0, 12)}…`;
      if (f.via === "cache") return `${r}: network failed (${f.error ?? "offline"}); used cached copy from ${f.retrievedAt}`;
      return `${r}: FAILED (${f.error ?? "unknown"})`;
    })
    .join("; ");
}
const latestRetrieval = (rels: string[]) =>
  rels
    .map((r) => retrievedAt(r))
    .filter((x): x is string => !!x)
    .sort()
    .pop();

// ===========================================================================
// 1. Districts (official BMA GIS boundaries)
// ===========================================================================
interface DistrictBuild {
  fullFc: FeatureCollection<Polygon | MultiPolygon>;
  validation: Record<string, unknown>;
}
async function buildDistricts(): Promise<DistrictBuild> {
  const pkgDgt = await ckanPackage(DATAGOTH, "50", "datagoth/package_50.json");
  const pkgBma = await ckanPackage(BMA_CKAN, "e537025b-1cf6-4c5b-8e46-c2e976f13283", "bma-opendata/pkg_district50.json");
  const zipUrl =
    pkgDgt?.resources.find((r) => /\.zip$/i.test(r.url))?.url ??
    "https://data.bangkok.go.th/dataset/e537025b-1cf6-4c5b-8e46-c2e976f13283/resource/d7be7e84-9d84-4595-bf8f-79b0bc01f1ae/download/district-2.zip";
  const csvUrl =
    pkgDgt?.resources.find((r) => /\.csv$/i.test(r.url))?.url ??
    "https://data.bangkok.go.th/dataset/e537025b-1cf6-4c5b-8e46-c2e976f13283/resource/7bf56a08-044f-4287-b10e-c2beefccdfcc/download/50district.csv";
  const zipRel = "bma-opendata/district50/district-2.zip";
  const csvRel = "bma-opendata/district50/50district.csv";
  const zip = await getRaw(zipUrl, zipRel, "zip");
  const areaCsv = await getRaw(csvUrl, csvRel, "csv");
  if (!zip) throw new Error("Official district boundaries unavailable (network and cache). OSM fallback is not implemented in this script.");

  const shpDir = path.join(RAW, "bma-opendata/district50/shp");
  unzip(path.join(RAW, zipRel), shpDir);
  const shp = path.join(shpDir, "district.shp");
  const cst = fs.existsSync(path.join(shpDir, "district.cst")) ? fs.readFileSync(path.join(shpDir, "district.cst"), "utf8").trim() : "";
  const enc = /874/.test(cst) ? "cp874" : "utf8";

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bkk-districts-"));
  const fullPath = path.join(tmp, "full.geojson");
  const simpPath = path.join(tmp, "simplified.geojson");
  mapshaper(["-i", shp, `encoding=${enc}`, "-proj", "wgs84", "-o", fullPath, "format=geojson"]);
  mapshaper([
    "-i", shp, `encoding=${enc}`,
    "-simplify", SIMPLIFY_PCT, "weighted", "keep-shapes",
    "-proj", "wgs84",
    "-o", simpPath, "format=geojson", "precision=0.00001",
  ]);
  type Props = { dcode: string; dname: string; dname_e: string };
  const full = JSON.parse(fs.readFileSync(fullPath, "utf8")) as FeatureCollection<Polygon | MultiPolygon, Props>;
  const simp = JSON.parse(fs.readFileSync(simpPath, "utf8")) as FeatureCollection<Polygon | MultiPolygon, Props>;
  fs.rmSync(tmp, { recursive: true, force: true });

  // Registry from the official attribute table.
  const list: District[] = full.features.map((f) => {
    const code = String(f.properties.dcode).trim();
    let nameTh = String(f.properties.dname).trim().replace(/^เขต/, "");
    for (const [re, rep] of THAI_NAME_FIXES) nameTh = nameTh.replace(re, rep);
    return {
      code,
      nameTh,
      nameEn: RTGS[code] ?? String(f.properties.dname_e),
      nameThSource: String(f.properties.dname).trim(),
      nameEnSource: String(f.properties.dname_e).trim(),
      skel: skel(nameTh),
    };
  });
  setRegistry(list);

  // Official area table (km²) from the same dataset.
  const areaOfficial = new Map<string, number>();
  if (areaCsv) {
    for (const r of csvObjects(decodeText(areaCsv).text)) {
      const a = num(r.area_dis);
      if (r.dcode && a !== null) areaOfficial.set(r.dcode, a);
    }
  }

  const fullByCode = new Map(full.features.map((f) => [String(f.properties.dcode).trim(), f]));
  const out: Feature<Polygon | MultiPolygon>[] = simp.features
    .map((f) => {
      const code = String(f.properties.dcode).trim();
      const d = byCode.get(code);
      if (!d) throw new Error(`Unknown code ${code}`);
      const fullF = fullByCode.get(code);
      return {
        type: "Feature" as const,
        properties: {
          code,
          nameTh: d.nameTh,
          nameEn: d.nameEn,
          nameEnSource: d.nameEnSource,
          geometryStatus: "official",
          sourceId: "bma-gis-district-boundaries",
          areaKm2Official: areaOfficial.get(code) ?? null,
          areaKm2Geodesic: fullF ? round(turf.area(fullF) / 1e6, 3) : null,
        },
        geometry: f.geometry,
      };
    })
    .sort((a, b) => String(a.properties.code).localeCompare(String(b.properties.code)));

  const outFc: FeatureCollection<Polygon | MultiPolygon> = { type: "FeatureCollection", features: out };
  const outFile = path.join(PUBLIC_OUT, "districts.geojson");
  ensureDir(PUBLIC_OUT);
  fs.writeFileSync(outFile, JSON.stringify(outFc) + "\n", "utf8");

  // ---- validation
  const codes = out.map((f) => String(f.properties?.code));
  const expected = Array.from({ length: 50 }, (_, i) => String(1001 + i));
  const invalid = out.filter((f) => !turf.booleanValid(f)).map((f) => String(f.properties?.code));
  const kinks = out
    .map((f) => ({ code: String(f.properties?.code), n: turf.kinks(f).features.length }))
    .filter((k) => k.n > 0);
  const sumSimp = out.reduce((a, f) => a + turf.area(f), 0) / 1e6;
  const sumFull = full.features.reduce((a, f) => a + turf.area(f), 0) / 1e6;
  let unionArea: number | null = null;
  try {
    const u = turf.union(outFc as FeatureCollection<Polygon | MultiPolygon>);
    unionArea = u ? turf.area(u) / 1e6 : null;
  } catch {
    unionArea = null;
  }
  const sumOfficialTable = [...areaOfficial.values()].reduce((a, b) => a + b, 0);
  // Simplification error: distance (m) from every 5th original vertex to the simplified outline of the same district.
  const devs: number[] = [];
  for (const f of full.features) {
    const s = out.find((o) => o.properties?.code === String(f.properties.dcode).trim());
    if (!s) continue;
    const outlines: Feature<import("geojson").LineString>[] = [];
    const sg = s.geometry;
    const polysS = sg.type === "Polygon" ? [sg.coordinates] : sg.coordinates;
    for (const p of polysS) for (const ring of p) outlines.push(turf.lineString(ring));
    const g = f.geometry;
    const rings = g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
    for (const ring of rings)
      for (let i = 0; i < ring.length; i += 5) {
        const pt = turf.point(ring[i]);
        devs.push(Math.min(...outlines.map((l) => turf.pointToLineDistance(pt, l, { units: "meters" }))));
      }
  }
  devs.sort((a, b) => a - b);
  const q = (x: number) => (devs.length ? round(devs[Math.floor(x * (devs.length - 1))], 1) : null);
  const validation = {
    featureCount: out.length,
    uniqueCodes: new Set(codes).size,
    codesMatch1001to1050: expected.every((c) => codes.includes(c)) && codes.length === 50,
    invalidGeometries: invalid,
    selfIntersections: kinks,
    unionAreaKm2: unionArea === null ? null : round(unionArea, 3),
    sumAreaSimplifiedKm2: round(sumSimp, 3),
    sumAreaFullResolutionKm2: round(sumFull, 3),
    officialAreaKm2: OFFICIAL_BKK_AREA_KM2,
    unionVsOfficialPct: unionArea === null ? null : round(((unionArea - OFFICIAL_BKK_AREA_KM2) / OFFICIAL_BKK_AREA_KM2) * 100, 3),
    withinThreePercent: unionArea !== null && Math.abs(unionArea - OFFICIAL_BKK_AREA_KM2) / OFFICIAL_BKK_AREA_KM2 <= 0.03,
    sumOfBmaAreaTableKm2: round(sumOfficialTable, 3),
    vertices: {
      fullResolution: full.features.reduce((a, f) => a + turf.coordAll(f).length, 0),
      simplified: out.reduce((a, f) => a + turf.coordAll(f).length, 0),
    },
    simplificationDeviationM: { sampledVertices: devs.length, median: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) },
    zoom13MetresPerPixel512: round((40075016.686 * Math.cos((13.75 * Math.PI) / 180)) / (512 * 2 ** 13), 2),
    fileBytes: fs.statSync(outFile).size,
    simplification: `mapshaper -simplify ${SIMPLIFY_PCT} weighted keep-shapes (in EPSG:32647), then -proj wgs84, precision=0.00001`,
    sourceEncoding: enc,
  };
  log("districts:", JSON.stringify(validation));

  addSource({
    id: "bma-gis-district-boundaries",
    nameTh: pkgDgt?.title ?? "พื้นที่เขตปกครอง 50 เขตของกรุงเทพมหานคร",
    nameEn: "Bangkok 50 district administrative boundaries (BMA GIS, shapefile EPSG:32647)",
    url: "https://data.go.th/dataset/50",
    publisher: `${pkgDgt?.organization?.title ?? "กรุงเทพมหานคร"} — ${pkgDgt?.maintainer ?? "กองสารสนเทศภูมิศาสตร์"} (BMA GIS Division)`,
    license: pkgDgt?.license_title ?? pkgBma?.license_title ?? "not stated",
    retrievedAt: latestRetrieval([zipRel, csvRel]),
    accessStatus: statusFor([zipRel, csvRel]),
    notes:
      `Download ${zipUrl} (resource last_modified ${pkgDgt?.resources.find((r) => r.url === zipUrl)?.last_modified ?? "?"}; ` +
      `shapefile exported 2020-08-11 from BMA GeoServer WFS BMAWMS:district, charset cp874). Area table: ${csvUrl}. ` +
      `${fetchNote([zipRel, csvRel])}. Attribute table also carries num_male/num_female with no stated reference year — not used.`,
  });
  return { fullFc: full as FeatureCollection<Polygon | MultiPolygon>, validation };
}

// ===========================================================================
// 2. Population (DOPA civil registration via NSO; BMA table as cross-check)
// ===========================================================================
async function buildPopulation() {
  const pkgNso = await ckanPackage(DATAGOTH, "0405_01_0005", "datagoth/package_0405_01_0005.json");
  const pkgBma = await ckanPackage(DATAGOTH, "bkkpopulationdistric", "datagoth/package_bkkpopulationdistric.json");
  const nsoUrl = "https://catalogapi.nso.go.th/api/index?table=OS_0405_01_0005_01&format=csv";
  const ddUrl = "https://catalogapi.nso.go.th/api/datadic?table=OS_0405_01_0005_01&format=csv";
  const bmaUrl =
    pkgBma?.resources.find((r) => /\.csv/i.test(r.url))?.url ??
    "https://data.bangkok.go.th/dataset/9801eb64-aaa1-4dbf-9b83-98dfb04ff81e/resource/0e77f0fd-17c7-4bd3-ba53-1fc9c46a8c3e/download/bangkok_population_separate_by_distric.csv";
  const nsoRel = "nso-catalog/OS_0405_01_0005_01.csv";
  const ddRel = "nso-catalog/OS_0405_01_0005_01_datadic.csv";
  const bmaRel = "bma-opendata/population/bangkok_population_separate_by_distric.csv";
  const nsoBuf = await getRaw(nsoUrl, nsoRel, "csv");
  await getRaw(ddUrl, ddRel, "csv");
  const bmaBuf = await getRaw(bmaUrl, bmaRel, "csv");

  addSource({
    id: "nso-dopa-registered-population",
    nameTh: pkgNso?.title ?? "จำนวนประชากรตามพื้นที่จากการทะเบียน",
    nameEn: "Registered population by district (DOPA civil registration), NSO official statistics table OS_0405_01_0005_01",
    url: "https://data.go.th/dataset/0405_01_0005",
    publisher: "สำนักงานสถิติแห่งชาติ (National Statistical Office); data source กรมการปกครอง (Department of Provincial Administration)",
    license: pkgNso?.license_title ?? "Creative Commons Attributions",
    retrievedAt: latestRetrieval([nsoRel, ddRel]),
    accessStatus: statusFor([nsoRel, ddRel]),
    notes: `CSV ${nsoUrl}. ${fetchNote([nsoRel, ddRel])}. CKAN metadata: last_updated ${pkgNso?.metadata_modified ?? "?"}.`,
  });
  addSource({
    id: "bma-population-by-district",
    nameTh: pkgBma?.title ?? "สถิติจำนวนประชากรในพื้นที่ กรุงเทพมหานคร จำแนกตามเพศ และเขตการปกครอง",
    nameEn: "Bangkok population by sex and district (BMA open data; year not stated in file — matches DOPA 2023 exactly)",
    url: "https://data.go.th/dataset/bkkpopulationdistric",
    publisher: "กรุงเทพมหานคร (Bangkok Metropolitan Administration)",
    license: pkgBma?.license_title ?? "not stated",
    retrievedAt: latestRetrieval([bmaRel]),
    accessStatus: statusFor([bmaRel]),
    notes: `CSV ${bmaUrl} (encoding windows-874). ${fetchNote([bmaRel])}. Used only as a cross-check.`,
  });
  // DOPA's own district-level download files (stat_aYY.txt, pipe-delimited UTF-8):
  // yymm|prov code|prov|district code|district|tambon code|tambon|village code|village|male|female|total|houses|
  const dopaYears = [64, 65, 66, 67, 68];
  const dopaRels: string[] = [];
  const dopaFiles = new Map<number, Map<string, { total: number; houses: number | null; period: string }>>();
  for (const yy of dopaYears) {
    const rel = `dopa/bangkok/stat_a${yy}.txt`;
    dopaRels.push(rel);
    const buf = await getRaw(`https://stat.bora.dopa.go.th/new_stat/file/${yy}/stat_a${yy}.txt`, rel, "csv");
    if (!buf) continue;
    const m = new Map<string, { total: number; houses: number | null; period: string }>();
    for (const line of buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const f = line.split("|");
      if (f.length < 13 || f[1] !== "10" || f[5] !== "0") continue;
      const total = num(f[11]);
      if (total === null) continue;
      m.set(f[3] === "0" ? "TOTAL" : f[3], { total, houses: num(f[12]), period: f[0] });
    }
    dopaFiles.set(2500 + yy, m);
  }
  addSource({
    id: "dopa-stat-files",
    nameTh: "สถิติจำนวนประชากรและบ้าน รายอำเภอ/เขต (stat_aYY.txt) กรมการปกครอง",
    nameEn: "DOPA registered population and houses by district, annual download files stat_a64–stat_a68 (Dec of each BE year)",
    url: "https://stat.bora.dopa.go.th/new_stat/webPage/statByYear.php",
    publisher: "สำนักบริหารการทะเบียน กรมการปกครอง (Bureau of Registration Administration, DOPA)",
    license: "not stated",
    retrievedAt: latestRetrieval(dopaRels),
    accessStatus: statusFor(dopaRels),
    notes:
      `Files https://stat.bora.dopa.go.th/new_stat/file/YY/stat_aYY.txt (period column yymm = 'YY12'). Used to verify the NSO table district-by-district via DOPA codes. ` +
      `The newer SPA portal https://stat.bora.dopa.go.th/stat/statnew/statyear/ returns only a JavaScript shell and was not scraped. ${fetchNote(dopaRels)}`,
  });

  if (!nsoBuf) return { error: "NSO population table unavailable" };
  const rows = csvObjects(decodeText(nsoBuf).text).filter((r) => r.PROVINCE === "กรุงเทพมหานคร");
  const years = [...new Set(rows.map((r) => Number(r.YEAR)))].filter(Number.isFinite).sort((a, b) => a - b);
  const unmatched: string[] = [];
  const per = new Map<string, { total: Record<string, number>; male: Record<string, number>; female: Record<string, number> }>();
  const cityTotals: Record<string, number> = {};
  for (const r of rows) {
    const v = num(r.VALUE);
    if (v === null) continue;
    const yr = String(beToCe(Number(r.YEAR)));
    if (r.DISTRIC === "รวม") {
      if (r.SEX === "รวม") cityTotals[yr] = v;
      continue;
    }
    const d = matchOrLog(r.DISTRIC, "nso-population");
    if (!d) {
      unmatched.push(r.DISTRIC);
      continue;
    }
    const rec = per.get(d.code) ?? { total: {}, male: {}, female: {} };
    if (r.SEX === "รวม") rec.total[yr] = v;
    else if (r.SEX === "ชาย") rec.male[yr] = v;
    else if (r.SEX === "หญิง") rec.female[yr] = v;
    per.set(d.code, rec);
  }
  const ceYears = years.map(beToCe);
  const totalsCheck = ceYears.map((y) => {
    const sum = REGISTRY.reduce((a, d) => a + (per.get(d.code)?.total[String(y)] ?? 0), 0);
    const n = REGISTRY.filter((d) => per.get(d.code)?.total[String(y)] !== undefined).length;
    const pub = cityTotals[String(y)] ?? null;
    return { year: y, yearBE: y + 543, districtsWithValue: n, sumOfDistricts: sum, publishedTotal: pub, sumEqualsPublished: pub !== null && sum === pub };
  });
  const latest = Math.max(...ceYears.filter((y) => totalsCheck.find((t) => t.year === y)?.districtsWithValue === 50));

  // Cross-check: BMA open-data table (no year in file).
  let bmaCheck: Record<string, unknown> = { available: false };
  if (bmaBuf) {
    const dec = decodeText(bmaBuf);
    const bRows = csvObjects(dec.text);
    const matchesByYear: Record<string, number> = {};
    for (const y of ceYears) {
      matchesByYear[String(y)] = bRows.filter((r) => {
        const d = r.DISTRICT ? matchDistrict(r.DISTRICT).district : null;
        return d && per.get(d.code)?.total[String(y)] === num(r.TOTAL);
      }).length;
    }
    const best = Object.entries(matchesByYear).sort((a, b) => b[1] - a[1])[0];
    const bmaTotal = num(bRows.find((r) => !r.NO && r.DISTRICT.includes("รวม"))?.TOTAL);
    bmaCheck = {
      available: true,
      encoding: dec.encoding,
      rows: bRows.length,
      districtRowsMatchingNsoByYear: matchesByYear,
      inferredYear: best && best[1] === 50 ? Number(best[0]) : null,
      bmaPublishedTotal: bmaTotal,
      note: "The BMA file states no reference year; all 50 district values and the total equal the NSO/DOPA figures for the inferred year.",
    };
  }

  // Cross-check: Central Registration Office announcement in the Royal Gazette (as of 31 Dec 2565).
  const gazUrl = "https://www.dopa.go.th/news/preview/10616";
  const gazRel = "dopa/dopa_news_preview_10616.pdf";
  const gazBuf = await getRaw(gazUrl, gazRel, "pdf");
  let gazetteCheck: Record<string, unknown> = { available: false };
  if (gazBuf) {
    const { text, via } = pdfToText(path.join(RAW, gazRel));
    const asOf = text ? /ณ\s*วันที่\s*31\s*ธันวาคม\s*(25\d\d)/.exec(text) : null;
    const line = text?.split("\n").find((l) => /^\s*1\s+กรุงเทพมหานคร\s/.test(l));
    const nums = line ? (line.match(/\d{1,3}(?:,\d{3})+|\d+/g) ?? []).map((v) => Number(v.replace(/,/g, ""))) : [];
    // columns: no., Thai male, Thai female, Thai total, non-Thai male, non-Thai female, non-Thai total, grand total
    const yr = asOf ? beToCe(Number(asOf[1])) : null;
    const total = nums.length >= 8 ? nums[nums.length - 1] : null;
    gazetteCheck = {
      available: true,
      textVia: via,
      asOf: yr ? `${yr}-12-31` : null,
      bangkokThaiNationals: nums.length >= 8 ? nums[3] : null,
      bangkokNonThai: nums.length >= 8 ? nums[6] : null,
      bangkokTotal: total,
      nsoTableValueSameYear: yr ? (cityTotals[String(yr)] ?? null) : null,
      equal: yr !== null && total !== null && cityTotals[String(yr)] === total,
      note: "Royal Gazette vol. 140 special part 16 ง (23 Jan 2023): ประกาศสำนักทะเบียนกลาง เรื่อง จำนวนราษฎรทั่วราชอาณาจักร ณ วันที่ 31 ธันวาคม 2565. Confirms the 31-December reference date and that totals include non-Thai registered persons.",
    };
  }
  addSource({
    id: "dopa-gazette-announcement-2565",
    nameTh: "ประกาศสำนักทะเบียนกลาง เรื่อง จำนวนราษฎรทั่วราชอาณาจักร ตามหลักฐานการทะเบียนราษฎร ณ วันที่ 31 ธันวาคม 2565",
    nameEn: "DOPA Central Registration Office announcement of registered population as of 31 Dec 2022 (Royal Gazette, 23 Jan 2023)",
    url: gazUrl,
    publisher: "สำนักทะเบียนกลาง กรมการปกครอง (Central Registration Office, DOPA)",
    license: "not stated (official gazette publication)",
    retrievedAt: retrievedAt(gazRel),
    accessStatus: statusFor([gazRel]),
    notes: `Province-level only; used to verify the NSO table and the reference-date convention. ${fetchNote([gazRel])}`,
  });

  const out = {
    cityId: "bangkok",
    dataRetrievedAt: latestRetrieval([nsoRel]),
    sourceId: "nso-dopa-registered-population",
    sourceUrl: nsoUrl,
    definition:
      "Registered population (ประชากรตามหลักฐานการทะเบียนราษฎร): Thai nationals and non-Thai persons recorded in the house registers of each district under the Civil Registration Act B.E. 2534, as compiled by DOPA and published by NSO. Not the de facto resident population (excludes people living in Bangkok but registered elsewhere).",
    referenceDateNote:
      "DOPA annual registration figures are announced by the Central Registration Office as of 31 December of each BE year (e.g. BE 2568 → 2025-12-31). The NSO table labels rows only by BE year.",
    unit: "persons",
    years: ceYears,
    latestYear: latest,
    latestReferenceDate: `${latest}-12-31`,
    cityTotals: totalsCheck,
    districts: REGISTRY.map((d) => {
      const rec = per.get(d.code);
      const pop: Record<string, number | null> = {};
      for (const y of ceYears) pop[String(y)] = rec?.total[String(y)] ?? null;
      return {
        code: d.code,
        nameTh: d.nameTh,
        nameEn: d.nameEn,
        population: pop,
        latest: {
          year: latest,
          value: rec?.total[String(latest)] ?? null,
          male: rec?.male[String(latest)] ?? null,
          female: rec?.female[String(latest)] ?? null,
          status: rec?.total[String(latest)] !== undefined ? "observed" : "unavailable",
        },
      };
    }),
    unmatchedDistrictNames: unmatched,
    crossCheckBmaOpenData: bmaCheck,
    crossCheckDopaAnnouncement: gazetteCheck,
    crossCheckDopaStatFiles: [...dopaFiles.entries()].map(([yBE, m]) => {
      const y = beToCe(yBE);
      const compared = REGISTRY.filter((d) => m.has(d.code) && per.get(d.code)?.total[String(y)] !== undefined);
      return {
        year: y,
        yearBE: yBE,
        period: m.get("TOTAL")?.period ?? null,
        districtsInFile: REGISTRY.filter((d) => m.has(d.code)).length,
        districtsEqualToNso: compared.filter((d) => m.get(d.code)?.total === per.get(d.code)?.total[String(y)]).length,
        bangkokTotalInFile: m.get("TOTAL")?.total ?? null,
        bangkokTotalEqualsNso: m.get("TOTAL")?.total === cityTotals[String(y)],
        housesInFile: m.get("TOTAL")?.houses ?? null,
      };
    }),
    housesLatest: Object.fromEntries(REGISTRY.map((d) => [d.code, dopaFiles.get(latest + 543)?.get(d.code)?.houses ?? null])),
    housesNote: "Number of registered houses (บ้าน) per district from the DOPA stat file for the latest year (sourceId dopa-stat-files); not used elsewhere.",
    externalCrossCheckNote:
      "Search-engine snippets of news reports (prachachat.net; page returned HTTP 403 to automated fetch, so unverified) give Bangkok 5,455,020 at end-2024 (BE 2567), equal to this table, and ~5.42 million at end-2025.",
  };
  writeJson(path.join(STAGED, "bangkok-population.json"), out);
  log("population: latest", latest, "total", cityTotals[String(latest)], "check", JSON.stringify(totalsCheck.find((t) => t.year === latest)));
  return out;
}

// ===========================================================================
// 3. Waste quantity
// ===========================================================================
/** Row order of the BMA Environment Department collected-waste tables (Thai alphabetical). */
const WASTE_TABLE_ORDER = [
  "คลองเตย", "คลองสาน", "คลองสามวา", "คันนายาว", "จตุจักร", "จอมทอง", "ดอนเมือง", "ดินแดง", "ดุสิต", "ตลิ่งชัน",
  "ทวีวัฒนา", "ทุ่งครุ", "ธนบุรี", "บางกอกน้อย", "บางกอกใหญ่", "บางกะปิ", "บางขุนเทียน", "บางเขน", "บางคอแหลม", "บางแค",
  "บางซื่อ", "บางนา", "บางบอน", "บางพลัด", "บางรัก", "บึงกุ่ม", "ปทุมวัน", "ประเวศ", "ป้อมปราบศัตรูพ่าย", "พญาไท",
  "พระโขนง", "พระนคร", "ภาษีเจริญ", "มีนบุรี", "ยานนาวา", "ราชเทวี", "ราษฎร์บูรณะ", "ลาดกระบัง", "ลาดพร้าว", "วังทองหลาง",
  "วัฒนา", "สวนหลวง", "สะพานสูง", "สัมพันธวงศ์", "สาทร", "สายไหม", "หนองแขม", "หนองจอก", "หลักสี่", "ห้วยขวาง",
  "อื่นๆ",
];
const OTHER_KEY = "OTHER";

interface WastePdfSpec {
  fyBE: number;
  url: string;
  rel: string;
}
const WASTE_INDEX_URL = "https://webportal.bangkok.go.th/environmentbma/page/sub/28229";
const WASTE_PDFS: WastePdfSpec[] = [
  { fyBE: 2562, url: "https://webportal.bangkok.go.th/upload/user/00000231/data/waste/WasteSept_62_050121.pdf", rel: "bma-environment/waste-stats/FY2562_WasteSept_62_050121.pdf" },
  { fyBE: 2563, url: "https://webportal.bangkok.go.th/upload/user/00000231/data/law/waste_Sept63.pdf", rel: "bma-environment/waste-stats/FY2563_waste_Sept63.pdf" },
  { fyBE: 2564, url: "https://webportal.bangkok.go.th/public/user_files_editor/231/WasteData/2564/12.September2021.pdf", rel: "bma-environment/waste-stats/FY2564_12.September2021.pdf" },
  { fyBE: 2565, url: "https://webportal.bangkok.go.th/public/user_files_editor/231/WasteData/2565/12.September2022.pdf", rel: "bma-environment/waste-stats/FY2565_12.September2022.pdf" },
  { fyBE: 2566, url: "https://webportal.bangkok.go.th/public/user_files_editor/231/WasteData/2566/12.September2566.pdf", rel: "bma-environment/waste-stats/FY2566_12.September2566.pdf" },
  { fyBE: 2567, url: "https://webportal.bangkok.go.th/public/user_files_editor/231/WasteData/2567/12-September67.pdf", rel: "bma-environment/waste-stats/FY2567_12-September67.pdf" },
  { fyBE: 2568, url: "https://webportal.bangkok.go.th/public/user_files_editor/231/WasteData/2568/12_September.pdf", rel: "bma-environment/waste-stats/FY2568_12_September.pdf" },
  {
    fyBE: 2569,
    url: "https://webportal.bangkok.go.th/public/user_files_editor/231/WasteData/2569/%E0%B8%9B%E0%B8%A3%E0%B8%B4%E0%B8%A1%E0%B8%B2%E0%B8%93%E0%B8%A1%E0%B8%B9%E0%B8%A5%E0%B8%9D%E0%B8%AD%E0%B8%A2%E0%B8%81.%E0%B8%A2.69.pdf",
    rel: "bma-environment/waste-stats/FY2569_Sep69.pdf",
  },
];

interface WasteRow {
  key: string; // district code or OTHER
  label: string;
  months: number[];
  total: number;
  avgPublished: number | null;
}
interface WastePdfParse {
  fyBE: number;
  daysStated: number | null;
  rows: WasteRow[];
  grandTotal: number | null;
  sumOfRows: number;
  labelChecks: { n: number; label: string; ok: boolean }[];
  summaryTable: { fyBE: number; monthlyTpd: number[]; annualTpd: number }[];
  errors: string[];
  textVia: string;
}
const DEC_RE = /-?\d{1,3}(?:,\d{3})+\.\d{2}|-?\d+\.\d{2}/g;

function parseWastePdf(text: string, fyBE: number, textVia: string): WastePdfParse {
  const errors: string[] = [];
  const pages = text.split(/=====PAGE \d+=====/).filter((p) => p.trim());
  const res: WastePdfParse = { fyBE, daysStated: null, rows: [], grandTotal: null, sumOfRows: 0, labelChecks: [], summaryTable: [], errors, textVia };

  // Citywide summary table lines: "<BE year> <12 monthly t/day> <annual t/day>"
  for (const line of text.split("\n")) {
    const m = /^\s*(25\d\d)((?:\s+-?[\d,]+\.\d{2}){13})\s*$/.exec(line);
    if (m) {
      const vals = (m[2].match(DEC_RE) ?? []).map((v) => Number(v.replace(/,/g, "")));
      if (vals.length === 13) res.summaryTable.push({ fyBE: Number(m[1]), monthlyTpd: vals.slice(0, 12), annualTpd: vals[12] });
    }
  }

  // District table page: first page with >= 52 rows that pass the month-sum check.
  const skelTitle = skel("ปริมาณมูลฝอยที่จัดเก็บได้");
  for (const page of pages) {
    if (!skel(page).includes(skelTitle)) continue;
    const nums = (page.match(DEC_RE) ?? []).map((v) => Number(v.replace(/,/g, "")));
    const found: { months: number[]; total: number; next: number }[] = [];
    let i = 0;
    while (i + 13 <= nums.length) {
      const months = nums.slice(i, i + 12);
      const total = nums[i + 12];
      const s = months.reduce((a, b) => a + b, 0);
      if (total > 0 && months.every((x) => x >= 0) && Math.abs(s - total) <= 0.07) {
        found.push({ months, total, next: i + 13 });
        i += 13;
      } else i++;
    }
    if (found.length < 52) continue;
    const dm = /รวม\s*(\d{3})\s*ว/.exec(page);
    res.daysStated = dm ? Number(dm[1]) : null;
    const fyM = /งบประมาณ\s*(25\d\d)/.exec(page);
    if (fyM && Number(fyM[1]) !== fyBE) errors.push(`Table title fiscal year ${fyM[1]} != expected ${fyBE}`);
    const days = res.daysStated ?? daysInclusive(fiscalRange(fyBE).from, fiscalRange(fyBE).to);
    res.rows = found.slice(0, 51).map((f, idx) => {
      const label = WASTE_TABLE_ORDER[idx];
      const key = label === "อื่นๆ" ? OTHER_KEY : (bySkel.get(skel(label))?.code ?? `?${label}`);
      const cand = nums[f.next];
      const avg = cand !== undefined && Math.abs(cand - f.total / days) <= 0.011 ? cand : null;
      return { key, label, months: f.months, total: f.total, avgPublished: avg };
    });
    res.sumOfRows = round(res.rows.reduce((a, r) => a + r.total, 0), 2);
    res.grandTotal = found[51].total;
    if (Math.abs(res.sumOfRows - res.grandTotal) > 0.5) errors.push(`Sum of 51 rows ${res.sumOfRows} != grand total ${res.grandTotal}`);
    // Label check: "<n> [สำนักงานเขต]<name>" pairs must agree with the canonical order.
    const toks = page.split(/\s+/).filter(Boolean);
    for (let t = 0; t < toks.length; t++) {
      if (!/^\d{1,2}$/.test(toks[t])) continue;
      const n = Number(toks[t]);
      let j = t + 1;
      const parts: string[] = [];
      while (j < toks.length && !/^[-\d,.()]+$/.test(toks[j]) && parts.length < 6) parts.push(toks[j++]);
      if (!parts.length) continue;
      const s = skel(parts.join(""));
      const idx = WASTE_TABLE_ORDER.findIndex((w) => skel(w) === s);
      if (idx >= 0 && n >= 1 && n <= 51) res.labelChecks.push({ n, label: WASTE_TABLE_ORDER[idx], ok: idx === n - 1 });
    }
    if (res.labelChecks.some((c) => !c.ok)) errors.push("Row-number labels disagree with canonical order");
    if (res.labelChecks.length < 5 && fyBE !== 2564) errors.push("Too few row labels to verify order");
    break;
  }
  if (!res.rows.length) errors.push("District table not found / not parseable");
  return res;
}

function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = Array<number>(v.length).fill(0);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num_ = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num_ += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return num_ / Math.sqrt(da * db);
}
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface WasteRecord {
  code: string;
  year: number;
  fiscalYearBE: number;
  periodFrom: string | null;
  periodTo: string | null;
  periodNote?: string;
  definitionNote?: string;
  definition: "collected";
  valuePublished: number | null;
  unitPublished: string;
  tonnesPerDay: number | null;
  tonnesPerDayPublished: number | null;
  daysDivisor: number;
  status: "observed" | "derived" | "unavailable";
  tonnesPerDayStatus: "derived" | "unavailable";
  seriesId: string;
  sourceId: string;
  flags: string[];
  monthlyTonnes?: number[];
  rawPublished?: { annual: number | null; perDay: number | null };
}

async function buildWaste() {
  // ---- metadata
  const pkgG1 = await ckanPackage(DATAGOTH, "garbage1", "datagoth/package_garbage1.json");
  const pkgG = await ckanPackage(DATAGOTH, "garbage", "datagoth/package_garbage.json");
  const pkgG50 = await ckanPackage(BMA_CKAN, "garbage50", "bma-opendata/pkg_garbage50.json");
  const pkgEnv4 = await ckanPackage(BMA_CKAN, "https-webportal-bangkok-go-th-environmentbma", "bma-opendata/pkg_https-webportal-bangkok-go-th-environmentbma.json");
  const pkgEnv11 = await ckanPackage(BMA_CKAN, "env0011", "bma-opendata/pkg_env0011.json");
  const idxRel = "bma-environment/page_sub_28229.html";
  const idxBuf = await getRaw(WASTE_INDEX_URL, idxRel, "html");
  const idxHtml = idxBuf ? idxBuf.toString("utf8") : "";

  // ---- BMA Environment Department collected-waste PDFs (FY2562–FY2569)
  const parsed: WastePdfParse[] = [];
  for (const spec of WASTE_PDFS) {
    const buf = await getRaw(spec.url, spec.rel, "pdf");
    const listed = idxHtml ? idxHtml.includes(spec.url.split("/").slice(-1)[0]) : null;
    let p: WastePdfParse | null = null;
    if (buf) {
      const { text, via } = pdfToText(path.join(RAW, spec.rel));
      if (text) p = parseWastePdf(text, spec.fyBE, via);
      else p = { fyBE: spec.fyBE, daysStated: null, rows: [], grandTotal: null, sumOfRows: 0, labelChecks: [], summaryTable: [], errors: [via], textVia: via };
      parsed.push(p);
    }
    addSource({
      id: `bma-env-waste-fy${spec.fyBE}`,
      nameTh: `สถิติปริมาณมูลฝอย ประจำปีงบประมาณ ${spec.fyBE} (ข้อมูลปริมาณมูลฝอยที่จัดเก็บได้)`,
      nameEn: `BMA collected solid waste statistics, fiscal year ${beToCe(spec.fyBE)} (Oct ${beToCe(spec.fyBE) - 1} – Sep ${beToCe(spec.fyBE)}), by district office`,
      url: spec.url,
      publisher: "สำนักสิ่งแวดล้อม กรุงเทพมหานคร (BMA Environment Department)",
      license: "not stated",
      retrievedAt: retrievedAt(spec.rel),
      accessStatus: !buf ? "failed" : p && !p.errors.length ? "retrieved" : "partial",
      notes:
        `Listed on ${WASTE_INDEX_URL}${listed === false ? " (link no longer found on index page)" : ""}. ${fetchNote([spec.rel])}. ` +
        `Text via ${p?.textVia ?? "n/a"}; parse ${p && !p.errors.length ? "OK" : "errors: " + (p?.errors.join("; ") ?? "no file")}.`,
    });
  }
  addSource({
    id: "bma-env-waste-statistics-index",
    nameTh: "สถิติปริมาณมูลฝอย — สำนักสิ่งแวดล้อม",
    nameEn: "BMA Environment Department waste statistics index page (links to annual PDFs FY2554–FY2569)",
    url: WASTE_INDEX_URL,
    publisher: "สำนักสิ่งแวดล้อม กรุงเทพมหานคร (BMA Environment Department)",
    license: "not stated",
    retrievedAt: retrievedAt(idxRel),
    accessStatus: statusFor([idxRel]),
    notes: fetchNote([idxRel]),
  });

  const pdfOk = parsed.filter((p) => p.rows.length === 51 && p.errors.length === 0);
  const records: WasteRecord[] = [];
  const otherRecords: WasteRecord[] = [];
  for (const p of pdfOk) {
    const { from, to } = fiscalRange(p.fyBE);
    const days = p.daysStated ?? daysInclusive(from, to);
    const flags = days !== daysInclusive(from, to) ? [`stated days ${days} != calendar days ${daysInclusive(from, to)}`] : [];
    for (const r of p.rows) {
      const rec: WasteRecord = {
        code: r.key,
        year: beToCe(p.fyBE),
        fiscalYearBE: p.fyBE,
        periodFrom: from,
        periodTo: to,
        definition: "collected",
        valuePublished: r.total,
        unitPublished: "t per fiscal year (sum of 12 monthly tonnages)",
        tonnesPerDay: round(r.total / days, 2),
        tonnesPerDayPublished: r.avgPublished,
        daysDivisor: days,
        status: "observed",
        tonnesPerDayStatus: "derived",
        seriesId: "bma-env-collected-by-district-fy",
        sourceId: `bma-env-waste-fy${p.fyBE}`,
        flags: [...flags],
        monthlyTonnes: r.months,
      };
      (r.key === OTHER_KEY ? otherRecords : records).push(rec);
    }
  }

  // ---- data.go.th "garbage" / "garbage1" (BMA GIS Division) 2553–2561
  const gUrl =
    pkgG1?.resources.find((r) => /\.csv$/i.test(r.url))?.url ??
    "https://data.bangkok.go.th/dataset/58771fe2-7614-4ebc-ab0b-a85c84fe19be/resource/f08ef6ac-4c78-47c5-952c-46ffa6e93579/download/garbage.csv";
  const gRel = "bma-opendata/garbage/garbage.csv";
  const gDocRel = "bma-opendata/garbage/garbage.docx";
  const gBuf = await getRaw(gUrl, gRel, "csv");
  await getRaw(
    pkgG1?.resources.find((r) => /\.docx$/i.test(r.url))?.url ??
      "https://data.bangkok.go.th/dataset/58771fe2-7614-4ebc-ab0b-a85c84fe19be/resource/8a87c44a-d12b-4859-90cc-3a6a7719b0f2/download/garbage.docx",
    gDocRel,
    "docx",
  );
  const g2Url =
    pkgG?.resources.find((r) => /\.csv$/i.test(r.url))?.url ??
    "https://data.go.th/dataset/731a8cb0-d563-45ca-93ae-52e3de47e474/resource/1c0a2c55-d28e-446d-bbdf-9b810b8c0035/download/garbage.csv";
  const g2Rel = "datagoth/garbage/garbage.csv";
  const g2Buf = await getRaw(g2Url, g2Rel, "csv");
  const identical = !!gBuf && !!g2Buf && sha256(gBuf) === sha256(g2Buf);
  const legacyQuality: Record<string, unknown>[] = [];
  const ref2562 = pdfOk.find((p) => p.fyBE === 2562);
  const legacyCitySums: { fiscalYearBE: number; sumAllRowsTpd365: number }[] = [];
  if (gBuf) {
    const rows = csvObjects(decodeText(gBuf).text);
    const yrs = Object.keys(rows[0] ?? {})
      .map((k) => /^garbage(\d\d)$/.exec(k)?.[1])
      .filter((x): x is string => !!x)
      .map(Number);
    const distRows = rows.filter((r) => r.dcode !== "1000");
    const refVals = ref2562 ? distRows.map((r) => ref2562.rows.find((x) => x.key === r.dcode)?.total ?? NaN) : [];
    const colFlag = new Map<number, string | null>();
    for (const y of yrs) {
      const vals = distRows.map((r) => num(r[`garbage${y}`]) ?? NaN);
      const rho = refVals.length && vals.every(Number.isFinite) && refVals.every(Number.isFinite) ? spearman(vals, refVals) : NaN;
      const pd = distRows.map((r) => num(r[`garbageperday${y}`]) ?? NaN);
      const zeroPerDay = pd.every((x) => x === 0);
      const flag = Number.isFinite(rho) && rho < 0.5 ? `column-misaligned (Spearman rho vs FY2562 PDF = ${round(rho, 3)} < 0.5)` : null;
      colFlag.set(y, flag);
      const sumAll = rows.reduce((a, r) => a + (num(r[`garbage${y}`]) ?? 0), 0);
      legacyCitySums.push({ fiscalYearBE: 2500 + y, sumAllRowsTpd365: round(sumAll / 365, 2) });
      legacyQuality.push({ yearBE: 2500 + y, spearmanVsFY2562Pdf: Number.isFinite(rho) ? round(rho, 3) : null, columnFlag: flag, perDayColumnAllZero: zeroPerDay });
    }
    // District medians over the columns not flagged as misaligned.
    const okYears = yrs.filter((y) => !colFlag.get(y));
    for (const r of rows) {
      const key = r.dcode === "1000" ? OTHER_KEY : r.dcode;
      if (key !== OTHER_KEY && !byCode.has(key)) continue;
      const med = median(okYears.map((y) => num(r[`garbage${y}`]) ?? NaN).filter(Number.isFinite));
      for (const y of yrs) {
        const annual = num(r[`garbage${y}`]);
        const perDay = num(r[`garbageperday${y}`]);
        const flags: string[] = [];
        const cf = colFlag.get(y);
        if (cf) flags.push(cf);
        if (annual !== null && !cf && (annual / med < 0.67 || annual / med > 1.5))
          flags.push(`outlier-vs-district-median (value/median = ${round(annual / med, 2)}, outside 0.67–1.5)`);
        if (annual !== null && perDay !== null) {
          if (perDay === 0) flags.push("published per-day value is 0 (column blank)");
          else if (Math.abs(perDay - annual / 365) / (annual / 365) > 0.01) flags.push(`published per-day ${perDay} inconsistent with annual/365 = ${round(annual / 365, 2)}`);
        }
        const usable = annual !== null && !flags.some((f) => f.startsWith("column-misaligned") || f.startsWith("outlier"));
        const rec: WasteRecord = {
          code: key,
          year: beToCe(2500 + y),
          fiscalYearBE: 2500 + y,
          periodFrom: null,
          periodTo: null,
          periodNote: "Labelled 'ปี 25xx' in the data dictionary; fiscal vs calendar year not stated (BMA waste statistics are normally fiscal years).",
          definitionNote:
            "Source says only 'ปริมาณขยะมูลฝอย' (quantity of solid waste). Treated as collected because column totals (incl. dcode 1000 'other') match the BMA collected-waste fiscal-year averages within 0.6% for BE 2556–2561 (see crossChecks.legacyCitySumsVsPdfSummary).",
          definition: "collected",
          valuePublished: usable ? annual : null,
          unitPublished: "t per year (as published)",
          tonnesPerDay: usable && annual !== null ? round(annual / 365, 2) : null,
          tonnesPerDayPublished: perDay,
          daysDivisor: 365,
          status: usable ? "observed" : "unavailable",
          tonnesPerDayStatus: usable ? "derived" : "unavailable",
          seriesId: "bma-gis-garbage-by-district-2553-2561",
          sourceId: "bma-gis-garbage-by-district",
          flags,
          rawPublished: { annual, perDay },
        };
        (key === OTHER_KEY ? otherRecords : records).push(rec);
      }
    }
  }
  addSource({
    id: "bma-gis-garbage-by-district",
    nameTh: pkgG1?.title ?? "ข้อมูลปริมาณขยะมูลฝอย จำแนกตามเขตการปกครองกรุงเทพมหานคร",
    nameEn: "Solid waste quantity by Bangkok district, BE 2553–2561 (data.go.th 'garbage1' / 'garbage', BMA GIS Division)",
    url: "https://data.go.th/dataset/garbage1",
    publisher: `กรุงเทพมหานคร — ${pkgG1?.maintainer ?? "กองสารสนเทศภูมิศาสตร์"}`,
    license: `${pkgG1?.license_title ?? "not stated"} (garbage1); ${pkgG?.license_title ?? "?"} (garbage)`,
    retrievedAt: latestRetrieval([gRel, g2Rel, gDocRel]),
    accessStatus: !gBuf ? "failed" : "partial",
    notes:
      `CSV ${gUrl}; duplicate dataset https://data.go.th/dataset/garbage (${g2Url}) is ${identical ? "byte-identical" : "NOT identical"}. ` +
      `Data dictionary garbage.docx (updated 4 Jun 2563): units t/year and t/day; dcode 1000 = 'อื่นๆ' (other). ` +
      `Marked partial: several columns/cells fail quality checks (see bangkok-waste.json legacyQuality). ${fetchNote([gRel, g2Rel, gDocRel])}`,
  });

  // ---- garbage50 (year not stated) — infer year by matching PDF tables
  const g50Url =
    pkgG50?.resources.find((r) => /\.csv$/i.test(r.url))?.url ??
    "https://data.bangkok.go.th/dataset/693011d9-70d3-4b38-aced-af040a2ad6ec/resource/0f094f40-c0c9-42ea-8cdb-29ec0f40cecd/download/quantity_waste.csv";
  const g50Rel = "bma-opendata/garbage50/quantity_waste.csv";
  const g50Buf = await getRaw(g50Url, g50Rel, "csv");
  let g50Check: Record<string, unknown> = { available: false };
  if (g50Buf) {
    const rows = csvObjects(decodeText(g50Buf).text);
    const codeIssues: string[] = [];
    const vals = new Map<string, number>();
    for (const r of rows) {
      const v = num(r.SolidWaste);
      if (v === null) continue;
      if (!r.dcode) {
        vals.set(OTHER_KEY, v);
        continue;
      }
      const d = matchOrLog(r.name, "garbage50");
      if (!d) continue;
      if (d.code !== r.dcode) codeIssues.push(`${r.name}: dcode ${r.dcode} in file, ${d.code} by name`);
      vals.set(d.code, v);
    }
    // garbage50 stores single-precision floats (6 significant digits): tolerance = half a unit in the 6th digit.
    const tol = (v: number) => 0.5 * 10 ** (Math.floor(Math.log10(Math.abs(v) || 1)) - 5) + 0.011;
    const matchCounts = pdfOk.map((p) => ({
      fiscalYearBE: p.fyBE,
      matchingRows: p.rows.filter((x) => vals.has(x.key) && Math.abs((vals.get(x.key) ?? 0) - x.total) <= tol(x.total)).length,
    }));
    const best = [...matchCounts].sort((a, b) => b.matchingRows - a.matchingRows)[0];
    g50Check = {
      available: true,
      rows: rows.length,
      codeIssues,
      matchCountsVsPdfTables: matchCounts,
      matchTolerance: "half a unit in the 6th significant digit (file stores 6-significant-digit floats)",
      inferredFiscalYearBE: best && best.matchingRows >= 45 ? best.fiscalYearBE : null,
      note: "Values are annual tonnes; the dataset states no year. When all rows equal one PDF fiscal-year table it is a duplicate of that table and is not used as a separate series.",
    };
  }
  addSource({
    id: "bma-gis-garbage50",
    nameTh: pkgG50?.title ?? "ปริมาณการเก็บมูลฝอยพื้นที่เขตกรุงเทพมหานคร 50 เขต",
    nameEn: "Collected waste per district (BMA open data 'garbage50'; year not stated)",
    url: "https://data.bangkok.go.th/dataset/garbage50",
    publisher: `กรุงเทพมหานคร — ${pkgG50?.organization?.title ?? "กองยุทธศาสตร์ดิจิทัล"}`,
    license: pkgG50?.license_title ?? "not stated",
    retrievedAt: retrievedAt(g50Rel),
    accessStatus: statusFor([g50Rel]),
    notes: `CSV ${g50Url}. ${fetchNote([g50Rel])}. Used for cross-check only.`,
  });

  // ---- env0004 (FY2566 Oct–Jul monthly, by district) — cross-check vs FY2566 PDF
  const e4Url =
    pkgEnv4?.resources.find((r) => /\.csv$/i.test(r.url))?.url ??
    "https://data.bangkok.go.th/dataset/2ab09309-b85f-4db0-9651-dce396f620f1/resource/0f76b9bf-ed5d-4386-bea2-16e245ea8b28/download/env0004.csv";
  const e4Rel = "bma-opendata/env0004/env0004.csv";
  const e4Buf = await getRaw(e4Url, e4Rel, "csv");
  let e4Check: Record<string, unknown> = { available: false };
  const p2566 = pdfOk.find((p) => p.fyBE === 2566);
  if (e4Buf && p2566) {
    const rows = csvObjects(decodeText(e4Buf).text);
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const slugAlias: Record<string, string> = { vadhana: "1039", envidepart: OTHER_KEY };
    const colToKey = (col: string) => {
      const s = col.replace(/_ton$/, "");
      if (slugAlias[s]) return slugAlias[s];
      return REGISTRY.find((d) => slug(d.nameEn) === s)?.code ?? null;
    };
    let compared = 0;
    let equal = 0;
    const unmatchedCols: string[] = [];
    const monthIdx = (my: string) => {
      const m = Number(my.split("_")[0]);
      return m >= 10 ? m - 10 : m + 2;
    };
    for (const r of rows) {
      for (const [col, v] of Object.entries(r)) {
        if (!col.endsWith("_ton") || col === "total_ton") continue;
        const key = colToKey(col);
        if (!key) {
          if (!unmatchedCols.includes(col)) unmatchedCols.push(col);
          continue;
        }
        const pdfRow = p2566.rows.find((x) => x.key === key);
        const val = num(v);
        if (!pdfRow || val === null) continue;
        compared++;
        if (Math.abs(pdfRow.months[monthIdx(r.month_year)] - val) <= 0.011) equal++;
      }
    }
    e4Check = {
      available: true,
      months: rows.map((r) => r.month_year),
      cellsCompared: compared,
      cellsEqualToFy2566Pdf: equal,
      unmatchedColumns: unmatchedCols,
      note: "env0004 holds FY2566 Oct 2565–Jul 2566 only (10 months); 'envidepart_ton' corresponds to the 'อื่นๆ' row of the PDF tables.",
    };
  }
  addSource({
    id: "bma-env0004-collected-monthly",
    nameTh: pkgEnv4?.title ?? "ปริมาณมูลฝอยทั่วไปที่จัดเก็บได้ของกรุงเทพมหานคร",
    nameEn: "General waste collected by district office, monthly Oct 2022–Jul 2023 (BMA open data env0004)",
    url: "https://data.bangkok.go.th/dataset/https-webportal-bangkok-go-th-environmentbma",
    publisher: "สำนักสิ่งแวดล้อม กรุงเทพมหานคร (BMA Environment Department)",
    license: pkgEnv4?.license_title ?? "not stated",
    retrievedAt: retrievedAt(e4Rel),
    accessStatus: statusFor([e4Rel]),
    notes: `CSV ${e4Url}. ${fetchNote([e4Rel])}. Cross-check only (superseded by the full-year FY2566 PDF).`,
  });

  // ---- env0011: waste disposed by technology (t/day), BE 2560–2565
  const e11Url =
    pkgEnv11?.resources.find((r) => /\.csv$/i.test(r.url))?.url ??
    "https://data.bangkok.go.th/dataset/af62128f-566b-4831-aece-1784041807d3/resource/55e93768-9427-4807-a791-e1f9350958d5/download/env0011-65.csv";
  const e11Rel = "bma-opendata/env0011/env0011-65.csv";
  const e11Buf = await getRaw(e11Url, e11Rel, "csv");
  const disposed: Record<string, unknown>[] = [];
  if (e11Buf) {
    for (const r of csvObjects(decodeText(e11Buf).text)) {
      const yBE = num(r.ye_ar);
      if (yBE === null) continue;
      disposed.push({
        year: beToCe(yBE),
        fiscalYearBE: yBE,
        definition: "disposed",
        tonnesPerDay: num(r.total_ton_day),
        byTechnologyTpd: {
          landfill: num(r.landfill_ton_day),
          compost: num(r.compost_ton_day),
          incinerator: num(r.incinerator_ton_day),
          mbt: num(r.mbt_ton_day),
          newSystem: num(r.new_system_ton_day),
        },
        unitPublished: "t/day",
        status: "observed",
        sourceId: "bma-env0011-disposal",
      });
    }
  }
  addSource({
    id: "bma-env0011-disposal",
    nameTh: pkgEnv11?.title ?? "ปริมาณมูลฝอยทั่วไปที่นำไปกำจัดแยกตามเทคโนโลยีการกำจัดมูลฝอย",
    nameEn: "General waste sent to disposal by technology (t/day), BE 2560–2565 (BMA open data env0011)",
    url: "https://data.bangkok.go.th/dataset/env0011",
    publisher: "สำนักสิ่งแวดล้อม กรุงเทพมหานคร (BMA Environment Department)",
    license: pkgEnv11?.license_title ?? "not stated",
    retrievedAt: retrievedAt(e11Rel),
    accessStatus: statusFor([e11Rel]),
    notes: `CSV ${e11Url}. ${fetchNote([e11Rel])}.`,
  });

  // ---- citywide collected t/day by fiscal year from the PDF summary tables
  const summaryByYear = new Map<number, { annualTpd: number; monthlyTpd: number[]; from: number }[]>();
  for (const p of parsed)
    for (const s of p.summaryTable) {
      const arr = summaryByYear.get(s.fyBE) ?? [];
      arr.push({ annualTpd: s.annualTpd, monthlyTpd: s.monthlyTpd, from: p.fyBE });
      summaryByYear.set(s.fyBE, arr);
    }
  const cityCollected = [...summaryByYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fy, arr]) => {
      const pick = [...arr].sort((a, b) => b.from - a.from)[0];
      const disagreements = arr.filter((x) => Math.abs(x.annualTpd - pick.annualTpd) > 0.011).map((x) => ({ pdfFy: x.from, annualTpd: x.annualTpd }));
      const table = pdfOk.find((p) => p.fyBE === fy);
      const { from, to } = fiscalRange(fy);
      return {
        year: beToCe(fy),
        fiscalYearBE: fy,
        periodFrom: from,
        periodTo: to,
        definition: "collected",
        tonnesPerDay: pick.annualTpd,
        monthlyTonnesPerDay: pick.monthlyTpd,
        totalTonnes: table?.grandTotal ?? null,
        unitPublished: "t/day (published fiscal-year average)",
        status: "observed",
        sourceId: `bma-env-waste-fy${pick.from}`,
        reportedIn: arr.map((x) => x.from).sort(),
        disagreementsBetweenReports: disagreements,
        sumOfDistrictTablesCheck: table
          ? { grandTotalTonnes: table.grandTotal, days: table.daysStated, grandTotalPerDay: table.grandTotal !== null && table.daysStated ? round(table.grandTotal / table.daysStated, 2) : null }
          : null,
      };
    });

  // ---- assemble per district
  const byDistrict = REGISTRY.map((d) => {
    const hist = records.filter((r) => r.code === d.code).sort((a, b) => a.year - b.year || a.seriesId.localeCompare(b.seriesId));
    const usable = hist.filter((r) => r.status === "observed");
    const latest = usable[usable.length - 1];
    return {
      code: d.code,
      nameTh: d.nameTh,
      nameEn: d.nameEn,
      latest: latest
        ? { year: latest.year, fiscalYearBE: latest.fiscalYearBE, periodFrom: latest.periodFrom, periodTo: latest.periodTo, tonnesPerDay: latest.tonnesPerDay, totalTonnes: latest.valuePublished, definition: latest.definition, status: latest.tonnesPerDayStatus, sourceId: latest.sourceId }
        : null,
      history: hist,
    };
  });

  // YoY jump check on the PDF series (document-order assignment sanity check)
  const jumps: { code: string; fromFy: number; toFy: number; ratio: number }[] = [];
  for (const d of byDistrict) {
    const pdfHist = d.history.filter((h) => h.seriesId === "bma-env-collected-by-district-fy");
    for (let i = 1; i < pdfHist.length; i++) {
      const a = pdfHist[i - 1].valuePublished;
      const b = pdfHist[i].valuePublished;
      if (a && b && (b / a > 1.5 || b / a < 0.67)) jumps.push({ code: d.code, fromFy: pdfHist[i - 1].fiscalYearBE, toFy: pdfHist[i].fiscalYearBE, ratio: round(b / a, 3) });
    }
  }

  const latestFy = Math.max(...pdfOk.map((p) => p.fyBE));
  const latestTable = pdfOk.find((p) => p.fyBE === latestFy);
  const out = {
    cityId: "bangkok",
    dataRetrievedAt: latestRetrieval(WASTE_PDFS.map((w) => w.rel)),
    definitions: {
      collected:
        "มูลฝอยที่จัดเก็บได้ — general municipal solid waste collected by each district office (สำนักงานเขต) and delivered to BMA transfer/disposal facilities, weighed at the facilities. Not generation: excludes waste recycled or sold at source, waste not collected, hazardous and infectious waste (separate BMA series).",
      others:
        "Row 'อื่นๆ' (Others) in the BMA tables: waste delivered by sources other than the 50 district offices (in env0004 the column is 'envidepart_ton', i.e. collected by the Environment Department itself). It cannot be allocated to districts; the citywide total includes it.",
      disposed: "มูลฝอยที่นำไปกำจัด — tonnage received for disposal by technology (env0011).",
    },
    daysDivisorPolicy:
      "BMA Environment Department PDFs (FY2562–FY2569): tonnesPerDay = fiscal-year total ÷ number of days stated in the table header ('รวม N วัน', 365 or 366 = calendar days of 1 Oct–30 Sep); reproduces the publisher's own average column. Legacy CSV (BE 2553–2561): annual ÷ 365, the divisor the publisher used in its own per-day columns.",
    yearConvention: "year = Gregorian year in which the Thai fiscal year ends (FY BE 2569 = 1 Oct 2025 – 30 Sep 2026 → 2026).",
    latest: {
      year: beToCe(latestFy),
      fiscalYearBE: latestFy,
      periodFrom: fiscalRange(latestFy).from,
      periodTo: fiscalRange(latestFy).to,
      cityTotalTonnes: latestTable?.grandTotal ?? null,
      cityTonnesPerDay: cityCollected.find((c) => c.fiscalYearBE === latestFy)?.tonnesPerDay ?? null,
      sumOfDistrictsTonnes: latestTable ? round(latestTable.rows.filter((r) => r.key !== OTHER_KEY).reduce((a, r) => a + r.total, 0), 2) : null,
      othersTonnes: latestTable?.rows.find((r) => r.key === OTHER_KEY)?.total ?? null,
    },
    series: [
      {
        id: "bma-env-collected-by-district-fy",
        nameEn: "Collected waste by district office, fiscal years (BMA Environment Department annual PDFs)",
        fiscalYearsBE: pdfOk.map((p) => p.fyBE),
        definition: "collected",
        quality: "Each row passes 12-month-sum = annual-total check; 51 rows sum to the published grand total; row order verified against printed row numbers.",
      },
      {
        id: "bma-gis-garbage-by-district-2553-2561",
        nameEn: "Solid waste by district BE 2553–2561 (data.go.th garbage1/garbage)",
        definition: "collected (ปริมาณขยะมูลฝอย; the dataset title does not say collected/generated — values reconcile with BMA collected totals to within ~1%)",
        quality: "Several columns misaligned (sorted) and cells inconsistent; flagged values are null with status 'unavailable', raw values retained in rawPublished.",
      },
    ],
    pdfParse: parsed.map((p) => ({
      fiscalYearBE: p.fyBE,
      textVia: p.textVia,
      daysStated: p.daysStated,
      rows: p.rows.length,
      grandTotal: p.grandTotal,
      sumOfRows: p.sumOfRows,
      labelChecks: `${p.labelChecks.filter((c) => c.ok).length}/${p.labelChecks.length} printed row labels agree with canonical order`,
      summaryTableYears: p.summaryTable.map((s) => s.fyBE),
      errors: p.errors,
    })),
    legacyQuality,
    crossChecks: {
      legacyCsvDuplicateIdentical: identical,
      legacyCitySumsVsPdfSummary: legacyCitySums.map((l) => ({
        ...l,
        pdfSummaryTpd: cityCollected.find((c) => c.fiscalYearBE === l.fiscalYearBE)?.tonnesPerDay ?? null,
      })),
      garbage50: g50Check,
      env0004VsFy2566Pdf: e4Check,
      largeYearOnYearChangesInPdfSeries: jumps,
    },
    districts: byDistrict,
    others: otherRecords.sort((a, b) => a.year - b.year),
    cityTotals: { collected: cityCollected, disposed },
  };
  writeJson(path.join(STAGED, "bangkok-waste.json"), out);
  log(
    "waste: pdf years OK",
    pdfOk.map((p) => p.fyBE).join(","),
    "| failed",
    parsed.filter((p) => !pdfOk.includes(p)).map((p) => `${p.fyBE}:${p.errors.join("/")}`).join(" "),
    "| latest",
    JSON.stringify(out.latest),
  );
  return out;
}

// ===========================================================================
// 4. Composition
// ===========================================================================
const CATS: WasteCategory[] = ["organic", "plastic", "paper", "glassMetal", "hazardous", "other"];
interface CompCat {
  th: string;
  alt: string[];
  en: string;
  to: WasteCategory;
  csvKey: string;
}
const COMP_CATS: CompCat[] = [
  { th: "เศษอาหาร", alt: [], en: "Food waste", to: "organic", csvKey: "foodwest" },
  { th: "ไม้และใบไม้", alt: ["กิ่งไม้และใบไม้"], en: "Wood, branches and leaves", to: "organic", csvKey: "wood" },
  { th: "กระดาษ recycle", alt: ["กระดาษที่สามารถรีไซเคิลได้"], en: "Paper, recyclable", to: "paper", csvKey: "paper_recycle" },
  { th: "กระดาษ non recycle", alt: ["กระดาษที่ไม่สามารถรีไซเคิลได้"], en: "Paper, non-recyclable", to: "paper", csvKey: "non_paper_recycle" },
  { th: "พลาสติก recycle", alt: ["พลาสติกที่สามารถรีไซเคิลได้"], en: "Plastic, recyclable", to: "plastic", csvKey: "plastic_recycle" },
  { th: "พลาสติก non recycle", alt: ["พลาสติกที่ไม่สามารถรีไซเคิลได้"], en: "Plastic, non-recyclable", to: "plastic", csvKey: "non_plastic_recycle" },
  { th: "โฟม", alt: [], en: "Foam (expanded polystyrene)", to: "plastic", csvKey: "foan" },
  { th: "แก้ว", alt: [], en: "Glass", to: "glassMetal", csvKey: "glass" },
  { th: "โลหะ", alt: [], en: "Metal", to: "glassMetal", csvKey: "metal" },
  { th: "หนังและยาง", alt: [], en: "Leather and rubber", to: "other", csvKey: "rubber" },
  { th: "ผ้าและสิ่งทอ", alt: [], en: "Textiles", to: "other", csvKey: "fabric" },
  { th: "หินและเซรามิค", alt: [], en: "Stone and ceramics", to: "other", csvKey: "stone" },
  { th: "กระดูกและเปลือกหอย", alt: [], en: "Bones and shells", to: "other", csvKey: "bones" },
  { th: "ผ้าอ้อมสำเร็จรูป", alt: [], en: "Disposable diapers", to: "other", csvKey: "diapers" },
];
/**
 * FY2563 and FY2564 tables are scanned images (no text layer); values below were
 * transcribed manually from the "average / เฉลี่ย" column of the PDFs and are
 * verified by the script to sum to 100.00 exactly.
 */
const MANUAL_COMPOSITION: Record<number, { values: Record<string, number>; scope: string; rel: string; url: string }> = {
  2563: {
    rel: "bma-environment/composition/WasteCompo2563.pdf",
    url: "https://webportal.bangkok.go.th/upload/user/00000231/data/waste63/WasteCompo2563.pdf",
    scope: "Average of samples at BMA's three disposal centres (On Nut, Nong Khaem, Sai Mai); unit '% by weight' (ร้อยละโดยน้ำหนัก).",
    values: {
      foodwest: 45.41, wood: 5.76, paper_recycle: 2.71, plastic_recycle: 4.94, foan: 1.34, glass: 2.3, metal: 1.38,
      non_paper_recycle: 11.31, non_plastic_recycle: 16.3, rubber: 1.05, fabric: 4.15, stone: 0.25, bones: 1.1, diapers: 2.0,
    },
  },
  2564: {
    rel: "bma-environment/composition/WasteComp_2.pdf",
    url: "https://webportal.bangkok.go.th/public/user_files_editor/231/WasteData/2565/WasteComp_2.pdf",
    scope:
      "Average of samples at BMA's three disposal centres (On Nut, Sai Mai, Nong Khaem). Footnote: because of COVID-19, in July and August 2564 samples were taken only at the On Nut transfer station.",
    values: {
      foodwest: 46.21, wood: 6.36, paper_recycle: 2.43, non_paper_recycle: 9.63, plastic_recycle: 2.15, non_plastic_recycle: 19.36,
      foan: 1.38, glass: 1.92, metal: 1.18, rubber: 1.0, fabric: 5.49, stone: 0.46, bones: 1.2, diapers: 1.23,
    },
  },
};

/** Largest-remainder rounding of shares to 0.1 summing to exactly 100.0 (integer arithmetic). */
function largestRemainder(shares: Record<WasteCategory, number>): Record<WasteCategory, number> {
  const hund = CATS.map((c) => Math.round(shares[c] * 100));
  const total = hund.reduce((a, b) => a + b, 0);
  const floors = hund.map((h) => Math.floor((h * 1000) / total));
  const rems = hund.map((h, i) => ({ i, r: (h * 1000) % total }));
  let left = 1000 - floors.reduce((a, b) => a + b, 0);
  rems.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of rems) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  return Object.fromEntries(CATS.map((c, i) => [c, floors[i] / 10])) as Record<WasteCategory, number>;
}
function aggregate(values: Record<string, number>) {
  const agg = Object.fromEntries(CATS.map((c) => [c, 0])) as Record<WasteCategory, number>;
  for (const cat of COMP_CATS) agg[cat.to] = round(agg[cat.to] + (values[cat.csvKey] ?? 0), 4);
  const sum = round(Object.values(values).reduce((a, b) => a + b, 0), 4);
  return { unrounded: agg, rounded: largestRemainder(agg), sourceSum: sum };
}

async function buildComposition() {
  const pdfUrl = "https://webportal.bangkok.go.th/public/user_files_editor/231/WasteData/2565/WasteComp%202565.pdf";
  const pdfRel = "bma-environment/composition/WasteComp_2565.pdf";
  const pageRel = "bma-environment/page_sub_20995.html";
  await getRaw("https://webportal.bangkok.go.th/environmentbma/page/sub/20995", pageRel, "html");
  const pdfBuf = await getRaw(pdfUrl, pdfRel, "pdf");
  for (const [, m] of Object.entries(MANUAL_COMPOSITION)) await getRaw(m.url, m.rel, "pdf");
  const pkgComp = await ckanPackage(BMA_CKAN, "https-webportal-bangkok-go-th-environmentbma-page-sub-20995", "bma-opendata/pkg_https-webportal-bangkok-go-th-environmentbma-page-sub-20995.json");
  const csvUrl =
    pkgComp?.resources.find((r) => /\.csv$/i.test(r.url))?.url ??
    "https://data.bangkok.go.th/dataset/a5e63301-7508-40ba-b8d2-9a5c6786fd80/resource/ee48268a-4501-4cba-a5b8-cf0d6d493ef9/download/garbage_element.csv";
  const csvRel = "bma-opendata/composition/garbage_element.csv";
  const csvBuf = await getRaw(csvUrl, csvRel, "csv");

  // FY2565 PDF (text layer)
  let fy2565: Record<string, number> | null = null;
  const parseNotes: string[] = [];
  if (pdfBuf) {
    const { text, via } = pdfToText(path.join(RAW, pdfRel));
    parseNotes.push(`FY2565 PDF text via ${via}`);
    if (text) {
      const vals: Record<string, number> = {};
      for (const line of text.split("\n")) {
        const m = /^(.+?)\s+(\d+\.\d{2})\s*$/.exec(line.trim());
        if (!m) continue;
        const lab = skel(m[1]);
        const cat = COMP_CATS.find((c) => [c.th, ...c.alt].some((x) => skel(x) === lab));
        if (cat) vals[cat.csvKey] = Number(m[2]);
      }
      const sum = round(Object.values(vals).reduce((a, b) => a + b, 0), 2);
      if (Object.keys(vals).length === COMP_CATS.length && Math.abs(sum - 100) < 0.011) fy2565 = vals;
      else parseNotes.push(`FY2565 parse incomplete: ${Object.keys(vals).length} categories, sum ${sum}`);
    }
  }
  // Open-data CSV (labelled 2565, values differ from the PDF)
  let csvVals: Record<string, number> | null = null;
  let csvYear: number | null = null;
  if (csvBuf) {
    const rows = csvObjects(decodeText(csvBuf).text).filter((r) => num(r.ye_ar) !== null);
    if (rows[0]) {
      csvYear = num(rows[0].ye_ar);
      csvVals = {};
      for (const c of COMP_CATS) {
        const v = num(rows[0][c.csvKey]);
        if (v !== null) csvVals[c.csvKey] = v;
      }
    }
  }
  for (const [fy, m] of Object.entries(MANUAL_COMPOSITION)) {
    const s = round(Object.values(m.values).reduce((a, b) => a + b, 0), 2);
    if (Math.abs(s - 100) > 0.011) throw new Error(`Manual transcription FY${fy} sums to ${s}`);
  }

  const mapping = COMP_CATS.map((c) => ({ sourceCategoryTh: c.th, sourceCategoryEn: c.en, mappedTo: c.to }));
  const mappingRationale = [
    "organic = food waste + wood/branches/leaves (biodegradable organics).",
    "plastic = recyclable + non-recyclable plastic + foam (expanded polystyrene is a plastic).",
    "paper = recyclable + non-recyclable paper.",
    "glassMetal = glass + metal.",
    "hazardous = 0.0: the BMA physical-composition table has NO hazardous category (household hazardous waste is collected and reported separately). 0.0 means 'not reported as a separate category', not a measured zero.",
    "other = leather & rubber + textiles + stone & ceramics + bones & shells + disposable diapers (bones/shells treated as inert, not readily biodegradable).",
  ];
  const mk = (fyBE: number, values: Record<string, number>, sourceId: string, scope: string, method: string) => {
    const a = aggregate(values);
    const { from, to } = fiscalRange(fyBE);
    return {
      fiscalYearBE: fyBE,
      referenceYear: beToCe(fyBE),
      observedFrom: from,
      observedTo: to,
      sourceId,
      sampleScope: scope,
      method,
      sourceCategories: COMP_CATS.map((c) => ({ th: c.th, en: c.en, percent: values[c.csvKey] ?? null, mappedTo: c.to })),
      sourceSum: a.sourceSum,
      sharesUnrounded: a.unrounded,
      shares: a.rounded,
      sharesSum: round(CATS.reduce((s, c) => s + a.rounded[c], 0), 1),
    };
  };
  const history = [
    ...Object.entries(MANUAL_COMPOSITION).map(([fy, m]) =>
      mk(Number(fy), m.values, `bma-env-composition-fy${fy}`, m.scope, "Manual transcription of the 'average' column of a scanned PDF table (no text layer); verified to sum to 100.00."),
    ),
    ...(fy2565
      ? [
          mk(
            2565,
            fy2565,
            "bma-env-composition-fy2565",
            "Bangkok municipal solid waste (city level; not national). Sampling locations/number of samples not stated on the FY2565 table; previous years' tables report sampling at BMA's three disposal centres (On Nut, Nong Khaem, Sai Mai).",
            "Parsed from the PDF text layer; 14 categories, sum 100.00.",
          ),
        ]
      : []),
  ];
  const primary = history.find((h) => h.fiscalYearBE === 2565) ?? history[history.length - 1];
  const out = {
    cityId: "bangkok",
    dataRetrievedAt: latestRetrieval([pdfRel]),
    categories: CATS,
    composition: {
      shares: primary.shares,
      provenance: {
        status: "derived",
        sourceId: primary.sourceId,
        sourceName: "องค์ประกอบมูลฝอยของกรุงเทพมหานคร (BMA Environment Department, Research & Development Group, Solid Waste and Sewage Management Office)",
        sourceUrl: pdfUrl,
        observedFrom: primary.observedFrom,
        observedTo: primary.observedTo,
        referenceYear: primary.referenceYear,
        geographicScope: "Bangkok (BMA) municipal solid waste — city level, not national",
        methodology:
          "Published physical composition (% by weight, 14 categories) aggregated into 6 app categories (mapping below) and rounded to 0.1 with the largest-remainder method so shares sum to exactly 100.0.",
        limitations: [
          "Composition of collected waste arriving at BMA disposal facilities; not district-specific.",
          "Hazardous waste is not a category in the source table; hazardous share shown as 0.0 = not reported.",
          "The BMA open-data CSV labelled 2565 (garbage_element.csv) has different values from the FY2565 PDF; the PDF was preferred (explicit fiscal-year title and author unit). Both are recorded.",
        ],
      },
    },
    primary,
    history,
    mapping,
    mappingRationale,
    roundingMethod: "Largest remainder on 0.1-percent units: floor each share×10, then add 0.1 to the shares with the largest remainders (ties by category order) until the total is 100.0.",
    alternateOpenDataCsv: csvVals
      ? {
          ...mk(csvYear ?? 2565, csvVals, "bma-opendata-garbage-element", "Unstated (BMA open-data CSV, no sampling description).", "Parsed from CSV."),
          conflict: fy2565
            ? COMP_CATS.filter((c) => Math.abs((fy2565?.[c.csvKey] ?? 0) - (csvVals?.[c.csvKey] ?? 0)) > 0.005).map((c) => ({
                category: c.th,
                pdf: fy2565?.[c.csvKey] ?? null,
                csv: csvVals?.[c.csvKey] ?? null,
              }))
            : [],
        }
      : null,
    parseNotes,
  };
  writeJson(path.join(STAGED, "bangkok-composition.json"), out);
  log("composition:", JSON.stringify(primary.shares), "sum", primary.sharesSum);

  addSource({
    id: "bma-env-composition-fy2565",
    nameTh: "องค์ประกอบมูลฝอยของกรุงเทพมหานคร ปีงบประมาณ พ.ศ. 2565",
    nameEn: "Bangkok solid waste physical composition, fiscal year 2022 (BMA Environment Department)",
    url: pdfUrl,
    publisher: "กลุ่มงานวิจัยและพัฒนา สำนักงานจัดการมูลฝอยและสิ่งปฏิกูล สำนักสิ่งแวดล้อม กรุงเทพมหานคร",
    license: "not stated",
    retrievedAt: retrievedAt(pdfRel),
    accessStatus: fy2565 ? "retrieved" : statusFor([pdfRel]) === "retrieved" ? "partial" : "failed",
    notes: `Linked from https://webportal.bangkok.go.th/environmentbma/page/sub/20995. The same file under .../WasteData/2569/ returned HTTP 200 with an empty body. ${fetchNote([pdfRel])}`,
  });
  for (const [fy, m] of Object.entries(MANUAL_COMPOSITION))
    addSource({
      id: `bma-env-composition-fy${fy}`,
      nameTh: `ตารางองค์ประกอบมูลฝอยทางกายภาพ ปีงบประมาณ ${fy}`,
      nameEn: `Bangkok solid waste physical composition, fiscal year ${beToCe(Number(fy))} (scanned PDF)`,
      url: m.url,
      publisher: "กลุ่มงานวิจัยและพัฒนา สำนักงานจัดการมูลฝอยและสิ่งปฏิกูล สำนักสิ่งแวดล้อม กรุงเทพมหานคร",
      license: "not stated",
      retrievedAt: retrievedAt(m.rel),
      accessStatus: statusFor([m.rel]),
      notes: `Scanned image PDF; values transcribed manually (embedded in fetch-bangkok.ts) and checked to sum to 100.00. ${fetchNote([m.rel])}`,
    });
  addSource({
    id: "bma-opendata-garbage-element",
    nameTh: pkgComp?.title ?? "องค์ประกอบทางกายภาพของมูลฝอยในกรุงเทพมหานคร",
    nameEn: "Bangkok waste physical composition table (BMA open data CSV, labelled 2565)",
    url: "https://data.bangkok.go.th/dataset/https-webportal-bangkok-go-th-environmentbma-page-sub-20995",
    publisher: "สำนักสิ่งแวดล้อม กรุงเทพมหานคร (BMA Environment Department)",
    license: pkgComp?.license_title ?? "not stated",
    retrievedAt: retrievedAt(csvRel),
    accessStatus: statusFor([csvRel]),
    notes: `CSV ${csvUrl}. Values differ from the FY2565 PDF (both sum to 100). Recorded as an alternate only. ${fetchNote([csvRel])}`,
  });
  return out;
}

// ===========================================================================
// 5. Flood-risk points
// ===========================================================================
interface FloodPoint {
  id: string;
  code: string | null;
  districtNameSource: string;
  nameTh: string;
  lon: number | null;
  lat: number | null;
  attributes: Record<string, string | number | null>;
  pipCode?: string | null;
}
interface FloodSeries {
  id: string;
  nameTh: string;
  nameEn: string;
  kind: string;
  referenceYear: number | null;
  referenceYearNote: string;
  sourceId: string;
  sourceUrl: string;
  coordinatesPublished: boolean;
  definition: string;
  total: number;
  countsByDistrict: Record<string, number>;
  nonDistrictRows: Record<string, unknown>[];
  unmatchedRows: Record<string, unknown>[];
  qa?: Record<string, unknown>;
  points?: FloodPoint[];
  extra?: Record<string, unknown>;
}
function emptyCounts(): Record<string, number> {
  return Object.fromEntries(REGISTRY.map((d) => [d.code, 0]));
}

async function buildFlood(fullFc: FeatureCollection<Polygon | MultiPolygon>) {
  const ids = {
    risk68: "25bc3f04-5707-4b60-a885-5ad45aa38cd6",
    register: "3fcbe9f7-d2b0-4442-b110-4a5620ebdce3",
    igd22: "0f44471a-9ad6-40bb-868d-784c687a8037",
    igd21: "5ed16717-0ab8-4bd9-925b-4049eadb2107",
    rw2566: "a1cc1d7a-6d87-4dd2-a662-79ed58c2623c",
    weak: "36256cdf-5576-4b17-9c4a-ddde6c7ff343",
  };
  const pk = {
    risk68: await ckanPackage(BMA_CKAN, "flood_risk26", "bma-opendata/pkg_flood_risk26.json"),
    register: await ckanPackage(BMA_CKAN, "flood_risk", "bma-opendata/pkg_flood_risk.json"),
    igd22: await ckanPackage(BMA_CKAN, "igd-22", "bma-opendata/pkg_igd-22.json"),
    igd21: await ckanPackage(BMA_CKAN, "igd-21", "bma-opendata/pkg_igd-21.json"),
    rw2566: await ckanPackage(BMA_CKAN, "risk-flood-bangkok-area", "bma-opendata/pkg_risk-flood-bangkok-area.json"),
    weak: await ckanPackage(BMA_CKAN, "floodpoint", "bma-opendata/pkg_floodpoint.json"),
  };
  const res = (k: keyof typeof pk, re: RegExp, fallback: string) => pk[k]?.resources.find((r) => re.test(r.url))?.url ?? fallback;
  const files = {
    risk68: { url: res("risk68", /\.csv$/i, `${BMA_CKAN}/dataset/${ids.risk68}/resource/837b7fb6-ce1f-4356-881e-6bf14eeb075f/download/flood_risk26.csv`), rel: "bma-opendata/flood/flood_risk26.csv" },
    register: { url: res("register", /\.csv$/i, `${BMA_CKAN}/dataset/${ids.register}/resource/8f1102d5-52a2-4494-9131-403e4f87a242/download/flood_risk.csv`), rel: "bma-opendata/flood/flood_risk.csv" },
    igd22: { url: res("igd22", /\.csv$/i, `${BMA_CKAN}/dataset/${ids.igd22}/resource/1df60609-eea9-4e0a-b67c-39d97a2354e0/download/7.-.csv`), rel: "bma-opendata/flood/igd-22_watch_points.csv" },
    igd21: { url: res("igd21", /\.csv$/i, `${BMA_CKAN}/dataset/${ids.igd21}/resource/fa27e318-aea0-4c0b-a79a-f94b306b943e/download/6.-.csv`), rel: "bma-opendata/flood/igd-21_risk_points.csv" },
    rw2566: { url: res("rw2566", /\.csv$/i, `${BMA_CKAN}/dataset/${ids.rw2566}/resource/b719945f-f10b-4b4c-afd2-2e8b43d21726/download/-2566.csv`), rel: "bma-opendata/flood/risk-flood-bangkok-area-2566.csv" },
    weak: { url: res("weak", /\.zip$/i, `${BMA_CKAN}/dataset/${ids.weak}/resource/b8f2058d-e562-421e-a4cf-1dd706c3ba8a/download/flood_point.zip`), rel: "bma-opendata/flood/flood_point.zip" },
  };
  const bufs: Record<string, Buffer | null> = {};
  for (const [k, f] of Object.entries(files)) bufs[k] = await getRaw(f.url, f.rel, k === "weak" ? "zip" : "csv");

  // Point-in-polygon against the full-resolution official boundaries.
  const polys = fullFc.features.map((f) => ({ code: String((f.properties as { dcode: string }).dcode).trim(), f, bbox: turf.bbox(f) }));
  const pip = (lon: number, lat: number): string | null => {
    const pt = turf.point([lon, lat]);
    for (const p of polys) {
      const [w, s, e, n] = p.bbox;
      if (lon < w || lon > e || lat < s || lat > n) continue;
      if (turf.booleanPointInPolygon(pt, p.f)) return p.code;
    }
    return null;
  };
  const qaPoints = (pts: FloodPoint[]) => {
    let agree = 0;
    let outside = 0;
    const disagree: { id: string; stated: string | null; contains: string; distanceToStatedDistrictM: number | null }[] = [];
    for (const p of pts) {
      if (p.lon === null || p.lat === null) continue;
      p.pipCode = pip(p.lon, p.lat);
      if (p.pipCode === null) outside++;
      else if (p.pipCode === p.code) agree++;
      else {
        const stated = polys.find((x) => x.code === p.code);
        const dist = stated ? Math.abs(turf.pointToPolygonDistance(turf.point([p.lon, p.lat]), stated.f, { units: "meters" })) : null;
        disagree.push({ id: p.id, stated: p.code, contains: p.pipCode, distanceToStatedDistrictM: dist === null ? null : Math.round(dist) });
      }
    }
    const dists = disagree.map((d) => d.distanceToStatedDistrictM).filter((d): d is number => d !== null);
    return {
      pointsWithCoordinates: pts.filter((p) => p.lon !== null).length,
      insideStatedDistrict: agree,
      outsideBangkokBoundary: outside,
      inOtherDistrict: disagree.length,
      inOtherDistrictWithin200mOfStated: dists.filter((d) => d <= 200).length,
      inOtherDistrictMaxDistanceM: dists.length ? Math.max(...dists) : null,
      inOtherDistrictList: disagree,
    };
  };

  const series: FloodSeries[] = [];
  const lonlat = (x: string | undefined, y: string | undefined) => {
    const lon = num(x);
    const lat = num(y);
    return lon !== null && lat !== null && lon > 100 && lon < 101.2 && lat > 13 && lat < 14.3 ? { lon, lat } : { lon: null, lat: null };
  };

  // (a) flood_risk26 — จุดเสี่ยงน้ำท่วม ประจำปี พ.ศ. 2568
  if (bufs.risk68) {
    const rows = csvObjects(decodeText(bufs.risk68).text);
    const counts = emptyCounts();
    const unmatched: Record<string, unknown>[] = [];
    const points: FloodPoint[] = [];
    rows.forEach((r, i) => {
      const d = matchOrLog(r.DISTRICT_NAME, "flood_risk26");
      const { lon, lat } = lonlat(r.UTM_X, r.UTM_Y);
      if (!d) unmatched.push(r);
      else counts[d.code]++;
      points.push({ id: `fr68-${String(i + 1).padStart(3, "0")}`, code: d?.code ?? null, districtNameSource: r.DISTRICT_NAME, nameTh: r.STATION_NAME, lon, lat, attributes: { districtGroup: r.GROUP_D } });
    });
    series.push({
      id: "bma-dds-flood-risk-2568",
      nameTh: "จุดเสี่ยงน้ำท่วม ประจำปี พ.ศ. 2568",
      nameEn: "Flood-risk points, BE 2568 (2025) — BMA Drainage and Sewerage Department",
      kind: "จุดเสี่ยงน้ำท่วม (flood-risk point)",
      referenceYear: 2025,
      referenceYearNote:
        "Dataset title 'ข้อมูลจุดเสี่ยงน้ำท่วม 68' and description 'ประจำปี พ.ศ. 2568' (= 2025). The CKAN resource fields first/last year of data say 2026 — conflicting metadata; the explicit BE year in title/description was used.",
      sourceId: "bma-dds-flood-risk-2568",
      sourceUrl: files.risk68.url,
      coordinatesPublished: true,
      definition: "Flood-risk locations designated by DDS for monitoring/crisis management in the 2025 season. Columns UTM_X/UTM_Y actually contain WGS84 longitude/latitude (decimal degrees).",
      total: rows.length,
      countsByDistrict: counts,
      nonDistrictRows: [],
      unmatchedRows: unmatched,
      qa: qaPoints(points),
      points,
    });
  }

  // (b) flood_risk — register of 737 risk points with remediation status
  if (bufs.register) {
    const rows = csvObjects(decodeText(bufs.register).text);
    const counts = emptyCounts();
    const countsActive = emptyCounts();
    const byProblem: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const unmatched: Record<string, unknown>[] = [];
    const points: FloodPoint[] = [];
    for (const r of rows) {
      const d = matchOrLog(r.district, "flood_risk");
      const { lon, lat } = lonlat(r.x, r.y);
      const st = num(r.status_num);
      byProblem[r.problems] = (byProblem[r.problems] ?? 0) + 1;
      const stKey = `${r.status_num} ${r.status_detail.length > 40 ? "(status text malformed)" : r.status_detail}`;
      byStatus[stKey] = (byStatus[stKey] ?? 0) + 1;
      if (!d) unmatched.push({ objectid: r.objectid, district: r.district });
      else {
        counts[d.code]++;
        if (st !== 5) countsActive[d.code]++;
      }
      points.push({
        id: `frr-${r.objectid}`,
        code: d?.code ?? null,
        districtNameSource: r.district,
        nameTh: r.name,
        lon,
        lat,
        attributes: { problem: r.problems, districtGroup: r.group_d, statusNum: st, status: r.status_detail.length > 40 ? null : r.status_detail },
      });
    }
    series.push({
      id: "bma-dds-flood-risk-register",
      nameTh: "จุดเสี่ยงน้ำท่วม (ทะเบียนจุดเสี่ยงพร้อมสถานะการแก้ไข)",
      nameEn: "Flood-risk point register with remediation status — BMA Drainage and Sewerage Department",
      kind: "จุดเสี่ยงน้ำท่วม (rain- and tide-induced flood-risk points)",
      referenceYear: null,
      referenceYearNote: `No reference year in the data; CSV resource last_modified ${pk.register?.resources[0]?.last_modified ?? "?"} (status as of that update).`,
      sourceId: "bma-dds-flood-risk-register",
      sourceUrl: files.register.url,
      coordinatesPublished: true,
      definition:
        "Flood-risk points from rain (น้ำฝน; 'สนข.' = district office responsible, 'สนน.' = DDS responsible) and river/tidal surge (น้ำหนุน), with project status: 1 urgent measures, 2 private/government-agency land, 3 being fixed, 4 partly fixed, 5 fixed.",
      total: rows.length,
      countsByDistrict: counts,
      nonDistrictRows: [],
      unmatchedRows: unmatched,
      qa: qaPoints(points),
      points,
      extra: { countsByDistrictExcludingFixed: countsActive, byProblem, byStatus },
    });
  }

  // (c,d) IGD counts BE 2566 (risk points / watch points) by district office
  const igd = (key: "igd21" | "igd22", id: string, valueCol: string, th: string, en: string, kind: string) => {
    const buf = bufs[key];
    if (!buf) return;
    const rows = csvObjects(decodeText(buf).text);
    const counts = emptyCounts();
    const nonDistrict: Record<string, unknown>[] = [];
    const unmatched: Record<string, unknown>[] = [];
    let total = 0;
    const years = new Set<string>();
    for (const r of rows) {
      const v = num(r[valueCol]) ?? 0;
      years.add(r.budget_year);
      total += v;
      if (!/เขต/.test(r.dname)) {
        nonDistrict.push({ unit: r.dname, value: v, byDistrictOffice: num(r[valueCol.replace("_number", "_district")]), byDrainage: num(r[valueCol.replace("_number", "_drainage")]) });
        continue;
      }
      const d = matchOrLog(r.dname, key);
      if (!d) unmatched.push({ dname: r.dname, value: v });
      else counts[d.code] += v;
    }
    const yr = [...years].map(Number).filter(Number.isFinite);
    series.push({
      id,
      nameTh: th,
      nameEn: en,
      kind,
      referenceYear: yr.length === 1 ? beToCe(yr[0]) : null,
      referenceYearNote: `budget_year ${[...years].join(",")} (Thai fiscal year), inspection round ${[...new Set(rows.map((r) => r.inspec_period))].join(",")}.`,
      sourceId: id,
      sourceUrl: files[key].url,
      coordinatesPublished: false,
      definition:
        "Counts reported per district office in the BMA Inspector-General integrated inspection report on flood prevention ('การป้องกันและแก้ไขปัญหาน้ำท่วม'); split into points handled by the district office vs DDS.",
      total,
      countsByDistrict: counts,
      nonDistrictRows: nonDistrict,
      unmatchedRows: unmatched,
    });
  };
  igd("igd21", "bma-igd-flood-risk-points-2566", "riskpoint_number", "จำนวนจุดเสี่ยงน้ำท่วมของกรุงเทพมหานคร (ปีงบประมาณ 2566)", "Number of flood-risk points by district office, FY2023 (BMA Inspector-General Division)", "จุดเสี่ยงน้ำท่วม (count)");
  igd("igd22", "bma-igd-flood-watch-points-2566", "lookoutpoint_number", "จำนวนจุดเฝ้าระวังน้ำท่วมของกรุงเทพมหานคร (ปีงบประมาณ 2566)", "Number of flood-watch points by district office, FY2023 (BMA Inspector-General Division)", "จุดเฝ้าระวังน้ำท่วม (count)");

  // (e) DDS risk & watch points 2566 (roads, no coordinates)
  if (bufs.rw2566) {
    const rows = csvObjects(decodeText(bufs.rw2566).text);
    const counts = emptyCounts();
    const byType: Record<string, Record<string, number>> = { "1": emptyCounts(), "2": emptyCounts() };
    const unmatched: Record<string, unknown>[] = [];
    for (const r of rows) {
      const d = matchOrLog(r.District, "risk-flood-bangkok-area");
      if (!d) {
        unmatched.push(r);
        continue;
      }
      counts[d.code]++;
      (byType[r.risk_type] ??= emptyCounts())[d.code]++;
    }
    series.push({
      id: "bma-dds-risk-watch-2566",
      nameTh: "ข้อมูลจุดเสี่ยงและจุดเฝ้าระวังน้ำท่วม ปี 2566",
      nameEn: "Flood-risk and flood-watch road sections, 2566 (2023) — BMA Drainage and Sewerage Department",
      kind: "จุดเสี่ยง / จุดเฝ้าระวังน้ำท่วม (road sections)",
      referenceYear: 2023,
      referenceYearNote: "risk_year column = 2566 (BE).",
      sourceId: "bma-dds-risk-watch-2566",
      sourceUrl: files.rw2566.url,
      coordinatesPublished: false,
      definition:
        "Road sections listed by district. risk_type codes 1/2 are not defined in the metadata (counts: type 1 = 6, type 2 = 43); risk_group 1/2 coincides with the east (Phra Nakhon) vs west (Thonburi) bank of the Chao Phraya. Code meanings NOT verified.",
      total: rows.length,
      countsByDistrict: counts,
      nonDistrictRows: [],
      unmatchedRows: unmatched,
      extra: { countsByRiskTypeCode: byType, rows: rows.map((r) => ({ id: r.risk_id, district: r.District, riskGroup: r.risk_group, riskType: r.risk_type, area: r.area })) },
    });
  }

  // (f) Older จุดอ่อนน้ำท่วม (flood weak points), shapefile EPSG:32647
  if (bufs.weak) {
    const dir = path.join(RAW, "bma-opendata/flood/flood_point_shp");
    unzip(path.join(RAW, files.weak.rel), dir);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bkk-flood-"));
    const outGj = path.join(tmp, "fp.geojson");
    mapshaper(["-i", path.join(dir, "flood_point.shp"), "encoding=cp874", "-proj", "wgs84", "-o", outGj, "format=geojson", "precision=0.000001"]);
    const fc = JSON.parse(fs.readFileSync(outGj, "utf8")) as FeatureCollection<Point, { id_flood: string; location: string; dcode: string; scode: string }>;
    fs.rmSync(tmp, { recursive: true, force: true });
    const counts = emptyCounts();
    const points: FloodPoint[] = fc.features.map((f) => {
      const code = byCode.has(String(f.properties.dcode)) ? String(f.properties.dcode) : null;
      if (code) counts[code]++;
      return {
        id: `fwp-${f.properties.id_flood}`,
        code,
        districtNameSource: String(f.properties.dcode),
        nameTh: f.properties.location,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        attributes: { subdistrictCode: f.properties.scode },
      };
    });
    series.push({
      id: "bma-gis-flood-weak-points",
      nameTh: "จุดอ่อนน้ำท่วมในพื้นที่เขตกรุงเทพมหานคร",
      nameEn: "Flood weak points (จุดอ่อนน้ำท่วม) — BMA GIS",
      kind: "จุดอ่อนน้ำท่วม (flood weak point)",
      referenceYear: null,
      referenceYearNote: "No reference year stated; shapefile exported from BMA GeoServer on 2020-08-11, uploaded 2021-03-09. Treat as historical.",
      sourceId: "bma-gis-flood-weak-points",
      sourceUrl: files.weak.url,
      coordinatesPublished: true,
      definition: "Locations designated as flood weak points; district from the dcode attribute (DOPA code). Coordinates reprojected from EPSG:32647.",
      total: fc.features.length,
      countsByDistrict: counts,
      nonDistrictRows: [],
      unmatchedRows: [],
      qa: qaPoints(points),
      points,
    });
  }

  const meta: Record<string, { pkg: CkanPackage | null; th: string; en: string; key: keyof typeof files }> = {
    "bma-dds-flood-risk-2568": { pkg: pk.risk68, th: "ข้อมูลจุดเสี่ยงน้ำท่วม 68", en: "Flood-risk points 2025 (DDS)", key: "risk68" },
    "bma-dds-flood-risk-register": { pkg: pk.register, th: "จุดเสี่ยงน้ำท่วม", en: "Flood-risk point register (DDS)", key: "register" },
    "bma-igd-flood-risk-points-2566": { pkg: pk.igd21, th: "จำนวนจุดเสี่ยงน้ำท่วมของกรุงเทพมหานคร", en: "Flood-risk point counts FY2023 (Inspector-General)", key: "igd21" },
    "bma-igd-flood-watch-points-2566": { pkg: pk.igd22, th: "จำนวนจุดเฝ้าระวังน้ำท่วมของกรุงเทพมหานคร", en: "Flood-watch point counts FY2023 (Inspector-General)", key: "igd22" },
    "bma-dds-risk-watch-2566": { pkg: pk.rw2566, th: "ข้อมูลจุดเสี่ยงและจุดเฝ้าระวังน้ำท่วม", en: "Flood-risk/watch road sections 2023 (DDS)", key: "rw2566" },
    "bma-gis-flood-weak-points": { pkg: pk.weak, th: "จุดอ่อนน้ำท่วมในพื้นที่เขตกรุงเทพมหานคร", en: "Flood weak points (BMA GIS)", key: "weak" },
  };
  for (const [id, m] of Object.entries(meta)) {
    const f = files[m.key];
    addSource({
      id,
      nameTh: m.pkg?.title ?? m.th,
      nameEn: m.en,
      url: `${BMA_CKAN}/dataset/${m.pkg?.name ?? ids[m.key]}`,
      publisher: `กรุงเทพมหานคร — ${m.pkg?.organization?.title ?? "?"}`,
      license: m.pkg?.license_title ?? "not stated",
      retrievedAt: retrievedAt(f.rel),
      accessStatus: statusFor([f.rel]),
      notes: `Resource ${f.url}. ${fetchNote([f.rel])}`,
    });
  }

  const out = {
    cityId: "bangkok",
    dataRetrievedAt: latestRetrieval(Object.values(files).map((f) => f.rel)),
    primarySeriesId: "bma-dds-flood-risk-2568",
    primaryRationale: "Most recent list with an explicit year (BE 2568 = 2025) and agency-published coordinates.",
    notes: [
      "Counts are per DOPA district code; districts absent from a citywide list have count 0 (observed zero for that list, not missing data).",
      "Points are published by BMA; coordinates were not geocoded or altered (weak points reprojected from UTM 47N only).",
      "QA: each published point was tested against the official district polygons; 'inOtherDistrictList' gives points whose coordinates fall in a different district from the one stated, with the distance to the stated district. Counts use the district stated by the agency; coordinates are not corrected.",
    ],
    fuzzyNameMatches: fuzzyMatches.filter((f) => !["nso-population", "garbage50"].includes(f.dataset)),
    series,
  };
  writeJson(path.join(STAGED, "bangkok-flood-points.json"), out);
  log("flood:", series.map((s) => `${s.id}=${s.total}`).join(", "));
  return out;
}

// ===========================================================================
// main
// ===========================================================================
async function main() {
  log(OFFLINE ? "offline mode (cache only)" : "online mode (fetch, fall back to cache)");
  const { fullFc, validation } = await buildDistricts();
  await buildPopulation();
  await buildWaste();
  await buildComposition();
  await buildFlood(fullFc);

  addSource({
    id: "datagoth-ckan-api",
    nameEn: "data.go.th CKAN API (package metadata for datasets 50, bkkpopulationdistric, 0405_01_0005, garbage1, garbage)",
    url: "https://data.go.th/api/3/action/package_show",
    publisher: "สำนักงานพัฒนารัฐบาลดิจิทัล (DGA) — Government Data Catalog",
    accessStatus: statusFor(["datagoth/package_50.json", "datagoth/package_0405_01_0005.json", "datagoth/package_bkkpopulationdistric.json", "datagoth/package_garbage1.json", "datagoth/package_garbage.json"]),
    retrievedAt: latestRetrieval(["datagoth/package_50.json"]),
    notes: "Metadata only (titles, licenses, resource URLs). Most BMA datasets are harvested from data.bangkok.go.th.",
  });
  addSource({
    id: "dopa-registration-news-crosscheck",
    nameTh: "รายงานข่าว ประกาศสำนักทะเบียนกลาง จำนวนราษฎร ณ 31 ธันวาคม 2568",
    nameEn: "News report of the DOPA population announcement as of 31 Dec 2025 (search snippet only)",
    url: "https://www.prachachat.net/general/news-1984243",
    publisher: "ประชาชาติธุรกิจ (prachachat.net)",
    accessStatus: "manual-reference",
    notes:
      "Page returned HTTP 403 to automated fetch; only search-engine snippets were seen (Bangkok 5,455,020 at end-2567 = NSO table; ~5.42 million at end-2568). Not used as a data source.",
  });
  addSource({
    id: "osm-overpass-district-boundaries",
    nameEn: "OpenStreetMap Bangkok khet boundaries via Overpass API",
    url: "https://overpass-api.de/api/interpreter",
    publisher: "OpenStreetMap contributors (ODbL)",
    license: "ODbL 1.0",
    accessStatus: "manual-reference",
    notes: "Not queried: the official BMA GIS boundaries were retrieved and validated, so the OSM fallback was not needed (no Overpass load generated).",
  });

  const srcList = [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeJson(path.join(STAGED, "bangkok-sources.json"), srcList);
  writeJson(MANIFEST_PATH, Object.fromEntries(Object.entries(manifest).sort((a, b) => a[0].localeCompare(b[0]))));
  writeJson(path.join(STAGED, "bangkok-ingest-report.json"), { validation, fuzzyNameMatches: fuzzyMatches, fetchResults: fetchResults.map(({ url, file, ok, via, httpStatus, error }) => ({ url, file, ok, via, httpStatus, error: error ?? null })) });
  const failed = fetchResults.filter((f) => !f.ok);
  log(`done. ${fetchResults.length} fetches, ${fetchResults.filter((f) => f.via === "network").length} network, ${fetchResults.filter((f) => f.via === "cache").length} cache, ${failed.length} failed`);
  for (const f of failed) log("  failed:", f.url, f.error);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
