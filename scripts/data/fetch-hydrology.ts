/**
 * fetch-hydrology.ts — water levels, official BMA drainage inventory, Bangkok flood history and
 * hourly event rainfall.
 *
 * Run from the project root:
 *   npx tsx scripts/data/fetch-hydrology.ts               # all sections
 *   npx tsx scripts/data/fetch-hydrology.ts --offline     # never touch the network, cached raw files only
 *   npx tsx scripts/data/fetch-hydrology.ts --refresh     # also re-download "cache-first" resources
 *   npx tsx scripts/data/fetch-hydrology.ts --sections=waterlevels,drainage,floods,hourly
 *
 * Fetch policy
 *   - "network-first": live snapshots (ThaiWater public waterlevel_load / canal_waterlevel). The
 *     network is tried first; on failure the last cached raw file is re-used (and the notes say so).
 *   - "cache-first": historical / slowly-changing resources (BMA CKAN metadata + CSVs, HII 2011
 *     flood record, ThaiWater May 2022 event page, Thai PBS articles, World Bank overview PDF).
 *   Every raw file lives under data/raw/<source>/ with a sibling *.meta.json (url, HTTP status,
 *   retrievedAt). Downloaded files are data only — never executed.
 *
 * Politeness: <= 1 request/s per host, descriptive User-Agent, retries with exponential backoff.
 *
 * Outputs (deterministic given the cached raw files):
 *   public/data/{bangkok,hatyai}/water-levels.json   WaterLevelStation[]  (observed snapshot)
 *   public/data/{bangkok,hatyai}/rain-hourly.json    HourlyRainEvent[]    (ERA5, estimated)
 *   public/data/bangkok/drainage.geojson             OSM features kept + BMA DDS features merged
 *   data/staged/bangkok-dds-drainage.json            official pump stations / gates / sumps / tunnels
 *   data/staged/bangkok-flood-events.json            FloodEvent[] (+ documented extra fields)
 *   data/staged/hydrology-sources.json               SourceRef[]
 *   data/staged/hydrology-report.json                machine-readable build report (counts, checks)
 *   (data/staged/hydrology-notes.md is hand-written from this report.)
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  CityId,
  DataProvenance,
  FloodEvent,
  HourlyRainEvent,
  MetricValue,
  SourceRef,
  WaterLevelStation,
} from "../../src/lib/types";

// ---------------------------------------------------------------------------------------------
// Paths, CLI
// ---------------------------------------------------------------------------------------------
function findRoot(): string {
  const candidates = [path.resolve(path.dirname(process.argv[1] ?? "."), "../.."), process.cwd()];
  for (const c of candidates) if (fs.existsSync(path.join(c, "src/lib/types.ts"))) return c;
  throw new Error("Cannot locate project root (src/lib/types.ts). Run from the project root.");
}
const ROOT = findRoot();
const RAW = path.join(ROOT, "data/raw");
const STAGED = path.join(ROOT, "data/staged");
const PUBLIC = path.join(ROOT, "public/data");
const SCRIPT_REL = "scripts/data/fetch-hydrology.ts";

const argv = process.argv.slice(2);
const OFFLINE = argv.includes("--offline");
const REFRESH = argv.includes("--refresh");
const SECTIONS = new Set(
  (argv.find((a) => a.startsWith("--sections="))?.split("=")[1] ?? "waterlevels,drainage,floods,hourly").split(","),
);
const UA = "UrbanIntelligenceDemo/0.1 (research prototype)";

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, "utf8")) as T;
function writeJson(p: string, data: unknown, compact = false) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, (compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)) + "\n");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const t = Math.PI / 180;
  const dLat = (b[1] - a[1]) * t;
  const dLon = (b[0] - a[0]) * t;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** ThaiWater timestamps ("2026-11-04 07:00") are Thai local time (UTC+7). */
function thaiLocalToIso(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) throw new Error(`Unexpected ThaiWater timestamp: ${s}`);
  return `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}+07:00`;
}

// ---------------------------------------------------------------------------------------------
// Fetch with cache + meta
// ---------------------------------------------------------------------------------------------
interface FetchMeta {
  url: string;
  httpStatus: number | null;
  retrievedAt: string | null;
  bytes: number;
  contentType?: string | null;
  note?: string;
}
interface FetchResult {
  id: string;
  file: string;
  meta: FetchMeta;
  from: "network" | "cache" | "failed";
  detail: string;
}
const fetchLog: FetchResult[] = [];
const lastHit = new Map<string, number>();

async function politeWait(url: string) {
  const host = new URL(url).host;
  const last = lastHit.get(host) ?? 0;
  const wait = last + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

async function fetchRaw(
  id: string,
  url: string,
  file: string,
  policy: "network-first" | "cache-first",
): Promise<FetchResult> {
  const metaFile = file + ".meta.json";
  const haveCache = fs.existsSync(file) && fs.statSync(file).size > 0;
  const cachedMeta = (): FetchMeta => {
    if (fs.existsSync(metaFile)) return readJson<FetchMeta>(metaFile);
    // Exploratory manual download made during this task (same URL, same User-Agent) before the
    // script existed: record its file time as the retrieval time.
    const m: FetchMeta = {
      url,
      httpStatus: 200,
      retrievedAt: fs.statSync(file).mtime.toISOString(),
      bytes: fs.statSync(file).size,
      note: "Initial download made manually with curl (same URL and User-Agent) while developing this script; retrievedAt = file modification time.",
    };
    writeJson(metaFile, m);
    return m;
  };
  const fromCache = (detail: string): FetchResult => {
    const r: FetchResult = { id, file, meta: cachedMeta(), from: "cache", detail };
    fetchLog.push(r);
    return r;
  };
  if (haveCache && (OFFLINE || (policy === "cache-first" && !REFRESH))) {
    return fromCache(OFFLINE ? "offline mode" : "cache-first");
  }
  if (OFFLINE) {
    const r: FetchResult = { id, file, meta: { url, httpStatus: null, retrievedAt: null, bytes: 0 }, from: "failed", detail: "offline mode and no cached file" };
    fetchLog.push(r);
    return r;
  }
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await politeWait(url);
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(90_000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok || buf.length === 0) {
        lastErr = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      const meta: FetchMeta = { url, httpStatus: res.status, retrievedAt: new Date().toISOString(), bytes: buf.length, contentType: res.headers.get("content-type") };
      writeJson(metaFile, meta);
      const r: FetchResult = { id, file, meta, from: "network", detail: `HTTP ${res.status}` };
      fetchLog.push(r);
      return r;
    } catch (e) {
      lastErr = (e as Error).message;
      await sleep(2000 * 2 ** attempt);
    }
  }
  if (haveCache) return fromCache(`network failed (${lastErr}); used cached copy`);
  const r: FetchResult = { id, file, meta: { url, httpStatus: num(lastErr.replace(/\D/g, "")) ?? null, retrievedAt: null, bytes: 0 }, from: "failed", detail: lastErr };
  fetchLog.push(r);
  return r;
}

// ---------------------------------------------------------------------------------------------
// CSV + HTML text helpers
// ---------------------------------------------------------------------------------------------
function parseCsv(text: string): Record<string, string>[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
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
  if (f || row.length) {
    row.push(f);
    rows.push(row);
  }
  const good = rows.filter((r) => r.length > 1 || (r[0] ?? "").trim());
  const header = good[0].map((h) => h.trim());
  return good.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
function decodeText(buf: Buffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if ((utf8.match(/�/g) ?? []).length > 5) return new TextDecoder("windows-874").decode(buf);
  return utf8;
}
const ENT: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
function htmlToText(html: string): string {
  return collapse(
    html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(#?\w+);/g, (m, e: string) => (ENT[e] ?? (e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : m))),
  );
}

// ---------------------------------------------------------------------------------------------
// Source registry for this topic
// ---------------------------------------------------------------------------------------------
const sources = new Map<string, SourceRef>();
function addSource(s: SourceRef) {
  // In --offline mode a resource that was never cached shows up as "failed"; keep the record of the
  // last online attempt (e.g. the HTTP status) instead of overwriting it with "offline".
  const prev = sources.get(s.id);
  if (OFFLINE && s.accessStatus === "failed" && prev) return;
  sources.set(s.id, s);
}
function srcFromFetch(r: FetchResult | undefined): Pick<SourceRef, "retrievedAt" | "accessStatus"> {
  if (!r || r.from === "failed") return { retrievedAt: undefined, accessStatus: "failed" };
  return { retrievedAt: r.meta.retrievedAt ?? undefined, accessStatus: "retrieved" };
}

const report: Record<string, unknown> = { generatedBy: SCRIPT_REL, offline: OFFLINE };

// =============================================================================================
// 1. WATER LEVELS (ThaiWater public API)
// =============================================================================================
const CITY_BBOX: Record<CityId, [number, number, number, number]> = {
  bangkok: [100.17, 13.34, 101.09, 14.11],
  hatyai: [100.28, 6.82, 100.66, 7.21],
};
const inBbox = (b: [number, number, number, number], lon: number, lat: number) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

/** Explicit, documented exclusions (published values that cannot be on the stated datum). */
const WL_EXCLUDE: Record<string, string> = {
  KRP901:
    "HII gauge KRP901 (อุทยานเฉลิมพระเกียรติ…, เขตดุสิต) publishes water level 29.82 and bank 30 / ground 27 labelled m MSL inside Bangkok, where land lies about 0–2 m MSL: the gauge evidently uses a local datum, so presenting it as m MSL would mislead. Excluded.",
};
const FRESH_HOURS = 48; // mirrors the ThaiWater web map, which hides readings older than 2 days

interface TwTele {
  waterlevel_datetime: string;
  waterlevel_msl: string | null;
  storage_percent: string | null;
  situation_level: number | null;
  river_name: string | null;
  agency: { agency_name: { th?: string; en?: string }; agency_shortname: { th?: string; en?: string } };
  station: {
    tele_station_name: { th?: string; en?: string };
    tele_station_lat: number;
    tele_station_long: number;
    tele_station_oldcode: string;
    left_bank: number | null;
    right_bank: number | null;
    min_bank: number | null;
    ground_level: number | null;
    critical_level_msl: number | null;
  };
  geocode: { tumbon_name?: { th?: string; en?: string }; amphoe_name?: { th?: string; en?: string }; province_name?: { th?: string; en?: string } };
}
interface TwCanal {
  canal_datetime: string;
  canal_value: number | null;
  canal_out: number | null;
  agency: { agency_name: { th?: string; en?: string } };
  geocode: { tumbon_name?: { th?: string; en?: string }; amphoe_name?: { th?: string; en?: string }; province_name?: { th?: string; en?: string }; province_code?: string };
  station: { canal_name: { th?: string }; canal_lat: number; canal_long: number; canal_oldcode: string; bank: number | null; warning_level: number | null; critical_level: number | null };
}
interface TwScale {
  scale: { operator: string; term: string; situation: string }[];
  rule_web: { operator: string; term: string; level: number }[];
}

const SITUATION_EN: Record<string, string> = {
  น้ำล้นตลิ่ง: "Overbank (> 100 % of bank capacity)",
  น้ำมาก: "High (> 70 – 100 %)",
  น้ำปกติ: "Normal (> 30 – 70 %)",
  น้ำน้อย: "Low (> 10 – 30 %)",
  น้ำน้อยวิกฤติ: "Critically low (≤ 10 %)",
  // BMA canal gauges (derived from the published warning / critical levels, ThaiWater web-map rule)
  ถึงระดับวิกฤต: "At or above the critical level",
  ถึงระดับเฝ้าระวัง: "At or above the watch (warning) level",
  ต่ำกว่าระดับเฝ้าระวัง: "Below the watch (warning) level",
};

async function buildWaterLevels() {
  const dir = path.join(RAW, "thaiwater/waterlevel");
  const tele = await fetchRaw("thaiwater-public-waterlevel", "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load", path.join(dir, "waterlevel_load.json"), "network-first");
  const canal = await fetchRaw("thaiwater-public-canal-waterlevel", "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/canal_waterlevel", path.join(dir, "canal_waterlevel.json"), "network-first");

  addSource({
    id: "thaiwater-public-waterlevel",
    nameTh: "คลังข้อมูลน้ำแห่งชาติ (สสน.) — ระดับน้ำโทรมาตร (waterlevel_load)",
    nameEn: "HII ThaiWater public API — telemetered water levels (waterlevel_load)",
    url: "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load",
    publisher: "Hydro-Informatics Institute (HII, สสน.) — National Hydroinformatics Data Center; originating agencies HII, RID, etc.",
    license: "No licence stated on the public API or front-end; attribute ThaiWater/HII and the originating agency.",
    ...srcFromFetch(tele),
    notes: `Public, unauthenticated endpoint used by the www.thaiwater.net front-end (found in its JS bundle, cached at data/raw/thaiwater/app.chunk.js.txt). Latest reading per station, nationwide. Snapshot ${tele.from === "network" ? "fetched" : "re-used from cache"} (${tele.detail}).`,
  });
  addSource({
    id: "thaiwater-public-canal-waterlevel",
    nameTh: "คลังข้อมูลน้ำแห่งชาติ — ระดับน้ำคลอง สำนักการระบายน้ำ กทม. (canal_waterlevel)",
    nameEn: "HII ThaiWater public API — BMA canal water levels (canal_waterlevel)",
    url: "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/canal_waterlevel",
    publisher: "Hydro-Informatics Institute (HII); originating agency: Drainage and Sewerage Department, Bangkok Metropolitan Administration (สำนักการระบายน้ำ กทม.)",
    license: "No licence stated on the public API or front-end; attribute ThaiWater/HII and BMA DDS.",
    ...srcFromFetch(canal),
    notes: `Public endpoint used by the www.thaiwater.net map ('ระดับน้ำคลอง'). canal_value = water level inside the canal / gate ('ระดับน้ำใน'), unit m MSL ('หน่วย : (ม.รทก.)' in the front-end popup). Snapshot ${canal.from === "network" ? "fetched" : "re-used from cache"} (${canal.detail}).`,
  });
  if (tele.from === "failed" || canal.from === "failed") throw new Error("Water-level snapshot unavailable (no network and no cache)");

  const t = readJson<{ waterlevel_data: { data: TwTele[] }; scale: { data: TwScale } }>(tele.file);
  const c = readJson<{ data: TwCanal[] }>(canal.file);
  const scale = t.scale.data;
  const levelText = new Map<number, string>();
  for (const r of scale.rule_web) {
    const s = scale.scale.find((x) => x.operator === r.operator && x.term === r.term);
    if (s) levelText.set(r.level, s.situation);
  }
  const retrievedTele = tele.meta.retrievedAt!;
  const retrievedCanal = canal.meta.retrievedAt!;
  const fresh = (iso: string, retrieved: string) => Date.parse(retrieved) - Date.parse(iso) <= FRESH_HOURS * 3600_000;

  const placeEn = (g: TwTele["geocode"]) =>
    [g.tumbon_name?.en, g.amphoe_name?.en, g.province_name?.en].filter(Boolean).join(", ");
  const placeTh = (g: TwTele["geocode"]) =>
    [g.tumbon_name?.th && `ต.${g.tumbon_name.th}`, g.amphoe_name?.th && `อ.${g.amphoe_name.th}`, g.province_name?.th && `จ.${g.province_name.th}`].filter(Boolean).join(" ");

  const cityReport: Record<string, unknown> = {};
  for (const city of ["bangkok", "hatyai"] as CityId[]) {
    const bbox = CITY_BBOX[city];
    const out: WaterLevelStation[] = [];
    const excluded: { id: string; reason: string }[] = [];
    let pctChecked = 0;
    let pctMaxDiff = 0;

    // --- telemetered river / canal gauges (HII, RID, …)
    for (const e of t.waterlevel_data.data) {
      const s = e.station;
      if (!inBbox(bbox, s.tele_station_long, s.tele_station_lat)) continue;
      const short = (e.agency.agency_shortname.en ?? "na").trim();
      const id = `${short.toLowerCase()}-${s.tele_station_oldcode}`;
      if (WL_EXCLUDE[s.tele_station_oldcode]) {
        excluded.push({ id, reason: WL_EXCLUDE[s.tele_station_oldcode] });
        continue;
      }
      const wl = num(e.waterlevel_msl);
      if (wl === null) {
        excluded.push({ id, reason: "no waterlevel_msl published" });
        continue;
      }
      const observedAt = thaiLocalToIso(e.waterlevel_datetime);
      if (!fresh(observedAt, retrievedTele)) {
        excluded.push({ id, reason: `stale: last reading ${observedAt} is more than ${FRESH_HOURS} h before retrieval` });
        continue;
      }
      const day = observedAt.slice(0, 10);
      const agencyName = `${(e.agency.agency_name.en ?? "").trim()} (${short}; ${(e.agency.agency_name.th ?? "").trim()})`;
      const scope = `Single gauge ${short} ${s.tele_station_oldcode} “${s.tele_station_name.th ?? ""}”${e.river_name ? ` on ${e.river_name}` : ""}, ${placeTh(e.geocode)} (${placeEn(e.geocode)}).`;
      const base: Omit<DataProvenance, "status"> = {
        sourceId: "thaiwater-public-waterlevel",
        sourceName: "HII ThaiWater public API — waterlevel_load (ระดับน้ำ)",
        sourceUrl: "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load",
        observedFrom: day,
        observedTo: day,
        referenceYear: Number(day.slice(0, 4)),
        geographicScope: scope,
      };
      const lim = [
        `Snapshot retrieved ${retrievedTele}; not live — rerun the script to refresh.`,
        "Telemetry as distributed by ThaiWater; not quality-controlled.",
      ];
      const waterLevel: MetricValue = {
        value: round(wl, 2),
        unit: "m MSL",
        provenance: {
          status: "observed",
          ...base,
          methodology: `Telemetered water level as published (waterlevel_msl = "${e.waterlevel_msl}" m above mean sea level, ม.รทก.) at waterlevel_datetime = "${e.waterlevel_datetime}" (Thai local time, UTC+7). Originating agency: ${agencyName}.`,
          limitations: lim,
        },
      };
      const bank = num(s.min_bank);
      const ground = num(s.ground_level);
      const st: WaterLevelStation = {
        id,
        nameTh: (s.tele_station_name.th ?? "").trim() || undefined,
        nameEn: s.tele_station_name.en?.trim() || `${short} gauge ${s.tele_station_oldcode} (${placeEn(e.geocode)})`,
        lon: round(s.tele_station_long, 5),
        lat: round(s.tele_station_lat, 5),
        agency: agencyName,
        ...(e.river_name ? { waterway: e.river_name.trim() } : {}),
        waterLevel,
        observedAt,
      };
      if (bank !== null) {
        st.bankLevel = {
          value: round(bank, 3),
          unit: "m MSL",
          provenance: {
            status: "observed",
            ...base,
            methodology: `Station attribute min_bank = ${s.min_bank} m MSL as published by ThaiWater (the bank level ThaiWater uses as 100 % in its storage_percent). Published left/right bank: ${s.left_bank ?? "n/a"} / ${s.right_bank ?? "n/a"} m MSL${s.critical_level_msl != null ? `; critical level ${s.critical_level_msl} m MSL` : ""}.`,
            limitations: ["Station metadata as published; survey date not stated."],
          },
        };
      }
      if (bank !== null && ground !== null && bank !== ground) {
        const pct = ((wl - ground) / (bank - ground)) * 100;
        const published = num(e.storage_percent);
        if (published !== null) {
          pctChecked++;
          pctMaxDiff = Math.max(pctMaxDiff, Math.abs(pct - published));
        }
        st.capacityPct = {
          value: round(pct, 1),
          unit: "%",
          provenance: {
            status: "derived",
            ...base,
            methodology: `(water level − ground level) ÷ (bank level − ground level) × 100 = (${wl} − ${ground}) ÷ (${bank} − ${ground}) × 100, using the published waterlevel_msl, ground_level (channel bed) and min_bank. ThaiWater's own storage_percent for this reading: ${e.storage_percent ?? "n/a"} %.`,
            limitations: ["Share of the channel depth between bed and bank that is filled; not a flow-capacity measure.", ...(pct > 100 ? ["Above 100 %: water above the published bank level at this reading."] : [])],
          },
        };
      }
      const sit = e.situation_level != null ? levelText.get(e.situation_level) : undefined;
      if (sit) st.situation = sit;
      out.push(st);
    }

    // --- BMA DDS canal gauges
    for (const e of c.data) {
      const s = e.station;
      if (!inBbox(bbox, s.canal_long, s.canal_lat)) continue;
      const id = `bma-${s.canal_oldcode}`;
      const wl = num(e.canal_value);
      if (wl === null) {
        excluded.push({ id, reason: "no canal_value published" });
        continue;
      }
      const observedAt = thaiLocalToIso(e.canal_datetime);
      if (!fresh(observedAt, retrievedCanal)) {
        excluded.push({ id, reason: `stale: last reading ${observedAt} is more than ${FRESH_HOURS} h before retrieval` });
        continue;
      }
      const day = observedAt.slice(0, 10);
      const g = e.geocode;
      const base: Omit<DataProvenance, "status"> = {
        sourceId: "thaiwater-public-canal-waterlevel",
        sourceName: "HII ThaiWater public API — canal_waterlevel (ระดับน้ำคลอง, BMA DDS)",
        sourceUrl: "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/canal_waterlevel",
        observedFrom: day,
        observedTo: day,
        referenceYear: Number(day.slice(0, 4)),
        geographicScope: `Single BMA DDS canal gauge ${s.canal_oldcode} “${s.canal_name.th ?? ""}”, ${placeTh(g)} (${placeEn(g)}).`,
      };
      const st: WaterLevelStation = {
        id,
        nameTh: (s.canal_name.th ?? "").trim() || undefined,
        nameEn: `BMA canal gauge ${s.canal_oldcode} (${placeEn(g)})`,
        lon: round(s.canal_long, 5),
        lat: round(s.canal_lat, 5),
        agency: "Drainage and Sewerage Department, Bangkok Metropolitan Administration (BMA DDS; สำนักการระบายน้ำ กรุงเทพมหานคร)",
        waterLevel: {
          value: round(wl, 2),
          unit: "m MSL",
          provenance: {
            status: "observed",
            ...base,
            methodology: `Canal water level as published (canal_value = ${e.canal_value} m MSL — the level inside the canal / upstream of the gate, 'ระดับน้ำใน') at canal_datetime = "${e.canal_datetime}" (Thai local time, UTC+7). Originating agency: BMA Drainage and Sewerage Department, distributed by ThaiWater.`,
            limitations: [`Snapshot retrieved ${retrievedCanal}; not live — rerun the script to refresh.`, "BMA canals are pumped down to operating levels; a low level is a managed state, not drought."],
          },
        },
        observedAt,
      };
      if (num(s.bank) !== null) {
        st.bankLevel = {
          value: round(s.bank as number, 3),
          unit: "m MSL",
          provenance: {
            status: "observed",
            ...base,
            methodology: `Station attribute bank = ${s.bank} m MSL as published (warning level ${s.warning_level ?? "n/a"}, critical level ${s.critical_level ?? "n/a"} m MSL).`,
            limitations: ["Station metadata as published; no ground (bed) level is published for BMA canal gauges, so no capacity % is derived."],
          },
        };
      }
      const w = num(s.warning_level);
      const cr = num(s.critical_level);
      if (w !== null && cr !== null && cr >= w) {
        // Same rule as the ThaiWater web map (value ≥ critical → critical; ≥ warning → warning; else normal).
        st.situation = wl >= cr ? "ถึงระดับวิกฤต" : wl >= w ? "ถึงระดับเฝ้าระวัง" : "ต่ำกว่าระดับเฝ้าระวัง";
      }
      out.push(st);
    }

    out.sort((a, b) => a.id.localeCompare(b.id));
    writeJson(path.join(PUBLIC, city, "water-levels.json"), out);
    const byAgency: Record<string, number> = {};
    for (const s of out) byAgency[s.id.split("-")[0]] = (byAgency[s.id.split("-")[0]] ?? 0) + 1;
    const sitCounts: Record<string, number> = {};
    for (const s of out) if (s.situation) sitCounts[s.situation] = (sitCounts[s.situation] ?? 0) + 1;
    const times = out.map((s) => s.observedAt!).sort();
    cityReport[city] = {
      stations: out.length,
      byAgencyPrefix: byAgency,
      withBankLevel: out.filter((s) => s.bankLevel).length,
      withCapacityPct: out.filter((s) => s.capacityPct).length,
      situationCounts: sitCounts,
      readingTimes: [times[0], times[times.length - 1]],
      capacityPctVsPublishedStoragePercent: { checked: pctChecked, maxAbsDiffPct: round(pctMaxDiff, 3) },
      excluded,
      keyGauges: out
        .filter((s) => /อู่ตะเภา|เจ้าพระยา/.test(s.waterway ?? ""))
        .map((s) => ({ id: s.id, nameTh: s.nameTh, waterway: s.waterway, waterLevel: s.waterLevel.value, bankLevel: s.bankLevel?.value ?? null, capacityPct: s.capacityPct?.value ?? null, situation: s.situation ?? null, observedAt: s.observedAt })),
    };
  }
  report.waterLevels = {
    retrievedAt: { waterlevel_load: retrievedTele, canal_waterlevel: retrievedCanal },
    fetch: { waterlevel_load: tele.detail, canal_waterlevel: canal.detail },
    freshnessHours: FRESH_HOURS,
    situationScale: Object.fromEntries([...levelText].map(([k, v]) => [k, { th: v, en: SITUATION_EN[v] ?? null }])),
    situationTextEn: SITUATION_EN,
    canalSituationRule: "BMA canal gauges: ≥ critical_level → 'ถึงระดับวิกฤต' (critical); ≥ warning_level → 'ถึงระดับเฝ้าระวัง' (watch); else 'ต่ำกว่าระดับเฝ้าระวัง' (below watch level) — the ThaiWater web-map rule applied to the published thresholds.",
    cities: cityReport,
  };
}

// =============================================================================================
// 2. OFFICIAL BMA DDS DRAINAGE INVENTORY (data.bangkok.go.th CKAN)
// =============================================================================================
const CKAN = "https://data.bangkok.go.th/api/3/action/package_show?id=";
const DDS_DIR = path.join(RAW, "bma-opendata/drainage");
interface CkanPkg {
  result: { name: string; title: string; organization?: { title: string }; license_title?: string; metadata_modified: string; resources: { url: string; format: string; name: string; last_modified?: string | null; created: string }[] };
}

function utmToLonLat(E: number, N: number, zone = 47): [number, number] {
  const a = 6378137,
    f = 1 / 298.257223563,
    k0 = 0.9996,
    e2 = f * (2 - f),
    ep2 = e2 / (1 - e2);
  const x = E - 500000;
  const M = N / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(p1) ** 2,
    T1 = Math.tan(p1) ** 2,
    N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2),
    R1 = (a * (1 - e2)) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5,
    D = x / (N1 * k0);
  const lat = p1 - ((N1 * Math.tan(p1)) / R1) * ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(p1);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

/** Name key for matching: drop whitespace, punctuation and generic structure prefixes. */
function nameKey(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/\s+/g, "")
    .replace(/[().,"'\-–—/]/g, "")
    .replace(/^(สถานีสูบน้ำ|สถานนีสูบน้ำ|ประตูระบายน้ำ|ปตร|บ่อสูบน้ำ|อาคารรับน้ำ|อาคารบังคับน้ำ)/, "")
    .replace(/^(และ)?/, "");
}
function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = nameKey(a),
    kb = nameKey(b);
  if (ka.length < 3 || kb.length < 3) return false;
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

interface DdsFeature {
  ddsDataset: string;
  ddsId: string;
  name: string;
  kind: "pump-station" | "gate";
  ddsType: string;
  district: string | null;
  lon: number | null;
  lat: number | null;
  capacityM3s: number | null;
  capacityNote: string;
  pumpCount: number | null;
  pumpBreakdown: string | null;
  group?: string | null;
  excludedReason?: string;
}

async function buildDrainage() {
  // DDS datasets used + the BMA Digital Strategy Division republications used for cross-checks.
  const pkgIds = ["water-station", "pumping-stations", "water-drainage-tunnel", "pumping-station", "floodgate", "pumpstation"];
  const pkgs = new Map<string, { r: FetchResult; pkg: CkanPkg | null }>();
  for (const id of pkgIds) {
    const r = await fetchRaw(`bma-ckan-pkg-${id}`, CKAN + encodeURIComponent(id), path.join(DDS_DIR, `pkg_${id}.json`), "cache-first");
    pkgs.set(id, { r, pkg: r.from === "failed" ? null : readJson<CkanPkg>(r.file) });
  }
  const csvOf = async (pkgId: string, file: string, match: (u: string) => boolean = () => true) => {
    const p = pkgs.get(pkgId)?.pkg;
    const res = p?.result.resources.find((x) => (x.format || "").toUpperCase() === "CSV" && match(x.url));
    if (!res) return { r: undefined, rows: null as Record<string, string>[] | null, url: null as string | null };
    const r = await fetchRaw(`bma-ckan-csv-${pkgId}`, res.url, path.join(DDS_DIR, file), "cache-first");
    return { r, rows: r.from === "failed" ? null : parseCsv(decodeText(fs.readFileSync(r.file))), url: res.url };
  };
  const ws = await csvOf("water-station", "water-station.csv");
  const sm = await csvOf("pumping-stations", "pumping-stations.csv");
  const tn = await csvOf("water-drainage-tunnel", "water-drainage-tunnel.csv");
  // Inspected for cross-checks only (same inventory republished by the BMA Digital Strategy Division).
  const psGis = await csvOf("pumping-station", "pump-station.csv");
  const fgGis = await csvOf("floodgate", "floodgate.csv");
  const oldGis = await csvOf("pumpstation", "water-pump-station.csv", (u) => /water-pump-station\.csv$/.test(u));

  const pkgSource = (pkgId: string, sid: string, extra: string, csv?: { r?: FetchResult; url: string | null }) => {
    const p = pkgs.get(pkgId);
    const res = p?.pkg?.result;
    addSource({
      id: sid,
      nameTh: res?.title,
      nameEn: `BMA open data (CKAN) dataset “${pkgId}”`,
      url: `https://data.bangkok.go.th/dataset/${pkgId}`,
      publisher: `กรุงเทพมหานคร — ${res?.organization?.title ?? "n/a"}`,
      license: res?.license_title ?? "n/a",
      ...srcFromFetch(csv?.r ?? p?.r),
      notes: `${extra} CKAN metadata_modified ${res?.metadata_modified ?? "n/a"}; CSV resource ${csv?.url ?? "n/a"}.`,
    });
  };
  pkgSource("water-station", "bma-dds-water-station", "DDS inventory of pump stations (gp_type 'บ่อสูบน้ำ') and floodgates ('ประตูระบายน้ำ') with coordinates. Column gp_gate holds the total pumping capacity (m³/s) — inferred: equals Σ(count×unit capacity) of the gp_pump breakdown in nearly all rows (see report).", ws);
  pkgSource("pumping-stations", "bma-dds-pump-sumps", "DDS drainage pump sumps (บ่อสูบน้ำ) with capacity (sump_capacity, m³/s inferred) and coordinates. Contains two releases: 2022-04-30 (WGS84 lat/long, 312 rows, used) and 2020-05-25 (UTM 47N metres in the lat/long columns, not merged).", sm);
  pkgSource("water-drainage-tunnel", "bma-dds-drainage-tunnels", "DDS drainage tunnels: capacity, diameter, length, service area, districts, status. No coordinates published → staged only.", tn);
  pkgSource("pumping-station", "bma-gis-pump-station", "Same 201 pump stations as bma-dds-water-station (all names match) republished by the BMA Digital Strategy Division (GIS portal). Cross-check only.", psGis);
  pkgSource("floodgate", "bma-gis-floodgate", "Same 237 floodgates as bma-dds-water-station (all names match). Cross-check only.", fgGis);
  pkgSource("pumpstation", "bma-gis-pumpstation-2021", "Older (2021) GIS layer of 144 pump stations; superseded by the 2023 DDS inventory. Not merged.", oldGis);
  if (!ws.rows || !sm.rows || !tn.rows) throw new Error("BMA DDS CSVs unavailable (no network and no cache)");

  // --- pump stations + gates
  const feats: DdsFeature[] = [];
  let capOk = 0,
    capMismatch = 0,
    capNoBreakdown = 0,
    capNonNumeric = 0;
  for (const r of ws.rows) {
    const name = collapse(r.gp_name ?? "");
    const lat = num(r.gp_lat),
      lon = num(r.gp_long);
    const kind = r.gp_type?.includes("ประตู") ? "gate" : "pump-station";
    const breakdown = collapse(r.gp_pump ?? "");
    const parts = [...breakdown.matchAll(/(\d+)\s*\(\s*([\d.]+)\s*\)/g)];
    const cap = /^\s*\d+(\.\d+)?\s*$/.test(r.gp_gate ?? "") ? Number(r.gp_gate) : null;
    let capacityM3s: number | null = null;
    let capacityNote: string;
    if (cap === null) {
      capNonNumeric++;
      capacityNote = `No numeric capacity published (gp_gate = "${collapse(r.gp_gate ?? "")}").`;
    } else if (!parts.length) {
      capNoBreakdown++;
      capacityM3s = cap;
      capacityNote = "Total pumping capacity as published (gp_gate); no per-pump breakdown to cross-check.";
    } else {
      const sum = parts.reduce((s, p) => s + Number(p[1]) * Number(p[2]), 0);
      if (Math.abs(sum - cap) <= 0.051) {
        capOk++;
        capacityM3s = cap;
        capacityNote = `Total pumping capacity as published (gp_gate); equals the published pump breakdown "${breakdown}".`;
      } else {
        capMismatch++;
        capacityNote = `Withheld: published total ${cap} m³/s disagrees with the published pump breakdown "${breakdown}" (Σ ${round(sum, 2)} m³/s).`;
      }
    }
    const pc = /^\s*(\d+)/.exec(breakdown);
    const f: DdsFeature = {
      ddsDataset: "water-station",
      ddsId: String(r.gp_id),
      name,
      kind,
      ddsType: collapse(r.gp_type ?? ""),
      district: collapse(r.district ?? "") || null,
      lon,
      lat,
      capacityM3s,
      capacityNote,
      pumpCount: pc ? Number(pc[1]) : null,
      pumpBreakdown: breakdown && breakdown !== "-" ? breakdown : null,
    };
    if (lat === null || lon === null || lat < 13 || lat > 14.5 || lon < 100 || lon > 101.5) {
      f.excludedReason = `No valid coordinate published (gp_lat = "${r.gp_lat}", gp_long = "${r.gp_long}") — likely a telephone number in the latitude column; not mapped.`;
      f.lon = null;
      f.lat = null;
    }
    feats.push(f);
  }
  // --- sumps (2022 release, WGS84)
  const sumps: DdsFeature[] = [];
  const olderSumps: { name: string; lon: number; lat: number; capacityM3s: number | null; nearest2022M: number; group: string }[] = [];
  const s2022 = sm.rows.filter((r) => (num(r.lat) ?? 999) < 90);
  const s2020 = sm.rows.filter((r) => (num(r.lat) ?? 0) >= 90);
  for (const r of s2022) {
    sumps.push({
      ddsDataset: "pumping-stations",
      ddsId: String(r.sump_id),
      name: collapse(r.sump_name),
      kind: "pump-station",
      ddsType: "บ่อสูบน้ำ (drainage pump sump)",
      district: null,
      lon: num(r.long),
      lat: num(r.lat),
      capacityM3s: num(r.sump_capacity),
      capacityNote: "Sump pumping capacity as published (sump_capacity; unit not stated in the CSV, m³/s inferred from magnitudes 0.08–… consistent with DDS usage).",
      pumpCount: null,
      pumpBreakdown: null,
      group: collapse(r.sump_group ?? "") || null,
    });
  }
  const k2022 = new Set(s2022.map((r) => nameKey(r.sump_name)));
  let datumCheck: number[] = [];
  for (const r of s2020) {
    const ll = utmToLonLat(Number(r.long), Number(r.lat));
    const same = s2022.filter((x) => nameKey(x.sump_name) === nameKey(r.sump_name));
    if (same.length) {
      datumCheck.push(Math.min(...same.map((x) => haversineM(ll, [Number(x.long), Number(x.lat)]))));
      continue;
    }
    if (k2022.has(nameKey(r.sump_name))) continue;
    olderSumps.push({ name: collapse(r.sump_name), lon: round(ll[0], 5), lat: round(ll[1], 5), capacityM3s: num(r.sump_capacity), nearest2022M: Math.round(Math.min(...s2022.map((x) => haversineM(ll, [Number(x.long), Number(x.lat)])))), group: collapse(r.sump_group ?? "") });
  }
  datumCheck = datumCheck.sort((a, b) => a - b);

  // --- tunnels (no coordinates)
  const tunnels = tn.rows
    .map((r) => ({
      ddsId: String(r.tun_id),
      nameTh: collapse(r.tun_name),
      capacityM3s: num(r.capacity),
      diameterM: num(r.diameter),
      lengthKm: num(r.length),
      serviceAreaKm2: num(r.tun_area),
      districts: collapse(r.available_khet ?? ""),
      status: collapse(r.status ?? ""),
      updated: r.updatedate,
    }))
    .sort((a, b) => Number(a.ddsId) - Number(b.ddsId));
  const tunnelByStatus: Record<string, { count: number; capacityM3s: number; lengthKm: number }> = {};
  for (const t of tunnels) {
    const g = (tunnelByStatus[t.status] ??= { count: 0, capacityM3s: 0, lengthKm: 0 });
    g.count++;
    g.capacityM3s = round(g.capacityM3s + (t.capacityM3s ?? 0), 2);
    g.lengthKm = round(g.lengthKm + (t.lengthKm ?? 0), 3);
  }

  // --- cross-check vs the GIS republications
  const wsKeys = new Set(ws.rows.map((r) => collapse(r.gp_name)));
  const gisCheck = {
    pumpStationGisRowsMatchedByName: psGis.rows ? `${psGis.rows.filter((r) => wsKeys.has(collapse(r.name))).length}/${psGis.rows.length}` : "n/a",
    floodgateGisRowsMatchedByName: fgGis.rows ? `${fgGis.rows.filter((r) => wsKeys.has(collapse(r.name))).length}/${fgGis.rows.length}` : "n/a",
    gis2021RowsMatchedByName: oldGis.rows ? `${oldGis.rows.filter((r) => wsKeys.has(collapse(r.PUMP_NAME))).length}/${oldGis.rows.length}` : "n/a",
  };

  // --- merge into public/data/bangkok/drainage.geojson
  const drainPath = path.join(PUBLIC, "bangkok/drainage.geojson");
  type GFeature = { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: number[] } };
  const fc = readJson<{ type: string; name: string; metadata: Record<string, unknown>; features: GFeature[] }>(drainPath);
  // idempotent: strip what a previous run added
  const osm = fc.features.filter((f) => f.properties.source !== "bma-dds");
  for (const f of osm) {
    delete f.properties.officialMatch;
    delete f.properties.capacityM3s;
    delete f.properties.capacitySource;
    f.properties.source = "osm";
  }
  const meta = fc.metadata;
  const bbox = (meta.bbox as [number, number, number, number]) ?? [100.32, 13.49, 100.94, 13.96];
  const added: GFeature[] = [];
  const matched: { ddsDataset: string; ddsId: string; name: string; osmId: unknown; osmName: unknown; distanceM: number }[] = [];
  const outsideBbox: string[] = [];
  const mapped = [...feats, ...sumps].filter((f) => f.lon !== null && f.lat !== null);
  for (const f of mapped) {
    const p: [number, number] = [f.lon!, f.lat!];
    if (!inBbox(bbox, p[0], p[1])) {
      outsideBbox.push(`${f.ddsDataset}#${f.ddsId} ${f.name}`);
      continue;
    }
    let best: { o: GFeature; d: number } | null = null;
    for (const o of osm) {
      if (o.properties.kind !== f.kind || o.geometry.type !== "Point") continue;
      const d = haversineM(p, o.geometry.coordinates as [number, number]);
      if (d > 150) continue;
      if (!namesMatch(f.name, o.properties.name as string) && !namesMatch(f.name, o.properties.nameEn as string)) continue;
      if (!best || d < best.d) best = { o, d };
    }
    if (best) {
      best.o.properties.officialMatch = { source: "bma-dds", sourceId: f.ddsDataset === "water-station" ? "bma-dds-water-station" : "bma-dds-pump-sumps", ddsId: f.ddsId, name: f.name, distanceM: Math.round(best.d) };
      if (f.capacityM3s !== null) {
        best.o.properties.capacityM3s = f.capacityM3s;
        best.o.properties.capacitySource = "bma-dds";
      }
      matched.push({ ddsDataset: f.ddsDataset, ddsId: f.ddsId, name: f.name, osmId: best.o.properties.osmId, osmName: best.o.properties.name, distanceM: Math.round(best.d) });
      continue;
    }
    added.push({
      type: "Feature",
      properties: {
        name: f.name,
        nameEn: null,
        kind: f.kind,
        source: "bma-dds",
        status: "observed",
        sourceId: f.ddsDataset === "water-station" ? "bma-dds-water-station" : "bma-dds-pump-sumps",
        ddsId: f.ddsId,
        ddsType: f.ddsType,
        ...(f.district ? { district: f.district } : {}),
        ...(f.group ? { ddsGroup: f.group } : {}),
        ...(f.capacityM3s !== null ? { capacityM3s: f.capacityM3s } : {}),
        ...(f.pumpCount !== null ? { pumpCount: f.pumpCount } : {}),
        pointMethod: "agency-published-coordinate",
      },
      geometry: { type: "Point", coordinates: [round(p[0], 5), round(p[1], 5)] },
    });
  }
  const kindOrder = { "pump-station": 0, gate: 1 } as Record<string, number>;
  added.sort((a, b) => (kindOrder[a.properties.kind as string] ?? 9) - (kindOrder[b.properties.kind as string] ?? 9) || String(a.properties.sourceId).localeCompare(String(b.properties.sourceId)) || Number(a.properties.ddsId) - Number(b.properties.ddsId));

  const retrievedWs = ws.r?.meta.retrievedAt ?? null;
  const retrievedSm = sm.r?.meta.retrievedAt ?? null;
  const baseSourceIds = ((meta.sourceIds as string[]) ?? []).filter((s) => !s.startsWith("bma-dds"));
  const baseLims = ((meta.limitations as string[]) ?? []).filter((l) => !l.startsWith("[BMA DDS]"));
  const newMeta = {
    ...meta,
    statusNote:
      "Two kinds of point: source 'osm' = OpenStreetMap-mapped features (volunteer-mapped, incomplete; counts are NOT an inventory); source 'bma-dds' = agency-published inventory of the BMA Drainage and Sewerage Department (pump stations and floodgates, 2023 release; drainage pump sumps, 2022 release) with agency coordinates. OSM features that match an official feature (same kind, name match, ≤ 150 m) are kept and carry properties.officialMatch instead of a duplicate point.",
    sourceIds: [...baseSourceIds, "bma-dds-water-station", "bma-dds-pump-sumps"],
    attribution: "© OpenStreetMap contributors; BMA Drainage and Sewerage Department (data.bangkok.go.th)",
    bmaDds: {
      retrievedAt: { waterStation: retrievedWs, pumpSumps: retrievedSm },
      datasets: ["https://data.bangkok.go.th/dataset/water-station", "https://data.bangkok.go.th/dataset/pumping-stations"],
      license: "License not specified on data.bangkok.go.th",
      added: added.length,
      matchedToOsm: matched.length,
      properties: {
        source: "'bma-dds'",
        sourceId: "bma-dds-water-station | bma-dds-pump-sumps",
        ddsId: "row id in the DDS table (gp_id / sump_id)",
        ddsType: "type as published (บ่อสูบน้ำ / ประตูระบายน้ำ)",
        capacityM3s: "nominal pumping capacity (m³/s) as published; omitted when not published or inconsistent",
        pumpCount: "number of pumps as published",
        district: "district as published (water-station only)",
        ddsGroup: "DDS operating zone as published (sumps only)",
      },
    },
    limitations: [
      ...baseLims,
      "[BMA DDS] Official inventory as published on data.bangkok.go.th (pump stations/floodgates last updated 2023-05; sumps 2022-04); structures built later are missing. Capacities are nominal installed pumping capacities, not simultaneous effective capacity.",
      "[BMA DDS] In the DDS table, DDS labels its pump stations 'บ่อสูบน้ำ'; the total-capacity column is named gp_gate — its meaning (total m³/s) is inferred from the per-pump breakdown, which it matches in nearly all rows.",
      `[BMA DDS] ${feats.filter((f) => f.excludedReason).length} DDS rows have no valid coordinate (e.g. a phone number in the latitude column) and are not mapped; they are listed in data/staged/bangkok-dds-drainage.json.`,
    ],
  };
  writeJson(drainPath, { type: fc.type, name: fc.name, metadata: newMeta, features: [...osm, ...added] }, true);

  // --- per-district summary (pump stations + gates; sumps carry no district)
  const byDistrict: Record<string, { pumpStations: number; gates: number; gatesWithPumps: number; capacityM3s: number }> = {};
  for (const f of feats) {
    const d = f.district ?? "ไม่ระบุ";
    const g = (byDistrict[d] ??= { pumpStations: 0, gates: 0, gatesWithPumps: 0, capacityM3s: 0 });
    if (f.kind === "gate") {
      g.gates++;
      if (f.capacityM3s) g.gatesWithPumps++;
    } else g.pumpStations++;
    g.capacityM3s = round(g.capacityM3s + (f.capacityM3s ?? 0), 2);
  }
  const sumCap = (arr: DdsFeature[]) => round(arr.reduce((s, f) => s + (f.capacityM3s ?? 0), 0), 2);
  const summary = {
    pumpStations: { count: feats.filter((f) => f.kind === "pump-station").length, withCapacity: feats.filter((f) => f.kind === "pump-station" && f.capacityM3s !== null).length, capacityM3sSum: sumCap(feats.filter((f) => f.kind === "pump-station")) },
    gates: { count: feats.filter((f) => f.kind === "gate").length, withPumpCapacity: feats.filter((f) => f.kind === "gate" && f.capacityM3s !== null).length, capacityM3sSum: sumCap(feats.filter((f) => f.kind === "gate")) },
    sumps2022: { count: sumps.length, capacityM3sSum: sumCap(sumps) },
    tunnels: { count: tunnels.length, byStatus: tunnelByStatus },
    capacityCheck: { matchesBreakdown: capOk, mismatchWithheld: capMismatch, noBreakdown: capNoBreakdown, nonNumeric: capNonNumeric },
    noCoordinates: feats.filter((f) => f.excludedReason).length,
    caveat: "Sums of nominal installed capacities (m³/s) as published; they are not a simultaneous or effective citywide drainage capacity and must not be presented as one.",
  };
  writeJson(path.join(STAGED, "bangkok-dds-drainage.json"), {
    generatedBy: SCRIPT_REL,
    cityId: "bangkok",
    status: "observed",
    sources: ["bma-dds-water-station", "bma-dds-pump-sumps", "bma-dds-drainage-tunnels"],
    retrievedAt: { waterStation: retrievedWs, pumpSumps: retrievedSm, tunnels: tn.r?.meta.retrievedAt ?? null },
    units: { capacityM3s: "m³/s (nominal installed pumping capacity)", diameterM: "m", lengthKm: "km", serviceAreaKm2: "km²" },
    unitNote: "Units are not stated in the CSV headers; inferred from values that match independently published figures (e.g. Bang Sue tunnel 60 m³/s, Ø5 m, 6.4 km, 56 km²; Makkasan 45 m³/s; the 4 operational tunnels sum to 195 m³/s as stated by the BMA in 2025).",
    summary,
    byDistrict: Object.fromEntries(Object.entries(byDistrict).sort(([a], [b]) => a.localeCompare(b, "th"))),
    pumpStationsAndGates: feats,
    sumps,
    tunnels,
    olderReleases: {
      sumps2020: { note: "2020-05-25 release in UTM zone 47N (WGS84) metres stored in the lat/long columns; converted for comparison only. Datum check: for names present in both releases, converted 2020 points lie a median of " + round(datumCheck[Math.floor(datumCheck.length / 2)] ?? NaN, 2) + " m from the 2022 points (n = " + datumCheck.length + "). Names only in the 2020 release are listed here and NOT merged (possibly renamed or decommissioned).", onlyIn2020: olderSumps },
    },
    crossChecks: gisCheck,
    merge: { target: "public/data/bangkok/drainage.geojson", added: added.length, matchedToOsm: matched, outsideBbox, rule: "Same kind, name match after removing whitespace/punctuation and generic prefixes (equal or containment, ≥ 3 chars), distance ≤ 150 m → keep OSM feature, annotate properties.officialMatch (+ capacityM3s), do not add a duplicate." },
  });
  report.drainage = { summary, added: added.length, matchedToOsm: matched.length, outsideBbox: outsideBbox.length, osmKept: osm.length, crossChecks: gisCheck, older2020SumpsNotMerged: olderSumps.length, datumMedianM: datumCheck[Math.floor(datumCheck.length / 2)] ?? null };
}

// =============================================================================================
// 3. BANGKOK FLOOD HISTORY
// =============================================================================================
interface QuoteCheck {
  sourceId: string;
  quote: string;
}
async function buildFloods() {
  const dir = path.join(RAW, "flood-history");
  const hii = await fetchRaw("hii-flood-2011-record", "https://tiwrmdev.hii.or.th/current/menu.html", path.join(dir, "hii_flood2554_menu.html"), "cache-first");
  const tw22 = await fetchRaw("thaiwater-floodbkk-may2022", "https://www.thaiwater.net/uploads/contents/current/2022/FloodBKK_May2022/summary.html", path.join(dir, "thaiwater_FloodBKK_May2022_summary.html"), "cache-first");
  const pbs50 = await fetchRaw("thaipbs-2026-09-26-bkk-50-districts", "https://www.thaipbs.or.th/news/content/558588", path.join(dir, "thaipbs_558588.html"), "cache-first");
  const pbs48 = await fetchRaw("thaipbs-2026-09-26-bkk-48h-rain", "https://www.thaipbs.or.th/news/content/558595", path.join(dir, "thaipbs_558595.html"), "cache-first");
  const pbsRain = await fetchRaw("thaipbs-2026-09-27-bkk-rain-report", "https://www.thaipbs.or.th/news/content/558661", path.join(dir, "thaipbs_558661.html"), "cache-first");
  const wbo = await fetchRaw("worldbank-thai-flood-2011-overview", "https://data.opendevelopmentmekong.net/dataset/8853ede2-9c6f-4e5c-9b55-14bfb9a40071/resource/0b15648c-4e21-4240-97bb-385ac230f07f/download/698220wp0v10p106011020120box370022b.pdf", path.join(dir, "worldbank_thai_flood_2011_overview.pdf"), "cache-first");
  const wbFull = await fetchRaw("worldbank-thai-flood-2011-full", "https://www.gfdrr.org/sites/default/files/publication/Thai_Flood_2011_2.pdf", path.join(dir, "worldbank_thai_flood_2011_full.pdf"), "cache-first");

  // text layers
  const texts = new Map<string, string>();
  const htmlText = (r: FetchResult) => (r.from === "failed" ? "" : htmlToText(decodeText(fs.readFileSync(r.file))));
  texts.set("hii-flood-2011-record", htmlText(hii));
  texts.set("thaiwater-floodbkk-may2022", htmlText(tw22));
  texts.set("thaipbs-2026-09-26-bkk-50-districts", htmlText(pbs50));
  texts.set("thaipbs-2026-09-26-bkk-48h-rain", htmlText(pbs48));
  texts.set("thaipbs-2026-09-27-bkk-rain-report", htmlText(pbsRain));
  if (wbo.from !== "failed") {
    const txt = wbo.file.replace(/\.pdf$/, ".txt");
    if (!fs.existsSync(txt) && process.platform === "darwin") execFileSync("osascript", ["-l", "JavaScript", path.join(ROOT, "scripts/data/lib/pdf-to-text.jxa.js"), wbo.file, txt]);
    texts.set("worldbank-thai-flood-2011-overview", fs.existsSync(txt) ? collapse(fs.readFileSync(txt, "utf8").replace(/=====PAGE \d+=====/g, " ")) : "");
  }

  const S = (id: string, r: FetchResult, nameEn: string, nameTh: string | undefined, publisher: string, license: string, notes: string) =>
    addSource({ id, nameEn, nameTh, url: r.meta.url, publisher, license, ...srcFromFetch(r), notes: r.from === "failed" ? `FAILED: ${r.detail}. ${notes}` : notes });
  S("hii-flood-2011-record", hii, "HII — Record of the great flood of 2011 (บันทึกเหตุการณ์มหาอุทกภัยปี 2554)", "บันทึกเหตุการณ์มหาอุทกภัยปี 2554", "Hydro-Informatics Institute (HII, สสน.)", "No licence stated; cite HII.", "Official HII event record. Bangkok facts quoted: rainfall (BMA DDS gauges), DDPM affected-area reports, Royal Thai Navy Hydrographic Department tide levels.");
  S("thaiwater-floodbkk-may2022", tw22, "ThaiWater/HII — Flooding in Bangkok, 17–18 May 2022 (event summary)", "บันทึกเหตุการณ์น้ำท่วมบริเวณกรุงเทพมหานคร ช่วงวันที่ 17-18 พฤษภาคม 2565", "Hydro-Informatics Institute (HII) — Hydro DataSci Section", "No licence stated; cite ThaiWater/HII.", "Rainfall from BMA DDS daily gauges (07:00–07:00). The English paragraph states the window as 17 May 07:00 to 19 May 07:00 while the Thai paragraph says 17 May 07:00 to 18 May 07:00 (one day); the Thai original is used.");
  S("thaipbs-2026-09-26-bkk-50-districts", pbs50, "Thai PBS, 26 Sep 2026 — BMA extends the disaster-area declaration to all 50 districts", undefined, "Thai PBS (reporting a BMA announcement)", "© Thai PBS; short quotations for citation only.", "News report of the BMA Disaster Prevention and Mitigation Directorate announcement signed 26 Sep 2026, effective 25 Sep 2026.");
  S("thaipbs-2026-09-26-bkk-48h-rain", pbs48, "Thai PBS, 26 Sep 2026 — Bangkok 48-hour rainfall nearly 300 mm; full pumping", undefined, "Thai PBS (reporting statements of the BMA governor)", "© Thai PBS; short quotations for citation only.", "Governor's statement at the BMA flood-control centre, 26 Sep 2026 06:30.");
  S("thaipbs-2026-09-27-bkk-rain-report", pbsRain, "Thai PBS, 27 Sep 2026 — BMA rainfall report 25–27 Sep 2026", undefined, "Thai PBS (reporting BMA DDS gauge rainfall)", "© Thai PBS; short quotations for citation only.", "BMA 24-hour (07:00–07:00) gauge maxima for 25→26 and 26→27 Sep 2026.");
  S("worldbank-thai-flood-2011-overview", wbo, "World Bank (2012) — Thai Flood 2011: Rapid Assessment for Resilient Recovery and Reconstruction Planning (Overview)", undefined, "The World Bank / GFDRR with the Royal Thai Government", "World Bank copyright; non-commercial use with attribution permitted.", "Overview edition (24 pp) downloaded from the Open Development Mekong library mirror; national scope.");
  S("worldbank-thai-flood-2011-full", wbFull, "World Bank (2012) — Thai Flood 2011 Rapid Assessment (full report, GFDRR)", undefined, "The World Bank / GFDRR", "World Bank copyright.", "Full report PDF on gfdrr.org returned an HTTP 403 (bot protection) to the script's User-Agent; not bypassed. The overview edition is used instead.");

  // Each quote must occur verbatim (whitespace-collapsed) in the cached source text.
  const checks: QuoteCheck[] = [];
  const Q = (sourceId: string, quote: string) => {
    checks.push({ sourceId, quote });
    return quote;
  };

  const prov = (o: Partial<DataProvenance> & { status: DataProvenance["status"] }): DataProvenance => o as DataProvenance;
  type ExtFlood = FloodEvent & {
    sourceIds: string[];
    peakValues: { label: string; value: number; unit: string; period: string; place: string; status: "observed"; sourceId: string; quoteTh?: string; quoteEn?: string }[];
    affectedDistricts: { count: number | null; namedTh: string[]; scope: string; sourceId: string } | null;
    eventWindowNote: string;
  };

  const ev2011: ExtFlood = {
    id: "bkk-flood-2011",
    cityId: "bangkok",
    titleTh: "มหาอุทกภัย พ.ศ. 2554 (กรุงเทพมหานคร)",
    titleEn: "Great flood of 2011 (Bangkok)",
    from: "2011-10-01",
    to: "2011-11-30",
    summaryTh:
      "น้ำท่วมใหญ่ที่สุดในกรุงเทพฯ ในรอบ 70 ปี (นับจากปี 2485) จากน้ำหลากลุ่มน้ำเจ้าพระยาที่ไหลเข้าทางทิศเหนือ ร่วมกับฝนสะสมสูงสุดเป็นประวัติการณ์และน้ำทะเลหนุน; รายงาน ปภ. เดือนตุลาคม 2554 ระบุกรุงเทพฯ ประสบอุทกภัย 32 เขต; ฝนสะสมกรุงเทพฯ ตั้งแต่ต้นปีถึง 1 ธ.ค. 2554 = 2,257.5 มม. (เดือน ต.ค. 388.0 มม.); ระดับน้ำทะเลหนุนสูงสุด 2.53 ม. วันที่ 30 ต.ค. 2554 (สถานีกองบัญชาการกองทัพเรือ) (สสน.)",
    summaryEn:
      "Bangkok's worst flood in 70 years (since 1942), driven by Chao Phraya basin floodwater entering from the north, record cumulative rainfall and high tides. The DDPM October 2011 report listed 32 Bangkok districts as affected; Bangkok rainfall from 1 Jan to 1 Dec 2011 was 2,257.5 mm (October 388.0 mm); the tide peaked at 2.53 m on 30 Oct 2011 at the Royal Thai Navy HQ gauge (HII). Nationally: THB 1.43 trillion damage and losses (World Bank).",
    sourceId: "hii-flood-2011-record",
    sourceIds: ["hii-flood-2011-record", "worldbank-thai-flood-2011-overview"],
    peakValues: [
      { label: "Bangkok rainfall, 1 Jan – 1 Dec 2011 (BMA DDS)", value: 2257.5, unit: "mm", period: "2011-01-01/2011-12-01", place: "Bangkok (BMA DDS gauges)", status: "observed", sourceId: "hii-flood-2011-record", quoteTh: Q("hii-flood-2011-record", "ในวันที่ 1 ธันวาคม 2554 มีปริมาณฝนสะสมตั้งแต่ต้นปีอยู่ที่ 2,257.5 มิลลิเมตร") },
      { label: "Bangkok monthly rainfall, October 2011 (highest month)", value: 388.0, unit: "mm/month", period: "2011-10", place: "Bangkok (BMA DDS gauges)", status: "observed", sourceId: "hii-flood-2011-record", quoteTh: Q("hii-flood-2011-record", "เดือนตุลาคมมีปริมาณฝนสะสมสูงที่สุดอยู่ที่ 388.0 มิลลิเมตร") },
      { label: "Peak tide level, late October 2011", value: 2.53, unit: "m (datum not stated in the source)", period: "2011-10-30", place: "Royal Thai Navy Headquarters gauge (Royal Thai Navy Hydrographic Department)", status: "observed", sourceId: "hii-flood-2011-record", quoteTh: Q("hii-flood-2011-record", "ระดับน้ำสูงสุด อยู่ที่ 2.53 เมตร ในวันที่ 30 ตุลาคม") },
      { label: "Peak tide level, mid-November 2011", value: 2.41, unit: "m (datum not stated in the source)", period: "2011-11-12", place: "Royal Thai Navy Headquarters gauge", status: "observed", sourceId: "hii-flood-2011-record", quoteTh: Q("hii-flood-2011-record", "ช่วงกลางเดือนระดับน้ำสูงสุดอยู่ที่ 2.41 เมตร ในวันที่ 12 พฤศจิกายน") },
      { label: "National damage and losses (World Bank)", value: 1.43, unit: "trillion THB", period: "2011 (losses assumed over 2011–2013)", place: "Thailand (national)", status: "observed", sourceId: "worldbank-thai-flood-2011-overview", quoteEn: Q("worldbank-thai-flood-2011-overview", "THB 1.43 trillion (USD 46.5 billion)") },
    ],
    affectedDistricts: {
      count: 32,
      namedTh: ["สายไหม", "คลองสามวา"],
      scope: "Count from the DDPM October 2011 situation summary as reproduced by HII; HII also names Sai Mai and Khlong Sam Wa as areas where water from the north could not drain. A complete per-district list is not given in the cited sources.",
      sourceId: "hii-flood-2011-record",
    },
    eventWindowNote: "from/to bound the reporting window in which DDPM lists Bangkok as affected (October 2011 report → 30 Nov 2011 report, when Bangkok was still affected); district-level onset and recession dates are not stated in the cited sources. Nationally the flood lasted July–December 2011 (World Bank).",
  };
  Q("hii-flood-2011-record", "เป็นพื้นที่หนึ่งซึ่งเกิดน้ำท่วมหนักในรอบ 70 ปี หากนับจากเหตุการณ์น้ำท่วมกรุงเทพมหานครในปี 2485");
  Q("hii-flood-2011-record", "จังหวัดกรุงเทพมหานคร รวม 147 อาเภอ 1,132 ตาบล 8,319 หมู่บ้าน 32 เขต");
  Q("hii-flood-2011-record", "แขตสายไหมและเขตคลองสามวา ไม่สามารถระบายลงสู่ระบบคลองไปยังสถานีสูบชายทะเลได้");
  Q("worldbank-thai-flood-2011-overview", "affected more than 13 million people from July through December 2011");

  const ev2022: ExtFlood = {
    id: "bkk-flood-2022-05-17",
    cityId: "bangkok",
    titleTh: "น้ำท่วมขังจากฝนตกหนัก กรุงเทพฯ 17–18 พ.ค. 2565",
    titleEn: "Heavy-rain urban flooding, Bangkok, 17–18 May 2022",
    from: "2022-05-17",
    to: "2022-05-18",
    summaryTh:
      "มวลอากาศเย็นจากจีนร่วมกับมรสุมตะวันตกเฉียงใต้ทำให้ฝนตกหนักมาก: สถานีวัดฝน สนน. 35 สถานีวัดได้เกิน 90 มม./วัน (21 สถานีเกิน 100 มม.) สูงสุด 136.0 มม. ที่สถานี ซ.สะพานขวา (07.00 น. 17 พ.ค. – 07.00 น. 18 พ.ค. 2565) เกิดน้ำท่วมบนถนนหลายสาย เช่น รัชดาภิเษก แจ้งวัฒนะ พหลโยธิน วิภาวดีรังสิต ลาดพร้าว (ThaiWater/สสน.)",
    summaryEn:
      "A cold air mass from China with the southwest monsoon brought very heavy rain: 35 BMA DDS gauges exceeded 90 mm/day (21 exceeded 100 mm), peaking at 136.0 mm at Soi Saphan Khwai station (07:00 17 May – 07:00 18 May 2022). Flooding was reported on many roads, e.g. Ratchadaphisek, Chaengwattana, Phahonyothin, Vibhavadi-Rangsit, Lat Phrao (ThaiWater/HII).",
    peakRainMm: {
      value: 136.0,
      unit: "mm/day",
      provenance: prov({
        status: "observed",
        sourceId: "thaiwater-floodbkk-may2022",
        sourceName: "ThaiWater/HII — Flooding in Bangkok, 17–18 May 2022",
        sourceUrl: "https://www.thaiwater.net/uploads/contents/current/2022/FloodBKK_May2022/summary.html",
        observedFrom: "2022-05-17",
        observedTo: "2022-05-18",
        referenceYear: 2022,
        geographicScope: "BMA DDS rain gauge 'ซ.สะพานขวา' (Soi Saphan Khwai), Bangkok",
        methodology: "Maximum 24-hour gauge rainfall (07:00 17 May → 07:00 18 May 2022) among BMA DDS stations, as published by HII.",
        limitations: ["Single-gauge maximum; not an areal average.", "The English text of the source gives a two-day window; the Thai original (one day) is used."],
      }),
    },
    sourceId: "thaiwater-floodbkk-may2022",
    sourceIds: ["thaiwater-floodbkk-may2022"],
    peakValues: [
      { label: "Highest 24-h gauge rainfall (BMA DDS)", value: 136.0, unit: "mm/day", period: "2022-05-17T07:00+07:00/2022-05-18T07:00+07:00", place: "ซ.สะพานขวา (Soi Saphan Khwai)", status: "observed", sourceId: "thaiwater-floodbkk-may2022", quoteTh: Q("thaiwater-floodbkk-may2022", "สถานี ซ.สะพานขวา มีฝนตกมากที่สุด 136.0 มิลลิเมตรต่อวัน") },
      { label: "Gauges above 90 mm/day", value: 35, unit: "stations", period: "2022-05-17T07:00+07:00/2022-05-18T07:00+07:00", place: "Bangkok (BMA DDS network)", status: "observed", sourceId: "thaiwater-floodbkk-may2022", quoteTh: Q("thaiwater-floodbkk-may2022", "ทั้งหมด 35 สถานี โดยมีสถานีที่วัดฝนได้เกิน 100 มิลลิเมตรอยู่ถึง 21 สถานี") },
    ],
    affectedDistricts: null,
    eventWindowNote: "Rain and road flooding from the evening of 17 May to the morning of 18 May 2022, as stated by the source.",
  };

  const ev2026: ExtFlood = {
    id: "bkk-flood-2026-09-25",
    cityId: "bangkok",
    titleTh: "ฝนตกหนักและน้ำท่วมขัง กรุงเทพฯ 25–27 ก.ย. 2569 (ประกาศพื้นที่ประสบสาธารณภัย 50 เขต)",
    titleEn: "Heavy rain and flooding, Bangkok, 25–27 Sep 2026 (disaster area declared for all 50 districts)",
    from: "2026-09-24",
    to: "2026-09-27",
    summaryTh:
      "ฝนตกต่อเนื่องเกือบ 48 ชั่วโมงตั้งแต่ 16.00 น. 24 ก.ย. 2569 ฝนสะสมใกล้ 300 มม. (มีนบุรี 274.5 มม., คลองสามวา 273.0 มม. ณ 06.00 น. 26 ก.ย.) ฝน 24 ชม. สูงสุด 210.0 มม. ที่จุดวัดเทศบาลสงเคราะห์ เขตจตุจักร (07.00 น. 25 ก.ย. – 07.00 น. 26 ก.ย.) กทม. ขยายประกาศเขตพื้นที่ประสบสาธารณภัยจาก 3 เขตเป็นทั้ง 50 เขต มีผลตั้งแต่ 25 ก.ย. 2569 และเดินเครื่องสูบน้ำเต็มกำลังรวม 1,200 ลบ.ม./วินาที (กทม. ผ่าน Thai PBS)",
    summaryEn:
      "Almost 48 hours of continuous rain from 16:00 on 24 Sep 2026, with accumulations near 300 mm (Min Buri 274.5 mm, Khlong Sam Wa 273.0 mm by 06:00 on 26 Sep). Highest 24-h gauge total 210.0 mm at Thetsaban Songkhro, Chatuchak (07:00 25 Sep → 07:00 26 Sep). The BMA extended its disaster-area declaration from 3 districts to all 50, effective 25 Sep 2026, and ran pumps at full capacity (1,200 m³/s) (BMA via Thai PBS).",
    peakRainMm: {
      value: 210.0,
      unit: "mm/day",
      provenance: prov({
        status: "observed",
        sourceId: "thaipbs-2026-09-27-bkk-rain-report",
        sourceName: "Thai PBS (27 Sep 2026) reporting BMA DDS rainfall 25–27 Sep 2026",
        sourceUrl: "https://www.thaipbs.or.th/news/content/558661",
        observedFrom: "2026-09-25",
        observedTo: "2026-09-26",
        referenceYear: 2026,
        geographicScope: "BMA DDS rain gauge 'เทศบาลสงเคราะห์', Chatuchak district, Bangkok",
        methodology: "Maximum 24-hour gauge rainfall (07:00 25 Sep → 07:00 26 Sep 2026) among BMA stations, as reported by the BMA and published by Thai PBS.",
        limitations: ["Single-gauge maximum reported via news media; the BMA primary report was not retrieved."],
      }),
    },
    sourceId: "thaipbs-2026-09-27-bkk-rain-report",
    sourceIds: ["thaipbs-2026-09-27-bkk-rain-report", "thaipbs-2026-09-26-bkk-48h-rain", "thaipbs-2026-09-26-bkk-50-districts"],
    peakValues: [
      { label: "Highest 24-h gauge rainfall (BMA)", value: 210.0, unit: "mm/day", period: "2026-09-25T07:00+07:00/2026-09-26T07:00+07:00", place: "เทศบาลสงเคราะห์, เขตจตุจักร", status: "observed", sourceId: "thaipbs-2026-09-27-bkk-rain-report", quoteTh: Q("thaipbs-2026-09-27-bkk-rain-report", "ปริมาณฝนสูงสุดที่ จุดวัด เทศบาลสงเคราะห์ เขตจตตุจักร 210.0 มม.") },
      { label: "Accumulated rain since 16:00 24 Sep, Min Buri", value: 274.5, unit: "mm", period: "2026-09-24T16:00+07:00/2026-09-26T06:00+07:00", place: "เขตมีนบุรี", status: "observed", sourceId: "thaipbs-2026-09-26-bkk-48h-rain", quoteTh: Q("thaipbs-2026-09-26-bkk-48h-rain", "เขตมีนบุรีวัดได้ 274.5 มม. และคลองสามวา 273.0 มม.") },
      { label: "BMA pumping at full capacity, both banks", value: 1200, unit: "m³/s", period: "2026-09-26", place: "Bangkok", status: "observed", sourceId: "thaipbs-2026-09-26-bkk-48h-rain", quoteTh: Q("thaipbs-2026-09-26-bkk-48h-rain", "รวม 1,200 ลบ.ม./วินาที") },
    ],
    affectedDistricts: {
      count: 50,
      namedTh: ["หนองจอก", "สวนหลวง", "คันนายาว"],
      scope: "Disaster-area declaration (legal designation) extended from 3 districts (named) to all 50 districts, effective 25 Sep 2026 — a declaration, not a measured inundation extent.",
      sourceId: "thaipbs-2026-09-26-bkk-50-districts",
    },
    eventWindowNote: "from = start of the continuous rain (16:00 24 Sep 2026); to = end of the last BMA 24-h rainfall report cited (07:00 27 Sep 2026). Street flooding persisted in places after that.",
  };
  Q("thaipbs-2026-09-26-bkk-50-districts", "ขยายพื้นที่ประสบสาธารณภัยจากเดิม 3 เขต ครอบคลุมกรุงเทพฯ ทั้ง 50 เขต มีผลตั้งแต่ 25 ก.ย.2569");
  Q("thaipbs-2026-09-26-bkk-48h-rain", "ปริมาณฝนสะสมใกล้แตะ 300 มม.");

  const verify = checks.map((c) => ({ ...c, found: (texts.get(c.sourceId) ?? "").includes(collapse(c.quote)) }));
  const failed = verify.filter((v) => !v.found);
  const events = [ev2011, ev2022, ev2026];
  writeJson(path.join(STAGED, "bangkok-flood-events.json"), events);
  report.floods = { events: events.map((e) => e.id), quoteChecks: `${verify.length - failed.length}/${verify.length} verbatim`, failedQuotes: failed };
  if (failed.length) console.warn("WARNING: quotes not found verbatim:", failed);
}

// =============================================================================================
// 4. HOURLY RAIN (ERA5 events → HourlyRainEvent[])
// =============================================================================================
function buildHourly() {
  interface StagedEvent {
    id: string;
    cityId: CityId;
    titleEn: string;
    requestedPoint: { lat: number; lon: number; definition: string };
    modelPoint: { lat: number; lon: number };
    times: string[];
    values: (number | null)[];
    eventTotalMm: number;
    peakHour: { time: string; mm: number };
    maxRolling24hMm: { endTime: string; mm: number };
    provenance: DataProvenance;
    retrievedAt: string;
  }
  const staged = readJson<{ events: StagedEvent[] }>(path.join(STAGED, "rain-hourly-events.json"));
  const titles: Record<string, { th: string; en: string; extraLim: string[] }> = {
    "hatyai-2025-11-18_2025-11-27": {
      th: "ฝนรายชั่วโมง เหตุการณ์อุทกภัยหาดใหญ่ 18–27 พ.ย. 2568 (ข้อมูลประมาณการ ERA5)",
      en: "Hourly rainfall, Hat Yai flood event 18–27 Nov 2025 (ERA5 reanalysis estimate)",
      extraLim: ["Gauges recorded far more locally: ThaiWater reports 370.2 mm/day at the TMD Hat Yai station on 21 Nov 2025 vs 240 mm for this ERA5 cell's local day — use for timing/shape, not depth."],
    },
    "bangkok-heaviest-day-2026-09-26": {
      th: "ฝนรายชั่วโมง ช่วงฝนตกหนักกรุงเทพฯ 25–27 ก.ย. 2569 (ข้อมูลประมาณการ ERA5)",
      en: "Hourly rainfall, Bangkok heavy-rain event 25–27 Sep 2026 (ERA5 reanalysis estimate)",
      extraLim: ["This window coincides with the documented 25–27 Sep 2026 Bangkok flood; BMA gauges recorded up to 210.0 mm in 24 h (07:00 25 Sep → 07:00 26 Sep) versus 88 mm for this ERA5 cell's wettest local day — use for timing/shape, not depth."],
    },
  };
  const outByCity: Record<CityId, HourlyRainEvent[]> = { bangkok: [], hatyai: [] };
  const rep: Record<string, unknown>[] = [];
  for (const e of staged.events) {
    const t = titles[e.id];
    if (!t) throw new Error(`No title mapping for hourly event ${e.id}`);
    if (e.times.length !== e.values.length) throw new Error(`${e.id}: times/values length mismatch`);
    const sum = round(e.values.reduce<number>((s, v) => s + (v ?? 0), 0), 1);
    if (Math.abs(sum - e.eventTotalMm) > 0.05) throw new Error(`${e.id}: Σ hourly ${sum} ≠ staged total ${e.eventTotalMm}`);
    const ev: HourlyRainEvent = {
      id: e.id,
      cityId: e.cityId,
      titleTh: t.th,
      titleEn: t.en,
      lon: e.requestedPoint.lon,
      lat: e.requestedPoint.lat,
      times: e.times,
      values: e.values,
      provenance: {
        ...e.provenance,
        status: "estimated",
        methodology: `${e.provenance.methodology} Event total ${e.eventTotalMm} mm; peak hour ${e.peakHour.mm} mm ending ${e.peakHour.time}; max rolling 24 h ${e.maxRolling24hMm.mm} mm ending ${e.maxRolling24hMm.endTime}. Requested point ${e.requestedPoint.lat}°N ${e.requestedPoint.lon}°E (${e.requestedPoint.definition}); answering ERA5 cell ${e.modelPoint.lat}°N ${e.modelPoint.lon}°E. Retrieved ${e.retrievedAt}.`,
        limitations: [...(e.provenance.limitations ?? []), ...t.extraLim],
      },
    };
    outByCity[e.cityId].push(ev);
    rep.push({ id: e.id, cityId: e.cityId, hours: e.times.length, totalMm: sum, peakHour: e.peakHour, nulls: e.values.filter((v) => v === null).length });
  }
  for (const city of ["bangkok", "hatyai"] as CityId[]) writeJson(path.join(PUBLIC, city, "rain-hourly.json"), outByCity[city], true);
  report.hourly = rep;
}

// =============================================================================================
// main
// =============================================================================================
async function main() {
  const prevSources = fs.existsSync(path.join(STAGED, "hydrology-sources.json")) ? readJson<SourceRef[]>(path.join(STAGED, "hydrology-sources.json")) : [];
  for (const s of prevSources) sources.set(s.id, s); // keep entries of sections not run this time
  if (SECTIONS.has("waterlevels")) await buildWaterLevels();
  if (SECTIONS.has("drainage")) await buildDrainage();
  if (SECTIONS.has("floods")) await buildFloods();
  if (SECTIONS.has("hourly")) buildHourly();
  writeJson(path.join(STAGED, "hydrology-sources.json"), [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)));
  const reportPath = path.join(STAGED, "hydrology-report.json");
  const prev = fs.existsSync(reportPath) ? readJson<Record<string, unknown>>(reportPath) : {};
  writeJson(reportPath, {
    ...prev,
    ...report,
    fetchLog: fetchLog.map((f) => ({ id: f.id, url: f.meta.url, from: f.from, detail: f.detail, httpStatus: f.meta.httpStatus, retrievedAt: f.meta.retrievedAt, bytes: f.meta.bytes, file: path.relative(ROOT, f.file) })),
  });
  console.log(JSON.stringify(report, (k, v) => (k === "excluded" || k === "keyGauges" || k === "failedQuotes" ? (Array.isArray(v) ? `[${v.length}]` : v) : v), 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
