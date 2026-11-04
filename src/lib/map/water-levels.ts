/**
 * Water-level gauges (snapshot at retrieval time — never presented as live).
 *
 * Situation classes follow the ThaiWater / HII convention of "% of channel capacity" (ร้อยละความจุลำน้ำ):
 *   ≤ 10 % critically low · 10–30 % low · 30–70 % normal · 70–100 % high · > 100 % over bank.
 * The class is taken from the published `capacityPct` when present, otherwise from the agency's own
 * situation text. Nothing is computed from level ÷ bank in m MSL (that ratio is not a capacity: it
 * ignores the channel bed), so a gauge without either stays "unknown".
 */
import type { FeatureCollection } from "geojson";
import type { DataStatus, MetricValue, WaterLevelStation } from "@/lib/types";
import type { Bi } from "@/lib/i18n";
import type { Lang } from "@/store/dashboard-store";
import { formatNumber, unitLabel } from "@/lib/formatters";
import { distanceM } from "@/lib/geo/local";
import { IMG } from "./ids";

export type GaugeClass = "overflow" | "high" | "normal" | "low" | "criticalLow" | "unknown";

export interface GaugeClassDef {
  id: GaugeClass;
  /** Exclusive lower bound (% capacity); null = open. */
  from: number | null;
  /** Inclusive upper bound; null = open. */
  to: number | null;
  color: string;
  label: Bi;
}

/** Display order: most severe first (legend, tables). */
export const GAUGE_CLASSES: GaugeClassDef[] = [
  { id: "overflow", from: 100, to: null, color: "#f05b63", label: { th: "ล้นตลิ่ง", en: "Over bank" } },
  { id: "high", from: 70, to: 100, color: "#4c8dff", label: { th: "น้ำมาก", en: "High" } },
  { id: "normal", from: 30, to: 70, color: "#3fcf8e", label: { th: "ปกติ", en: "Normal" } },
  { id: "low", from: 10, to: 30, color: "#e8c547", label: { th: "น้ำน้อย", en: "Low" } },
  { id: "criticalLow", from: null, to: 10, color: "#d07a3a", label: { th: "น้อยวิกฤต", en: "Critically low" } },
  { id: "unknown", from: null, to: null, color: "#62798c", label: { th: "ไม่มีข้อมูลสถานการณ์", en: "No situation data" } },
];

export const GAUGE_CLASS: Record<GaugeClass, GaugeClassDef> = Object.fromEntries(GAUGE_CLASSES.map((c) => [c.id, c])) as Record<GaugeClass, GaugeClassDef>;

export const gaugeIconId = (c: GaugeClass) => `${IMG.gaugePrefix}${c}`;

export const GAUGE_SCHEME: Bi = { th: "เกณฑ์ร้อยละความจุลำน้ำแบบ ThaiWater (สสน.)", en: "ThaiWater (HII) % of channel capacity classes" };
export const GAUGE_SNAPSHOT: Bi = {
  th: "ค่า ณ เวลาที่ดึงข้อมูล (snapshot) ไม่ใช่ข้อมูลสด",
  en: "Snapshot at retrieval time — not live data",
};

const ok = (m: MetricValue | null | undefined): m is MetricValue & { value: number } =>
  !!m && m.value !== null && Number.isFinite(m.value) && m.provenance?.status !== "unavailable";

export function classByCapacity(pct: number | null | undefined): GaugeClass {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "unknown";
  if (pct > 100) return "overflow";
  if (pct > 70) return "high";
  if (pct > 30) return "normal";
  if (pct > 10) return "low";
  return "criticalLow";
}

/**
 * Agency situation text (Thai or English, as published) → class. Order matters: "ต่ำกว่าระดับเฝ้าระวัง"
 * (below the watch level) before "เฝ้าระวัง", and "น้อยวิกฤต" before "วิกฤต".
 */
export function classBySituation(text: string | null | undefined): GaugeClass {
  const s = (text ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (/ต่ำกว่าระดับเฝ้าระวัง|ต่ำกว่าระดับเตือนภัย|below (the )?(watch|warning)/.test(s)) return "normal";
  if (/น้อยวิกฤ|critically low|very low|extremely low/.test(s)) return "criticalLow";
  if (/ล้นตลิ่ง|ล้น|overflow|over ?bank|above bank|flood|critical|วิกฤ|อันตราย|danger/.test(s)) return "overflow";
  if (/น้ำมาก|มาก|high|alert|warning|เฝ้าระวัง|watch/.test(s)) return "high";
  if (/น้ำน้อย|น้อย|low/.test(s)) return "low";
  if (/ปกติ|normal/.test(s)) return "normal";
  return "unknown";
}

/**
 * English rendering of the agency situation wording (HII ThaiWater scale tables and the BMA canal
 * watch/critical levels, see data/staged/hydrology-report.json → waterLevels.situationTextEn).
 * Unknown wording is shown as published.
 */
const SITUATION_EN: Record<string, string> = {
  น้ำล้นตลิ่ง: "Overbank (> 100 % of bank capacity)",
  น้ำมาก: "High (> 70–100 %)",
  น้ำปกติ: "Normal (> 30–70 %)",
  น้ำน้อย: "Low (> 10–30 %)",
  น้ำน้อยวิกฤติ: "Critically low (≤ 10 %)",
  ถึงระดับวิกฤต: "At or above the critical level",
  ถึงระดับเฝ้าระวัง: "At or above the watch (warning) level",
  ต่ำกว่าระดับเฝ้าระวัง: "Below the watch (warning) level",
};

export function situationLabel(text: string): { th: string; en: string } {
  const k = text.trim();
  return { th: k, en: SITUATION_EN[k] ?? k };
}

export interface GaugeInfo {
  index: number;
  station: WaterLevelStation;
  cls: GaugeClass;
  /** Where the class came from. */
  classFrom: "capacity" | "situation" | "none";
  /** bank − level (m), derived only when both are published in the same datum. */
  freeboardM: number | null;
}

export function gaugeInfo(station: WaterLevelStation, index: number): GaugeInfo {
  const cap = ok(station.capacityPct) ? station.capacityPct.value : null;
  let cls: GaugeClass = classByCapacity(cap);
  let classFrom: GaugeInfo["classFrom"] = cls === "unknown" ? "none" : "capacity";
  if (cls === "unknown") {
    cls = classBySituation(station.situation);
    if (cls !== "unknown") classFrom = "situation";
  }
  const lv = ok(station.waterLevel) ? station.waterLevel.value : null;
  const bk = ok(station.bankLevel) ? station.bankLevel.value : null;
  const sameDatum = !!station.bankLevel && station.bankLevel.unit === station.waterLevel?.unit;
  return { index, station, cls, classFrom, freeboardM: lv !== null && bk !== null && sameDatum ? bk - lv : null };
}

export interface GaugeModel {
  fc: FeatureCollection;
  items: GaugeInfo[];
  counts: Record<GaugeClass, number>;
  statuses: DataStatus[];
  /** Latest observation time across gauges (ISO) or null. */
  latest: string | null;
  withValue: number;
  total: number;
}

/** Valid-coordinate gauges → lean point features (`_i` index, `_c` class, `_t` level label). */
export function gaugeModel(stations: WaterLevelStation[] | null | undefined): GaugeModel | null {
  if (!stations || !Array.isArray(stations) || !stations.length) return null;
  const items: GaugeInfo[] = [];
  const counts = Object.fromEntries(GAUGE_CLASSES.map((c) => [c.id, 0])) as Record<GaugeClass, number>;
  const statuses = new Set<DataStatus>();
  let latest: string | null = null;
  let withValue = 0;
  const features: FeatureCollection["features"] = [];
  stations.forEach((st, i) => {
    if (!st || !Number.isFinite(st.lon) || !Number.isFinite(st.lat)) return;
    const info = gaugeInfo(st, i);
    items.push(info);
    counts[info.cls]++;
    const has = ok(st.waterLevel);
    if (has) withValue++;
    statuses.add(has ? st.waterLevel.provenance.status : "unavailable");
    const t = st.observedAt ?? st.waterLevel?.provenance?.observedTo ?? null;
    if (t && (!latest || t > latest)) latest = t;
    features.push({
      type: "Feature",
      properties: { _i: i, _c: info.cls, _t: has ? (st.waterLevel.value as number).toFixed(2) : "" },
      geometry: { type: "Point", coordinates: [st.lon, st.lat] },
    });
  });
  if (!items.length) return null;
  return { fc: { type: "FeatureCollection", features }, items, counts, statuses: [...statuses], latest, withValue, total: items.length };
}

export interface NearbyGauge extends GaugeInfo {
  distanceKm: number;
}

export function nearbyGauges(stations: WaterLevelStation[] | null | undefined, anchor: [number, number], radiusKm = 8): NearbyGauge[] {
  if (!stations) return [];
  const out: NearbyGauge[] = [];
  stations.forEach((st, i) => {
    if (!st || !Number.isFinite(st.lon) || !Number.isFinite(st.lat)) return;
    const d = distanceM(anchor, [st.lon, st.lat]) / 1000;
    if (d <= radiusKm) out.push({ ...gaugeInfo(st, i), distanceKm: d });
  });
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Water-level unit label: the contract's m MSL reads "ม.รทก." / "m MSL". */
export function levelUnit(unit: string | undefined, lang: Lang): string {
  const u = (unit ?? "").trim();
  if (!u || u === "m" || /msl|รทก/i.test(u)) return lang === "th" ? "ม.รทก." : "m MSL";
  return unitLabel(u, lang);
}

export function formatLevel(m: MetricValue | null | undefined, lang: Lang, withUnit = true): string | null {
  if (!ok(m)) return null;
  const n = formatNumber(m.value, lang, 2);
  return withUnit ? `${n} ${levelUnit(m.unit, lang)}` : n;
}

export function gaugeName(st: WaterLevelStation, lang: Lang): string {
  return (lang === "th" ? st.nameTh : st.nameEn) ?? st.nameTh ?? st.nameEn ?? st.id;
}
