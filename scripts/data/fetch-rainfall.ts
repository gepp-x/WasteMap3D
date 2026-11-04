/**
 * fetch-rainfall.ts — rainfall and drainage-capacity context for Bangkok and Hat Yai.
 *
 * Run from the project root:
 *   npx tsx scripts/data/fetch-rainfall.ts                 # all sections
 *   npx tsx scripts/data/fetch-rainfall.ts --offline       # never touch the network, cached raw files only
 *   npx tsx scripts/data/fetch-rainfall.ts --refresh       # re-download "cache-first" resources too
 *   npx tsx scripts/data/fetch-rainfall.ts --sections=stations,normals,drainage,ckan,openmeteo
 *   npx tsx scripts/data/fetch-rainfall.ts --end-date=YYYY-MM-DD   # pin the Open-Meteo period end
 *
 * Fetch policy
 *   - "network-first": live snapshots (ThaiWater rain_24h, BMA weather page, TMD aeromet2 report).
 *     The network is tried first; on failure the last cached raw file is re-used.
 *   - "cache-first": immutable/historical resources (Open-Meteo archive requests with a fixed
 *     period, TMD normals PDF, news pages, CKAN files). Re-used from data/raw unless --refresh.
 *   Every raw file is stored under data/raw/<source>/ with a sibling *.meta.json
 *   (url, HTTP status, retrievedAt). Downloaded files are treated as data only — never executed.
 *
 * Politeness: <= 1 request/s per host, descriptive User-Agent, retries with exponential backoff.
 * Open-Meteo (free tier: 600 calls/min, 5 000/h, 10 000/day, weighted by #locations x weeks)
 * is paced with an in-process weighted budget and 429-aware waits.
 *
 * Outputs (deterministic given the cached raw files):
 *   public/data/{bangkok,hatyai}/stations.json   RainStation[] (observed snapshots)
 *   public/data/{bangkok,hatyai}/rain-grid.json  RainSeries   (ERA5 reanalysis grid via Open-Meteo models=era5, status "estimated")
 *   data/staged/rain-hourly-events.json
 *   data/staged/rain-normals.json
 *   data/staged/drainage-capacity.json
 *   data/staged/rain-sources.json                SourceRef[]
 *   data/staged/rain-notes.md
 *   data/staged/rain-grid-meta.json, tmd-airport-daily-rain.json,
 *   data/staged/bma-district-rainfall-2023.json, rain-build-summary.json (supporting files)
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- report/notes rendering walks heterogeneous Open-Meteo,
   ThaiWater and TMD payloads; outputs are checked against the zod contract by scripts/data/validate-data.ts. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  CityId,
  DataProvenance,
  MetricValue,
  RainSeries,
  RainStation,
  SourceRef,
} from "../../src/lib/types";

// ---------------------------------------------------------------------------------------------
// Paths, CLI
// ---------------------------------------------------------------------------------------------
function findRoot(): string {
  const candidates = [
    path.resolve(path.dirname(process.argv[1] ?? "."), "../.."),
    process.cwd(),
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, "src/lib/types.ts"))) return c;
  throw new Error("Cannot locate project root (src/lib/types.ts). Run from the project root.");
}
const ROOT = findRoot();
const RAW = path.join(ROOT, "data/raw");
const STAGED = path.join(ROOT, "data/staged");
const PUB = path.join(ROOT, "public/data");
const SCRIPT_REL = "scripts/data/fetch-rainfall.ts";

const ARGV = process.argv.slice(2);
const hasFlag = (n: string) => ARGV.includes(`--${n}`);
const optVal = (n: string) => ARGV.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const OFFLINE = hasFlag("offline");
const REFRESH = hasFlag("refresh");
const ALL_SECTIONS = ["stations", "openmeteo", "normals", "drainage", "ckan"] as const;
type Section = (typeof ALL_SECTIONS)[number];
const SECTIONS = new Set<string>((optVal("sections") ?? ALL_SECTIONS.join(",")).split(","));
const END_DATE_OVERRIDE = optVal("end-date");

const UA = "UrbanIntelligenceDemo/0.1 (research prototype)";

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (v: number) => Math.round(v * 10) / 10;
const rN = (v: number, n: number) => Number(v.toFixed(n));

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}
function writeJson(file: string, data: unknown) {
  ensureDir(path.dirname(file));
  // Pretty-print, but keep arrays of numbers/null on one line (time series, monthly values, bboxes).
  const atom = String.raw`(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|null|"\d{4}-\d{2}-\d{2}(?:T[\d:]+(?:[+-]\d{2}:\d{2}|Z)?)?")`;
  const re = new RegExp(String.raw`\[\s+(${atom}(?:,\s+${atom})*)\s+\]`, "gi");
  const s = JSON.stringify(data, null, 2).replace(re, (_, inner: string) => `[${inner.replace(/,\s+/g, ", ")}]`);
  fs.writeFileSync(file, s + "\n", "utf8");
}
function writeText(file: string, text: string) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n", "utf8");
}
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}
function rel(p: string) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}
function stripHtml(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  return s.replace(/\s+/g, " ").trim();
}
function normSpace(s: string) {
  return s.replace(/\s+/g, " ").trim();
}
function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}
function addDays(date: string, n: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}
function daysInclusive(a: string, b: string) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000) + 1;
}
function dateRange(a: string, b: string): string[] {
  const out: string[] = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}
function todayBangkok(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
}

// ---------------------------------------------------------------------------------------------
// HTTP with cache, politeness, retries
// ---------------------------------------------------------------------------------------------
type FetchMode = "network-first" | "cache-first";
interface FetchSpec {
  id: string;
  url: string;
  cacheFile: string; // absolute
  mode: FetchMode;
  minGapMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  omWeight?: number; // Open-Meteo weighted call estimate
  validate?: (body: Buffer, status: number) => string | null; // error message or null
}
interface FetchMeta {
  url: string;
  status: number | null;
  retrievedAt: string;
  bytes: number;
  contentType?: string | null;
  retrievedAtSource?: "http" | "file-mtime";
}
interface FetchResult {
  id: string;
  url: string;
  ok: boolean;
  body: Buffer | null;
  status: number | null;
  fromCache: boolean;
  retrievedAt: string | null;
  bytes: number;
  cacheFile: string;
  error?: string;
  note?: string;
  attemptedAt?: string; // last network attempt (also set when the attempt failed)
}
const FETCH_LOG: Omit<FetchResult, "body">[] = [];
const lastHit = new Map<string, number>();
const omHistory: { t: number; w: number }[] = [];

async function politeWait(host: string, gapMs: number) {
  const last = lastHit.get(host) ?? 0;
  const wait = last + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

const OM_MINUTE_BUDGET = 540; // free tier: 600/min
const OM_HOUR_BUDGET = 4700; // free tier: 5 000/h (headroom for calls made outside this process)
async function omPace(weight: number) {
  for (;;) {
    const now = Date.now();
    while (omHistory.length && omHistory[0].t < now - 3600_000) omHistory.shift();
    const minute = omHistory.filter((h) => h.t >= now - 60_000).reduce((a, h) => a + h.w, 0);
    const hour = omHistory.reduce((a, h) => a + h.w, 0);
    if (minute + weight <= OM_MINUTE_BUDGET && hour + weight <= OM_HOUR_BUDGET) break;
    let waitMs = 5_000;
    if (minute + weight > OM_MINUTE_BUDGET) {
      const firstInMinute = omHistory.find((h) => h.t >= now - 60_000);
      if (firstInMinute) waitMs = Math.max(waitMs, firstInMinute.t + 61_000 - now);
    }
    if (hour + weight > OM_HOUR_BUDGET) {
      let acc = hour;
      for (const h of omHistory) {
        acc -= h.w;
        if (acc + weight <= OM_HOUR_BUDGET) {
          waitMs = Math.max(waitMs, h.t + 3601_000 - now);
          break;
        }
      }
    }
    console.log(`  [open-meteo pacing] weight ${weight.toFixed(0)}; minute=${minute.toFixed(0)} hour=${hour.toFixed(0)}; waiting ${(waitMs / 1000).toFixed(0)} s`);
    await sleep(waitMs);
  }
  omHistory.push({ t: Date.now(), w: weight });
}

function readMeta(cacheFile: string): FetchMeta | null {
  const m = readJson<FetchMeta>(cacheFile + ".meta.json");
  if (m) return m;
  if (fs.existsSync(cacheFile)) {
    const st = fs.statSync(cacheFile);
    return { url: "", status: null, retrievedAt: st.mtime.toISOString(), bytes: st.size, retrievedAtSource: "file-mtime" };
  }
  return null;
}

function fromCacheResult(spec: FetchSpec, error?: string): FetchResult | null {
  if (!fs.existsSync(spec.cacheFile)) return null;
  const body = fs.readFileSync(spec.cacheFile);
  const meta = readMeta(spec.cacheFile);
  const err = spec.validate?.(body, meta?.status ?? 200);
  if (err) return null;
  return {
    id: spec.id,
    url: spec.url,
    ok: true,
    body,
    status: meta?.status ?? null,
    fromCache: true,
    retrievedAt: meta?.retrievedAt ?? null,
    bytes: body.length,
    cacheFile: rel(spec.cacheFile),
    error,
    note: meta?.retrievedAtSource === "file-mtime" ? "cached file has no meta; retrievedAt = file mtime" : undefined,
  };
}

function logFetch(r: FetchResult) {
  const { body: _b, ...rest } = r;
  void _b;
  FETCH_LOG.push(rest);
  const tag = r.ok ? (r.fromCache ? "cache" : "net") : "FAIL";
  console.log(`  [${tag}] ${r.id} ${r.status ?? ""} ${r.bytes}B ${r.error ? "(" + r.error + ")" : ""}`);
}

async function fetchRaw(spec: FetchSpec): Promise<FetchResult> {
  const host = new URL(spec.url).host;
  const isOM = host.endsWith("open-meteo.com");
  if (spec.mode === "cache-first" && !REFRESH) {
    const c = fromCacheResult(spec);
    if (c) {
      logFetch(c);
      return c;
    }
  }
  if (OFFLINE) {
    const c = fromCacheResult(spec, "offline mode");
    const r: FetchResult = c ?? {
      id: spec.id, url: spec.url, ok: false, body: null, status: null, fromCache: false,
      retrievedAt: null, bytes: 0, cacheFile: rel(spec.cacheFile), error: "offline mode and no cached file",
    };
    logFetch(r);
    return r;
  }
  const maxAttempts = spec.maxAttempts ?? 4;
  let lastErr = "";
  let lastStatus: number | null = null;
  let rateLimitRetries = 0;
  let attemptedAt: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await politeWait(host, spec.minGapMs ?? (isOM ? 2000 : 1100));
    if (isOM && spec.omWeight) await omPace(spec.omWeight);
    attemptedAt = new Date().toISOString();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), spec.timeoutMs ?? 120_000);
    try {
      const res = await fetch(spec.url, {
        headers: { "User-Agent": UA, Accept: "*/*" },
        redirect: "follow",
        signal: ac.signal,
      });
      const body = Buffer.from(await res.arrayBuffer());
      clearTimeout(timer);
      lastStatus = res.status;
      if (res.status === 429 && isOM && rateLimitRetries < 6) {
        rateLimitRetries++;
        attempt--; // rate-limit waits do not consume ordinary attempts
        const reason = (() => {
          try {
            return String(JSON.parse(body.toString("utf8")).reason ?? "");
          } catch {
            return body.toString("utf8").slice(0, 200);
          }
        })();
        lastErr = `HTTP 429: ${reason}`;
        if (/daily/i.test(reason)) break;
        let waitMs = 65_000;
        if (/hour/i.test(reason)) {
          const now = new Date();
          waitMs = (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1000 + 90_000;
        }
        console.log(`  [open-meteo 429] ${reason} — waiting ${(waitMs / 1000).toFixed(0)} s`);
        await sleep(waitMs);
        continue;
      }
      if (res.status >= 500 || res.status === 429) {
        lastErr = `HTTP ${res.status}`;
        await sleep(2000 * 2 ** (attempt - 1));
        continue;
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${body.toString("utf8").slice(0, 160).replace(/\s+/g, " ")}`;
        break; // 4xx other than 429: do not retry
      }
      const verr = spec.validate?.(body, res.status);
      if (verr) {
        lastErr = `invalid payload: ${verr}`;
        await sleep(2000 * 2 ** (attempt - 1));
        continue;
      }
      ensureDir(path.dirname(spec.cacheFile));
      fs.writeFileSync(spec.cacheFile, body);
      const meta: FetchMeta = {
        url: spec.url,
        status: res.status,
        retrievedAt: new Date().toISOString(),
        bytes: body.length,
        contentType: res.headers.get("content-type"),
        retrievedAtSource: "http",
      };
      writeJson(spec.cacheFile + ".meta.json", meta);
      const r: FetchResult = {
        id: spec.id, url: spec.url, ok: true, body, status: res.status, fromCache: false,
        retrievedAt: meta.retrievedAt, bytes: body.length, cacheFile: rel(spec.cacheFile),
      };
      logFetch(r);
      return r;
    } catch (e) {
      clearTimeout(timer);
      lastErr = (e as Error).name === "AbortError" ? "timeout" : String((e as Error).message ?? e);
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  const cached = fromCacheResult(spec, `network failed (${lastErr}); re-used cached raw file`);
  const r: FetchResult = cached ?? {
    id: spec.id, url: spec.url, ok: false, body: null, status: lastStatus, fromCache: false,
    retrievedAt: null, bytes: 0, cacheFile: rel(spec.cacheFile), error: lastErr,
  };
  r.attemptedAt = attemptedAt;
  if (!cached) writeJson(spec.cacheFile + ".failed.json", { url: spec.url, status: lastStatus, error: lastErr, attemptedAt });
  logFetch(r);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------------------------
type BBox = [number, number, number, number];
const CITIES: Record<CityId, { nameEn: string; nameTh: string; bbox: BBox }> = {
  bangkok: { nameEn: "Bangkok", nameTh: "กรุงเทพมหานคร", bbox: [100.32, 13.49, 100.94, 13.96] },
  hatyai: { nameEn: "Hat Yai Municipality", nameTh: "เทศบาลนครหาดใหญ่", bbox: [100.43, 6.97, 100.51, 7.06] },
};
const STATION_BUFFER_DEG = 0.15;
const buffered = (b: BBox, d: number): BBox => [rN(b[0] - d, 4), rN(b[1] - d, 4), rN(b[2] + d, 4), rN(b[3] + d, 4)];
const inBox = (lon: number, lat: number, b: BBox) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

const URLS = {
  thaiwater: "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/rain_24h",
  thaiwaterBundle: "https://www.thaiwater.net/dist/js/app.chunk.js",
  bmaWeather: "https://weather.bangkok.go.th/",
  aeromet2Report: "https://aeromet2.tmd.go.th/api/daily-obs/rainfall-report",
  aeromet2Page: "https://aeromet2.tmd.go.th/reports/daily-rainfall",
  aeromet2Legend: "https://aeromet2.tmd.go.th/assets/rainfallExport-O01ssJWd.js",
  tmdOpenData: "https://data.tmd.go.th/api/WeatherToday/V2/?type=json",
  openMeteo: "https://archive-api.open-meteo.com/v1/archive",
  openMeteoDocs: "https://open-meteo.com/en/docs/historical-weather-api",
  openMeteoLicence: "https://open-meteo.com/en/licence",
  tmdNormalsPdf: "https://ubonmet.tmd.go.th/files/MetInfo/climate_normal.pdf",
  tmdCriteria: "https://www.tmd.go.th/info/%E0%B9%80%E0%B8%81%E0%B8%93%E0%B8%91%E0%B8%AD%E0%B8%B2%E0%B8%81%E0%B8%B2%E0%B8%A8",
  bmaCkanPkg: "https://data.bangkok.go.th/api/3/action/package_show?id=rainfall",
};

// Accumulated per-section summaries (persisted so partial runs can still regenerate notes).
interface BuildSummary {
  [k: string]: unknown;
}
const SUMMARY_FILE = path.join(STAGED, "rain-build-summary.json");
const summary: BuildSummary = readJson<BuildSummary>(SUMMARY_FILE) ?? {};

// ---------------------------------------------------------------------------------------------
// Section 1: station snapshots
// ---------------------------------------------------------------------------------------------
interface TwRecord {
  id: number;
  rain_24h: number | null;
  rain_1h?: number | null;
  rainfall_datetime: string;
  station_type: string;
  agency: { agency_name: { th?: string; en?: string }; agency_shortname: { th?: string; en?: string } };
  geocode: {
    amphoe_name?: { th?: string; en?: string };
    tumbon_name?: { th?: string; en?: string };
    province_name?: { th?: string; en?: string };
  };
  station: {
    id: number;
    tele_station_name?: { th?: string; en?: string };
    tele_station_lat: number | null;
    tele_station_long: number | null;
    tele_station_oldcode?: string | null;
  };
}

const AGENCY_LABEL: Record<string, string> = {
  BMA: "Bangkok Metropolitan Administration – Drainage and Sewerage Department (BMA; สำนักการระบายน้ำ กรุงเทพมหานคร)",
};
function agencyLabel(r: TwRecord) {
  const short = (r.agency.agency_shortname.en ?? "").trim();
  if (AGENCY_LABEL[short]) return AGENCY_LABEL[short];
  const en = (r.agency.agency_name.en ?? "").trim();
  const th = (r.agency.agency_name.th ?? "").trim();
  return `${en} (${short}${th ? "; " + th : ""})`;
}
function twTimeToIso(s: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+07:00` : null;
}
function beTimeToIso(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[3]) - 543; // Buddhist Era -> Gregorian
  return `${y}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+07:00`;
}
function slug(s: string) {
  return s.replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
}

interface BmaRow {
  lat: number;
  lon: number;
  nameTh: string;
  time: string;
  internalId: string;
  districtTh: string;
  rain24: number | null;
  code: string;
  districtEn: string;
  nameEn: string;
}
function parseBmaWeather(html: string): BmaRow[] {
  // The public page embeds `locationsrain = [ [...], ... ];` arrays (one per time-window radio).
  // Column meaning taken from the page's own popup builder: [5]=latest data time ("เวลาข้อมูลล่าสุด"),
  // [12]=“ฝนสะสม 24 ชั่วโมง” (24 h accumulated rain), [16]=station code, [18]=English name.
  const blocks = [...html.matchAll(/locationsrain\s*=\s*\[([\s\S]*?)\n\s*\];/g)].map((m) => m[1]);
  const byCode = new Map<string, BmaRow>();
  for (const b of blocks) {
    for (const line of b.split("\n")) {
      const m = /^\s*\[(.*)\],?\s*$/.exec(line);
      if (!m) continue;
      const cols = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'|(-?\d+(?:\.\d+)?)/g)].map((x) => (x[1] !== undefined ? x[1] : x[2]));
      if (cols.length < 20) continue;
      const code = cols[16];
      if (byCode.has(code)) continue;
      const v = Number(cols[12]);
      byCode.set(code, {
        lat: Number(cols[0]),
        lon: Number(cols[1]),
        nameTh: cols[2].trim(),
        time: cols[5],
        internalId: cols[7],
        districtTh: cols[8].trim(),
        rain24: cols[12] !== "" && Number.isFinite(v) ? v : null,
        code,
        districtEn: cols[17].trim(),
        nameEn: cols[18].trim(),
      });
    }
  }
  return [...byCode.values()];
}

function stationProvenance(p: {
  value: number | null;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  observedAt: string | null;
  scope: string;
  methodology: string;
  limitations: string[];
}): DataProvenance {
  const prov: DataProvenance = {
    status: p.value === null ? "unavailable" : "observed",
    sourceId: p.sourceId,
    sourceName: p.sourceName,
    sourceUrl: p.sourceUrl,
  };
  if (p.observedAt) {
    prov.observedTo = p.observedAt.slice(0, 10);
    prov.referenceYear = Number(p.observedAt.slice(0, 4));
  }
  prov.geographicScope = p.scope;
  prov.methodology = p.methodology;
  prov.limitations = p.limitations;
  return prov;
}

async function sectionStations() {
  console.log("\n== Section 1: station rainfall snapshots");
  const tw = await fetchRaw({
    id: "thaiwater-public-rain24h",
    url: URLS.thaiwater,
    cacheFile: path.join(RAW, "thaiwater/public_rain_24h.json"),
    mode: "network-first",
    timeoutMs: 180_000,
    validate: (b) => {
      try {
        const j = JSON.parse(b.toString("utf8"));
        return j.result === "OK" && Array.isArray(j.data) ? null : "unexpected JSON shape";
      } catch {
        return "not JSON";
      }
    },
  });
  const bma = await fetchRaw({
    id: "bma-dds-weather-page",
    url: URLS.bmaWeather,
    cacheFile: path.join(RAW, "bma-weather/weather_bangkok_index.html"),
    mode: "network-first",
    validate: (b) => (b.toString("utf8").includes("locationsrain") ? null : "no embedded rain arrays"),
  });
  const aero = await fetchRaw({
    id: "tmd-aeromet2-rainfall-report",
    url: URLS.aeromet2Report,
    cacheFile: path.join(RAW, "tmd/aeromet2_rainfall_report.json"),
    mode: "network-first",
    validate: (b) => {
      try {
        const j = JSON.parse(b.toString("utf8"));
        return Array.isArray(j.stations) ? null : "unexpected JSON shape";
      } catch {
        return "not JSON";
      }
    },
  });
  // TMD open-data API: probe once WITHOUT credentials to document that a key (uid/ukey) is required.
  const tmdOpen = await fetchRaw({
    id: "tmd-opendata-probe-no-key",
    url: URLS.tmdOpenData,
    cacheFile: path.join(RAW, "tmd/tmd_opendata_probe_nokey.txt"),
    mode: "network-first",
    maxAttempts: 1,
    validate: (b) => (b.length > 0 ? null : "empty body without uid/ukey"),
  });

  const twRecords: TwRecord[] = tw.ok && tw.body ? (JSON.parse(tw.body.toString("utf8")).data as TwRecord[]) : [];
  const twRetrievedAt = tw.retrievedAt;
  const bmaRows = bma.ok && bma.body ? parseBmaWeather(bma.body.toString("utf8")) : [];
  const bmaRetrievedAt = bma.retrievedAt;
  const useBmaDirect = bmaRows.length > 0;

  const twMethod = (raw: string, agency: string, retrievedAt: string | null) =>
    `Near-real-time telemetry snapshot (not a climatological daily total). ThaiWater labels this product “ฝน 24 ชั่วโมง” and defines it as “ปริมาณฝนสะสมตั้งแต่เวลาปัจจุบันย้อนหลังไป 24 ชั่วโมง” (rainfall accumulated over the 24 hours up to the reading time). ` +
    `Reading time exactly as published: rainfall_datetime="${raw}" (Thai local time, UTC+7 — inferred: ThaiWater publishes local timestamps). Originating agency: ${agency}; distributed by the Hydro-Informatics Institute (HII) ThaiWater public API. Snapshot retrieved ${retrievedAt ?? "unknown"}.`;
  const bmaMethod = (raw: string, retrievedAt: string | null) =>
    `Near-real-time telemetry snapshot (not a climatological daily total). Value is the column the BMA page labels “ฝนสะสม 24 ชั่วโมง” (24-hour accumulated rainfall) in the station arrays embedded in the public page ${URLS.bmaWeather}; ` +
    `latest data time exactly as published: "${raw}" (dd/mm/BE yyyy HH:mm, Thai local time; Gregorian year = BE − 543). Snapshot retrieved ${retrievedAt ?? "unknown"}.`;
  const commonLimits = [
    "Snapshot only: the value changes every few minutes as new telemetry arrives.",
    "Unvalidated real-time telemetry; gauge faults, outages or zero-filled values are possible.",
    "Rolling 24 h window; differs from the TMD climatological day (07:00–07:00 local).",
    "Station coordinates are as published by the operating agency (no geocoding by this project).",
  ];

  const out: Record<CityId, RainStation[]> = { bangkok: [], hatyai: [] };
  const stats: Record<string, unknown> = {};
  for (const cityId of ["bangkok", "hatyai"] as CityId[]) {
    const core = CITIES[cityId].bbox;
    const buf = buffered(core, STATION_BUFFER_DEG);
    const excluded = { stale: 0, noCoords: 0, noValue: 0, bmaViaThaiwaterReplaced: 0 };
    const stations: RainStation[] = [];
    // (a) ThaiWater records
    for (const r of twRecords) {
      const lat = r.station.tele_station_lat;
      const lon = r.station.tele_station_long;
      if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        excluded.noCoords++;
        continue;
      }
      if (!inBox(lon, lat, buf)) continue;
      const short = (r.agency.agency_shortname.en ?? "").trim();
      if (short === "BMA" && cityId === "bangkok" && useBmaDirect) {
        excluded.bmaViaThaiwaterReplaced++;
        continue;
      }
      const iso = twTimeToIso(r.rainfall_datetime);
      if (iso && twRetrievedAt) {
        const age = Date.parse(twRetrievedAt) - Date.parse(iso);
        if (age > 48 * 3600_000 || age < -3600_000) {
          excluded.stale++;
          continue; // same 2-day freshness rule the ThaiWater front-end applies
        }
      }
      const value = typeof r.rain_24h === "number" && Number.isFinite(r.rain_24h) ? r.rain_24h : null;
      if (value === null) excluded.noValue++;
      const code = (r.station.tele_station_oldcode ?? String(r.station.id)).trim();
      const nameTh = (r.station.tele_station_name?.th ?? "").trim() || undefined;
      const place = [r.geocode.tumbon_name?.en, r.geocode.amphoe_name?.en, r.geocode.province_name?.en].filter(Boolean).join(", ");
      const nameEn = (r.station.tele_station_name?.en ?? "").trim() || `${short} station ${code} (${place})`;
      const inCore = inBox(lon, lat, core);
      const limits = [...commonLimits];
      if (value === 0.01) limits.push("0.01 mm is below the 0.1 mm gauge resolution; TMD synoptic feeds appear to use it for trace rainfall — kept exactly as published.");
      if (!(r.station.tele_station_name?.en ?? "").trim()) limits.push("No English station name is published; nameEn is composed from the station code and the published sub-district/district/province names.");
      stations.push({
        id: `${short.toLowerCase()}-${slug(code)}`,
        nameTh,
        nameEn,
        lon,
        lat,
        agency: agencyLabel(r),
        rain24h: {
          value,
          unit: "mm",
          provenance: stationProvenance({
            value,
            sourceId: "thaiwater-public-rain24h",
            sourceName: "HII ThaiWater public API — rain_24h (ฝน 24 ชั่วโมง)",
            sourceUrl: URLS.thaiwater,
            observedAt: iso,
            scope: `Single gauge (${short} ${code}) at ${place || "published coordinates"}; ${inCore ? "inside" : "outside"} the ${CITIES[cityId].nameEn} analysis bbox${inCore ? "" : ` but within its ${STATION_BUFFER_DEG}° station buffer`}.`,
            methodology: twMethod(r.rainfall_datetime, agencyLabel(r), twRetrievedAt),
            limitations: limits,
          }),
        },
        ...(iso ? { observedAt: iso } : {}),
      });
    }
    // (b) BMA stations directly from the agency page (Bangkok only)
    if (cityId === "bangkok" && useBmaDirect) {
      for (const b of bmaRows) {
        if (!Number.isFinite(b.lat) || !Number.isFinite(b.lon) || !inBox(b.lon, b.lat, buf)) continue;
        const iso = beTimeToIso(b.time);
        const inCore = inBox(b.lon, b.lat, core);
        stations.push({
          id: `bma-${slug(b.code)}`,
          nameTh: b.nameTh || undefined,
          nameEn: b.nameEn || `BMA station ${b.code}`,
          lon: b.lon,
          lat: b.lat,
          agency: AGENCY_LABEL.BMA,
          rain24h: {
            value: b.rain24,
            unit: "mm",
            provenance: stationProvenance({
              value: b.rain24,
              sourceId: "bma-dds-weather-rain",
              sourceName: "BMA Drainage and Sewerage Department — weather.bangkok.go.th rain gauge network (ระบบตรวจวัดปริมาณฝน)",
              sourceUrl: URLS.bmaWeather,
              observedAt: iso,
              scope: `Single BMA gauge ${b.code} (${b.districtEn || b.districtTh}); ${inCore ? "inside" : "outside"} the Bangkok analysis bbox${inCore ? "" : ` but within its ${STATION_BUFFER_DEG}° station buffer`}.`,
              methodology: bmaMethod(b.time, bmaRetrievedAt),
              limitations: commonLimits,
            }),
          },
          ...(iso ? { observedAt: iso } : {}),
        });
      }
    }
    stations.sort((a, b) => a.id.localeCompare(b.id));
    // de-duplicate ids deterministically (should not happen, but keep the output valid)
    const seen = new Map<string, number>();
    for (const s of stations) {
      const n = seen.get(s.id) ?? 0;
      seen.set(s.id, n + 1);
      if (n > 0) s.id = `${s.id}-${n + 1}`;
    }
    out[cityId] = stations;
    writeJson(path.join(PUB, cityId, "stations.json"), stations);
    const byAgency: Record<string, number> = {};
    for (const s of stations) {
      const k = s.id.split("-")[0];
      byAgency[k] = (byAgency[k] ?? 0) + 1;
    }
    const vals = stations.map((s) => s.rain24h.value).filter((v): v is number => v !== null);
    const top = [...stations]
      .filter((s) => s.rain24h.value !== null)
      .sort((a, b) => (b.rain24h.value as number) - (a.rain24h.value as number) || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((s) => ({ id: s.id, nameEn: s.nameEn, value: s.rain24h.value, observedAt: s.observedAt }));
    const times = stations.map((s) => s.observedAt).filter(Boolean).sort() as string[];
    stats[cityId] = {
      count: stations.length,
      insideCoreBbox: stations.filter((s) => inBox(s.lon, s.lat, core)).length,
      byAgency,
      excluded,
      stationBufferBbox: buf,
      max24hMm: vals.length ? Math.max(...vals) : null,
      top5: top,
      observedAtRange: times.length ? [times[0], times[times.length - 1]] : null,
    };
    console.log(`  ${cityId}: ${stations.length} stations written`);
  }

  // Cross-check BMA direct vs ThaiWater for the same station codes.
  let cross: Record<string, unknown> | null = null;
  if (useBmaDirect && twRecords.length) {
    const twBma = new Map(twRecords.filter((r) => (r.agency.agency_shortname.en ?? "").trim() === "BMA").map((r) => [String(r.station.tele_station_oldcode ?? "").trim(), r]));
    let matched = 0, coordDiff = 0, valueDiff = 0;
    const onlyBma: string[] = [];
    for (const b of bmaRows) {
      const t = twBma.get(b.code);
      if (!t) {
        onlyBma.push(b.code);
        continue;
      }
      matched++;
      if (Math.abs((t.station.tele_station_lat ?? 0) - b.lat) > 1e-4 || Math.abs((t.station.tele_station_long ?? 0) - b.lon) > 1e-4) coordDiff++;
      if (t.rain_24h !== null && b.rain24 !== null && Math.abs(t.rain_24h - b.rain24) > 0.05) valueDiff++;
    }
    cross = { bmaPageStations: bmaRows.length, thaiwaterBmaStations: twBma.size, matchedCodes: matched, coordinateDifferences: coordDiff, valueDifferencesOver0_05mm: valueDiff, onlyOnBmaPage: onlyBma.sort() };
  }

  // TMD aeromet2 airport daily rainfall (07:00–07:00) — staged only: the report publishes no coordinates.
  let aeroOut: Record<string, unknown> | null = null;
  if (aero.ok && aero.body) {
    const j = JSON.parse(aero.body.toString("utf8"));
    const want: Record<string, CityId> = { VTBD: "bangkok", VTBS: "bangkok", VTSS: "hatyai" };
    aeroOut = {
      kind: "snapshot",
      source: { sourceId: "tmd-aeromet2-daily-rainfall", url: URLS.aeromet2Report, page: URLS.aeromet2Page, publisher: "Thai Meteorological Department – Aeronautical Meteorological Division (กองอุตุนิยมวิทยาการบิน)" },
      retrievedAt: aero.retrievedAt,
      report: { date: j.date, periodStart: j.periodStart, periodEnd: j.periodEnd, issuedAt: j.issuedAt, latestDate: j.latestDate ?? null, stationCount: j.stationCount },
      definition: `TMD aeromet2 daily airport rainfall: “ข้อมูลฝนสะสม 24 ชั่วโมง”, period 07:00 local on periodStart to 07:00 local on periodEnd (as printed on ${URLS.aeromet2Page}). 'trace' = < 0.1 mm (T).`,
      note: "Not written to stations.json because this report publishes no station coordinates; matching ICAO codes to coordinates would be an inference.",
      airports: (j.stations as { icao: string; nameThai: string; status: string; band: string; rainMm: number | null; label: string }[])
        .filter((s) => want[s.icao])
        .map((s) => ({
          cityId: want[s.icao],
          icao: s.icao,
          nameTh: s.nameThai,
          status: s.status,
          band: s.band,
          rainMm: {
            value: s.status === "value" ? s.rainMm : null,
            unit: "mm",
            provenance: {
              status: s.status === "value" ? "observed" : "unavailable",
              sourceId: "tmd-aeromet2-daily-rainfall",
              sourceUrl: URLS.aeromet2Report,
              observedFrom: j.periodStart,
              observedTo: j.periodEnd,
              referenceYear: Number(String(j.date).slice(0, 4)),
              methodology: `Airport daily rainfall 07:00 ${j.periodStart} – 07:00 ${j.periodEnd} (local). Published label: "${s.label}".`,
            } satisfies DataProvenance,
          } satisfies MetricValue,
        })),
    };
    writeJson(path.join(STAGED, "tmd-airport-daily-rain.json"), aeroOut);
  }

  summary.stations = {
    thaiwater: { ok: tw.ok, fromCache: tw.fromCache, retrievedAt: tw.retrievedAt, status: tw.status, records: twRecords.length, error: tw.error ?? null },
    bmaWeather: { ok: bma.ok, fromCache: bma.fromCache, retrievedAt: bma.retrievedAt, status: bma.status, stationsParsed: bmaRows.length, error: bma.error ?? null },
    aeromet2: { ok: aero.ok, fromCache: aero.fromCache, retrievedAt: aero.retrievedAt, status: aero.status, error: aero.error ?? null, airports: aeroOut ? (aeroOut.airports as unknown[]).length : 0, report: aeroOut?.report ?? null },
    tmdOpenData: {
      ok: tmdOpen.ok,
      status: tmdOpen.status ?? readJson<{ status: number }>(path.join(RAW, "tmd/tmd_opendata_probe_nokey.txt.failed.json"))?.status ?? null,
      attemptedAt: tmdOpen.attemptedAt ?? readJson<{ attemptedAt: string }>(path.join(RAW, "tmd/tmd_opendata_probe_nokey.txt.failed.json"))?.attemptedAt ?? null,
      error: tmdOpen.error ?? null,
    },
    cities: stats,
    bmaVsThaiwater: cross,
    usedBmaDirect: useBmaDirect,
  };
}

// ---------------------------------------------------------------------------------------------
// Section 2: Open-Meteo ERA5 reanalysis grid + hourly events
// ---------------------------------------------------------------------------------------------
const OM_TZ = "Asia/Bangkok";
const OM_PERIOD_START = "2024-01-01";
/**
 * Single model used for EVERY published Open-Meteo value (both cities' grids and the hourly events).
 * Chosen deliberately: models=era5_land returns null precipitation, and models=best_match is (for
 * precipitation, on all checked windows) identical to models=ecmwf_ifs — the operational IFS
 * analysis/short-range-forecast archive, not a reanalysis. ERA5 is a true, frozen-model reanalysis
 * available for the whole period, which matches the contract's kind "reanalysis-grid".
 */
const OM_MODEL = "era5";
const OM_MODEL_DESC = {
  openMeteoParam: "models=era5",
  name: "ECMWF ERA5 reanalysis (Copernicus Climate Change Service, C3S)",
  resolution: "0.25° × 0.25° regular latitude/longitude grid (≈27–28 km), hourly",
  latency: "≈5 days behind real time on Open-Meteo (the most recent ~2–3 months are the preliminary ERA5T release)",
};
const OM_SOURCE_ID = "open-meteo-archive-era5";
const OM_CMP_MODEL = "best_match"; // comparison only (centre points); = ECMWF IFS on the checked windows
const CENTRES: Record<CityId, { lat: number; lon: number; definition: string }> = {
  bangkok: {
    lat: 13.72639,
    lon: 100.56,
    definition:
      "TMD synoptic station 48455 “Bangkok Metropolis” coordinates as published in ThaiWater station metadata (TMD normals report: 13°43'N 100°33'E). Used as a citable city-centre reference point.",
  },
  hatyai: {
    lat: 7.015,
    lon: 100.47,
    definition: "Midpoint of the Hat Yai Municipality analysis bbox [100.43, 6.97, 100.51, 7.06] (derived; not an official centroid).",
  },
};
const GRID_DEF: Record<CityId, { step: number; buffer: number; batch: number }> = {
  bangkok: { step: 0.1, buffer: 0, batch: 6 },
  hatyai: { step: 0.05, buffer: 0.05, batch: 6 },
};
/** Short windows used to map every lattice point to the ERA5 cell Open-Meteo assigns to it (and to verify value identity). */
const CELLMAP_WINDOW: Record<CityId, { start: string; end: string }> = {
  bangkok: { start: "2024-09-01", end: "2024-09-14" },
  hatyai: { start: "2025-11-18", end: "2025-11-27" },
};

function cellCentres(min: number, max: number, step: number): number[] {
  const k0 = Math.floor(min / step + 1e-9);
  const k1 = Math.ceil(max / step - 1e-9);
  const out: number[] = [];
  for (let k = k0; k < k1; k++) out.push(rN((k + 0.5) * step, 4));
  return out;
}
function gridPoints(cityId: CityId) {
  const g = GRID_DEF[cityId];
  const b = buffered(CITIES[cityId].bbox, g.buffer);
  const lons = cellCentres(b[0], b[2], g.step);
  const lats = cellCentres(b[1], b[3], g.step);
  const pts: { lat: number; lon: number }[] = [];
  for (const lat of lats) for (const lon of lons) pts.push({ lat, lon });
  const extent: BBox = [rN(lons[0] - g.step / 2, 4), rN(lats[0] - g.step / 2, 4), rN(lons[lons.length - 1] + g.step / 2, 4), rN(lats[lats.length - 1] + g.step / 2, 4)];
  return { pts, lons, lats, requestBbox: b, cellExtent: extent };
}
function omWeight(nLoc: number, days: number, nVars = 1, nModels = 1) {
  return nLoc * Math.max(1, days / 14) * Math.max(1, (nVars * nModels) / 10) * nModels;
}
function omUrl(p: Record<string, string>) {
  return `${URLS.openMeteo}?${new URLSearchParams(p).toString()}`;
}
const omValidate = (b: Buffer) => {
  try {
    const j = JSON.parse(b.toString("utf8"));
    if (j && j.error) return `API error: ${j.reason}`;
    return null;
  } catch {
    return "not JSON";
  }
};
interface OmLoc {
  latitude: number;
  longitude: number;
  elevation: number;
  daily?: Record<string, (number | null)[] | string[]> & { time: string[] };
  hourly?: Record<string, (number | null)[] | string[]> & { time: string[] };
}
const asLocs = (body: Buffer): OmLoc[] => {
  const j = JSON.parse(body.toString("utf8"));
  return Array.isArray(j) ? j : [j];
};
function pickKey(obj: Record<string, unknown>, prefix: string, model?: string) {
  return Object.keys(obj).find((k) => k.startsWith(prefix) && (!model || k.includes(model)));
}
const cellKey = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
const sameCell = (a: { latitude: number; longitude: number }, lat: number, lon: number) => Math.abs(a.latitude - lat) < 1e-4 && Math.abs(a.longitude - lon) < 1e-4;

async function sectionOpenMeteo() {
  console.log(`\n== Section 2: Open-Meteo modelled precipitation (models=${OM_MODEL})`);
  const dir = path.join(RAW, "open-meteo");
  const res: Record<string, unknown> = { model: OM_MODEL, modelDescription: OM_MODEL_DESC, sourceId: OM_SOURCE_ID, comparisonModel: OM_CMP_MODEL };
  const omRetrieved: string[] = [];
  const noteRetrieved = (f: FetchResult) => { if (f.ok && f.retrievedAt) omRetrieved.push(f.retrievedAt); };

  // (a) Does models=era5_land provide precipitation? (documentation of the model decision)
  const chk = await fetchRaw({
    id: "open-meteo-era5_land-precip-check",
    url: omUrl({ latitude: "13.75", longitude: "100.55", start_date: "2024-01-01", end_date: "2024-01-14", daily: "precipitation_sum", timezone: OM_TZ, models: "era5_land" }),
    cacheFile: path.join(dir, "check_era5_land_precip_2024-01.json"),
    mode: "cache-first",
    omWeight: omWeight(1, 14),
    validate: omValidate,
  });
  let era5LandWorks = false;
  if (chk.ok && chk.body) {
    const l = asLocs(chk.body)[0];
    const k = l.daily ? pickKey(l.daily, "precipitation_sum") : undefined;
    era5LandWorks = !!k && (l.daily![k] as (number | null)[]).some((v) => v !== null);
  }
  res.era5LandPrecipitationAvailable = era5LandWorks;
  res.era5LandCheck = { ok: chk.ok, retrievedAt: chk.retrievedAt, cacheFile: chk.cacheFile };
  console.log(`  era5_land precipitation available: ${era5LandWorks} (model used regardless: ${OM_MODEL})`);

  // (b) What is best_match for precipitation? (best_match vs ecmwf_ifs vs era5 on small windows)
  const idWindows: { id: string; city: CityId; start: string; end: string }[] = [
    { id: "bkk-2024-01", city: "bangkok", start: "2024-01-01", end: "2024-01-14" },
    { id: "bkk-2025-06", city: "bangkok", start: "2025-06-01", end: "2025-06-14" },
    { id: "hy-2025-11", city: "hatyai", start: "2025-11-18", end: "2025-11-27" },
  ];
  const identity: Record<string, unknown>[] = [];
  for (const w of idWindows) {
    const f = await fetchRaw({
      id: `open-meteo-model-identity-${w.id}`,
      url: omUrl({
        latitude: String(CENTRES[w.city].lat), longitude: String(CENTRES[w.city].lon),
        start_date: w.start, end_date: w.end, daily: "precipitation_sum", timezone: OM_TZ, models: "best_match,ecmwf_ifs,era5",
      }),
      cacheFile: path.join(dir, `check_model_identity_${w.id}.json`),
      mode: "cache-first",
      omWeight: omWeight(1, daysInclusive(w.start, w.end), 1, 3),
      validate: omValidate,
    });
    if (!f.ok || !f.body) {
      identity.push({ window: w, ok: false, error: f.error });
      continue;
    }
    const l = asLocs(f.body)[0];
    const d = l.daily!;
    const bm = d[pickKey(d, "precipitation_sum", "best_match")!] as (number | null)[];
    const ifs = d[pickKey(d, "precipitation_sum", "ecmwf_ifs")!] as (number | null)[];
    const e5 = d[pickKey(d, "precipitation_sum", "era5")!] as (number | null)[];
    const eq = (a: (number | null)[], b: (number | null)[]) => a.every((v, i) => v === b[i]);
    identity.push({
      window: w,
      ok: true,
      retrievedAt: f.retrievedAt,
      bestMatchEqualsEcmwfIfs: eq(bm, ifs),
      bestMatchEqualsEra5: eq(bm, e5),
      sumBestMatch: r1(bm.reduce((a: number, v) => a + (v ?? 0), 0)),
      sumEcmwfIfs: r1(ifs.reduce((a: number, v) => a + (v ?? 0), 0)),
      sumEra5: r1(e5.reduce((a: number, v) => a + (v ?? 0), 0)),
    });
  }
  res.modelIdentityChecks = identity;
  const bmIsIfs = identity.length > 0 && identity.every((x) => x.ok && x.bestMatchEqualsEcmwfIfs === true);
  res.bestMatchIsEcmwfIfsOnAllChecks = bmIsIfs;

  // (c) Aggregation convention: is daily precipitation_sum the sum of the 24 hourly values stamped 00:00–23:00 local?
  const aggWin = { start: "2025-11-20", end: "2025-11-21" };
  const agg = await fetchRaw({
    id: "open-meteo-era5-daily-vs-hourly-check",
    url: omUrl({
      latitude: String(CENTRES.hatyai.lat), longitude: String(CENTRES.hatyai.lon),
      start_date: aggWin.start, end_date: aggWin.end, hourly: "precipitation", daily: "precipitation_sum", timezone: OM_TZ, models: OM_MODEL,
    }),
    cacheFile: path.join(dir, `check_era5_daily_vs_hourly_hy_${aggWin.start}_${aggWin.end}.json`),
    mode: "cache-first",
    omWeight: omWeight(1, 2, 2),
    validate: omValidate,
  });
  if (agg.ok && agg.body) {
    const l = asLocs(agg.body)[0];
    const ht = l.hourly!.time as string[];
    const hv = l.hourly![pickKey(l.hourly!, "precipitation")!] as (number | null)[];
    const days = (l.daily!.time as string[]).map((d, i) => {
      const idx = ht.map((t, j) => (t.startsWith(d) ? j : -1)).filter((j) => j >= 0);
      const fromHourly = r1(idx.reduce((a, j) => a + (hv[j] ?? 0), 0));
      const daily = (l.daily![pickKey(l.daily!, "precipitation_sum")!] as (number | null)[])[i];
      return { date: d, dailyEndpointMm: daily, sumOfHourly00to23Mm: fromHourly, hours: idx.length, firstHour: ht[idx[0]], lastHour: ht[idx[idx.length - 1]] };
    });
    res.aggregationCheck = {
      point: { lat: CENTRES.hatyai.lat, lon: CENTRES.hatyai.lon }, modelCell: { lat: l.latitude, lon: l.longitude },
      days, matches: days.every((d) => d.dailyEndpointMm !== null && Math.abs((d.dailyEndpointMm as number) - d.sumOfHourly00to23Mm) < 0.051),
      retrievedAt: agg.retrievedAt,
    };
  }

  // (d) Latest complete ERA5 date (hourly probe at both centres), persisted for reproducibility.
  const periodFile = path.join(dir, `period_${OM_MODEL}.json`);
  let period = readJson<{ start: string; end: string; determinedAt: string; rule: string; probe?: string; model?: string }>(periodFile);
  if (END_DATE_OVERRIDE) {
    period = { start: OM_PERIOD_START, end: END_DATE_OVERRIDE, determinedAt: new Date().toISOString(), rule: "--end-date override", model: OM_MODEL };
    writeJson(periodFile, period);
  } else if (!period || hasFlag("refresh-period")) {
    const today = todayBangkok();
    const pStart = addDays(today, -14);
    const pEnd = addDays(today, -1);
    const probeFile = path.join(dir, `period_probe_${OM_MODEL}_${today}.json`);
    const probe = await fetchRaw({
      id: `open-meteo-${OM_MODEL}-latest-complete-date-probe`,
      url: omUrl({
        latitude: `${CENTRES.bangkok.lat},${CENTRES.hatyai.lat}`,
        longitude: `${CENTRES.bangkok.lon},${CENTRES.hatyai.lon}`,
        start_date: pStart, end_date: pEnd, hourly: "precipitation", timezone: OM_TZ, models: OM_MODEL,
      }),
      cacheFile: probeFile,
      mode: "network-first",
      omWeight: omWeight(2, 14),
      validate: omValidate,
    });
    if (!probe.ok || !probe.body) {
      console.log(`  !! cannot determine latest complete date (no probe, no ${rel(periodFile)}); skipping Open-Meteo section`);
      summary.openmeteo = { ...res, error: "period probe failed: " + (probe.error ?? "") };
      return;
    }
    const locs = asLocs(probe.body);
    let end = "";
    for (const d of dateRange(pStart, pEnd)) {
      const complete = locs.every((l) => {
        const t = l.hourly!.time as string[];
        const k = pickKey(l.hourly!, "precipitation")!;
        const v = l.hourly![k] as (number | null)[];
        const idx = t.map((x, i) => (x.startsWith(d) ? i : -1)).filter((i) => i >= 0);
        return idx.length === 24 && idx.every((i) => v[i] !== null);
      });
      if (complete) end = d;
    }
    if (!end) {
      summary.openmeteo = { ...res, error: "no complete day in probe window" };
      return;
    }
    period = {
      start: OM_PERIOD_START,
      end,
      model: OM_MODEL,
      determinedAt: probe.retrievedAt ?? new Date().toISOString(),
      rule: `Last local (Asia/Bangkok) date in [${pStart}, ${pEnd}] whose 24 hourly precipitation values are all non-null at both city-centre points (models=${OM_MODEL}).`,
      probe: rel(probeFile),
    };
    writeJson(periodFile, period);
  }
  const START = period.start;
  const END = period.end;
  const nDays = daysInclusive(START, END);
  res.period = { ...period, days: nDays };
  console.log(`  period ${START} .. ${END} (${nDays} days)`);

  // (e) Centre points: full-period daily, era5 (used: heaviest Bangkok day) + best_match (comparison only).
  const centreFetch = await fetchRaw({
    id: `open-meteo-centres-daily-${OM_MODEL}-${OM_CMP_MODEL}`,
    url: omUrl({
      latitude: `${CENTRES.bangkok.lat},${CENTRES.hatyai.lat}`,
      longitude: `${CENTRES.bangkok.lon},${CENTRES.hatyai.lon}`,
      start_date: START, end_date: END, daily: "precipitation_sum", timezone: OM_TZ, models: `${OM_MODEL},${OM_CMP_MODEL}`,
    }),
    cacheFile: path.join(dir, `centres_daily_${OM_MODEL}_${OM_CMP_MODEL}_${START}_${END}.json`),
    mode: "cache-first",
    omWeight: omWeight(2, nDays, 1, 2),
    validate: omValidate,
  });
  noteRetrieved(centreFetch);
  const centreSeries: Partial<Record<CityId, { time: string[]; main: (number | null)[]; cmp: (number | null)[]; modelLat: number; modelLon: number; elevation: number }>> = {};
  if (centreFetch.ok && centreFetch.body) {
    const locs = asLocs(centreFetch.body);
    (["bangkok", "hatyai"] as CityId[]).forEach((c, i) => {
      const d = locs[i].daily!;
      const kMain = pickKey(d, "precipitation_sum", `_${OM_MODEL}`)!;
      const kCmp = pickKey(d, "precipitation_sum", OM_CMP_MODEL)!;
      centreSeries[c] = { time: d.time as string[], main: d[kMain] as (number | null)[], cmp: d[kCmp] as (number | null)[], modelLat: locs[i].latitude, modelLon: locs[i].longitude, elevation: locs[i].elevation };
    });
  }

  // (f) Grids. ERA5 cells (0.25°) are coarser than the requested lattices (0.1° / 0.05°), and Open-Meteo answers
  //     each coordinate with ONE model cell (no interpolation). So: (1) one short request with every lattice point
  //     records which ERA5 cell each point gets; (2) the full period is fetched once per distinct cell, at the first
  //     lattice point mapped to that cell (same coordinates -> same cell selection); (3) every point's values in
  //     the short window must equal its cell's full-period values on those dates, else the city grid is not written.
  const gridMeta: Record<string, unknown> = {};
  for (const cityId of ["hatyai", "bangkok"] as CityId[]) {
    const g = gridPoints(cityId);
    const def = GRID_DEF[cityId];
    const w = CELLMAP_WINDOW[cityId];
    const cm = await fetchRaw({
      id: `open-meteo-${OM_MODEL}-cellmap-${cityId}`,
      url: omUrl({
        latitude: g.pts.map((p) => p.lat.toFixed(3)).join(","),
        longitude: g.pts.map((p) => p.lon.toFixed(3)).join(","),
        start_date: w.start, end_date: w.end, daily: "precipitation_sum", timezone: OM_TZ, models: OM_MODEL,
      }),
      cacheFile: path.join(dir, `cellmap_${cityId}_${OM_MODEL}_${w.start}_${w.end}.json`),
      mode: "cache-first",
      omWeight: omWeight(g.pts.length, daysInclusive(w.start, w.end)),
      validate: omValidate,
    });
    noteRetrieved(cm);
    const cmLocs = cm.ok && cm.body ? asLocs(cm.body) : [];
    if (cmLocs.length !== g.pts.length) {
      console.log(`  !! cell-map probe for ${cityId} failed; grid not written`);
      gridMeta[cityId] = { error: `cell-map probe failed (${cm.error ?? `got ${cmLocs.length} locations`})` };
      continue;
    }
    const groups = new Map<string, { lat: number; lon: number; members: number[] }>();
    cmLocs.forEach((l, i) => {
      const k = cellKey(l.latitude, l.longitude);
      if (!groups.has(k)) groups.set(k, { lat: l.latitude, lon: l.longitude, members: [] });
      groups.get(k)!.members.push(i);
    });
    const cells = [...groups.values()];
    const batches: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += def.batch) batches.push(cells.slice(i, i + def.batch));
    const cellSeries = new Map<string, { time: string[]; values: (number | null)[] }>();
    let failure = "";
    for (let bi = 0; bi < batches.length && !failure; bi++) {
      const b = batches[bi];
      const reps = b.map((c) => g.pts[c.members[0]]);
      const f = await fetchRaw({
        id: `open-meteo-${OM_MODEL}-grid-${cityId}-b${bi + 1}of${batches.length}`,
        url: omUrl({
          latitude: reps.map((p) => p.lat.toFixed(3)).join(","),
          longitude: reps.map((p) => p.lon.toFixed(3)).join(","),
          start_date: START, end_date: END, daily: "precipitation_sum", timezone: OM_TZ, models: OM_MODEL,
        }),
        cacheFile: path.join(dir, `grid_${cityId}_${OM_MODEL}_cells_${START}_${END}_b${String(bi + 1).padStart(2, "0")}.json`),
        mode: "cache-first",
        omWeight: omWeight(reps.length, nDays),
        validate: omValidate,
        timeoutMs: 240_000,
      });
      noteRetrieved(f);
      const ls = f.ok && f.body ? asLocs(f.body) : [];
      if (ls.length !== b.length) {
        failure = `batch ${bi + 1} failed (${f.error ?? `got ${ls.length} locations`})`;
        break;
      }
      ls.forEach((l, j) => {
        if (!sameCell(l, b[j].lat, b[j].lon)) failure = `batch ${bi + 1}: representative point returned cell ${l.latitude},${l.longitude} instead of ${b[j].lat},${b[j].lon}`;
        const k = pickKey(l.daily!, "precipitation_sum")!;
        cellSeries.set(cellKey(b[j].lat, b[j].lon), { time: l.daily!.time as string[], values: l.daily![k] as (number | null)[] });
      });
    }
    const dates = dateRange(START, END);
    let verifiedPoints = 0;
    const mismatches: string[] = [];
    if (!failure) {
      cmLocs.forEach((l, i) => {
        const cs = cellSeries.get(cellKey(l.latitude, l.longitude))!;
        const pt = l.daily!.time as string[];
        const pv = l.daily![pickKey(l.daily!, "precipitation_sum")!] as (number | null)[];
        const ok = pt.every((d, j) => {
          const ci = cs.time.indexOf(d);
          return ci >= 0 && cs.values[ci] === pv[j];
        });
        if (ok) verifiedPoints++;
        else mismatches.push(`${g.pts[i].lat},${g.pts[i].lon}`);
      });
      for (const [k, cs] of cellSeries) {
        if (cs.time.length !== dates.length || cs.time[0] !== dates[0] || cs.time[cs.time.length - 1] !== dates[dates.length - 1]) failure = `date axis mismatch for cell ${k}`;
      }
      if (mismatches.length) failure = `${mismatches.length} lattice points differ from their cell series in the probe window`;
    }
    if (failure) {
      console.log(`  !! grid for ${cityId} not written: ${failure}`);
      gridMeta[cityId] = { error: failure, mismatches };
      continue;
    }
    const prefix = cityId === "bangkok" ? "bkk" : "hy";
    const series = g.pts.map((p, i) => {
      const l = cmLocs[i];
      const cs = cellSeries.get(cellKey(l.latitude, l.longitude))!;
      return {
        id: `${prefix}-g-${p.lat.toFixed(3)}-${p.lon.toFixed(3)}`,
        nameEn: `Grid point ${p.lat.toFixed(3)}°N ${p.lon.toFixed(3)}°E`,
        nameTh: `จุดกริด ${p.lat.toFixed(3)}°N ${p.lon.toFixed(3)}°E`,
        lon: p.lon,
        lat: p.lat,
        values: cs.values.map((x) => (x === null || x === undefined ? null : r1(x))),
        _model: { lat: l.latitude, lon: l.longitude, elevation: l.elevation },
      };
    });
    const nullCount = series.reduce((a, s) => a + s.values.filter((v) => v === null).length, 0);
    const years = [...new Set(dates.map((d) => d.slice(0, 4)))];
    const annual: Record<string, { gridMeanMm: number; minMm: number; maxMm: number; complete: boolean; days: number }> = {};
    for (const y of years) {
      const idx = dates.map((d, i) => (d.startsWith(y) ? i : -1)).filter((i) => i >= 0);
      const totals = series.map((s) => idx.reduce((a, i) => a + (s.values[i] ?? 0), 0));
      annual[y] = {
        gridMeanMm: r1(totals.reduce((a, v) => a + v, 0) / totals.length),
        minMm: r1(Math.min(...totals)),
        maxMm: r1(Math.max(...totals)),
        complete: idx.length === (Number(y) % 4 === 0 ? 366 : 365),
        days: idx.length,
      };
    }
    const gridMean = dates.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0) / series.length);
    const maxMeanIdx = gridMean.reduce((bi2, v, i) => (v > gridMean[bi2] ? i : bi2), 0);
    let maxCell = { id: "", date: "", mm: -1 };
    for (const s of series) s.values.forEach((v, i) => { if (v !== null && v > maxCell.mm) maxCell = { id: s.id, date: dates[i], mm: v }; });

    const rs: RainSeries = {
      cityId,
      kind: "reanalysis-grid",
      dates,
      series: series.map(({ _model: _m, ...rest }) => { void _m; return rest; }),
      provenance: {
        status: "estimated",
        sourceId: OM_SOURCE_ID,
        sourceName: `Open-Meteo Historical Weather API — ${OM_MODEL_DESC.name}, daily precipitation_sum (models=${OM_MODEL})`,
        sourceUrl: URLS.openMeteo,
        observedFrom: START,
        observedTo: END,
        geographicScope:
          `${CITIES[cityId].nameEn}: regular ${def.step}° lattice of ${g.pts.length} points (${g.lats.length} lat × ${g.lons.length} lon) whose ${def.step}° cells span ` +
          `[${g.cellExtent.join(", ")}] and cover the ${def.buffer ? `bbox buffered by ${def.buffer}° [${g.requestBbox.join(", ")}]` : `city bbox [${CITIES[cityId].bbox.join(", ")}]`}; ` +
          `values come from ${cells.length} distinct ERA5 0.25° cells.`,
        methodology:
          `Modelled reanalysis precipitation, NOT rain-gauge observations. Source: ${OM_MODEL_DESC.name}, ${OM_MODEL_DESC.resolution}, served by ${URLS.openMeteo} with models=${OM_MODEL} (the same model for Bangkok and Hat Yai and for the whole period ${START}..${END}). ` +
          `Daily value = Open-Meteo daily precipitation_sum in local time (Asia/Bangkok, UTC+7) = sum of the 24 hourly values stamped 00:00–23:00, each the accumulation over the preceding hour, i.e. the window (D−1 23:00, D 23:00] local; rounded to 0.1 mm (mm/day). ` +
          `ERA5 cells are coarser than the ${def.step}° lattice: Open-Meteo answers every coordinate with one model cell (no interpolation), so the ${g.pts.length} lattice points carry the series of ${cells.length} distinct ERA5 cells and neighbouring points repeat identical values. ` +
          `Point-to-cell mapping was recorded with one short request covering all points (${w.start}..${w.end}); the full period was then fetched once per cell at the first point mapped to it, and all ${verifiedPoints}/${g.pts.length} points were verified to have values identical to their cell's series over that window. Mapping in data/staged/rain-grid-meta.json. ` +
          `models=era5 chosen over era5_land (returns no precipitation on Open-Meteo) and best_match (identical to ECMWF IFS operational analysis/forecast archive on the checked windows, i.e. not a reanalysis). ` +
          `Data CC BY 4.0 by Open-Meteo (attribution: “Weather data by Open-Meteo.com”); contains modified Copernicus Climate Change Service information.`,
        limitations: [
          "Model reanalysis, not observations: ERA5 at 0.25° (≈27–28 km) smooths convective cloudbursts and typically understates gauge maxima, especially for intense local storms.",
          `Spatial detail is limited to ${cells.length} ERA5 cells; the ${def.step}° lattice does not add information beyond the cell boundaries.`,
          "Local-midnight daily boundaries (effectively 23:00–23:00 local) differ from TMD's 07:00–07:00 climatological day; do not compare day-by-day with TMD daily totals without accounting for this.",
          `Period ends ${END} (latest complete ERA5 day available when retrieved, ~5-day latency); recent months are preliminary ERA5T and may be revised by C3S.`,
          "Free Open-Meteo API: non-commercial use only; attribution required (CC BY 4.0).",
        ],
      },
    };
    writeJson(path.join(PUB, cityId, "rain-grid.json"), rs);
    console.log(`  ${cityId}: rain-grid.json written (${series.length} series × ${dates.length} days, ${cells.length} ERA5 cells, ${nullCount} nulls)`);
    gridMeta[cityId] = {
      grid: { step: def.step, bufferDeg: def.buffer, requestBbox: g.requestBbox, cellExtent: g.cellExtent, lats: g.lats, lons: g.lons, points: g.pts.length, cellBatchSize: def.batch, cellBatches: batches.length },
      cellMapWindow: w,
      distinctModelCells: cells.length,
      modelCells: cells.map((c) => ({ cell: [c.lon, c.lat], representativePoint: [g.pts[c.members[0]].lon, g.pts[c.members[0]].lat], pointIds: c.members.map((i) => series[i].id) })),
      pointsVerifiedAgainstCellSeries: verifiedPoints,
      points: series.map((s) => ({ id: s.id, requested: [s.lon, s.lat], modelCell: [s._model.lon, s._model.lat], demElevationAtRequestedPointM: s._model.elevation })),
      nullValues: nullCount,
      annualTotalsDerived: annual,
      heaviestDayGridMean: { date: dates[maxMeanIdx], gridMeanMm: r1(gridMean[maxMeanIdx]) },
      maxCellDay: maxCell,
    };
  }

  // (g) Hourly events (centre points, models=era5)
  const events: Record<string, unknown>[] = [];
  const hourlyEvent = async (o: { id: string; cityId: CityId; start: string; end: string; title: string; selection: string; extra?: Record<string, unknown> }) => {
    const c = CENTRES[o.cityId];
    const f = await fetchRaw({
      id: `open-meteo-hourly-${o.id}`,
      url: omUrl({ latitude: String(c.lat), longitude: String(c.lon), start_date: o.start, end_date: o.end, hourly: "precipitation", timezone: OM_TZ, models: OM_MODEL }),
      cacheFile: path.join(dir, `hourly_${o.id}_${OM_MODEL}.json`),
      mode: "cache-first",
      omWeight: omWeight(1, daysInclusive(o.start, o.end)),
      validate: omValidate,
    });
    noteRetrieved(f);
    if (!f.ok || !f.body) {
      events.push({ id: o.id, cityId: o.cityId, error: f.error ?? "fetch failed", status: "unavailable" });
      return;
    }
    const l = asLocs(f.body)[0];
    const t = l.hourly!.time as string[];
    const v = (l.hourly![pickKey(l.hourly!, "precipitation")!] as (number | null)[]).map((x) => (x === null ? null : r1(x)));
    const cs = centreSeries[o.cityId];
    const daily = dateRange(o.start, o.end).map((d) => {
      const idx = t.map((x, i) => (x.startsWith(d) ? i : -1)).filter((i) => i >= 0);
      const vals = idx.map((i) => v[i]);
      const ci = cs ? cs.time.indexOf(d) : -1;
      return {
        date: d,
        mm: vals.some((x) => x === null) ? null : r1(vals.reduce((a: number, x) => a + (x ?? 0), 0)),
        hours: idx.length,
        dailyEndpointMm: ci >= 0 ? cs!.main[ci] : null,
      };
    });
    let peak = { time: "", mm: -1 };
    v.forEach((x, i) => { if (x !== null && x > peak.mm) peak = { time: t[i] + ":00+07:00", mm: x }; });
    let best24 = { endTime: "", mm: -1 };
    for (let i = 23; i < v.length; i++) {
      const win = v.slice(i - 23, i + 1);
      if (win.some((x) => x === null)) continue;
      const s = r1(win.reduce((a: number, x) => a + (x as number), 0));
      if (s > best24.mm) best24 = { endTime: t[i] + ":00+07:00", mm: s };
    }
    const total = v.every((x) => x !== null) ? r1(v.reduce((a: number, x) => a + (x as number), 0)) : null;
    const prov: DataProvenance = {
      status: "estimated",
      sourceId: OM_SOURCE_ID,
      sourceName: `Open-Meteo Historical Weather API — ${OM_MODEL_DESC.name}, hourly precipitation (models=${OM_MODEL})`,
      sourceUrl: URLS.openMeteo,
      observedFrom: o.start,
      observedTo: o.end,
      referenceYear: Number(o.start.slice(0, 4)),
      geographicScope: `Single ERA5 0.25° cell answering ${c.lat}°N ${c.lon}°E (${c.definition}); model cell ${l.latitude}°N ${l.longitude}°E.`,
      methodology: `Modelled reanalysis hourly precipitation (mm), not gauge data. ${OM_MODEL_DESC.name}, ${OM_MODEL_DESC.resolution}. Open-Meteo convention: the value stamped at hour T is the accumulation over the preceding hour (T−1h, T], local time Asia/Bangkok (UTC+7). Rounded to 0.1 mm.`,
      limitations: [
        "Single ≈27–28 km reanalysis cell; local gauge peaks can be much higher than the cell value.",
        "Model output; timing of convective peaks can be shifted by hours.",
      ],
    };
    const mismatchDays = daily.filter((d) => d.mm !== null && d.dailyEndpointMm !== null && Math.abs(d.mm - (d.dailyEndpointMm as number)) > 0.051).map((d) => d.date);
    events.push({
      id: o.id,
      cityId: o.cityId,
      titleEn: o.title,
      selection: o.selection,
      requestedPoint: { lat: c.lat, lon: c.lon, definition: c.definition },
      modelPoint: { lat: l.latitude, lon: l.longitude },
      model: OM_MODEL,
      modelDescription: `${OM_MODEL_DESC.name}; ${OM_MODEL_DESC.resolution}`,
      timezone: OM_TZ,
      from: o.start,
      to: o.end,
      unit: "mm",
      times: t.map((x) => x + ":00+07:00"),
      values: v,
      dailyTotals: daily,
      dailyTotalsCheck: cs ? (mismatchDays.length ? `MISMATCH vs daily endpoint on ${mismatchDays.join(", ")}` : "sum of hourly values 00:00–23:00 equals the daily precipitation_sum endpoint (±0.05 mm) on every day") : "daily endpoint unavailable",
      eventTotalMm: total,
      peakHour: peak.mm >= 0 ? peak : null,
      maxRolling24hMm: best24.mm >= 0 ? best24 : null,
      ...(o.extra ?? {}),
      provenance: prov,
      retrievedAt: f.retrievedAt,
    });
  };
  await hourlyEvent({
    id: "hatyai-2025-11-18_2025-11-27",
    cityId: "hatyai",
    start: "2025-11-18",
    end: "2025-11-27",
    title: "Hat Yai municipality centre — hourly ERA5 reanalysis precipitation, 18–27 Nov 2025",
    selection: "Fixed window requested by the project brief (November 2025 Hat Yai flood context).",
  });
  const bc = centreSeries.bangkok;
  if (bc) {
    let bi = -1;
    bc.main.forEach((x, i) => { if (x !== null && (bi < 0 || x > (bc.main[bi] as number))) bi = i; });
    const day = bc.time[bi];
    await hourlyEvent({
      id: `bangkok-heaviest-day-${day}`,
      cityId: "bangkok",
      start: addDays(day, -1) < START ? day : addDays(day, -1),
      end: addDays(day, 1) > END ? day : addDays(day, 1),
      title: `Bangkok city-centre point — hourly ERA5 reanalysis precipitation around the heaviest modelled day ${day}`,
      selection: `Heaviest day = maximum daily precipitation_sum (models=${OM_MODEL}, local day) at the Bangkok centre point over ${START}..${END}: ${day} with ${r1(bc.main[bi] as number)} mm. Window = that day ±1 day.`,
      extra: { heaviestDay: day, heaviestDayDailyMm: r1(bc.main[bi] as number) },
    });
  } else {
    events.push({ id: "bangkok-heaviest-day", cityId: "bangkok", error: "centre-point daily series unavailable; heaviest day not determined", status: "unavailable" });
  }
  writeJson(path.join(STAGED, "rain-hourly-events.json"), {
    generatedNote: "Modelled (estimated) hourly precipitation for event context — ERA5 reanalysis via Open-Meteo. Not gauge observations.",
    model: OM_MODEL,
    modelDescription: OM_MODEL_DESC,
    sourceId: OM_SOURCE_ID,
    period: { start: START, end: END },
    events,
  });

  // centre comparison (derived): ERA5 (used) vs best_match (= ECMWF IFS; comparison only)
  const centreCmp: Record<string, unknown> = {};
  for (const c of ["bangkok", "hatyai"] as CityId[]) {
    const s = centreSeries[c];
    if (!s) continue;
    const years: Record<string, unknown> = {};
    for (const y of [...new Set(s.time.map((d) => d.slice(0, 4)))]) {
      const idx = s.time.map((d, i) => (d.startsWith(y) ? i : -1)).filter((i) => i >= 0);
      const sum = (arr: (number | null)[]) => (idx.some((i) => arr[i] === null) ? null : r1(idx.reduce((a, i) => a + (arr[i] as number), 0)));
      years[y] = { days: idx.length, era5Mm: sum(s.main), bestMatchMm: sum(s.cmp) };
    }
    let mi = 0;
    s.main.forEach((x, i) => { if ((x ?? -1) > (s.main[mi] ?? -1)) mi = i; });
    let ci = 0;
    s.cmp.forEach((x, i) => { if ((x ?? -1) > (s.cmp[ci] ?? -1)) ci = i; });
    centreCmp[c] = {
      point: { lat: CENTRES[c].lat, lon: CENTRES[c].lon, definition: CENTRES[c].definition },
      modelCellEra5: { lat: s.modelLat, lon: s.modelLon },
      annualTotals: years,
      heaviestDay: { era5: { date: s.time[mi], mm: s.main[mi] }, bestMatch: { date: s.time[ci], mm: s.cmp[ci] } },
    };
  }
  const retrievedRange = omRetrieved.length ? [omRetrieved.reduce((a, b) => (a < b ? a : b)), omRetrieved.reduce((a, b) => (a > b ? a : b))] : null;
  res.retrievedRange = retrievedRange;
  writeJson(path.join(STAGED, "rain-grid-meta.json"), {
    note: "Supporting metadata for public/data/*/rain-grid.json and data/staged/rain-hourly-events.json (derived by scripts/data/fetch-rainfall.ts). Annual totals are derived sums of modelled daily values (grid mean = mean over lattice points, i.e. ERA5 cells weighted by how many lattice points they answer). modelCell = latitude/longitude returned by Open-Meteo (the ERA5 cell used). demElevationAtRequestedPointM = elevation Open-Meteo reports for the requested coordinate (its 90 m DEM; precipitation is not elevation-adjusted). centreComparison.bestMatchMm = models=best_match (= ECMWF IFS on the checked windows), comparison only.",
    model: OM_MODEL,
    modelDescription: OM_MODEL_DESC,
    era5LandPrecipitationAvailable: era5LandWorks,
    period: res.period,
    retrievedRange,
    aggregationCheck: res.aggregationCheck ?? null,
    modelIdentityChecks: identity,
    cities: gridMeta,
    centreComparison: centreCmp,
  });
  summary.openmeteo = {
    ...res,
    grids: Object.fromEntries(Object.entries(gridMeta).map(([k, v]) => {
      const m = v as Record<string, unknown>;
      return [k, { points: (m.grid as { points?: number } | undefined)?.points, distinctModelCells: m.distinctModelCells, pointsVerifiedAgainstCellSeries: m.pointsVerifiedAgainstCellSeries, annualTotalsDerived: m.annualTotalsDerived, heaviestDayGridMean: m.heaviestDayGridMean, maxCellDay: m.maxCellDay, error: m.error }];
    })),
    centreComparison: centreCmp,
    events: events.map((e) => ({ id: e.id, eventTotalMm: e.eventTotalMm, peakHour: e.peakHour, maxRolling24hMm: e.maxRolling24hMm, dailyTotals: e.dailyTotals, dailyTotalsCheck: e.dailyTotalsCheck, modelPoint: e.modelPoint, error: e.error })),
  };
}

// ---------------------------------------------------------------------------------------------
// Section 3: TMD normals 1991–2020 + intensity classes
// ---------------------------------------------------------------------------------------------
interface NormalsStation {
  name: string;
  index: string;
  period: string;
  latDms: string;
  lonDms: string;
  lat: number;
  lon: number;
  elevationM: number;
  pdfPage: number;
  printedPage: string | null;
  rain: number[];
  rainyDays: number[];
  dailyMax: number[];
}
function parseNormals(text: string, stationName: string): NormalsStation | null {
  const parts = text.split(/=====PAGE (\d+)=====\n?/);
  for (let i = 1; i < parts.length; i += 2) {
    const page = Number(parts[i]);
    const body = parts[i + 1] ?? "";
    const h = new RegExp(`Station ${stationName.replace(/[()]/g, "\\$&")} Index station (\\d{5}) Latitude (\\d{1,2}) (\\d{2}) ([NS]) Longitude (\\d{2,3}) (\\d{2}) ([EW]) Elevation of station above MSL (\\d+) Meters`).exec(body);
    if (!h) continue;
    const per = /CLIMATOLOGICAL DATA FOR THE PERIOD (\d{4}-\d{4})/.exec(body);
    const rows: number[][] = [];
    for (const line of body.split("\n")) {
      const toks = line.trim().split(/\s+/);
      const nums: number[] = [];
      for (let k = toks.length - 1; k >= 0 && /^-?\d+(?:\.\d+)?$/.test(toks[k]); k--) nums.unshift(Number(toks[k]));
      if (nums.length === 13) rows.push(nums);
    }
    const sumOk = (r: number[]) => Math.abs(r.slice(0, 12).reduce((a, v) => a + v, 0) - r[12]) <= 0.25;
    const maxOk = (r: number[]) => Math.abs(Math.max(...r.slice(0, 12)) - r[12]) < 0.01;
    for (let k = 0; k + 2 < rows.length; k++) {
      const [a, b, c] = [rows[k], rows[k + 1], rows[k + 2]];
      if (sumOk(a) && a[12] >= 500 && a[12] <= 5000 && sumOk(b) && b.slice(0, 12).every((v) => v <= 31) && b[12] >= 30 && b[12] <= 250 && maxOk(c)) {
        const printed = /-\s*(\d+)\s*-\s*$/.exec(body.trim());
        const dms = (d: string, m: string, hemi: string) => (Number(d) + Number(m) / 60) * (hemi === "S" || hemi === "W" ? -1 : 1);
        return {
          name: stationName,
          index: h[1],
          period: per ? per[1] : "unknown",
          latDms: `${h[2]}°${h[3]}'${h[4]}`,
          lonDms: `${h[5]}°${h[6]}'${h[7]}`,
          lat: rN(dms(h[2], h[3], h[4]), 4),
          lon: rN(dms(h[5], h[6], h[7]), 4),
          elevationM: Number(h[8]),
          pdfPage: page,
          printedPage: printed ? printed[1] : null,
          rain: a,
          rainyDays: b,
          dailyMax: c,
        };
      }
    }
  }
  return null;
}

async function sectionNormals() {
  console.log("\n== Section 3: TMD climatological normals + rainfall intensity classes");
  const pdf = await fetchRaw({
    id: "tmd-climate-normals-1991-2020-pdf",
    url: URLS.tmdNormalsPdf,
    cacheFile: path.join(RAW, "tmd/ubonmet_climate_normal_1991-2020.pdf"),
    mode: "cache-first",
    timeoutMs: 300_000,
    validate: (b) => (b.subarray(0, 5).toString("latin1") === "%PDF-" ? null : "not a PDF"),
  });
  const txtFile = path.join(RAW, "tmd/ubonmet_climate_normal_1991-2020.txt");
  let textNote = "";
  if (pdf.ok && (!fs.existsSync(txtFile) || REFRESH)) {
    try {
      execFileSync("osascript", ["-l", "JavaScript", path.join(ROOT, "scripts/data/lib/pdf-to-text.jxa.js"), path.join(RAW, "tmd/ubonmet_climate_normal_1991-2020.pdf"), txtFile], { stdio: "pipe" });
      textNote = "text layer extracted with macOS PDFKit (scripts/data/lib/pdf-to-text.jxa.js)";
    } catch (e) {
      textNote = `PDF text extraction failed: ${(e as Error).message}`;
    }
  } else if (fs.existsSync(txtFile)) textNote = "re-used cached text extraction";
  const text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, "utf8") : "";
  const header = {
    titleEn: /CLIMATOLOGICAL DATA OF THAILAND\s*\nFOR 30 YEAR PERIOD \((\d{4}-\d{4})\)/.exec(text)?.[0]?.replace(/\s+/g, " ") ?? null,
    reportNo: /Meteorological Data report No\. ([^\n]+)/.exec(text)?.[1]?.trim() ?? null,
    rainfallDefinition: /Daily rainfall is recorded\s*from 0700 L\.S\.T\. of the day to 0700 L\.S\.T\. of the following\s*day\. A rainy day is a day with an amount of 0\.1 mm\. or\s*more of rain\./.test(text),
  };
  const targets: { cityId: CityId; name: string; nameTh: string }[] = [
    { cityId: "bangkok", name: "BANGKOK METROPOLIS", nameTh: "กรุงเทพมหานคร" },
    { cityId: "hatyai", name: "HAT YAI AIRPORT", nameTh: "หาดใหญ่ (สนามบินหาดใหญ่)" },
  ];
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const stations = targets.map((t) => {
    const p = text ? parseNormals(text, t.name) : null;
    const prov = (what: string): DataProvenance => ({
      status: p ? "observed" : "unavailable",
      sourceId: "tmd-climate-normals-1991-2020",
      sourceName: "TMD, Climatological Data of Thailand for 30 Year Period (1991-2020)",
      sourceUrl: URLS.tmdNormalsPdf,
      ...(p ? { observedFrom: `${p.period.slice(0, 4)}-01-01`, observedTo: `${p.period.slice(5, 9)}-12-31` } : {}),
      geographicScope: `TMD synoptic station ${t.name}${p ? ` (index ${p.index}, ${p.latDms} ${p.lonDms}, ${p.elevationM} m MSL)` : ""}`,
      methodology: `${what} Station climatological normal published by TMD (30-year mean, ${p?.period ?? "1991-2020"}). Daily rainfall is recorded from 0700 L.S.T. to 0700 L.S.T. of the following day; a rainy day has >= 0.1 mm. Values transcribed by text extraction from PDF page ${p?.pdfPage ?? "?"} (printed page ${p?.printedPage ?? "?"}); monthly sums verified against the published annual value.`,
    });
    return {
      cityId: t.cityId,
      id: `tmd-${p?.index ?? t.name.toLowerCase().replace(/\s+/g, "-")}`,
      wmoIndex: p?.index ?? null,
      nameEn: t.name,
      nameTh: t.nameTh,
      nameThSource: "Thai name as used in ThaiWater/TMD station metadata (the normals PDF lists English names only).",
      latDms: p?.latDms ?? null,
      lonDms: p?.lonDms ?? null,
      lat: p?.lat ?? null,
      lon: p?.lon ?? null,
      elevationM: p?.elevationM ?? null,
      period: p?.period ?? null,
      pdfPage: p?.pdfPage ?? null,
      printedPage: p?.printedPage ?? null,
      months,
      annualRainfall: { value: p ? p.rain[12] : null, unit: "mm/year", provenance: prov("Mean annual rainfall.") } satisfies MetricValue,
      annualRainyDays: { value: p ? p.rainyDays[12] : null, unit: "days/year", provenance: prov("Mean number of rainy days per year.") } satisfies MetricValue,
      monthlyRainfallMm: p ? p.rain.slice(0, 12) : null,
      monthlyRainyDays: p ? p.rainyDays.slice(0, 12) : null,
      monthlyDailyMaximumMm: p ? p.dailyMax.slice(0, 12) : null,
      recordDailyMaximumMm: p ? p.dailyMax[12] : null,
      checks: p
        ? {
            monthlyRainSum: r1(p.rain.slice(0, 12).reduce((a, v) => a + v, 0)),
            publishedAnnual: p.rain[12],
            monthlyRainyDaySum: r1(p.rainyDays.slice(0, 12).reduce((a, v) => a + v, 0)),
            publishedAnnualRainyDays: p.rainyDays[12],
          }
        : null,
    };
  });

  // Rainfall intensity classes (TMD forecast criteria page) + cross-checks.
  const crit = await fetchRaw({
    id: "tmd-weather-criteria-page",
    url: URLS.tmdCriteria,
    cacheFile: path.join(RAW, "tmd/tmd_info_weather_criteria.html"),
    mode: "cache-first",
    validate: (b) => (b.toString("utf8").includes("เกณฑ์ปริมาณฝน") ? null : "criteria text not found"),
  });
  const critText = crit.ok && crit.body ? stripHtml(crit.body.toString("utf8")) : "";
  const classRe = /(\d)\.\s*(ฝน[^()\d]*?)\s*\((Light Rain|Moderate Rain|Heavy Rain|Very Heavy Rain)\)\s*ฝนตกมีปริมาณตั้งแต่\s*([\d.]+)\s*มิลลิเมตร\s*(?:ถึง\s*([\d.]+)\s*มิลลิเมตร|ขึ้นไป)/g;
  const classes = [...critText.matchAll(classRe)].map((m) => ({
    id: m[3].toLowerCase().replace(/\s+/g, "-"),
    labelTh: m[2].trim(),
    labelEn: m[3],
    minMm: Number(m[4]),
    maxMm: m[5] ? Number(m[5]) : null,
    quoteTh: normSpace(m[0]),
  }));
  const legend = await fetchRaw({
    id: "tmd-aeromet2-legend-bundle",
    url: URLS.aeromet2Legend,
    cacheFile: path.join(RAW, "tmd/aeromet2_rainfallExport-O01ssJWd.js.txt"),
    mode: "cache-first",
  });
  const legendText = legend.ok && legend.body ? legend.body.toString("utf8") : "";
  const aeroLegend = [...legendText.matchAll(/legend:`(ฝน(?:น้อยกว่า|เล็กน้อย|ปานกลาง|หนัก|หนักมาก)[^`]*)`/g)].map((m) => m[1]).slice(0, 5);
  const bmaHtmlFile = path.join(RAW, "bma-weather/weather_bangkok_index.html");
  const bmaHtml = fs.existsSync(bmaHtmlFile) ? fs.readFileSync(bmaHtmlFile, "utf8") : "";
  const bmaBar = /id="Rain_Bar_To1"><\/span>\s*10[\s\S]{0,300}id="Rain_Bar_To2"><\/span>\s*35[\s\S]{0,300}id="Rain_Bar_To3"><\/span>\s*90/.test(bmaHtml);

  const out = {
    note: "TMD climatological normals and rainfall-intensity classes. Normals are station statistics (observed 30-year means), not city-wide averages.",
    source: {
      sourceId: "tmd-climate-normals-1991-2020",
      url: URLS.tmdNormalsPdf,
      publisher: "Thai Meteorological Department (กรมอุตุนิยมวิทยา), 30 Year Period Climatological Data Working Group",
      title: header.titleEn,
      reportNo: header.reportNo,
      hostedOn: "ubonmet.tmd.go.th (TMD Ubon Ratchathani Meteorological Station website)",
      retrievedAt: pdf.retrievedAt,
      textExtraction: textNote,
      definitionsFoundInPdf: header.rainfallDefinition,
      definitionsQuote: "Daily rainfall is recorded from 0700 L.S.T. of the day to 0700 L.S.T. of the following day. A rainy day is a day with an amount of 0.1 mm. or more of rain.",
      license: "© Thai Meteorological Department; no open licence stated. Factual statistics cited with attribution.",
    },
    stations,
    intensityClasses24h: {
      sourceId: "tmd-weather-criteria",
      url: URLS.tmdCriteria,
      publisher: "Thai Meteorological Department – Weather Forecast Division (กองพยากรณ์อากาศ), page “เกณฑ์อากาศ”",
      retrievedAt: crit.retrievedAt,
      headingTh: critText.includes("เกณฑ์ปริมาณฝน") ? "เกณฑ์ปริมาณฝน" : null,
      classes: [
        { id: "trace", labelTh: "ฝนน้อยกว่า 0.1 มม. (T)", labelEn: "Trace", minMm: 0, maxMm: 0.1, maxExclusive: true, quoteTh: "ฝนน้อยกว่า 0.1 มม. (T)", source: "TMD aeromet2 daily rainfall report legend (not on the criteria page)" },
        ...classes.map((c) => ({ ...c, source: "TMD criteria page" })),
      ],
      accumulationWindow:
        "The criteria page states amounts without an explicit window. TMD's aeromet2 daily report applies the same bands to “ข้อมูลฝนสะสม 24 ชั่วโมง” over 07:00–07:00, and the TMD normals define the rainfall day as 0700–0700 L.S.T.",
      crossChecks: {
        aeromet2LegendTh: aeroLegend,
        aeromet2LegendUrl: URLS.aeromet2Page,
        bmaWeatherBarSameThresholds: bmaBar,
        bmaWeatherBarNote: "weather.bangkok.go.th rain bar shows class breaks >0 / 10 / 35 / 90 mm (ฝนละออง, ฝนเล็กน้อย, ฝนปานกลาง, ฝนหนัก, ฝนหนักมาก).",
      },
      license: "© Thai Meteorological Department; no open licence stated.",
    },
  };
  writeJson(path.join(STAGED, "rain-normals.json"), out);
  summary.normals = {
    pdf: { ok: pdf.ok, fromCache: pdf.fromCache, retrievedAt: pdf.retrievedAt, bytes: pdf.bytes },
    textNote,
    stations: stations.map((s) => ({ id: s.id, period: s.period, annual: s.annualRainfall.value, rainyDays: s.annualRainyDays.value, pdfPage: s.pdfPage, checks: s.checks })),
    classesParsed: classes.length,
    criteria: { ok: crit.ok, retrievedAt: crit.retrievedAt },
    aeromet2Legend: aeroLegend.length,
    bmaBar,
  };
  console.log(`  normals: ${stations.filter((s) => s.wmoIndex).length}/2 stations parsed; ${classes.length} intensity classes`);
}

// ---------------------------------------------------------------------------------------------
// Section 4: drainage capacity statements (curated; each quote is verified against the cached page)
// ---------------------------------------------------------------------------------------------
interface Statement {
  id: string;
  cityId: CityId;
  topic: string;
  subject: string;
  value: number | null;
  unit: string | null;
  valueType: "stated-capacity" | "design-target" | "project-target" | "combined-capacity" | "status" | "context";
  quoteTh: string;
  quoteEnTranslation: string;
  attribution: string;
  sourceKey: string;
  caveats: string[];
}
const DRAINAGE_SOURCES: Record<string, { url: string; cacheFile: string; publisher: string; title: string; publishedAt: string; sourceType: string }> = {
  thaipublica2025: {
    url: "https://thaipublica.org/2025/06/green-up-the-world-02/",
    cacheFile: "news/thaipublica_2025_06_green-up-the-world-02.html",
    publisher: "ThaiPublica",
    title: "“อรรถเศรษฐ์ เพชรมีศรี” เล่าเบื้องหลัง “น้ำรอระบายไม่เกิน 1 ชม.” กทม. ทำอะไรบ้าง",
    publishedAt: "2025-06-08",
    sourceType: "news report quoting a BMA official (adviser to the Bangkok Governor)",
  },
  thaipbs2016: {
    url: "https://www.thaipbs.or.th/news/content/253350",
    cacheFile: "news/thaipbs_253350.html",
    publisher: "Thai PBS News",
    title: "ขีดจำกัดระบายน้ำ \"ดินทรุด-ขยะอุดตัน\" ต้นตอน้ำท่วมขัง กทม.วงกว้าง",
    publishedAt: "2016-06-21",
    sourceType: "news report (reporter's statement; no named official)",
  },
  thaipbs2026: {
    url: "https://www.thaipbs.or.th/news/content/558901",
    cacheFile: "news/thaipbs_558901.html",
    publisher: "Thai PBS News",
    title: "เปิดแผน \"อุโมงค์ระบายน้ำ\" กทม. รับมือฝนหนัก-เพิ่มทางด่วนสู่เจ้าพระยา",
    publishedAt: "2026-09-30",
    sourceType: "news report summarising the BMA Drainage and Sewerage Department's 2569 (2026) flood action plan book",
  },
  bmapr2025: {
    url: "https://pr-bangkok.com/?p=522995",
    cacheFile: "bma-pr/prbkk_522995.html",
    publisher: "BMA Public Relations Office (สำนักงานประชาสัมพันธ์ กรุงเทพมหานคร)",
    title: "รองผู้ว่าฯ วิศณุ ตรวจโครงการระบายน้ำคลองรางอ้อ – รางแก้ว ...",
    publishedAt: "2025-09-16",
    sourceType: "official BMA press release",
  },
  onep2020: {
    url: "https://www.onep.go.th/?p=4759",
    cacheFile: "hatyai-drainage/onep_4759.html",
    publisher: "Office of Natural Resources and Environmental Policy and Planning (ONEP, สำนักงานนโยบายและแผนทรัพยากรธรรมชาติและสิ่งแวดล้อม)",
    title: "12 กุมภาพันธ์ 2563 กรมชลประทานเร่งก่อสร้างโครงการบรรเทาอุทกภัยหาดใหญ่ หวังปี 63 รอดน้ำท่วม",
    publishedAt: "2020-02-12",
    sourceType: "government news item reporting the Royal Irrigation Department (RID)",
  },
  dailynews2026: {
    url: "https://www.dailynews.co.th/news/6104172/",
    cacheFile: "hatyai-drainage/dailynews_6104172.html",
    publisher: "Daily News (เดลินิวส์)",
    title: "“สุริยะ” เร่งฟื้นฟูคลองระบายน้ำ ร.1 สงขลา คืนประสิทธิภาพเต็มศักยภาพ",
    publishedAt: "2026-08-13",
    sourceType: "news report quoting the Minister of Agriculture and Cooperatives",
  },
};
const STATEMENTS: Statement[] = [
  {
    id: "bkk-design-intensity-60mmh-2025",
    cityId: "bangkok",
    topic: "design-rainfall-intensity",
    subject: "Bangkok drainage system (citywide statement)",
    value: 60,
    unit: "mm/h",
    valueType: "stated-capacity",
    quoteTh: "กรุงเทพฯ รองรับปริมาณฝนได้จำกัดสูงสุด 60 มิลลิเมตรต่อชั่วโมง แต่ที่ผ่านมาฝนตกในกรุงเทพฯ ไป 80 หรือ 100 มิลลิเมตร",
    quoteEnTranslation: "Bangkok can handle rainfall up to a maximum of 60 mm per hour, but recently rain in Bangkok has reached 80 or 100 mm. (translation by this project)",
    attribution: "Attasit Petchmeesri (อรรถเศรษฐ์ เพชรมีศรี), adviser to the Bangkok Governor, speaking on 7 Jun 2025",
    sourceKey: "thaipublica2025",
    caveats: ["Spoken statement reported by media, not a design document.", "A citywide figure; local sub-catchments differ (older pipes vs. upgraded areas)."],
  },
  {
    id: "bkk-design-intensity-60mm-2025-b",
    cityId: "bangkok",
    topic: "design-rainfall-intensity",
    subject: "Bangkok drainage system (citywide statement)",
    value: 60,
    unit: "mm (unit of time not stated in this quote)",
    valueType: "stated-capacity",
    quoteTh: "กรุงเทพฯ ถูกออกแบบมาให้รับน้ำฝนได้ 60 มิลลิเมตร วันนี้ฝนตก 100, 120 มิลลิเมตร",
    quoteEnTranslation: "Bangkok was designed to take 60 mm of rain; today it rains 100, 120 mm. (translation by this project)",
    attribution: "Attasit Petchmeesri, adviser to the Bangkok Governor (same talk)",
    sourceKey: "thaipublica2025",
    caveats: ["The quote omits the time unit; the same speaker states 60 mm per hour elsewhere in the article."],
  },
  {
    id: "bkk-pipe-limit-60mmh-2016",
    cityId: "bangkok",
    topic: "design-rainfall-intensity",
    subject: "Bangkok street drainage pipes",
    value: 60,
    unit: "mm/h",
    valueType: "stated-capacity",
    quoteTh: "ท่อระบายน้ำในกรุงเทพฯ มีขีดจำกัดที่ระบายน้ำได้เพียง 60 มิลลิเมตรต่อชั่วโมงเท่านั้น",
    quoteEnTranslation: "Bangkok's drainage pipes are limited to draining only 60 mm per hour. (translation by this project)",
    attribution: "Thai PBS reporter (no named official), 21 Jun 2016",
    sourceKey: "thaipbs2016",
    caveats: ["2016 statement; not attributed to a named BMA official.", "Consistent with the 2025 statement above."],
  },
  {
    id: "bkk-target-76mmh-104mmday-2026",
    cityId: "bangkok",
    topic: "design-rainfall-target",
    subject: "BMA flood action plan 2569 (2026) — target capacity of the drainage system",
    value: 76,
    unit: "mm/h (with ≤104 mm/day, ~3-hour storm)",
    valueType: "design-target",
    quoteTh: "กทม.มีเป้าหมายเพิ่มขีดความสามารถของระบบระบายน้ำให้สามารถรองรับปริมาณฝนตกสะสมได้ไม่เกิน 104 มม.ใน 1 วัน โดยเอกสารระบุลักษณะฝนประมาณ 3 ชั่วโมง และความเข้มของฝนที่ 76 มม./ชั่วโมง",
    quoteEnTranslation: "The BMA aims to raise drainage capacity to handle accumulated rainfall of up to 104 mm in one day; the document specifies a storm of about 3 hours with an intensity of 76 mm/hour. (translation by this project)",
    attribution: "Thai PBS, citing หนังสือแผนปฏิบัติการป้องกันและแก้ไขปัญหาน้ำท่วมกรุงเทพมหานคร ประจำปี 2569 (BMA Drainage and Sewerage Department)",
    sourceKey: "thaipbs2026",
    caveats: ["A target, not the current citywide capacity.", "Primary document (ebooks.dds.bangkok.go.th/ebook_files/2026/0000059_2.pdf, ~161 MB) was not downloaded; the figure is verified only as quoted by Thai PBS."],
  },
  {
    id: "bkk-tunnels-5-existing-255m3s",
    cityId: "bangkok",
    topic: "tunnel-capacity",
    subject: "5 existing large drainage tunnels, total (28.57 km)",
    value: 255,
    unit: "m³/s",
    valueType: "combined-capacity",
    quoteTh: "เมื่อรวมทั้ง 5 โครงการ จะได้ความยาวอุโมงค์ 28.57 กม. และกำลังระบายน้ำรวม 255 ลบ.ม./วินาที",
    quoteEnTranslation: "Combining all 5 projects gives 28.57 km of tunnels with a total drainage capacity of 255 m³/s. (translation by this project)",
    attribution: "Thai PBS, citing the BMA DDS 2569 flood action plan",
    sourceKey: "thaipbs2026",
    caveats: ["Nominal sum; tunnels do not necessarily operate at full capacity simultaneously (the article itself notes this for the 625 m³/s planned total)."],
  },
  {
    id: "bkk-tunnel-prem-prachakorn-30m3s",
    cityId: "bangkok",
    topic: "tunnel-capacity",
    subject: "Prem Prachakorn diversion system (ระบบผันน้ำเปรมประชากร), Ø3.40 m, ~1.88 km",
    value: 30,
    unit: "m³/s",
    valueType: "stated-capacity",
    quoteTh: "มีขีดความสามารถในการระบายน้ำ 30 ลบ.ม./วินาที",
    quoteEnTranslation: "Has a drainage capacity of 30 m³/s. (translation by this project)",
    attribution: "Thai PBS, citing the BMA DDS 2569 flood action plan",
    sourceKey: "thaipbs2026",
    caveats: [],
  },
  {
    id: "bkk-tunnel-bueng-makkasan-45m3s",
    cityId: "bangkok",
    topic: "tunnel-capacity",
    subject: "Bueng Makkasan – Chao Phraya tunnel (อุโมงค์บึงมักกะสันลงสู่แม่น้ำเจ้าพระยา), Ø4.60 m, ~5.98 km",
    value: 45,
    unit: "m³/s",
    valueType: "stated-capacity",
    quoteTh: "สามารถระบายน้ำได้ 45 ลบ.ม./วินาที",
    quoteEnTranslation: "Can drain 45 m³/s. (translation by this project)",
    attribution: "Thai PBS, citing the BMA DDS 2569 flood action plan",
    sourceKey: "thaipbs2026",
    caveats: [],
  },
  {
    id: "bkk-tunnel-saen-saep-lat-phrao-60m3s",
    cityId: "bangkok",
    topic: "tunnel-capacity",
    subject: "Khlong Saen Saep and Khlong Lat Phrao tunnel (อุโมงค์คลองแสนแสบและคลองลาดพร้าว), Ø5 m, ~5.11 km",
    value: 60,
    unit: "m³/s",
    valueType: "stated-capacity",
    quoteTh: "อุโมงค์มีเส้นผ่านศูนย์กลาง 5 เมตร ยาวประมาณ 5.11 กม. และมีขีดความสามารถในการระบายน้ำ 60 ลบ.ม./วินาที",
    quoteEnTranslation: "The tunnel is 5 m in diameter, about 5.11 km long, with a drainage capacity of 60 m³/s. (translation by this project)",
    attribution: "Thai PBS, citing the BMA DDS 2569 flood action plan",
    sourceKey: "thaipbs2026",
    caveats: [],
  },
  {
    id: "bkk-tunnel-bang-sue-pump-60m3s",
    cityId: "bangkok",
    topic: "tunnel-capacity",
    subject: "Khlong Bang Sue tunnel (อุโมงค์ใต้คลองบางซื่อ), Ø5 m, ~6.40 km — outlet pumping station",
    value: 60,
    unit: "m³/s",
    valueType: "stated-capacity",
    quoteTh: "พร้อมสถานีสูบน้ำบริเวณปลายอุโมงค์กำลังสูบ 60 ลบ.ม./วินาที",
    quoteEnTranslation: "With a pumping station at the tunnel outlet of 60 m³/s. (translation by this project)",
    attribution: "Thai PBS, citing the BMA DDS 2569 flood action plan",
    sourceKey: "thaipbs2026",
    caveats: ["Capacity stated for the outlet pumping station."],
  },
  {
    id: "bkk-tunnel-bueng-nong-bon-pump-60m3s",
    cityId: "bangkok",
    topic: "tunnel-capacity",
    subject: "Bueng Nong Bon – Chao Phraya tunnel (อุโมงค์บึงหนองบอนลงสู่แม่น้ำเจ้าพระยา), Ø5 m, ~9.20 km — Bang O pumping station",
    value: 60,
    unit: "m³/s",
    valueType: "stated-capacity",
    quoteTh: "สถานีสูบน้ำอุโมงค์บางอ้อกำลังสูบ 60 ลบ.ม./วินาที",
    quoteEnTranslation: "Bang O tunnel pumping station: 60 m³/s. (translation by this project)",
    attribution: "Thai PBS, citing the BMA DDS 2569 flood action plan",
    sourceKey: "thaipbs2026",
    caveats: ["Capacity stated for the outlet pumping station."],
  },
  {
    id: "bkk-tunnels-8-planned-370m3s",
    cityId: "bangkok",
    topic: "tunnel-capacity",
    subject: "8 planned large drainage tunnels (~55.32 km)",
    value: 370,
    unit: "m³/s",
    valueType: "design-target",
    quoteTh: "กรุงเทพมหานครมีแผนดำเนินการก่อสร้างอุโมงค์ระบายน้ำขนาดใหญ่อีก 8 แห่ง รวมความยาวประมาณ 55.32 กม. และมีประสิทธิภาพการระบายน้ำรวม 370 ลบ.ม./วินาที",
    quoteEnTranslation: "Bangkok plans to build 8 more large drainage tunnels, about 55.32 km in total, with a combined drainage capacity of 370 m³/s. (translation by this project)",
    attribution: "Thai PBS, citing the BMA DDS 2569 flood action plan",
    sourceKey: "thaipbs2026",
    caveats: ["Planned (5 under construction, 3 awaiting FY2027 budget per the article); not operational capacity."],
  },
  {
    id: "bkk-tunnels-4-operational-195m3s-2025",
    cityId: "bangkok",
    topic: "tunnel-capacity",
    subject: "4 fully operating tunnels in mid-2025 (Prem Prachakorn, Makkasan, Rama 9, Bang Sue)",
    value: 195,
    unit: "m³/s",
    valueType: "combined-capacity",
    quoteTh: "ความสามารถในการระบายน้ำรวม 195 ลบ.ม. ต่อวินาที",
    quoteEnTranslation: "Combined drainage capacity of 195 m³/s. (translation by this project)",
    attribution: "ThaiPublica summary of Attasit Petchmeesri's talk (7 Jun 2025)",
    sourceKey: "thaipublica2025",
    caveats: ["Mid-2025 figure before the Bueng Nong Bon tunnel was added; consistent with 30+45+60+60 = 195."],
  },
  {
    id: "bkk-pumping-1300m3s-2025",
    cityId: "bangkok",
    topic: "pumping-capacity",
    subject: "Total pumping capacity to the Chao Phraya, both banks",
    value: 1300,
    unit: "m³/s",
    valueType: "stated-capacity",
    quoteTh: "กำลังสูบน้ำออกแม่น้ำเจ้าพระยาทั้งสองฝั่งรวมกัน 1,300 ลบ.ม.ต่อวินาที",
    quoteEnTranslation: "Combined pumping capacity out to the Chao Phraya on both banks is 1,300 m³/s. (translation by this project)",
    attribution: "Attasit Petchmeesri, adviser to the Bangkok Governor (7 Jun 2025)",
    sourceKey: "thaipublica2025",
    caveats: ["Nominal installed capacity; effective capacity depends on canal levels, river stage and pump availability."],
  },
  {
    id: "bkk-rang-o-rang-kaeo-100mmh-target",
    cityId: "bangkok",
    topic: "design-rainfall-target",
    subject: "Khlong Rang O – Rang Kaeo drainage project, western Bang Khen (~3 km²)",
    value: 100,
    unit: "mm/h",
    valueType: "project-target",
    quoteTh: "เพิ่มประสิทธิภาพในการระบายน้ำพื้นที่เขตบางเขนให้สามารถรองรับปริมาณน้ำได้ไม่น้อยกว่า 100 มม./ชั่วโมง",
    quoteEnTranslation: "Improve drainage in Bang Khen district so that it can handle not less than 100 mm/hour. (translation by this project)",
    attribution: "BMA press release on Deputy Governor Wisanu Subsompon's site visit, 16 Sep 2025",
    sourceKey: "bmapr2025",
    caveats: ["Local project target for one sub-catchment, not citywide; project was under construction at the time (completion expected Q1 2569 = early 2026 per the release)."],
  },
  {
    id: "hy-r1-canal-1200m3s",
    cityId: "hatyai",
    topic: "canal-capacity",
    subject: "RID flood diversion canal R.1 (คลองระบายน้ำ ร.1) — Hat Yai flood relief project phase 2",
    value: 1200,
    unit: "m³/s",
    valueType: "stated-capacity",
    quoteTh: "การปรับปรุงคลองระบายน้ำ ร.1 เพื่อเพิ่มประสิทธิภาพการระบายน้ำจากเดิมระบายน้ำได้ 465  ลบ.ม. ต่อวินาที เพิ่มเป็น 1,200 ลบ.ม. ต่อวินาที",
    quoteEnTranslation: "Improving drainage canal R.1 raises its capacity from 465 m³/s to 1,200 m³/s. (translation by this project)",
    attribution: "Royal Irrigation Department, reported by ONEP, 12 Feb 2020",
    sourceKey: "onep2020",
    caveats: ["Design capacity after the phase-2 works; R.1 was damaged in the 2025 floods (see status statement)."],
  },
  {
    id: "hy-r1-plus-u-taphao-1665m3s",
    cityId: "hatyai",
    topic: "canal-capacity",
    subject: "R.1 diversion canal + Khlong U-Taphao (คลองอู่ตะเภา) combined",
    value: 1665,
    unit: "m³/s",
    valueType: "combined-capacity",
    quoteTh: "เมื่อระบายน้ำร่วมกับคลองอู่ตะเภาในอัตรา 465 ลบ.ม. ต่อวินาที จะสามารถเพิ่มศักยภาพในการระบายน้ำได้สูงสุดรวมกันประมาณ 1,665 ลบ.ม. ต่อวินาที",
    quoteEnTranslation: "Together with Khlong U-Taphao at 465 m³/s, the maximum combined drainage potential is about 1,665 m³/s. (translation by this project)",
    attribution: "Royal Irrigation Department, reported by ONEP, 12 Feb 2020",
    sourceKey: "onep2020",
    caveats: ["River/canal conveyance at basin scale, not the municipal street-drainage design intensity."],
  },
  {
    id: "hy-r1-repair-status-2026",
    cityId: "hatyai",
    topic: "status",
    subject: "R.1 diversion canal repair after the 2025 floods",
    value: null,
    unit: null,
    valueType: "status",
    quoteTh: "เพื่อให้คลองระบายน้ำ ร.1 สามารถกลับมาระบายน้ำได้อย่างเต็มศักยภาพภายในเดือนพฤศจิกายน 2569",
    quoteEnTranslation: "So that canal R.1 can return to full drainage capacity by November 2026. (translation by this project)",
    attribution: "Suriya Juangroongruangkit, Minister of Agriculture and Cooperatives, reported 13 Aug 2026",
    sourceKey: "dailynews2026",
    caveats: ["Status on 13 Aug 2026 (contract signing expected 18 Aug 2026); completion not verified by this project."],
  },
];
const UNKNOWNS = [
  { cityId: "hatyai", topic: "design-rainfall-intensity", subject: "Hat Yai Municipality street/stormwater drainage design intensity (mm/h)", status: "unknown", note: "No verifiable public figure found (searched Thai news and municipality pages, Nov 2026). Basin-scale canal capacities (R.1, U-Taphao) are listed instead." },
  { cityId: "bangkok", topic: "design-rainfall-intensity", subject: "Official BMA design document stating the citywide current design intensity", status: "not retrieved", note: "The 60 mm/h figure is verified only via media quotes of BMA officials; the DDS 2569 action-plan book (~161 MB PDF) was not downloaded, and pr-bangkok.com/?p=373537 (a 2024 BMA release reported by search results to mention 60 mm) returned HTTP 404." },
];

async function sectionDrainage() {
  console.log("\n== Section 4: drainage capacity statements");
  const pages: Record<string, { text: string; retrievedAt: string | null; ok: boolean; fromCache: boolean }> = {};
  for (const [k, s] of Object.entries(DRAINAGE_SOURCES)) {
    const f = await fetchRaw({ id: `drainage-src-${k}`, url: s.url, cacheFile: path.join(RAW, s.cacheFile), mode: "cache-first" });
    pages[k] = { text: f.ok && f.body ? stripHtml(f.body.toString("utf8")) : "", retrievedAt: f.retrievedAt, ok: f.ok, fromCache: f.fromCache };
  }
  // HEAD the primary BMA action-plan PDF (not downloaded: ~161 MB).
  // The last successful HEAD result is persisted so that --offline rebuilds report it instead of the older manual record.
  const planHeadFile = path.join(RAW, "bma-dds/action_plan_2569_head.json");
  let planHead: Record<string, unknown> = readJson<Record<string, unknown>>(planHeadFile) ?? { url: "https://ebooks.dds.bangkok.go.th/ebook_files/2026/0000059_2.pdf", checkedAt: "2026-11-03T18:18:39Z", contentLength: 161119984, lastModified: "Thu, 28 May 2026 03:32:50 GMT", note: "HEAD result recorded during manual investigation" };
  if (!OFFLINE) {
    try {
      await politeWait("ebooks.dds.bangkok.go.th", 1100);
      const r = await fetch(String(planHead.url), { method: "HEAD", headers: { "User-Agent": UA } });
      if (r.ok) {
        planHead = { url: planHead.url, checkedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"), contentLength: Number(r.headers.get("content-length")), lastModified: r.headers.get("last-modified"), note: "HTTP HEAD only; file not downloaded" };
        writeJson(planHeadFile, planHead);
      }
    } catch {
      /* keep recorded values */
    }
  }
  const statements = STATEMENTS.map((s) => {
    const src = DRAINAGE_SOURCES[s.sourceKey];
    const page = pages[s.sourceKey];
    const verified = page.ok && normSpace(page.text).includes(normSpace(s.quoteTh));
    return {
      ...s,
      source: { url: src.url, publisher: src.publisher, title: src.title, publishedAt: src.publishedAt, sourceType: src.sourceType, retrievedAt: page.retrievedAt, rawFile: `data/raw/${src.cacheFile}` },
      quoteVerifiedInRetrievedPage: verified,
    };
  });
  const out = {
    note: "Verifiable public statements about drainage capacity. Values are as stated by the cited source; no value is inferred. English translations are by this project; the Thai quote is authoritative.",
    statements,
    unknowns: UNKNOWNS,
    primaryDocumentNotRetrieved: { title: "หนังสือแผนปฏิบัติการป้องกันและแก้ไขปัญหาน้ำท่วมกรุงเทพมหานคร ประจำปี 2569 (BMA Drainage and Sewerage Department)", ...planHead },
  };
  writeJson(path.join(STAGED, "drainage-capacity.json"), out);
  summary.drainage = {
    statements: statements.length,
    verified: statements.filter((s) => s.quoteVerifiedInRetrievedPage).length,
    unverified: statements.filter((s) => !s.quoteVerifiedInRetrievedPage).map((s) => s.id),
    pages: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, { ok: v.ok, retrievedAt: v.retrievedAt }])),
    planHead,
  };
  console.log(`  ${statements.filter((s) => s.quoteVerifiedInRetrievedPage).length}/${statements.length} quotes verified in retrieved pages`);
}

// ---------------------------------------------------------------------------------------------
// Section 5: BMA open data (CKAN) — monthly district rainfall 2023 (supporting, observed)
// ---------------------------------------------------------------------------------------------
async function sectionCkan() {
  console.log("\n== Section 5: BMA CKAN monthly district rainfall (supporting)");
  const pkg = await fetchRaw({
    id: "bma-ckan-package-rainfall",
    url: URLS.bmaCkanPkg,
    cacheFile: path.join(RAW, "ckan/bma_ckan_package_rainfall.json"),
    mode: "cache-first",
    validate: (b) => {
      try {
        return JSON.parse(b.toString("utf8")).success ? null : "CKAN success=false";
      } catch {
        return "not JSON";
      }
    },
  });
  if (!pkg.ok || !pkg.body) {
    summary.ckan = { error: pkg.error };
    return;
  }
  const meta = JSON.parse(pkg.body.toString("utf8")).result;
  const resource = (meta.resources as { url: string; name: string; format: string; last_modified?: string; created?: string }[]).find((r) => /csv/i.test(r.format));
  if (!resource) {
    summary.ckan = { error: "no CSV resource" };
    return;
  }
  const csv = await fetchRaw({ id: "bma-ckan-rainfall-csv", url: resource.url, cacheFile: path.join(RAW, "ckan", path.basename(new URL(resource.url).pathname)), mode: "cache-first" });
  if (!csv.ok || !csv.body) {
    summary.ckan = { error: csv.error };
    return;
  }
  // The CSV is TIS-620 / Windows-874 encoded (Thai). Decode explicitly to UTF-8.
  let text = csv.body.toString("utf8");
  let encoding = "utf-8";
  if (text.includes("�")) {
    text = new TextDecoder("windows-874").decode(csv.body);
    encoding = "TIS-620/Windows-874 (decoded with TextDecoder('windows-874'))";
    writeText(path.join(RAW, "ckan", path.basename(new URL(resource.url).pathname).replace(/\.csv$/, ".utf8.csv")), text);
  }
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(","));
  const header = rows.shift();
  const byDistrict = new Map<string, Map<number, number | null>>();
  const monthsSeen = new Set<number>();
  for (const r of rows) {
    const d = r[0].trim();
    const m = Number(r[1]);
    const v = r[2] === undefined || r[2].trim() === "" ? null : Number(r[2]);
    monthsSeen.add(m);
    if (!byDistrict.has(d)) byDistrict.set(d, new Map());
    byDistrict.get(d)!.set(m, v !== null && Number.isFinite(v) ? v : null);
  }
  const months = [...monthsSeen].sort((a, b) => a - b);
  const yearMatch = /(\d{4})\.csv$/.exec(resource.url);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const districts = [...byDistrict.entries()].map(([nameTh, mm]) => {
    const vals = months.map((m) => mm.get(m) ?? null);
    const tot = vals.every((v) => v !== null) ? r1(vals.reduce((a: number, v) => a + (v as number), 0)) : null;
    return {
      nameTh,
      monthlyMm: vals.map((v) => (v === null ? null : rN(v, 2))),
      periodTotal: {
        value: tot,
        unit: "mm",
        provenance: {
          status: tot === null ? "unavailable" : "derived",
          sourceId: "bma-ckan-rainfall-district",
          sourceUrl: resource.url,
          observedFrom: year ? `${year}-${String(months[0]).padStart(2, "0")}-01` : undefined,
          observedTo: year ? isoDate(new Date(Date.UTC(year, months[months.length - 1], 0))) : undefined,
          referenceYear: year ?? undefined,
          geographicScope: `Bangkok district ${nameTh} (one value per district as published)`,
          methodology: `Sum of the published monthly accumulated rainfall for months ${months.join(",")} of ${year} (partial year).`,
          limitations: ["Partial year only (months listed)", "Station-to-district assignment not published in the CSV"],
        } satisfies DataProvenance,
      } satisfies MetricValue,
    };
  });
  writeJson(path.join(STAGED, "bma-district-rainfall-2023.json"), {
    note: "Observed monthly accumulated rainfall per Bangkok district as published by the BMA Drainage and Sewerage Department on data.bangkok.go.th. PARTIAL YEAR — not an annual total. District names are Thai only in the source.",
    source: {
      sourceId: "bma-ckan-rainfall-district",
      datasetUrl: "https://data.bangkok.go.th/dataset/rainfall",
      packageApi: URLS.bmaCkanPkg,
      resourceUrl: resource.url,
      title: meta.title,
      publisher: meta.organization?.title ?? "สำนักการระบายน้ำ",
      license: meta.license_title,
      metadataModified: meta.metadata_modified,
      resourceLastModified: resource.last_modified ?? resource.created ?? null,
      retrievedAt: csv.retrievedAt,
      encoding,
      header,
    },
    year,
    months,
    unit: "mm",
    districts,
  });
  summary.ckan = { year, months, districts: districts.length, license: meta.license_title, retrievedAt: csv.retrievedAt, encoding };
  console.log(`  ${districts.length} districts, months ${months.join(",")} of ${year}`);
}

// ---------------------------------------------------------------------------------------------
// Sources + notes
// ---------------------------------------------------------------------------------------------
function lastRetrieved(id: string) {
  const r = [...FETCH_LOG].reverse().find((f) => f.id === id);
  return r?.retrievedAt ?? undefined;
}
function buildSources(): SourceRef[] {
  const S = summary as Record<string, any>;
  const st = S.stations ?? {};
  const om = S.openmeteo ?? {};
  const no = S.normals ?? {};
  const dr = S.drainage ?? {};
  const ck = S.ckan ?? {};
  const pageAt = (k: string) => dr.pages?.[k]?.retrievedAt ?? undefined;
  const list: SourceRef[] = [
    {
      id: "thaiwater-public-rain24h",
      nameTh: "คลังข้อมูลน้ำแห่งชาติ (ThaiWater) — ฝน 24 ชั่วโมง",
      nameEn: "HII ThaiWater public API — 24-hour rainfall at telemetry stations",
      url: URLS.thaiwater,
      publisher: "Hydro-Informatics Institute (HII, สสน.), aggregating BMA, TMD, RID, DWR, DDPM, HII, EGAT and other agencies",
      license: "No licence stated on the public API or front-end; attribute ThaiWater/HII and the originating agency.",
      retrievedAt: st.thaiwater?.retrievedAt ?? undefined,
      accessStatus: st.thaiwater?.ok ? "retrieved" : "failed",
      notes: `Unauthenticated public endpoint used by www.thaiwater.net. ${st.thaiwater?.records ?? "?"} station records; snapshot. ${st.thaiwater?.fromCache ? "Served from cache: " + (st.thaiwater?.error ?? "") : ""}`.trim(),
    },
    {
      id: "bma-dds-weather-rain",
      nameTh: "สำนักการระบายน้ำ กรุงเทพมหานคร — ระบบตรวจวัดปริมาณฝน",
      nameEn: "BMA Drainage and Sewerage Department — weather.bangkok.go.th rain gauges",
      url: URLS.bmaWeather,
      publisher: "Bangkok Metropolitan Administration, Drainage and Sewerage Department",
      license: "© BMA Drainage and Sewerage Department (page footer); no open licence stated.",
      retrievedAt: st.bmaWeather?.retrievedAt ?? undefined,
      accessStatus: st.bmaWeather?.ok ? "retrieved" : "failed",
      notes: `Station arrays embedded in the public HTML (no JSON API, no authentication). ${st.bmaWeather?.stationsParsed ?? "?"} stations parsed; column 12 = “ฝนสะสม 24 ชั่วโมง”.`,
    },
    {
      id: "tmd-aeromet2-daily-rainfall",
      nameTh: "กรมอุตุนิยมวิทยา กองอุตุนิยมวิทยาการบิน — รายงานปริมาณน้ำฝนรายวันบริเวณท่าอากาศยาน",
      nameEn: "TMD Aeronautical Meteorological Division — airport daily rainfall report",
      url: URLS.aeromet2Report,
      publisher: "Thai Meteorological Department",
      license: "© Thai Meteorological Department; no open licence stated.",
      retrievedAt: st.aeromet2?.retrievedAt ?? undefined,
      accessStatus: st.aeromet2?.ok ? "partial" : "failed",
      notes: "JSON endpoint behind https://aeromet2.tmd.go.th/reports/daily-rainfall (robots.txt allows /). Used only in data/staged/tmd-airport-daily-rain.json: the report publishes no coordinates, so it is not in stations.json.",
    },
    {
      id: "tmd-opendata-api",
      nameEn: "TMD open data API (data.tmd.go.th)",
      url: URLS.tmdOpenData,
      publisher: "Thai Meteorological Department",
      retrievedAt: st.tmdOpenData?.attemptedAt ?? undefined,
      accessStatus: "failed",
      notes: `Requires uid/ukey credentials; a request without them (attempted ${st.tmdOpenData?.attemptedAt ?? "?"}) returned HTTP ${st.tmdOpenData?.status ?? "?"} with an empty body. Not used (task rule: only if no key is required). retrievedAt here = attempt time.`,
    },
    {
      id: "open-meteo-archive-era5",
      nameEn: "Open-Meteo Historical Weather API — ECMWF ERA5 reanalysis (models=era5), daily and hourly precipitation",
      url: URLS.openMeteo,
      publisher: "Open-Meteo.com; underlying data: ECMWF ERA5 reanalysis, Copernicus Climate Change Service (C3S)",
      license: "CC BY 4.0 (Open-Meteo API data; attribution “Weather data by Open-Meteo.com”); contains modified Copernicus Climate Change Service information. Free tier: non-commercial use, 10 000 calls/day.",
      retrievedAt: om.retrievedRange?.[1] ?? undefined,
      accessStatus: om.error ? "failed" : Object.values<any>(om.grids ?? {}).some((g) => g?.error) ? "partial" : "retrieved",
      notes:
        `Used for public/data/{bangkok,hatyai}/rain-grid.json and data/staged/rain-hourly-events.json. Model ${OM_MODEL_DESC.name}; ${OM_MODEL_DESC.resolution}. Period ${om.period?.start ?? "?"}..${om.period?.end ?? "?"} (${om.period?.rule ?? "?"}). ` +
        `Distinct ERA5 cells: Bangkok ${om.grids?.bangkok?.distinctModelCells ?? "?"} for ${om.grids?.bangkok?.points ?? "?"} lattice points, Hat Yai ${om.grids?.hatyai?.distinctModelCells ?? "?"} for ${om.grids?.hatyai?.points ?? "?"}. ` +
        `Raw requests retrieved ${om.retrievedRange?.[0] ?? "?"} … ${om.retrievedRange?.[1] ?? "?"}.`,
    },
    {
      id: "open-meteo-archive-best-match",
      nameEn: "Open-Meteo Historical Weather API — models=best_match (comparison only; = ECMWF IFS for precipitation on the checked windows)",
      url: URLS.openMeteo,
      publisher: "Open-Meteo.com (ECMWF IFS operational archive)",
      license: "CC BY 4.0 (Open-Meteo API data); attribution “Weather data by Open-Meteo.com”.",
      retrievedAt: lastRetrieved(`open-meteo-centres-daily-${OM_MODEL}-${OM_CMP_MODEL}`),
      accessStatus: lastRetrieved(`open-meteo-centres-daily-${OM_MODEL}-${OM_CMP_MODEL}`) ? "retrieved" : "failed",
      notes: `NOT used in any published value. Only for the model-identity checks and the city-centre comparison in data/staged/rain-grid-meta.json. ${om.bestMatchIsEcmwfIfsOnAllChecks ? "best_match precipitation was identical to models=ecmwf_ifs (operational IFS analysis/short-range forecast archive, ~9 km) on all checked windows — not a reanalysis." : ""} An earlier draft of the grids used best_match; those raw files remain in data/raw/open-meteo/grid_*_best_match_* and are superseded.`,
    },
    {
      id: "open-meteo-archive-era5-land",
      nameEn: "Open-Meteo Historical Weather API — models=era5_land (precipitation)",
      url: URLS.openMeteoDocs,
      publisher: "Open-Meteo.com",
      license: "CC BY 4.0",
      retrievedAt: om.era5LandCheck?.retrievedAt ?? lastRetrieved("open-meteo-era5_land-precip-check"),
      accessStatus: om.era5LandPrecipitationAvailable ? "retrieved" : "failed",
      notes: om.era5LandPrecipitationAvailable ? "Precipitation present in the check request, but models=era5 is used for all outputs." : "HTTP 200 but precipitation_sum is null for every day of the check window: Open-Meteo does not serve ERA5-Land precipitation (ERA5-Land is forced by ERA5 precipitation). Not used; models=era5 used instead.",
    },
    {
      id: "tmd-climate-normals-1991-2020",
      nameTh: "สถิติภูมิอากาศของประเทศไทยในคาบ 30 ปี (พ.ศ.2534-2563)",
      nameEn: "TMD Climatological Data of Thailand for 30 Year Period (1991-2020), Meteorological Data report No. 551.586-13-2023",
      url: URLS.tmdNormalsPdf,
      publisher: "Thai Meteorological Department",
      license: "© Thai Meteorological Department; no open licence stated.",
      retrievedAt: no.pdf?.retrievedAt ?? undefined,
      accessStatus: no.pdf?.ok ? "retrieved" : "failed",
      notes: "PDF hosted on ubonmet.tmd.go.th; station pages for BANGKOK METROPOLIS (48455) and HAT YAI AIRPORT (48569) parsed from the PDF text layer.",
    },
    {
      id: "tmd-weather-criteria",
      nameTh: "กรมอุตุนิยมวิทยา — เกณฑ์อากาศ (เกณฑ์ปริมาณฝน)",
      nameEn: "TMD weather criteria page — rainfall amount classes",
      url: URLS.tmdCriteria,
      publisher: "Thai Meteorological Department – Weather Forecast Division",
      license: "© Thai Meteorological Department; no open licence stated.",
      retrievedAt: no.criteria?.retrievedAt ?? undefined,
      accessStatus: no.criteria?.ok ? "retrieved" : "failed",
      notes: "Light 0.1–10.0, moderate 10.1–35.0, heavy 35.1–90.0, very heavy >= 90.1 mm.",
    },
    {
      id: "thaipublica-2025-06-08-bma-adviser",
      nameEn: "ThaiPublica (2025-06-08): BMA adviser Attasit Petchmeesri on Bangkok drainage",
      url: DRAINAGE_SOURCES.thaipublica2025.url,
      publisher: "ThaiPublica",
      license: "© ThaiPublica; short quotations for citation only.",
      retrievedAt: pageAt("thaipublica2025"),
      accessStatus: dr.pages?.thaipublica2025?.ok ? "retrieved" : "failed",
      notes: "60 mm/h citywide capacity statement; 1,300 m³/s pumping; 195 m³/s for 4 tunnels.",
    },
    {
      id: "thaipbs-2016-06-21-drainage-limit",
      nameEn: "Thai PBS (2016-06-21): Bangkok drainage pipe limit 60 mm/h",
      url: DRAINAGE_SOURCES.thaipbs2016.url,
      publisher: "Thai PBS",
      license: "© Thai PBS; short quotations for citation only.",
      retrievedAt: pageAt("thaipbs2016"),
      accessStatus: dr.pages?.thaipbs2016?.ok ? "retrieved" : "failed",
    },
    {
      id: "thaipbs-2026-09-30-bma-tunnels",
      nameEn: "Thai PBS (2026-09-30): BMA drainage tunnel plan (citing the DDS 2569 flood action plan)",
      url: DRAINAGE_SOURCES.thaipbs2026.url,
      publisher: "Thai PBS",
      license: "© Thai PBS; short quotations for citation only.",
      retrievedAt: pageAt("thaipbs2026"),
      accessStatus: dr.pages?.thaipbs2026?.ok ? "retrieved" : "failed",
      notes: "Tunnel capacities (30/45/60/60/60 m³/s; total 255), planned 370 m³/s, 76 mm/h & 104 mm/day target.",
    },
    {
      id: "bma-dds-flood-action-plan-2569",
      nameTh: "หนังสือแผนปฏิบัติการป้องกันและแก้ไขปัญหาน้ำท่วมกรุงเทพมหานคร ประจำปี 2569",
      nameEn: "BMA DDS flood prevention action plan 2026 (book, PDF)",
      url: "https://ebooks.dds.bangkok.go.th/ebook_files/2026/0000059_2.pdf",
      publisher: "BMA Drainage and Sewerage Department",
      accessStatus: "manual-reference",
      notes: `Primary document behind the Thai PBS figures. Not downloaded (HEAD: ${dr.planHead?.contentLength ?? "?"} bytes, Last-Modified ${dr.planHead?.lastModified ?? "?"}).`,
    },
    {
      id: "bma-pr-2025-09-16-rang-o",
      nameEn: "BMA PR (2025-09-16): Khlong Rang O – Rang Kaeo drainage project (≥100 mm/h target)",
      url: DRAINAGE_SOURCES.bmapr2025.url,
      publisher: "BMA Public Relations Office",
      license: "© BMA; no open licence stated.",
      retrievedAt: pageAt("bmapr2025"),
      accessStatus: dr.pages?.bmapr2025?.ok ? "retrieved" : "failed",
    },
    {
      id: "bma-pr-373537",
      nameEn: "BMA PR article pr-bangkok.com/?p=373537 (reported by web search to mention rainfall above 60 mm)",
      url: "https://pr-bangkok.com/?p=373537",
      publisher: "BMA Public Relations Office",
      accessStatus: "failed",
      notes: "HTTP 404 on 2026-11-03 (curl and WebFetch). Not used.",
    },
    {
      id: "onep-2020-02-12-hatyai-r1",
      nameEn: "ONEP (2020-02-12): RID Hat Yai flood relief project — R.1 canal 465→1,200 m³/s",
      url: DRAINAGE_SOURCES.onep2020.url,
      publisher: "Office of Natural Resources and Environmental Policy and Planning (reporting the Royal Irrigation Department)",
      license: "© ONEP; no open licence stated.",
      retrievedAt: pageAt("onep2020"),
      accessStatus: dr.pages?.onep2020?.ok ? "retrieved" : "failed",
    },
    {
      id: "dailynews-2026-08-13-r1-repair",
      nameEn: "Daily News (2026-08-13): R.1 canal repair after the 2025 floods",
      url: DRAINAGE_SOURCES.dailynews2026.url,
      publisher: "Daily News",
      license: "© Daily News; short quotations for citation only.",
      retrievedAt: pageAt("dailynews2026"),
      accessStatus: dr.pages?.dailynews2026?.ok ? "retrieved" : "failed",
    },
    {
      id: "bma-ckan-rainfall-district",
      nameTh: "ข้อมูลปริมาณฝนรายเดือนในพื้นที่กรุงเทพมหานครจำแนกตามพื้นที่เขต",
      nameEn: "BMA open data: monthly rainfall by Bangkok district",
      url: "https://data.bangkok.go.th/dataset/rainfall",
      publisher: "BMA Drainage and Sewerage Department (data.bangkok.go.th)",
      license: ck.license ?? "Creative Commons Attributions",
      retrievedAt: ck.retrievedAt ?? undefined,
      accessStatus: ck.error ? "failed" : "partial",
      notes: `Only ${ck.year ?? "?"} months ${(ck.months ?? []).join(",")} are published (partial year). TIS-620 CSV converted to UTF-8. Staged in data/staged/bma-district-rainfall-2023.json.`,
    },
  ];
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

function fmt(v: unknown) {
  return v === null || v === undefined ? "n/a" : String(v);
}
function buildNotes(sources: SourceRef[]): string {
  const S = summary as Record<string, any>;
  const st = S.stations ?? {};
  const om = S.openmeteo ?? {};
  const no = S.normals ?? {};
  const dr = S.drainage ?? {};
  const ck = S.ckan ?? {};
  const L: string[] = [];
  L.push("# Rainfall and drainage-capacity context — Bangkok and Hat Yai");
  L.push("");
  L.push(`Generated by \`${SCRIPT_REL}\` (run: \`npx tsx ${SCRIPT_REL}\`; add \`--offline\` to rebuild only from \`data/raw/\`). Raw downloads live in \`data/raw/<source>/\` with \`*.meta.json\` siblings (URL, HTTP status, retrieval time). Fetch log: \`data/raw/fetch-log-rainfall.json\`.`);
  L.push("");
  L.push("## 1. Observed station snapshots (`public/data/{bangkok,hatyai}/stations.json`)");
  L.push("");
  L.push("These are **snapshots** of near-real-time telemetry, labelled `status: \"observed\"`, with the reading time exactly as published in `observedAt` (converted to ISO with +07:00) and quoted verbatim in `provenance.methodology`. Values change every few minutes; they are not daily (07:00–07:00) totals and are not quality-controlled.");
  L.push("");
  L.push("| Source | Result | Retrieved (UTC) | Notes |");
  L.push("|---|---|---|---|");
  L.push(`| ThaiWater \`${URLS.thaiwater}\` | ${st.thaiwater?.ok ? "OK" : "FAILED"} (HTTP ${fmt(st.thaiwater?.status)})${st.thaiwater?.fromCache ? ", cached" : ""} | ${fmt(st.thaiwater?.retrievedAt)} | ${fmt(st.thaiwater?.records)} station records nationwide. Public, unauthenticated; same endpoint the www.thaiwater.net front-end calls. Definition (front-end tooltip): “ปริมาณฝนสะสมตั้งแต่เวลาปัจจุบันย้อนหลังไป 24 ชั่วโมง” = rolling 24 h ending at \`rainfall_datetime\`. Other public endpoints found in the front-end bundle: rain_today (07:00→now), rain_yesterday (07:00→07:00), rain_monthly, rain_yearly, rain7day_forecast. |`);
  L.push(`| BMA \`${URLS.bmaWeather}\` | ${st.bmaWeather?.ok ? "OK" : "FAILED"} (HTTP ${fmt(st.bmaWeather?.status)})${st.bmaWeather?.fromCache ? ", cached" : ""} | ${fmt(st.bmaWeather?.retrievedAt)} | No JSON API is exposed; station data are server-rendered into JS arrays (\`locationsrain\`) in the public HTML. Column meanings taken from the page's own popup code: [5] latest time (dd/mm/BE yyyy), [12] “ฝนสะสม 24 ชั่วโมง”, [16] code, [18] English name. ${fmt(st.bmaWeather?.stationsParsed)} stations parsed. No authentication involved. |`);
  L.push(`| TMD aeromet2 \`${URLS.aeromet2Report}\` | ${st.aeromet2?.ok ? "OK" : "FAILED"} (HTTP ${fmt(st.aeromet2?.status)})${st.aeromet2?.fromCache ? ", cached" : ""} | ${fmt(st.aeromet2?.retrievedAt)} | Airport daily rainfall, 07:00→07:00, report date ${fmt(st.aeromet2?.report?.date)} (period ${fmt(st.aeromet2?.report?.periodStart)}→${fmt(st.aeromet2?.report?.periodEnd)}). No coordinates in the report → staged only in \`data/staged/tmd-airport-daily-rain.json\` (VTBD, VTBS, VTSS). The data-entry endpoints of the same API need an unlock code and were not touched. |`);
  L.push(`| TMD open data \`${URLS.tmdOpenData}\` | not used | ${fmt(st.tmdOpenData?.attemptedAt)} (attempt) | Requires \`uid\`/\`ukey\`; without them HTTP ${fmt(st.tmdOpenData?.status)} and an empty body. Skipped per the "no key" rule. |`);
  L.push("");
  for (const c of ["bangkok", "hatyai"]) {
    const x = st.cities?.[c];
    if (!x) continue;
    L.push(`**${c}** — ${x.count} stations (${x.insideCoreBbox} inside the city bbox, rest within the ${STATION_BUFFER_DEG}° buffer \`${JSON.stringify(x.stationBufferBbox)}\`); by agency prefix: ${Object.entries(x.byAgency).map(([k, v]) => `${k} ${v}`).join(", ")}. Excluded: ${JSON.stringify(x.excluded)}. Reading times ${fmt(x.observedAtRange?.[0])} … ${fmt(x.observedAtRange?.[1])}. Max 24 h value ${fmt(x.max24hMm)} mm.`);
    L.push("");
  }
  if (st.bmaVsThaiwater) {
    const b = st.bmaVsThaiwater;
    L.push(`Cross-check BMA page vs ThaiWater (BMA agency records): ${b.matchedCodes} codes matched, ${b.coordinateDifferences} coordinate differences (>1e-4°), ${b.valueDifferencesOver0_05mm} 24 h value differences (>0.05 mm; timestamps differ by up to ~1 h). Only on the BMA page: ${(b.onlyOnBmaPage ?? []).join(", ") || "none"}. For Bangkok, BMA stations are taken directly from the BMA page (agency source) and the ThaiWater copies are dropped; all other agencies come from ThaiWater.`);
    L.push("");
  }
  L.push("Station ids: `<agency>-<published station code>` (e.g. `bma-RF.KTY.01`, `tmd-48455`, `hii-BKK021`). Where no English name is published (DWR/RID/DDPM gauges), `nameEn` is composed from the code and the published sub-district/district/province names and a limitation says so. A TMD value of 0.01 mm is kept as published (below gauge resolution; appears to encode trace).");
  L.push("");
  L.push("## 2. Modelled gridded precipitation — ERA5 reanalysis (`public/data/{city}/rain-grid.json`)");
  L.push("");
  const ag = om.aggregationCheck;
  L.push(`- **Model used for every published value (both cities, grids and hourly events): \`models=${fmt(om.model)}\` = ${OM_MODEL_DESC.name}; ${OM_MODEL_DESC.resolution}.** RainSeries \`kind: "reanalysis-grid"\`, provenance \`status: "estimated"\`, \`sourceId: "${OM_SOURCE_ID}"\`.`);
  L.push(`- **Period**: ${fmt(om.period?.start)} → ${fmt(om.period?.end)} (${fmt(om.period?.days)} days). Rule: ${fmt(om.period?.rule)} Determined ${fmt(om.period?.determinedAt)}; persisted in \`data/raw/open-meteo/period_${OM_MODEL}.json\` so reruns are deterministic (\`--refresh-period\` re-probes, \`--end-date=\` pins). ERA5 latency: ${OM_MODEL_DESC.latency}.`);
  L.push("- **Why ERA5 (model decision)**:");
  L.push(`  - \`models=era5_land\` (the brief's first choice): HTTP 200 but \`precipitation_sum\` = null for every day of the check window (${om.era5LandPrecipitationAvailable ? "UNEXPECTED: precipitation present" : "confirmed"}). Open-Meteo does not serve ERA5-Land precipitation (ERA5-Land is forced by ERA5 precipitation).`);
  L.push(`  - \`models=best_match\` (the brief's fallback) compared with \`models=ecmwf_ifs\` and \`models=era5\` on ${(om.modelIdentityChecks ?? []).length} windows: ${(om.modelIdentityChecks ?? []).map((x: any) => `${x.window?.id}: =IFS ${x.bestMatchEqualsEcmwfIfs}, =ERA5 ${x.bestMatchEqualsEra5} (sums best_match/IFS/ERA5 ${x.sumBestMatch}/${x.sumEcmwfIfs}/${x.sumEra5} mm)`).join("; ")}. ${om.bestMatchIsEcmwfIfsOnAllChecks ? "So best_match precipitation here is the ECMWF IFS operational analysis/short-range-forecast archive (~9 km), whose model version changes over time — not a reanalysis." : ""}`);
  L.push("  - ERA5 is a frozen-model reanalysis available for the whole period and both cities, which matches the contract's `kind: \"reanalysis-grid\"`. Trade-offs accepted: coarser cells (0.25°) and ~5-day latency (the period ends a few days earlier than best_match would).");
  L.push(`- **Daily aggregation convention** (verified): Open-Meteo's daily \`precipitation_sum\` (timezone Asia/Bangkok) = sum of the 24 hourly values stamped 00:00–23:00 local; each hourly value is the accumulation over the preceding hour, so day D covers (D−1 23:00, D 23:00] local. Check at the Hat Yai centre (ERA5 cell ${fmt(ag?.modelCell?.lat)}°N ${fmt(ag?.modelCell?.lon)}°E): ${(ag?.days ?? []).map((d: any) => `${d.date} daily ${fmt(d.dailyEndpointMm)} mm vs Σhourly ${fmt(d.sumOfHourly00to23Mm)} mm`).join("; ")} → ${ag?.matches ? "identical" : "NOT identical / not checked"}. Values rounded to 0.1 mm.`);
  L.push("- **Grids** (regular cell-centre lattices as specified; Open-Meteo answers each coordinate with ONE model cell — no interpolation — so lattice points inside the same 0.25° ERA5 cell carry identical series):");
  const gb = om.grids?.bangkok ?? {};
  const gh = om.grids?.hatyai ?? {};
  L.push(`  - Bangkok: 0.1° lattice, centres lon 100.35…100.95 × lat 13.45…13.95 (${fmt(gb.points)} points), cells span [100.30, 13.40, 101.00, 14.00] ⊇ bbox [100.32, 13.49, 100.94, 13.96]. **Distinct ERA5 cells: ${fmt(gb.distinctModelCells)}**; points verified identical to their cell series: ${fmt(gb.pointsVerifiedAgainstCellSeries)}/${fmt(gb.points)}.${gb.error ? " ERROR: " + gb.error : ""}`);
  L.push(`  - Hat Yai: bbox buffered by 0.05° → [100.38, 6.92, 100.56, 7.11]; 0.05° lattice, centres lon 100.375…100.575 × lat 6.925…7.125 (${fmt(gh.points)} points). **Distinct ERA5 cells: ${fmt(gh.distinctModelCells)}** — the whole municipality falls into very few reanalysis cells, so the Hat Yai grid conveys almost no intra-city spatial variation; points verified: ${fmt(gh.pointsVerifiedAgainstCellSeries)}/${fmt(gh.points)}.${gh.error ? " ERROR: " + gh.error : ""}`);
  L.push("  - Fetch method (polite, deterministic): one short request with all lattice points (Bangkok 2024-09-01..14, Hat Yai 2025-11-18..27) records the cell Open-Meteo assigns to each point; the full period is then fetched once per distinct cell at the first lattice point mapped to it (same coordinates → same cell; the returned cell is checked); finally every point's short-window values must equal its cell's full-period values, otherwise the city grid is not written. Point→cell mapping, representative points and DEM elevations: `data/staged/rain-grid-meta.json`. Raw responses: `data/raw/open-meteo/cellmap_*_era5_*.json`, `grid_*_era5_cells_*.json`.");
  L.push("");
  L.push("Derived annual totals (mean over lattice points of per-point annual sums — i.e. ERA5 cells weighted by the number of lattice points they answer; modelled):");
  L.push("");
  L.push("| City | Year | Days | Grid-mean mm | Min–max of points mm |");
  L.push("|---|---|---|---|---|");
  for (const c of ["bangkok", "hatyai"]) {
    const a = om.grids?.[c]?.annualTotalsDerived ?? {};
    for (const [y, v] of Object.entries<any>(a)) L.push(`| ${c} | ${y}${v.complete ? "" : " (partial)"} | ${v.days} | ${v.gridMeanMm} | ${v.minMm}–${v.maxMm} |`);
  }
  L.push("");
  for (const c of ["bangkok", "hatyai"]) {
    const g = om.grids?.[c];
    if (g?.heaviestDayGridMean) L.push(`- ${c}: heaviest day by grid mean ${g.heaviestDayGridMean.date} (${g.heaviestDayGridMean.gridMeanMm} mm); highest single-point day ${fmt(g.maxCellDay?.date)} (${fmt(g.maxCellDay?.mm)} mm at ${fmt(g.maxCellDay?.id)}).`);
  }
  L.push("");
  const cc = om.centreComparison ?? {};
  if (Object.keys(cc).length) {
    L.push("City-centre comparison, ERA5 (used) vs best_match (= ECMWF IFS, comparison only) — modelled annual totals, mm:");
    L.push("");
    L.push("| City | Year | ERA5 | best_match (IFS) |");
    L.push("|---|---|---|---|");
    for (const c of Object.keys(cc)) for (const [y, v] of Object.entries<any>(cc[c].annualTotals)) L.push(`| ${c} | ${y} (${v.days} d) | ${fmt(v.era5Mm)} | ${fmt(v.bestMatchMm)} |`);
    L.push("");
    L.push(`For reference, TMD 1991–2020 station normals: Bangkok Metropolis ${fmt(no.stations?.[0]?.annual)} mm/yr, Hat Yai Airport ${fmt(no.stations?.[1]?.annual)} mm/yr (station climatology, not directly comparable with single years or 0.25° cells).`);
    const pct = (c: string, ni: number) => {
      const normal = no.stations?.[ni]?.annual;
      if (!normal) return "n/a";
      return Object.entries<any>(cc[c]?.annualTotals ?? {}).filter(([y, v]) => v.days >= 365 && v.era5Mm !== null && y).map(([y, v]) => `${y} ${Math.round((v.era5Mm / normal) * 100)} %`).join(", ") || "n/a";
    };
    L.push(`ERA5 complete-year totals at the centre cells as a share of those station normals (indicative only — different years and spatial support): Bangkok ${pct("bangkok", 0)}; Hat Yai ${pct("hatyai", 1)}. In this build the Bangkok ERA5 cell is markedly drier than the station climatology (plausibly because a 0.25° reanalysis under-represents convective rainfall); treat ERA5 values as relative/temporal context rather than absolute local rainfall depths.`);
    L.push("");
  }
  L.push("### Hourly events (`data/staged/rain-hourly-events.json`, models=era5)");
  L.push("");
  for (const e of om.events ?? []) {
    if (e.error) {
      L.push(`- ${e.id}: FAILED (${e.error})`);
      continue;
    }
    L.push(`- **${e.id}** (ERA5 cell ${fmt(e.modelPoint?.lat)}°N ${fmt(e.modelPoint?.lon)}°E) — event total ${fmt(e.eventTotalMm)} mm; peak hour ${fmt(e.peakHour?.mm)} mm ending ${fmt(e.peakHour?.time)}; max rolling 24 h ${fmt(e.maxRolling24hMm?.mm)} mm ending ${fmt(e.maxRolling24hMm?.endTime)}. Daily: ${(e.dailyTotals ?? []).map((d: any) => `${d.date.slice(5)} ${fmt(d.mm)}`).join(", ")}. Check: ${fmt(e.dailyTotalsCheck)}.`);
  }
  L.push("");
  L.push("Centre points: Bangkok = TMD station 48455 “Bangkok Metropolis” coordinates (13.72639 N, 100.56 E, as published in ThaiWater metadata); Hat Yai = midpoint of the municipality analysis bbox (7.015 N, 100.47 E; derived, not an official centroid). Bangkok's heaviest day = the maximum ERA5 daily total at the Bangkok centre point over the whole period; the hourly file covers that day ±1 day. Hourly values follow Open-Meteo's convention (value at T = accumulation over the preceding hour). A single ≈27–28 km reanalysis cell will understate local gauge peaks — it should not be read as the observed Hat Yai rainfall of November 2025.");
  L.push("");
  L.push("Superseded: an earlier draft of this build (same day) used `models=best_match` (= ECMWF IFS). Its raw responses remain in `data/raw/open-meteo/` (`grid_*_best_match_*`, `centres_daily_best_match_era5_*`, `period.json`, `period_probe_2026-11-04.json`) for traceability only; no published or staged value uses them.");
  L.push("");
  L.push("## 3. Climatological normals and intensity classes (`data/staged/rain-normals.json`)");
  L.push("");
  L.push(`- Source: TMD *Climatological Data of Thailand for 30 Year Period (1991-2020)*, Meteorological Data report No. 551.586-13-2023, PDF at ${URLS.tmdNormalsPdf} (hosted on the TMD Ubon Ratchathani station site; ${fmt(no.pdf?.bytes)} bytes, retrieved ${fmt(no.pdf?.retrievedAt)}). Text extracted locally with macOS PDFKit (${fmt(no.textNote)}); the parser picks the rainfall “Mean / Mean rainy day / Daily maximum” rows and verifies monthly sums against the published annual values.`);
  for (const s of no.stations ?? []) L.push(`  - ${s.id}: period ${fmt(s.period)}, annual ${fmt(s.annual)} mm, rainy days ${fmt(s.rainyDays)} (PDF page ${fmt(s.pdfPage)}; check ${JSON.stringify(s.checks)}).`);
  L.push("- Definitions from the report: daily rainfall 0700→0700 L.S.T.; rainy day ≥ 0.1 mm.");
  L.push("- Caution: for Bangkok Metropolis the extracted April daily-maximum (216.8 mm) equals the station's all-month record and is large relative to the April mean (93.3 mm). It is transcribed exactly as it appears in the PDF text layer (and the row passes the max-check); it was not independently verified. Monthly means and rainy days pass the sum checks.");
  L.push(`- Intensity classes (24 h amounts) from the TMD criteria page ${URLS.tmdCriteria} (เกณฑ์ปริมาณฝน): light 0.1–10.0 mm, moderate 10.1–35.0 mm, heavy 35.1–90.0 mm, very heavy ≥ 90.1 mm (${fmt(no.classesParsed)} classes parsed). The page states no accumulation window; TMD's aeromet2 report applies the same bands to 24 h (07:00–07:00) totals (${fmt(no.aeromet2Legend)} legend strings found), and weather.bangkok.go.th uses the same 10/35/90 mm breaks (${no.bmaBar ? "confirmed" : "not confirmed"} in the cached HTML). Trace (< 0.1 mm, “T”) comes from the aeromet2 legend.`);
  L.push("- www.tmd.go.th robots.txt (Cloudflare-managed) disallows AI *training* crawlers (ClaudeBot, anthropic-ai, Claude-Web, GPTBot …) and sets `Content-Signal: search=yes, ai-train=no, use=reference` for `*`, with `Allow: /`. Pages were fetched with the project's own User-Agent for reference/citation only (no training use). The same applies to ubonmet.tmd.go.th.");
  L.push("");
  L.push("## 4. Drainage capacity (`data/staged/drainage-capacity.json`)");
  L.push("");
  L.push(`${fmt(dr.statements)} statements, each with the Thai quote, an English translation by this project, attribution, URL and publication date; the script checks that each Thai quote occurs verbatim in the retrieved page (${fmt(dr.verified)}/${fmt(dr.statements)} verified${(dr.unverified ?? []).length ? "; NOT verified: " + dr.unverified.join(", ") : ""}).`);
  L.push("");
  L.push("- Bangkok citywide design intensity: **60 mm/h** — stated by BMA adviser Attasit Petchmeesri (ThaiPublica, 8 Jun 2025) and by Thai PBS in 2016. No BMA design document was retrieved; a 2024 BMA release (pr-bangkok.com/?p=373537) returned HTTP 404.");
  L.push("- BMA 2569 (2026) action plan (via Thai PBS, 30 Sep 2026): target 104 mm/day, ~3 h storm, 76 mm/h; 5 tunnels = 255 m³/s (Prem Prachakorn 30, Bueng Makkasan 45, Saen Saep–Lat Phrao 60, Bang Sue 60 pumping, Bueng Nong Bon/Bang O 60 pumping); 8 planned tunnels = 370 m³/s. Primary PDF (~161 MB) not downloaded — HEAD only.");
  L.push("- Pumping to the Chao Phraya, both banks: 1,300 m³/s (Attasit, 2025). Local project target ≥ 100 mm/h for Khlong Rang O–Rang Kaeo (BMA PR, 16 Sep 2025; local, not citywide).");
  L.push("- Hat Yai: RID diversion canal R.1 465 → 1,200 m³/s; with Khlong U-Taphao (465 m³/s) ≈ 1,665 m³/s combined (RID via ONEP, 12 Feb 2020). R.1 was damaged in the 2025 floods; repair targeted to restore full capacity by Nov 2026 (Daily News, 13 Aug 2026; completion not verified). **Hat Yai municipal street-drainage design intensity (mm/h): unknown** — no verifiable public figure found.");
  L.push("");
  L.push("## 5. Supporting: BMA monthly district rainfall (`data/staged/bma-district-rainfall-2023.json`)");
  L.push("");
  L.push(`BMA CKAN dataset \`rainfall\` (data.bangkok.go.th, licence “${fmt(ck.license)}”): one CSV \`dds015-rainfall2023.csv\`, ${fmt(ck.districts)} districts × months ${(ck.months ?? []).join(",")} of ${fmt(ck.year)} — **partial year (Jan–Sep 2023)**, so it is not an annual total. Encoding ${fmt(ck.encoding)}. Columns: District (Thai), rain_month, rain(mm). The dataset description mentions station names but the CSV has none; one value (หนองแขม) has many decimals, suggesting an average of several gauges — treat as published.`);
  L.push("");
  L.push("Also inspected (not used): data.go.th `disaster_101` (Songkhla Irrigation Project monthly rainfall 1999–2025 for 8 RID stations: คลองวาด, คลองจำไหร, คลองหลา, สะเดา, ชะมวง, ปลักปลิง, คลองจะนะ, ระโนด) — no coordinates and none inside Hat Yai municipality; raw copy in `data/raw/ckan/songkhla_rid_rain.csv` (manual exploratory download).");
  L.push("");
  L.push("## 6. Sources (`data/staged/rain-sources.json`)");
  L.push("");
  L.push("| id | status | retrieved | licence |");
  L.push("|---|---|---|---|");
  for (const s of sources) L.push(`| \`${s.id}\` | ${s.accessStatus} | ${fmt(s.retrievedAt)} | ${fmt(s.license)} |`);
  L.push("");
  L.push("## 7. Investigation log (manual, before the script was written)");
  L.push("");
  L.push("- `api-v3.thaiwater.net` has no robots.txt (HTTP 404); `www.thaiwater.net/robots.txt` allows all. The public endpoint list was read from the front-end bundle `www.thaiwater.net/dist/js/app.chunk.js` (saved as text in `data/raw/thaiwater/`, never executed).");
  L.push("- `weather.bangkok.go.th`: no robots.txt (404 page). The page's own popup builder maps the array columns (see §1). No hidden/authenticated API was called.");
  L.push("- `aeromet2.tmd.go.th`: robots.txt `Allow: /` (disallows only `/admin`, `/add-daily-data`). The public report page is a SPA; its bundle (`/assets/DailyRainfallReportPage-*.js`, `dailyObsApi-*.js`) shows the read-only endpoint `/api/daily-obs/rainfall-report`; the `unlock`/`entry` endpoints are for data entry and were not used.");
  L.push("- `data.tmd.go.th` open-data API: requires `uid`/`ukey` → not used. `climate.tmd.go.th`: connection reset (curl error 56). `www.tmd.go.th/en/ClimateChart` and `/en/climate/climatestat` were fetched once (HTTP 200) but contain no station normals tables.");
  L.push("- NOAA NCEI `pub/data/normals/WMO/1991-2020/` → HTTP 404 (the WMO 1991–2020 normals are in NCEI accession 0253808, not used because TMD's own report was found).");
  L.push("- Open-Meteo probes (2026-11-03/04): `models=era5_land` → precipitation null for 2024 and 2026 test periods (temperature present); `models=era5` → data ≈5 days behind real time; `models=best_match` → data to the previous day; best_match equals `ecmwf_ifs`, not `era5`. Decision: `models=era5` for all published values (see §2).");
  L.push("- `dds.bangkok.go.th` (about pages, flood report) contain no capacity figures. `pr-bangkok.com/?p=373537` → HTTP 404. The DDS 2569 action-plan PDF (161,119,984 bytes) was HEAD-checked but not downloaded (size).");
  L.push("- Hat Yai municipal drainage design intensity: searched Thai news / municipality sources — nothing verifiable found → recorded as unknown.");
  L.push("");
  L.push("### Fetches in this build");
  L.push("");
  L.push("| id | result | HTTP | bytes | retrieved / attempted |");
  L.push("|---|---|---|---|---|");
  for (const f of FETCH_LOG) L.push(`| \`${f.id}\` | ${f.ok ? (f.fromCache ? "cache" : "network") : "FAILED"}${f.error ? ` (${f.error.replace(/\|/g, "/")})` : ""} | ${fmt(f.status)} | ${f.bytes} | ${fmt(f.retrievedAt ?? f.attemptedAt)} |`);
  L.push("");
  L.push("## 8. Caveats");
  L.push("");
  L.push("- Station values are real-time snapshots at the retrieval time shown; rerunning the script without `--offline` replaces them.");
  L.push("- Gridded and hourly values are modelled ERA5 reanalysis (0.25°, via Open-Meteo `models=era5`), not observations and not ERA5-Land; they smooth convective extremes, carry only a few distinct cells per city (Hat Yai especially) and use local-midnight (effectively 23:00–23:00) days. The most recent months are preliminary ERA5T and may be revised.");
  L.push("- Normals are single-station 30-year means (Bangkok Metropolis, Hat Yai Airport ~10 km south of the municipality), not area averages.");
  L.push("- Drainage figures are as stated by officials/media; nominal capacities are not simultaneous effective capacities. Translations are unofficial.");
  L.push("- Open-Meteo free API: non-commercial use only; attribute “Weather data by Open-Meteo.com” (CC BY 4.0).");
  return L.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function main() {
  console.log(`fetch-rainfall: root=${ROOT} offline=${OFFLINE} refresh=${REFRESH} sections=${[...SECTIONS].join(",")}`);
  ensureDir(STAGED);
  const run: Record<Section, () => Promise<void>> = {
    stations: sectionStations,
    openmeteo: sectionOpenMeteo,
    normals: sectionNormals,
    drainage: sectionDrainage,
    ckan: sectionCkan,
  };
  // normals before openmeteo so notes can reference them; openmeteo last (slowest).
  for (const s of ["stations", "normals", "drainage", "ckan", "openmeteo"] as Section[]) {
    if (!SECTIONS.has(s)) continue;
    try {
      await run[s]();
    } catch (e) {
      console.error(`!! section ${s} failed:`, e);
      summary[s] = { ...(summary[s] as object), error: String((e as Error).message ?? e) };
    }
    writeJson(SUMMARY_FILE, summary);
  }
  const sources = buildSources();
  writeJson(path.join(STAGED, "rain-sources.json"), sources);
  writeText(path.join(STAGED, "rain-notes.md"), buildNotes(sources));
  const logFile = path.join(RAW, "fetch-log-rainfall.json");
  const prevLog = readJson<{ runs: unknown[] }>(logFile) ?? { runs: [] };
  prevLog.runs.push({ at: new Date().toISOString(), argv: ARGV, fetches: FETCH_LOG });
  prevLog.runs = prevLog.runs.slice(-20);
  writeJson(logFile, prevLog);
  console.log("\ndone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
