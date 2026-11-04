/**
 * Waste data gaps — Bangkok waste GENERATED (PCD) with an estimated district
 * allocation, Bangkok district-level composition (estimated), and Hat Yai
 * composition (Hat Yai-specific published shares).
 *
 *   npx tsx scripts/data/fetch-waste-gaps.ts            # fetch (polite), fall back to cached raw files
 *   npx tsx scripts/data/fetch-waste-gaps.ts --offline  # use cached raw files only
 *
 * Raw downloads are untrusted data and live under data/raw/<source>/ (parsed as
 * text, never executed). PDF text is extracted with macOS PDFKit
 * (scripts/data/lib/pdf-to-text.jxa.js) and cached next to the PDF as .txt with a
 * "#sha256:" header line, so the parse can be re-run without the (large) PDF.
 *
 * Inputs re-used from earlier ingestion (read-only):
 *   data/staged/bangkok-waste.json        (BMA collected tonnes by district, FY2562–FY2569)
 *   data/staged/bangkok-composition.json  (BMA FY2565 citywide composition, mapped to 6 categories)
 *
 * Outputs (deterministic for the same raw inputs; timestamps come from the
 * fetch manifest, not the wall clock):
 *   data/staged/bangkok-generated.json
 *   data/staged/bangkok-district-composition.json
 *   data/staged/hatyai-composition.json
 *   data/staged/waste-gaps-sources.json   (SourceRef[])
 *
 * Integrity: no value is invented. PCD's published Bangkok generation figure is
 * "observed"; the district split of it is "estimated" (allocation by collected
 * share); the city composition applied to districts is "estimated"; Hat Yai
 * shares re-mapped from a Hat Yai-specific publication are "derived".
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DataProvenance, SourceRef, WasteCategory } from "../../src/lib/types";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, "..", "..");
const RAW = path.join(ROOT, "data", "raw");
const STAGED = path.join(ROOT, "data", "staged");
const MANIFEST_PATH = path.join(RAW, "_manifests", "fetch-waste-gaps.json");
const PDF_TO_TEXT = path.join(ROOT, "scripts", "data", "lib", "pdf-to-text.jxa.js");
const UA = "UrbanIntelligenceDemo/0.1 (research prototype)";
const OFFLINE = process.argv.includes("--offline");

const CATS: WasteCategory[] = ["organic", "plastic", "paper", "glassMetal", "hazardous", "other"];

const PCD_BASE = "https://thaimsw.pcd.go.th";
/** PCD reporting years (BE) probed on thaimsw.pcd.go.th. */
const PCD_YEARS_BE = [2556, 2557, 2558, 2559, 2560, 2561, 2562, 2563, 2564, 2565, 2566, 2567, 2568, 2569, 2570];
/** Years for which a district allocation is produced (BMA FY district PDFs exist for FY2562–FY2569). */
const ALLOCATION_YEARS_BE = [2562, 2563, 2564, 2565, 2566, 2567, 2568, 2569];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const ensureDir = (p: string) => fs.mkdirSync(p, { recursive: true });
const round = (x: number, d: number) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
function writeJson(file: string, data: unknown) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function log(...args: unknown[]) {
  console.log("[waste-gaps]", ...args);
}
function fiscalRange(fyBE: number) {
  const endYear = fyBE - 543;
  return { from: `${endYear - 1}-10-01`, to: `${endYear}-09-30` };
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
  note?: string;
}
const manifest: Record<string, ManifestEntry> = fs.existsSync(MANIFEST_PATH)
  ? (JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Record<string, ManifestEntry>)
  : {};
/** Per-run log of every attempt (success, cache fallback, failure) for the notes/sources. */
const attempts: { rel: string; url: string; outcome: string }[] = [];

const lastHit = new Map<string, number>();
async function politeWait(host: string) {
  const last = lastHit.get(host) ?? 0;
  const wait = 1200 - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

async function httpGet(url: string): Promise<{ status: number; buf: Buffer; contentType: string }> {
  const host = new URL(url).host;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await politeWait(host);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(90_000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return { status: res.status, buf, contentType: res.headers.get("content-type") ?? "" };
    } catch (e) {
      lastErr = e;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

type Kind = "html" | "pdf";
function looksValid(buf: Buffer, kind: Kind): string | null {
  if (buf.length === 0) return "empty body";
  if (kind === "pdf" && buf.subarray(0, 5).toString("latin1") !== "%PDF-") return "not a PDF";
  if (kind === "html" && !/<html|<!doctype/i.test(buf.subarray(0, 2048).toString("utf8"))) return "not HTML";
  return null;
}

/** Fetch `url` into data/raw/<rel>; on any failure fall back to the cached file. */
async function getRaw(url: string, rel: string, kind: Kind): Promise<Buffer | null> {
  const file = path.join(RAW, rel);
  if (!OFFLINE) {
    try {
      const { status, buf, contentType } = await httpGet(url);
      const bad = status !== 200 ? `HTTP ${status}` : looksValid(buf, kind);
      if (!bad) {
        ensureDir(path.dirname(file));
        fs.writeFileSync(file, buf);
        manifest[rel] = {
          url,
          retrievedAt: new Date().toISOString(),
          httpStatus: status,
          bytes: buf.length,
          sha256: sha256(buf),
          contentType,
        };
        attempts.push({ rel, url, outcome: `retrieved (HTTP ${status}, ${buf.length} bytes)` });
        return buf;
      }
      attempts.push({ rel, url, outcome: `rejected: ${bad}` });
      log(`! ${url}: ${bad}`);
    } catch (e) {
      attempts.push({ rel, url, outcome: `network error: ${(e as Error).message}` });
      log(`! ${url}: ${(e as Error).message}`);
    }
  }
  if (fs.existsSync(file)) {
    const m = manifest[rel];
    attempts.push({ rel, url, outcome: `used cached copy${m ? ` from ${m.retrievedAt}` : ""}` });
    return fs.readFileSync(file);
  }
  attempts.push({ rel, url, outcome: "unavailable (no cache)" });
  return null;
}

/**
 * Text layer of a (possibly large) PDF. Uses the cached .txt when present (so
 * the PDF itself need not be kept); otherwise downloads the PDF (online only)
 * and extracts it with macOS PDFKit.
 */
async function pdfText(url: string, rel: string): Promise<{ text: string | null; via: string }> {
  const pdfFile = path.join(RAW, rel);
  const txtFile = path.join(RAW, path.dirname(rel), "..", "text", path.basename(rel).replace(/\.pdf$/i, ".txt"));
  if (fs.existsSync(txtFile)) {
    attempts.push({ rel, url, outcome: `used cached text layer ${path.relative(RAW, txtFile)}` });
    return { text: fs.readFileSync(txtFile, "utf8"), via: "cached text layer" };
  }
  let buf: Buffer | null = fs.existsSync(pdfFile) ? fs.readFileSync(pdfFile) : null;
  if (!buf) buf = await getRaw(url, rel, "pdf");
  if (!buf) return { text: null, via: "PDF unavailable" };
  if (process.platform !== "darwin") return { text: null, via: "text extraction needs macOS PDFKit" };
  const tmp = txtFile + ".tmp";
  ensureDir(path.dirname(txtFile));
  execFileSync("osascript", ["-l", "JavaScript", PDF_TO_TEXT, pdfFile, tmp]);
  const body = fs.readFileSync(tmp, "utf8");
  fs.writeFileSync(txtFile, `#sha256:${sha256(buf)}\n#url:${url}\n${body}`, "utf8");
  fs.rmSync(tmp);
  if (!manifest[rel]) {
    manifest[rel] = {
      url,
      retrievedAt: new Date().toISOString(),
      httpStatus: 200,
      bytes: buf.length,
      sha256: sha256(buf),
      contentType: "application/pdf",
    };
  }
  return { text: body, via: "PDFKit text layer" };
}

/** Strip scripts, <option> lists and tags; collapse whitespace; decode basic entities. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<option[\s\S]*?<\/option>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}
const num = (s: string) => Number(s.replace(/,/g, ""));

/**
 * Largest-remainder apportionment in integer units.
 * `weights` are non-negative; returns integers summing exactly to `totalUnits`.
 * Ties are broken by input order (stable, deterministic).
 */
function apportion(totalUnits: number, weights: number[]): number[] {
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (wsum <= 0) throw new Error("apportion: zero weight sum");
  const quotas = weights.map((w) => (totalUnits * w) / wsum);
  const floors = quotas.map((q) => Math.floor(q + 1e-9));
  let left = totalUnits - floors.reduce((a, b) => a + b, 0);
  const order = quotas.map((q, i) => ({ i, r: q - Math.floor(q + 1e-9) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  if (left !== 0) throw new Error(`apportion: ${left} units left over`);
  return floors;
}

/** Map source categories to the 6 app categories and round shares to 0.1 summing to 100.0. */
function mapComposition(rows: { th: string; en: string; percent: number; mappedTo: WasteCategory }[]) {
  const unrounded = Object.fromEntries(CATS.map((c) => [c, 0])) as Record<WasteCategory, number>;
  for (const r of rows) unrounded[r.mappedTo] = round(unrounded[r.mappedTo] + r.percent, 4);
  const sourceSum = round(rows.reduce((a, r) => a + r.percent, 0), 4);
  const tenths = apportion(1000, CATS.map((c) => unrounded[c]));
  const shares = Object.fromEntries(CATS.map((c, i) => [c, tenths[i] / 10])) as Record<WasteCategory, number>;
  return { sourceSum, unrounded, shares, sharesSum: round(CATS.reduce((a, c) => a + shares[c], 0), 1) };
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------
const sources = new Map<string, SourceRef>();
function addSource(s: SourceRef) {
  sources.set(s.id, s);
}
const retrievedAtOf = (rel: string) => manifest[rel]?.retrievedAt;

// ---------------------------------------------------------------------------
// 1. PCD — Bangkok waste generated
// ---------------------------------------------------------------------------
interface PcdRow {
  yearBE: number;
  generated: number;
  utilised: number;
  disposedCorrectly: number;
  disposedIncorrectly: number;
  residualStockT: number;
}
interface PcdYear {
  yearBE: number;
  rel: string;
  url: string;
  bangkok: PcdRow | null;
  bangkokAllZero: boolean;
  nationalGeneratedMt: number | null;
  provinceAnnualMt: { generated: number; utilised: number; disposedCorrectly: number } | null;
  provinceRel: string | null;
  provinceUrl: string | null;
  issue?: string;
}

function parsePcdCountry(text: string, yearBE: number): Pick<PcdYear, "bangkok" | "bangkokAllZero" | "nationalGeneratedMt" | "issue"> {
  const yearHeader = text.match(/ปริมาณขยะมูลฝอยจำแนกตามจังหวัด ปี (\d{4})/);
  if (yearHeader && Number(yearHeader[1]) !== yearBE) {
    return { bangkok: null, bangkokAllZero: false, nationalGeneratedMt: null, issue: `page shows year ${yearHeader[1]} instead of ${yearBE}` };
  }
  const m = text.match(/กรุงเทพมหานคร ([\d,]+\.?\d*) ([\d,]+\.?\d*) ([\d,]+\.?\d*) ([\d,]+\.?\d*) ([\d,]+\.?\d*)/);
  const nat = text.match(/ข้อมูลสรุป ปี (\d{4}) ปริมาณขยะมูลฝอยที่เกิดขึ้น ([\d.]+) ล้านตัน/);
  const nationalGeneratedMt = nat && Number(nat[1]) === yearBE ? Number(nat[2]) : null;
  if (!m) return { bangkok: null, bangkokAllZero: false, nationalGeneratedMt, issue: "Bangkok row not found" };
  const vals = m.slice(1, 6).map(num);
  if (vals.every((v) => v === 0)) return { bangkok: null, bangkokAllZero: true, nationalGeneratedMt, issue: "Bangkok row is all zeros (year not yet reported)" };
  const [generated, utilised, disposedCorrectly, disposedIncorrectly, residualStockT] = vals;
  return { bangkok: { yearBE, generated, utilised, disposedCorrectly, disposedIncorrectly, residualStockT }, bangkokAllZero: false, nationalGeneratedMt };
}

function parsePcdProvince(text: string, yearBE: number): PcdYear["provinceAnnualMt"] {
  const g = text.match(new RegExp(`ข้อมูลสรุป ปี ${yearBE} ปริมาณขยะมูลฝอยที่เกิดขึ้น ([\\d.]+) ล้านตัน ปริมาณขยะมูลฝอยที่ถูกนำกลับมาใช้ประโยชน์ ([\\d.]+) ล้านตัน ปริมาณขยะมูลฝอยที่ถูกกำจัดถูกต้อง ([\\d.]+) ล้านตัน`));
  // The province table must list Bangkok (guards against the page silently showing another province).
  const row = text.match(/ขยะมูลฝอยตกค้าง \(ตัน\) กรุงเทพมหานคร [\d,]/);
  if (!g || !row) return null;
  return { generated: Number(g[1]), utilised: Number(g[2]), disposedCorrectly: Number(g[3]) };
}

async function fetchPcd(): Promise<PcdYear[]> {
  const out: PcdYear[] = [];
  for (const y of PCD_YEARS_BE) {
    const url = `${PCD_BASE}/report_country.php?year=${y}`;
    const rel = `pcd/report_country_${y}.html`;
    const buf = await getRaw(url, rel, "html");
    if (!buf) {
      out.push({ yearBE: y, rel, url, bangkok: null, bangkokAllZero: false, nationalGeneratedMt: null, provinceAnnualMt: null, provinceRel: null, provinceUrl: null, issue: "page unavailable" });
      continue;
    }
    const parsed = parsePcdCountry(htmlToText(buf.toString("utf8")), y);
    const rec: PcdYear = { yearBE: y, rel, url, ...parsed, provinceAnnualMt: null, provinceRel: null, provinceUrl: null };
    if (rec.bangkok && ALLOCATION_YEARS_BE.includes(y)) {
      // Bangkok province page: annual totals in million tonnes (cross-check of the t/day row).
      const pUrl = `${PCD_BASE}/report_province.php?year=${y}&province=1`;
      const pRel = `pcd/report_province_bkk_${y}.html`;
      const pBuf = await getRaw(pUrl, pRel, "html");
      if (pBuf) {
        rec.provinceAnnualMt = parsePcdProvince(htmlToText(pBuf.toString("utf8")), y);
        rec.provinceRel = pRel;
        rec.provinceUrl = pUrl;
      }
    }
    out.push(rec);
  }
  return out;
}

/** PCD annual PDF reports used to cross-check the web-system values. */
const PCD_REPORTS = [
  {
    id: "pcd-disposal-report-2566",
    yearBE: 2566,
    url: "https://www.pcd.go.th/wp-content/uploads/2024/05/pcdnew-2024-05-09_07-53-50_682275.pdf",
    rel: "pcd/reports/pcdnew-2024-05-09_07-53-50_682275.pdf",
    nameTh: "รายงานสถานการณ์สถานที่กำจัดขยะมูลฝอยชุมชนของประเทศไทย ปี พ.ศ. 2566",
    nameEn: "Situation report on community solid-waste disposal sites of Thailand, BE 2566 (2023)",
    // Table: "... 76 อุบลราชธานี ... กรุงเทพมหานคร 12,748 3,940 8,808 0"
    bangkokPattern: /กรุงเทพมหานคร ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+)\s*\n\s*รวม \(ตัน\/วัน\)/,
  },
  {
    id: "pcd-disposal-report-2564",
    yearBE: 2564,
    url: "https://www.pcd.go.th/wp-content/uploads/2022/08/pcdnew-2022-08-18_03-17-27_336926.pdf",
    rel: "pcd/reports/pcdnew-2022-08-18_03-17-27_336926.pdf",
    nameTh: "รายงานสถานการณ์สถานที่กำจัดขยะมูลฝอยชุมชนของประเทศไทย ปี พ.ศ. 2564",
    nameEn: "Situation report on community solid-waste disposal sites of Thailand, BE 2564 (2021)",
    // Narrative: "... กรุงเทพมหานคร 12,214 ตันต่อวัน ..."
    bangkokPattern: /กรุงเทพมหานคร ([\d,]+) ตันต่อวัน/,
  },
] as const;

async function pcdReportCrossChecks(pcd: PcdYear[]) {
  const checks: Record<string, unknown>[] = [];
  for (const r of PCD_REPORTS) {
    const { text, via } = await pdfText(r.url, r.rel);
    const web = pcd.find((p) => p.yearBE === r.yearBE)?.bangkok ?? null;
    let reportValue: number | null = null;
    let footnote: string | null = null;
    if (text) {
      const m = text.match(r.bangkokPattern);
      reportValue = m ? num(m[1]) : null;
      const fn = text.match(/1ข้อมูลขยะมูลฝอยที่เกิดขึ้น[^\n]*\n[^\n]*/);
      footnote = fn ? fn[0].replace(/\s+/g, " ").trim() : null;
    }
    checks.push({
      sourceId: r.id,
      yearBE: r.yearBE,
      textVia: via,
      reportBangkokGeneratedTPerDay: reportValue,
      webSystemBangkokGeneratedTPerDay: web?.generated ?? null,
      agrees: reportValue !== null && web !== null && reportValue === web.generated,
      generationFootnote: footnote,
    });
    addSource({
      id: r.id,
      nameTh: r.nameTh,
      nameEn: r.nameEn,
      url: r.url,
      publisher: "กรมควบคุมมลพิษ (Pollution Control Department, PCD)",
      license: "Not stated (Thai government publication)",
      retrievedAt: retrievedAtOf(r.rel),
      accessStatus: text ? "retrieved" : "failed",
      notes: `Used only to cross-check the thaimsw.pcd.go.th Bangkok figure for BE ${r.yearBE}. Text via ${via}. The PDF (${manifest[r.rel]?.bytes ?? "?"} bytes, sha256 ${manifest[r.rel]?.sha256 ?? "?"}) is not kept in data/raw because of its size; its text layer is cached under data/raw/pcd/text/.`,
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// BMA staged inputs
// ---------------------------------------------------------------------------
interface BmaHistory {
  year: number;
  fiscalYearBE: number;
  periodFrom: string | null;
  periodTo: string | null;
  valuePublished: number | null;
  tonnesPerDay: number | null;
  daysDivisor: number;
  status: string;
  seriesId: string;
  sourceId: string;
}
interface BmaDistrict {
  code: string;
  nameTh: string;
  nameEn: string;
  history: BmaHistory[];
}
interface BmaWaste {
  districts: BmaDistrict[];
  others: (BmaHistory & { code: string })[];
  cityTotals: { collected: { year: number; fiscalYearBE: number; tonnesPerDay: number; totalTonnes: number | null; sourceId: string }[] };
}
const FY_SERIES = "bma-env-collected-by-district-fy";

function bmaFy(bma: BmaWaste, fyBE: number) {
  const rows = bma.districts.map((d) => {
    const h = d.history.find((x) => x.fiscalYearBE === fyBE && x.seriesId === FY_SERIES);
    return { d, h: h && h.status === "observed" && h.valuePublished !== null ? h : null };
  });
  const other = bma.others.find((x) => x.fiscalYearBE === fyBE && x.seriesId === FY_SERIES) ?? null;
  return { rows, other };
}

// ---------------------------------------------------------------------------
// Build bangkok-generated.json
// ---------------------------------------------------------------------------
function buildBangkokGenerated(pcd: PcdYear[], bma: BmaWaste, reportChecks: Record<string, unknown>[]) {
  const periodNote =
    "PCD labels the figure 'ปี พ.ศ. <year>' and does not state whether it is a calendar or fiscal year. The PCD BE 2566 report footnote says generation data come from Department of Local Administration (DLA) reporting, 'data as of February 2024'. Treated here as reporting year = BE − 543 (e.g. BE 2568 → 2025); observedFrom/observedTo are therefore NOT set.";

  const citySeries = pcd
    .filter((p) => p.bangkok)
    .map((p) => {
      const b = p.bangkok!;
      const ann = p.provinceAnnualMt;
      return {
        yearBE: p.yearBE,
        year: p.yearBE - 543,
        definition: "generated",
        generatedTPerDay: b.generated,
        utilisedTPerDay: b.utilised,
        disposedCorrectlyTPerDay: b.disposedCorrectly,
        disposedIncorrectlyTPerDay: b.disposedIncorrectly,
        residualStockTonnes: b.residualStockT,
        unitPublished: "ตัน/วัน (t/day) — as published",
        annualGeneratedMtPublished: ann?.generated ?? null,
        annualCheck: ann
          ? {
              generatedTPerDayX365Mt: round((b.generated * 365) / 1e6, 3),
              generatedTPerDayX366Mt: round((b.generated * 366) / 1e6, 3),
              publishedMt: ann.generated,
              // PCD does not state its day divisor; record which (if any) reproduces the published annual value.
              matchingDivisor:
                round((b.generated * 365) / 1e6, 2) === ann.generated ? 365 : round((b.generated * 366) / 1e6, 2) === ann.generated ? 366 : null,
            }
          : {
              publishedMt: null,
              note:
                p.provinceRel === null
                  ? "Bangkok province page not fetched for this year."
                  : "The PCD Bangkok province page shows the annual summary fields blank for this year (no number printed).",
            },
        identityGeneratedEqualsUtilisedPlusDisposed: round(b.utilised + b.disposedCorrectly + b.disposedIncorrectly, 2) === b.generated,
        status: "observed" as const,
        sourceId: "pcd-thaimsw-report-country",
        sourceUrl: p.url,
      };
    });

  const notReported = pcd.filter((p) => p.bangkokAllZero).map((p) => p.yearBE);
  const latest = citySeries.reduce((a, b) => (b.yearBE > a.yearBE ? b : a));

  // Collected/generated cross-check per year (BMA FY with the same BE number).
  const collectedVsGenerated = citySeries.map((c) => {
    const bc = bma.cityTotals.collected.find((x) => x.fiscalYearBE === c.yearBE);
    return {
      yearBE: c.yearBE,
      pcdGeneratedTPerDay: c.generatedTPerDay,
      pcdDisposedCorrectlyTPerDay: c.disposedCorrectlyTPerDay,
      bmaCollectedFyTPerDay: bc?.tonnesPerDay ?? null,
      bmaCollectedOverPcdGenerated: bc ? round(bc.tonnesPerDay / c.generatedTPerDay, 4) : null,
      bmaCollectedOverPcdDisposedCorrectly: bc ? round(bc.tonnesPerDay / c.disposedCorrectlyTPerDay, 4) : null,
    };
  });

  // District allocation for every year where both PCD and a complete BMA FY table exist.
  const allocations = ALLOCATION_YEARS_BE.flatMap((yBE) => {
    const city = citySeries.find((c) => c.yearBE === yBE);
    if (!city) return [];
    const { rows, other } = bmaFy(bma, yBE);
    if (rows.some((r) => !r.h)) return [];
    const weights = rows.map((r) => r.h!.valuePublished!);
    const sum50 = round(weights.reduce((a, b) => a + b, 0), 2);
    const units = Math.round(city.generatedTPerDay * 100);
    const alloc = apportion(units, weights);
    const othersT = other?.valuePublished ?? null;
    return [
      {
        yearBE: yBE,
        year: yBE - 543,
        pcdGeneratedTPerDay: city.generatedTPerDay,
        bmaFiscalYearBE: yBE,
        bmaFiscalPeriod: fiscalRange(yBE),
        bmaSourceId: rows[0].h!.sourceId,
        sum50DistrictsCollectedTonnes: sum50,
        othersCollectedTonnes: othersT,
        grandTotalCollectedTonnes: othersT !== null ? round(sum50 + othersT, 2) : null,
        othersShareOfGrandTotal: othersT !== null ? round(othersT / (sum50 + othersT), 6) : null,
        districts: rows.map((r, i) => ({
          code: r.d.code,
          collectedTonnesFy: r.h!.valuePublished!,
          collectedTPerDayFy: r.h!.tonnesPerDay,
          share: round(r.h!.valuePublished! / weights.reduce((a, b) => a + b, 0), 8),
          generatedTPerDay: alloc[i] / 100,
        })),
        allocatedTotalTPerDay: round(alloc.reduce((a, b) => a + b, 0) / 100, 2),
      },
    ];
  });

  const latestAlloc = allocations.find((a) => a.yearBE === latest.yearBE) ?? null;
  if (!latestAlloc) throw new Error(`No district allocation possible for latest PCD year ${latest.yearBE}`);

  const methodology = (yBE: number) =>
    `district generated (t/day) = PCD Bangkok generated BE ${yBE} (t/day) × district share, where share = district collected tonnes ÷ sum of the 50 district offices' collected tonnes in BMA fiscal year BE ${yBE} (${fiscalRange(yBE).from} → ${fiscalRange(yBE).to}, BMA Environment Department annual table). The BMA 'Others' row (waste delivered by sources other than the 50 district offices) is EXCLUDED from the share denominator, so its generation is implicitly spread pro rata over the 50 districts and the 50 district values sum exactly to the PCD city total. Rounded to 0.01 t/day with the largest-remainder method (ties by DOPA code order).`;

  const limitations = [
    "Allocation assumes each district's share of generation equals its share of BMA-collected tonnage. Districts with more recycling/sale at source or less collection coverage are under-estimated, and vice versa. No district generation survey exists.",
    "PCD's Bangkok 'generated' equals utilised + correctly disposed (an accounting identity in PCD's table), not an independent measurement at source.",
    "PCD reporting-year basis (calendar vs fiscal) is not stated; matched to the BMA fiscal year with the same BE number.",
    "The BMA 'Others' row (Environment Department's own collection) cannot be located in a district; it is spread pro rata.",
  ];

  const districts = bma.districts.map((d) => {
    const cur = latestAlloc.districts.find((x) => x.code === d.code)!;
    const provenance: DataProvenance = {
      status: "estimated",
      sourceId: "pcd-thaimsw-report-country",
      sourceName: "PCD สถานการณ์ขยะมูลฝอยของประเทศ (city total) × BMA Environment Department collected-by-district share",
      sourceUrl: latest.sourceUrl,
      referenceYear: latest.year,
      geographicScope: `District ${d.code} ${d.nameEn} (allocated from the Bangkok-wide PCD total)`,
      methodology: methodology(latest.yearBE),
      limitations,
    };
    return {
      code: d.code,
      areaId: `bkk-${d.code}`,
      nameTh: d.nameTh,
      nameEn: d.nameEn,
      wasteGenerated: { value: cur.generatedTPerDay, unit: "t/day", provenance },
      allocationInputs: {
        bmaFiscalYearBE: latestAlloc.bmaFiscalYearBE,
        collectedTonnesFy: cur.collectedTonnesFy,
        collectedTPerDayFy: cur.collectedTPerDayFy,
        shareOf50Districts: cur.share,
        bmaSourceId: latestAlloc.bmaSourceId,
      },
      history: allocations.map((a) => {
        const x = a.districts.find((k) => k.code === d.code)!;
        return { year: a.year, yearBE: a.yearBE, value: x.generatedTPerDay, unit: "t/day", status: "estimated" as const, bmaFiscalYearBE: a.bmaFiscalYearBE };
      }),
    };
  });

  const sumLatest = round(districts.reduce((a, d) => a + (d.wasteGenerated.value ?? 0), 0), 2);

  return {
    cityId: "bangkok",
    dataRetrievedAt: manifest[`pcd/report_country_${latest.yearBE}.html`]?.retrievedAt ?? null,
    definition:
      "Waste GENERATED (ขยะมูลฝอยที่เกิดขึ้น) as reported by the Pollution Control Department for Bangkok (province = BMA area). Distinct from BMA 'collected' (มูลฝอยที่จัดเก็บได้), which excludes waste recycled/sold at source.",
    periodNote,
    city: {
      wasteGenerated: {
        value: latest.generatedTPerDay,
        unit: "t/day",
        provenance: {
          status: "observed",
          sourceId: "pcd-thaimsw-report-country",
          sourceName: "กรมควบคุมมลพิษ — ระบบสารสนเทศด้านการจัดการขยะมูลฝอยชุมชน: ข้อมูลสถานการณ์ขยะมูลฝอยของประเทศ",
          sourceUrl: latest.sourceUrl,
          referenceYear: latest.year,
          geographicScope: "Bangkok (กรุงเทพมหานคร) — whole BMA area, province row of the PCD national table",
          methodology: `Published value 'ขยะมูลฝอยที่เกิดขึ้น (ตัน/วัน)' for กรุงเทพมหานคร, PCD reporting year BE ${latest.yearBE}; copied as published (no conversion).`,
          limitations: [
            "PCD does not state calendar vs fiscal year; observation period not set.",
            "PCD Bangkok 'generated' = utilised + correctly disposed (accounting identity in the PCD table).",
            `Later PCD years (${notReported.join(", ") || "none"}) show all-zero rows on the PCD system (not yet reported) and are treated as unavailable, not 0.`,
          ],
        } satisfies DataProvenance,
      },
      latestYearBE: latest.yearBE,
      latestComponents: {
        utilisedTPerDay: latest.utilisedTPerDay,
        disposedCorrectlyTPerDay: latest.disposedCorrectlyTPerDay,
        disposedIncorrectlyTPerDay: latest.disposedIncorrectlyTPerDay,
        residualStockTonnes: latest.residualStockTonnes,
        annualGeneratedMtPublished: latest.annualGeneratedMtPublished,
      },
      yearsNotYetReportedBE: notReported,
    },
    citySeries,
    allocationMethod: {
      summary: methodology(latest.yearBE),
      othersRowIncluded: false,
      othersRowTreatment:
        "Excluded from the share denominator (shares are over the 50 district offices only); the allocated city total therefore equals the full PCD Bangkok total and the 'Others' tonnage is implicitly redistributed pro rata. No separate 'unallocated' row is produced.",
      rounding: "Integer hundredths of t/day; floor of each quota, then +0.01 to the largest fractional remainders (ties by DOPA code order) until the sum equals the PCD total exactly.",
      fiscalYearMatching:
        "PCD BE year Y ↔ BMA fiscal year BE Y (1 Oct Y−544 → 30 Sep Y−543). If PCD's year is a calendar year this overlaps 9 of 12 months; it is the closest available BMA district table.",
      status: "estimated",
    },
    latestAllocation: {
      yearBE: latestAlloc.yearBE,
      pcdGeneratedTPerDay: latestAlloc.pcdGeneratedTPerDay,
      sum50DistrictsCollectedTonnes: latestAlloc.sum50DistrictsCollectedTonnes,
      othersCollectedTonnes: latestAlloc.othersCollectedTonnes,
      grandTotalCollectedTonnes: latestAlloc.grandTotalCollectedTonnes,
      othersShareOfGrandTotal: latestAlloc.othersShareOfGrandTotal,
      allocatedTotalTPerDay: latestAlloc.allocatedTotalTPerDay,
      sumOfDistrictValuesTPerDay: sumLatest,
    },
    districts,
    allocationsByYear: allocations.map(({ districts: ds, ...rest }) => ({ ...rest, districtCount: ds.length })),
    checks: {
      districtCount: districts.length,
      latestSumEqualsCityTotal: sumLatest === latest.generatedTPerDay,
      everyYearSumEqualsCityTotal: allocations.every((a) => a.allocatedTotalTPerDay === a.pcdGeneratedTPerDay),
      collectedVsGenerated,
      pcdReportCrossChecks: reportChecks,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Bangkok district composition
// ---------------------------------------------------------------------------
type CompRow = { th: string; en: string; percent: number; mappedTo: WasteCategory };

/**
 * Per-disposal-centre columns of the BMA physical-composition tables (scanned
 * PDFs, no text layer) — transcribed from the PDF images; every column is
 * verified to sum to 100.00 below. Reference only (see notes): BMA does not
 * publish which districts deliver to which centre.
 */
const CENTRE_TABLES: {
  fiscalYearBE: number;
  sourceId: string;
  centres: string[];
  centresEn: string[];
  rows: { th: string; en: string; mappedTo: WasteCategory; values: number[]; average: number }[];
  footnote?: string;
}[] = [
  {
    fiscalYearBE: 2563,
    sourceId: "bma-env-composition-fy2563",
    centres: ["อ่อนนุช", "หนองแขม", "สายไหม"],
    centresEn: ["On Nut", "Nong Khaem", "Sai Mai"],
    rows: [
      { th: "เศษอาหาร", en: "Food waste", mappedTo: "organic", values: [43.77, 46.55, 45.92], average: 45.41 },
      { th: "กิ่งไม้และใบไม้", en: "Wood, branches and leaves", mappedTo: "organic", values: [4.26, 6.45, 6.56], average: 5.76 },
      { th: "กระดาษที่สามารถรีไซเคิลได้", en: "Paper, recyclable", mappedTo: "paper", values: [3.08, 2.49, 2.55], average: 2.71 },
      { th: "พลาสติกที่สามารถรีไซเคิลได้", en: "Plastic, recyclable", mappedTo: "plastic", values: [6.35, 4.1, 4.37], average: 4.94 },
      { th: "โฟม", en: "Foam (expanded polystyrene)", mappedTo: "plastic", values: [1.5, 1.31, 1.2], average: 1.34 },
      { th: "แก้ว", en: "Glass", mappedTo: "glassMetal", values: [1.54, 2.98, 2.37], average: 2.3 },
      { th: "โลหะ", en: "Metal", mappedTo: "glassMetal", values: [1.1, 1.61, 1.43], average: 1.38 },
      { th: "กระดาษที่ไม่สามารถรีไซเคิลได้", en: "Paper, non-recyclable", mappedTo: "paper", values: [12.85, 11.07, 10.01], average: 11.31 },
      { th: "พลาสติกที่ไม่สามารถรีไซเคิลได้", en: "Plastic, non-recyclable", mappedTo: "plastic", values: [17.47, 15.36, 16.08], average: 16.3 },
      { th: "หนังและยาง", en: "Leather and rubber", mappedTo: "other", values: [1.13, 0.81, 1.22], average: 1.05 },
      { th: "ผ้าและสิ่งทอ", en: "Textiles", mappedTo: "other", values: [3.78, 3.78, 4.89], average: 4.15 },
      { th: "หินและเซรามิค", en: "Stone and ceramics", mappedTo: "other", values: [0.22, 0.15, 0.38], average: 0.25 },
      { th: "กระดูกและเปลือกหอย", en: "Bones and shells", mappedTo: "other", values: [1.03, 1.25, 1.02], average: 1.1 },
      { th: "ผ้าอ้อมสำเร็จรูป", en: "Disposable diapers", mappedTo: "other", values: [1.92, 2.09, 2.0], average: 2.0 },
    ],
  },
  {
    fiscalYearBE: 2564,
    sourceId: "bma-env-composition-fy2564",
    centres: ["อ่อนนุช", "สายไหม", "หนองแขม"],
    centresEn: ["On Nut", "Sai Mai", "Nong Khaem"],
    footnote:
      "Because of COVID-19, in July and August 2564 samples were taken only at the On Nut transfer station (PDF footnote).",
    rows: [
      { th: "เศษอาหาร", en: "Food waste", mappedTo: "organic", values: [46.01, 45.43, 47.2], average: 46.21 },
      { th: "ไม้และใบไม้", en: "Wood, branches and leaves", mappedTo: "organic", values: [4.48, 5.86, 8.75], average: 6.36 },
      { th: "กระดาษ recycle", en: "Paper, recyclable", mappedTo: "paper", values: [2.28, 1.92, 3.1], average: 2.43 },
      { th: "กระดาษ non recycle", en: "Paper, non-recyclable", mappedTo: "paper", values: [11.2, 10.27, 7.43], average: 9.63 },
      { th: "พลาสติก recycle", en: "Plastic, recyclable", mappedTo: "plastic", values: [2.2, 2.05, 2.19], average: 2.15 },
      { th: "พลาสติก non recycle", en: "Plastic, non-recyclable", mappedTo: "plastic", values: [19.4, 19.98, 18.7], average: 19.36 },
      { th: "โฟม", en: "Foam (expanded polystyrene)", mappedTo: "plastic", values: [1.15, 1.62, 1.38], average: 1.38 },
      { th: "แก้ว", en: "Glass", mappedTo: "glassMetal", values: [2.02, 2.36, 1.39], average: 1.92 },
      { th: "โลหะ", en: "Metal", mappedTo: "glassMetal", values: [1.5, 1.03, 1.01], average: 1.18 },
      { th: "หนังและยาง", en: "Leather and rubber", mappedTo: "other", values: [1.13, 0.81, 1.05], average: 1.0 },
      { th: "ผ้าและสิ่งทอ", en: "Textiles", mappedTo: "other", values: [5.38, 5.96, 5.12], average: 5.49 },
      { th: "หินและเซรามิค", en: "Stone and ceramics", mappedTo: "other", values: [0.52, 0.21, 0.64], average: 0.46 },
      { th: "กระดูกและเปลือกหอย", en: "Bones and shells", mappedTo: "other", values: [1.43, 1.03, 1.14], average: 1.2 },
      { th: "ผ้าอ้อมสำเร็จรูป", en: "Disposable diapers", mappedTo: "other", values: [1.3, 1.47, 0.9], average: 1.23 },
    ],
  },
];

interface BmaComposition {
  composition: { shares: Record<WasteCategory, number>; provenance: DataProvenance };
  primary: { fiscalYearBE: number; referenceYear: number; observedFrom: string; observedTo: string; sourceId: string; sampleScope: string; sourceCategories: CompRow[]; sharesSum: number };
  history: { fiscalYearBE: number; sourceCategories: CompRow[] }[];
  mappingRationale: string[];
}

function buildDistrictComposition(bma: BmaWaste, comp: BmaComposition) {
  const p = comp.primary;
  const re = mapComposition(p.sourceCategories);
  for (const c of CATS) {
    if (re.shares[c] !== comp.composition.shares[c]) throw new Error(`FY2565 re-mapping mismatch for ${c}: ${re.shares[c]} vs ${comp.composition.shares[c]}`);
  }

  const centreTables = CENTRE_TABLES.map((t) => {
    // Verify the transcription: each centre column and the average sum to 100.00,
    // and the average column matches the city history already staged.
    const colSums = t.centres.map((_, i) => round(t.rows.reduce((a, r) => a + r.values[i], 0), 2));
    const avgSum = round(t.rows.reduce((a, r) => a + r.average, 0), 2);
    if (colSums.some((s) => s !== 100) || avgSum !== 100) throw new Error(`FY${t.fiscalYearBE} centre transcription sums ${colSums.join("/")} avg ${avgSum}`);
    const staged = comp.history.find((h) => h.fiscalYearBE === t.fiscalYearBE);
    const avgMatchesStagedCityHistory =
      !!staged && t.rows.every((r) => staged.sourceCategories.some((s) => s.percent === r.average && s.mappedTo === r.mappedTo));
    return {
      fiscalYearBE: t.fiscalYearBE,
      referenceYear: t.fiscalYearBE - 543,
      period: fiscalRange(t.fiscalYearBE),
      sourceId: t.sourceId,
      unit: "% by weight (ร้อยละโดยน้ำหนัก)",
      footnote: t.footnote ?? null,
      transcription: "Manual transcription of every column of the scanned table (no text layer); each column verified to sum to 100.00.",
      avgMatchesStagedCityHistory,
      centres: t.centres.map((th, i) => {
        const m = mapComposition(t.rows.map((r) => ({ th: r.th, en: r.en, percent: r.values[i], mappedTo: r.mappedTo })));
        return { nameTh: `ศูนย์กำจัดมูลฝอย${th}`, nameEn: `${t.centresEn[i]} disposal centre`, columnSum: colSums[i], sharesUnrounded: m.unrounded, shares: m.shares, status: "derived" as const };
      }),
    };
  });

  const methodology =
    `City composition applied; district surveys unavailable. Every district receives the BMA citywide physical composition for fiscal year BE ${p.fiscalYearBE} (${p.observedFrom} → ${p.observedTo}), mapped to the 6 app categories and rounded to 0.1 (largest remainder) exactly as in bangkok-composition.json.`;
  const limitations = [
    "Not a district measurement: identical shares in all 50 districts. Real composition differs by land use (markets, offices, housing).",
    "BMA does not publish composition by district or by district group (กลุ่มเขต). It publishes composition by disposal centre (On Nut / Nong Khaem / Sai Mai) for FY2563 and FY2564 only; no official district → disposal-centre assignment was found (and assignments change, e.g. temporary diversions to On Nut), so per-centre values are NOT applied to districts.",
    "Hazardous 0.0 = no hazardous category in the BMA table (household hazardous waste is reported separately); not a measured zero.",
    "Composition is of collected waste sampled at BMA disposal facilities, not of waste generated at source.",
  ];

  const districts = bma.districts.map((d) => ({
    code: d.code,
    areaId: `bkk-${d.code}`,
    nameTh: d.nameTh,
    nameEn: d.nameEn,
    composition: {
      shares: { ...comp.composition.shares },
      provenance: {
        status: "estimated",
        sourceId: p.sourceId,
        sourceName: comp.composition.provenance.sourceName,
        sourceUrl: comp.composition.provenance.sourceUrl,
        observedFrom: p.observedFrom,
        observedTo: p.observedTo,
        referenceYear: p.referenceYear,
        geographicScope: `Bangkok citywide composition applied to district ${d.code} ${d.nameEn}`,
        methodology,
        limitations,
      } satisfies DataProvenance,
    },
  }));

  return {
    cityId: "bangkok",
    method: "city composition applied; district surveys unavailable",
    status: "estimated",
    baseComposition: {
      fiscalYearBE: p.fiscalYearBE,
      referenceYear: p.referenceYear,
      sourceId: p.sourceId,
      shares: comp.composition.shares,
      sharesSum: re.sharesSum,
      sampleScope: p.sampleScope,
      mappingRationale: comp.mappingRationale,
    },
    zoneResearch: {
      question: "Does BMA publish waste composition by district group (กลุ่มเขต) or by district?",
      answer: "No (as of retrieval). BMA Environment Department composition pages (webportal.bangkok.go.th/environmentbma/page/sub/20995 and /28232) publish citywide tables for FY2563, FY2564 and FY2565 only; the FY2563 and FY2564 tables also give one column per disposal centre (On Nut, Nong Khaem, Sai Mai). No กลุ่มเขต breakdown and no district → disposal-centre assignment table was found on BMA pages, data.bangkok.go.th or by web search.",
      consequence: "Per-zone ('derived') composition is not possible; the citywide FY2565 composition is applied to each district ('estimated').",
      disposalCentreTables: centreTables,
    },
    districts,
    checks: {
      districtCount: districts.length,
      everyDistrictSumsTo100: districts.every((d) => round(CATS.reduce((a, c) => a + d.composition.shares[c], 0), 1) === 100),
      fy2565RemappingMatchesStagedCityComposition: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Hat Yai composition
// ---------------------------------------------------------------------------
const PSU_URL = "https://kb.psu.ac.th/psukb/bitstream/2016/19489/1/64052245_400371.pdf";
const PSU_REL = "psu/64052245_400371.pdf";
const PMC_REL = "pmc/hatyai/PMC12247160.html";

async function buildHatyaiComposition() {
  // (a) PMC12247160 — re-verify that the article has no composition table (cached by fetch-hatyai.ts).
  let pmcCheck: Record<string, unknown> = { checked: false };
  const pmcFile = path.join(RAW, PMC_REL);
  if (fs.existsSync(pmcFile)) {
    const html = fs.readFileSync(pmcFile, "utf8");
    const tables = (html.match(/<table/gi) ?? []).length;
    const text = htmlToText(html);
    const pctNearWaste = /(food|organic)[^.]{0,80}\d+(\.\d+)?\s?%/i.test(text);
    pmcCheck = {
      checked: true,
      file: `data/raw/${PMC_REL}`,
      tableCount: tables,
      hasCompositionTable: false,
      foodOrOrganicPercentInText: pctNearWaste,
      finding:
        "PMC12247160 contains one table (mechanical properties of plastics) and no Hat Yai waste-composition table; it only cites a qualitative ranking. Not usable for shares.",
    };
  }

  // (b) PSU / TSRI research report ENV6405051S (Hat Yai-specific shares).
  let psuBuf: Buffer | null = await getRaw(PSU_URL, PSU_REL, "pdf");
  let text: string | null = null;
  let via = "unavailable";
  if (psuBuf) {
    const txt = path.join(RAW, "psu", "text", "64052245_400371.txt");
    if (fs.existsSync(txt) && fs.readFileSync(txt, "utf8").startsWith(`#sha256:${sha256(psuBuf)}`)) {
      text = fs.readFileSync(txt, "utf8");
      via = "cached text layer";
    } else if (process.platform === "darwin") {
      ensureDir(path.dirname(txt));
      execFileSync("osascript", ["-l", "JavaScript", PDF_TO_TEXT, path.join(RAW, PSU_REL), txt + ".tmp"]);
      text = fs.readFileSync(txt + ".tmp", "utf8");
      fs.writeFileSync(txt, `#sha256:${sha256(psuBuf)}\n#url:${PSU_URL}\n${text}`, "utf8");
      fs.rmSync(txt + ".tmp");
      via = "PDFKit text layer";
    }
  }
  psuBuf = null;

  const sentenceRe =
    /มีองค[^\n]{0,4}ประกอบขยะ \(ณ เดือน สิงหาคม 2564\) ดังนี้\s*\n\s*เศษอาหาร ร[^\s]*ละ (\d+) กระดาษ ร[^\s]*ละ (\d+) พลาสติก ร[^\s]*ละ (\d+) แก[^\s]* ร[^\s]*ละ (\d+) โลหะ ร[^\s]*ละ (\d+) ยาง\/หนัง ร[^\s]*\s*\n?\s*ละ (\d+) ผ[^\s]* ร[^\s]*ละ (\d+) อื่นๆ ร[^\s]*ละ (\d+)/;
  const m = text ? text.match(sentenceRe) : null;
  const tonsRe = /ปริมาณขยะที่เกิดขึ้นในเขตเทศบาล (\d+) ตัน\/วัน/;
  const tons = text ? text.match(tonsRe) : null;

  let shares: Record<WasteCategory, number> | null = null;
  let mapped: ReturnType<typeof mapComposition> | null = null;
  let sourceCategories: CompRow[] = [];
  if (m) {
    const [food, paper, plastic, glass, metal, rubberLeather, textile, other] = m.slice(1, 9).map(Number);
    sourceCategories = [
      { th: "เศษอาหาร", en: "Food waste", percent: food, mappedTo: "organic" },
      { th: "กระดาษ", en: "Paper", percent: paper, mappedTo: "paper" },
      { th: "พลาสติก", en: "Plastic", percent: plastic, mappedTo: "plastic" },
      { th: "แก้ว", en: "Glass", percent: glass, mappedTo: "glassMetal" },
      { th: "โลหะ", en: "Metal", percent: metal, mappedTo: "glassMetal" },
      { th: "ยาง/หนัง", en: "Rubber/leather", percent: rubberLeather, mappedTo: "other" },
      { th: "ผ้า", en: "Textiles", percent: textile, mappedTo: "other" },
      { th: "อื่นๆ (อาทิ วัสดุที่ถอดแยกจากซากเครื่องใช้ไฟฟ้า)", en: "Others (e.g. parts dismantled from waste electrical appliances)", percent: other, mappedTo: "other" },
    ];
    mapped = mapComposition(sourceCategories);
    if (mapped.sourceSum !== 100) throw new Error(`PSU composition sums to ${mapped.sourceSum}`);
    shares = mapped.shares;
  }

  const bmaComp = JSON.parse(fs.readFileSync(path.join(STAGED, "bangkok-composition.json"), "utf8")) as BmaComposition;

  const provenance: DataProvenance = shares
    ? {
        status: "derived",
        sourceId: "psu-tsri-env6405051s-hatyai",
        sourceName:
          "รายงานวิจัยฉบับสมบูรณ์ ENV6405051S 'การศึกษาแนวทางการสร้างชุมชนขยะเป็นศูนย์ ด้วยการแปลงขยะเป็นพลังงาน' (คณะการจัดการสิ่งแวดล้อม ม.สงขลานครินทร์; ทุน กสว./TSRI ปีงบประมาณ 2564)",
        sourceUrl: PSU_URL,
        referenceYear: 2021,
        geographicScope: "Hat Yai City Municipality (เทศบาลนครหาดใหญ่), municipality-wide",
        methodology:
          "Published Hat Yai shares ('ณ เดือน สิงหาคม 2564', 8 categories, integer %, sum 100) mapped to the 6 app categories: organic = food; paper = paper; plastic = plastic; glassMetal = glass + metal; other = rubber/leather + textiles + others; hazardous = 0.0 (not a source category). Largest-remainder rounding to 0.1 (no change: inputs are integers).",
        limitations: [
          "Secondary statement in a research report (the report's step 4 'analyse secondary data from Hat Yai Municipality operations… composition of waste at source'); sampling design, sample size and basis (weight vs volume) are not stated.",
          "Shares are integers (±0.5 percentage-point precision).",
          "Plastic 49% / food 22% is very different from Bangkok (plastic 21.0%, organic 54.1%, BMA FY2565) and PCD national descriptions (organic ≈ 64%); it may reflect waste after organics diversion or a volume basis. Treat as indicative.",
          "Hazardous 0.0 = no hazardous category in the source (e-waste parts are inside 'others'); not a measured zero.",
          "Reference date August 2021 (BE 2564); predates the November 2025 flood.",
        ],
      }
    : {
        status: "unavailable",
        geographicScope: "Hat Yai City Municipality",
        methodology: "No Hat Yai composition table could be parsed.",
      };

  addSource({
    id: "psu-tsri-env6405051s-hatyai",
    nameTh: "รายงานวิจัยฉบับสมบูรณ์ การศึกษาแนวทางการสร้างชุมชนขยะเป็นศูนย์ ด้วยการแปลงขยะเป็นพลังงาน (ENV6405051S)",
    nameEn: "Final research report ENV6405051S: Feasibility Study of Waste to Energy for Sustainable Zero Waste Community (Hat Yai Municipality)",
    url: PSU_URL,
    publisher: "Prince of Songkla University, Faculty of Environmental Management (PSU Knowledge Bank; via Thai National Research Repository); funded by TSRI FY2564",
    license: "Not stated (institutional repository document)",
    retrievedAt: retrievedAtOf(PSU_REL),
    accessStatus: shares ? "retrieved" : "failed",
    notes: `PDF ${manifest[PSU_REL]?.bytes ?? "?"} bytes, sha256 ${manifest[PSU_REL]?.sha256 ?? "?"}; text via ${via}. Composition sentence on report pp. 3 and 27 (executive summary and section 1.6). Also states ~200 t/day generated (Aug 2564) and ~190 t/day collected (2564, weighed) — context only, not used.`,
  });

  return {
    cityId: "hatyai",
    composition: { shares, provenance },
    status: provenance.status,
    scope: "Hat Yai-specific (municipality-wide), not national or regional",
    primary: shares
      ? {
          sourceId: "psu-tsri-env6405051s-hatyai",
          asOf: "2021-08 (ณ เดือน สิงหาคม 2564, as stated)",
          referenceYear: 2021,
          textVia: via,
          quoteTh:
            "ปริมาณขยะที่เกิดขึ้นในเขตเทศบาล 200 ตัน/วัน มีองค์ประกอบขยะ (ณ เดือน สิงหาคม 2564) ดังนี้ เศษอาหาร ร้อยละ 22 กระดาษ ร้อยละ 12 พลาสติก ร้อยละ 49 แก้ว ร้อยละ 3 โลหะ ร้อยละ 1 ยาง/หนัง ร้อยละ 1 ผ้า ร้อยละ 4 อื่นๆ ร้อยละ 8 โดยอื่นๆ อาทิ วัสดุที่ถอดแยกจากซากเครื่องใช้ไฟฟ้า ฯลฯ",
          generatedTPerDayStatedInSameSentence: tons ? Number(tons[1]) : null,
          sourceCategories,
          sourceSum: mapped!.sourceSum,
          sharesUnrounded: mapped!.unrounded,
          shares,
          sharesSum: mapped!.sharesSum,
        }
      : null,
    mappingRationale: [
      "organic = food waste (the source has no separate yard-waste category).",
      "paper = paper; plastic = plastic (single categories in the source).",
      "glassMetal = glass 3 + metal 1.",
      "other = rubber/leather 1 + textiles 4 + others 8 (others include parts dismantled from waste appliances).",
      "hazardous = 0.0: not a category in the source; 0.0 means 'not reported', not a measured zero.",
    ],
    rounding: "Largest remainder on 0.1-percent units (inputs are whole percents, so the result equals the input).",
    alternativesConsidered: [
      { source: "PMC12247160 (journal article cited in hatyai-waste.json; cached HTML re-checked)", result: "no composition table", detail: pmcCheck },
      {
        source: "PSU report ENV6405051S landfill characterisation table (p. 40)",
        result: "not used",
        detail: "Five samples of landfill-mined waste from the Hat Yai landfill (May–July); describes aged landfill material, not current municipal waste; table layout is garbled in the text layer.",
      },
      {
        source: "PCD national composition (organic / recyclable / general / hazardous ≈ 64 / 30 / 3 / 3 %)",
        result: "not used",
        detail: "Four classes only; cannot be split into plastic / paper / glassMetal without inventing proportions. Hat Yai-specific shares were found, so a national fallback is not needed.",
      },
    ],
    comparison: {
      bangkokFy2565Shares: bmaComp.composition.shares,
      note: "Shown for context only — different city, year and method.",
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(OFFLINE ? "offline mode (cached raw files only)" : "online mode");
  const bma = JSON.parse(fs.readFileSync(path.join(STAGED, "bangkok-waste.json"), "utf8")) as BmaWaste;
  const bmaComp = JSON.parse(fs.readFileSync(path.join(STAGED, "bangkok-composition.json"), "utf8")) as BmaComposition;
  if (bma.districts.length !== 50) throw new Error(`expected 50 districts, got ${bma.districts.length}`);

  // --- 1. PCD generated
  const pcd = await fetchPcd();
  const reportChecks = await pcdReportCrossChecks(pcd);
  const generated = buildBangkokGenerated(pcd, bma, reportChecks);
  writeJson(path.join(STAGED, "bangkok-generated.json"), generated);
  log(`bangkok-generated.json: city ${generated.city.wasteGenerated.value} t/day (PCD BE ${generated.city.latestYearBE}); districts sum ${generated.latestAllocation.sumOfDistrictValuesTPerDay}`);

  const pcdRetrieved = pcd.filter((p) => manifest[p.rel]).map((p) => p.yearBE);
  addSource({
    id: "pcd-thaimsw-report-country",
    nameTh: "ระบบสารสนเทศด้านการจัดการขยะมูลฝอยชุมชน — ข้อมูลสถานการณ์ขยะมูลฝอยของประเทศ (ปริมาณขยะมูลฝอยจำแนกตามจังหวัด)",
    nameEn: "PCD community solid-waste information system — national MSW situation, waste by province (t/day)",
    url: `${PCD_BASE}/report_country.php`,
    publisher: "กรมควบคุมมลพิษ (Pollution Control Department, PCD)",
    license: "Not stated (Thai government web system, publicly accessible, no login)",
    retrievedAt: retrievedAtOf(`pcd/report_country_${generated.city.latestYearBE}.html`),
    accessStatus: "retrieved",
    notes: `Pages report_country.php?year=<BE> cached for BE ${pcdRetrieved.join(", ")}. Bangkok row parsed for ${generated.citySeries.map((c) => c.yearBE).join(", ")}; BE ${generated.city.yearsNotYetReportedBE.join(", ") || "-"} show all-zero rows (not yet reported). A one-page PDF export (service/api/report-country/export?year=2568) was also saved for reference.`,
  });
  addSource({
    id: "pcd-thaimsw-report-province-bkk",
    nameTh: "ข้อมูลสถานการณ์ขยะมูลฝอยของจังหวัด — กรุงเทพมหานคร",
    nameEn: "PCD community solid-waste information system — province report, Bangkok (annual million tonnes)",
    url: `${PCD_BASE}/report_province.php?province=1`,
    publisher: "กรมควบคุมมลพิษ (Pollution Control Department, PCD)",
    license: "Not stated (Thai government web system, publicly accessible, no login)",
    retrievedAt: retrievedAtOf(`pcd/report_province_bkk_${generated.city.latestYearBE}.html`),
    accessStatus: "retrieved",
    notes: "Used to cross-check t/day × 365 against the published annual million tonnes.",
  });
  addSource({
    id: "pcd-disposal-report-2565",
    nameTh: "รายงานสถานการณ์สถานที่กำจัดขยะมูลฝอยชุมชนของประเทศไทย ปี พ.ศ. 2565 (สันนิษฐาน)",
    nameEn: "PCD disposal-site situation report (assumed BE 2565 edition)",
    url: "https://www.pcd.go.th/wp-content/uploads/2023/04/pcdnew-2023-05-23_07-53-42_299799.pdf",
    publisher: "กรมควบคุมมลพิษ (Pollution Control Department, PCD)",
    retrievedAt: retrievedAtOf("pcd/reports/pcdnew-2023-05-23_07-53-42_299799.pdf"),
    accessStatus: "failed",
    notes: "HTTP 200, 58,888,943 bytes, 226 pages, sha256 434a53bbba84c42c26613fa82e1ae8649a72ee4e7458a196ed1ce18a78392fde — scanned images without a text layer, so it was not parsed (no OCR) and its edition year could not be confirmed. Deleted from data/raw because of size; not needed (BE 2564 and BE 2566 editions cross-check the web system).",
  });
  for (const id of ["bma-env-waste-fy2562", "bma-env-waste-fy2563", "bma-env-waste-fy2564", "bma-env-waste-fy2565", "bma-env-waste-fy2566", "bma-env-waste-fy2567", "bma-env-waste-fy2568", "bma-env-waste-fy2569"]) {
    addSource({
      id,
      nameEn: `BMA Environment Department collected waste by district, fiscal year BE ${id.slice(-4)}`,
      url: "https://webportal.bangkok.go.th/environmentbma/page/sub/28229",
      publisher: "กรุงเทพมหานคร — สำนักสิ่งแวดล้อม",
      accessStatus: "retrieved",
      notes: "Registered in bangkok-sources.json (fetch-bangkok.ts); re-used here via data/staged/bangkok-waste.json as allocation weights. Same id, see that registry for full metadata.",
    });
  }

  // --- 2. District composition
  const dComp = buildDistrictComposition(bma, bmaComp);
  writeJson(path.join(STAGED, "bangkok-district-composition.json"), dComp);
  log(`bangkok-district-composition.json: ${dComp.districts.length} districts, shares ${JSON.stringify(dComp.baseComposition.shares)}`);
  for (const id of ["bma-env-composition-fy2563", "bma-env-composition-fy2564", "bma-env-composition-fy2565"]) {
    addSource({
      id,
      nameEn: `BMA physical composition of Bangkok municipal solid waste, fiscal year BE ${id.slice(-4)}`,
      url: "https://webportal.bangkok.go.th/environmentbma/page/sub/20995",
      publisher: "กรุงเทพมหานคร — สำนักสิ่งแวดล้อม (กลุ่มงานวิจัยและพัฒนา สำนักงานจัดการมูลฝอยและสิ่งปฏิกูล)",
      accessStatus: "retrieved",
      notes: "Registered in bangkok-sources.json (fetch-bangkok.ts) with the PDF URL. FY2563/FY2564 per-disposal-centre columns transcribed here from the cached scanned PDFs (data/raw/bma-environment/composition/).",
    });
  }

  // --- 3. Hat Yai composition
  const hy = await buildHatyaiComposition();
  writeJson(path.join(STAGED, "hatyai-composition.json"), hy);
  log(`hatyai-composition.json: status ${hy.status}, shares ${JSON.stringify(hy.composition.shares)}`);
  addSource({
    id: "pmc-12247160",
    nameEn: "PMC12247160 — plastic waste properties study, Songkhla (cited in hatyai-waste.json)",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC12247160/",
    publisher: "PubMed Central",
    accessStatus: "retrieved",
    notes: "Registered in hatyai-sources.json. Re-checked from the cached HTML: no Hat Yai composition table.",
  });

  // --- Sources + manifest
  const sorted = [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeJson(path.join(STAGED, "waste-gaps-sources.json"), sorted);
  ensureDir(path.dirname(MANIFEST_PATH));
  const sortedManifest = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(sortedManifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(RAW, "_manifests", "fetch-waste-gaps-attempts.json"), JSON.stringify(attempts, null, 2) + "\n", "utf8");
  log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
