/** Bilingual vocabulary shared by the map legend, tooltip and controls. */
import type { Bi } from "@/lib/i18n";
import type { Lang } from "@/store/dashboard-store";
import type { AreaKind } from "@/lib/types";
import { formatDate } from "@/lib/formatters";
import type { DrainKind, WaterKind } from "./features";

export const AREA_KIND: Record<AreaKind, Bi> = {
  district: { th: "เขต", en: "District" },
  "community-zone": { th: "เขตชุมชน", en: "Community zone" },
  municipality: { th: "เทศบาล", en: "Municipality" },
};

export const DRAIN_KIND_LABEL: Record<DrainKind, Bi> = {
  pump: { th: "สถานีสูบน้ำ", en: "Pump station" },
  gate: { th: "ประตูระบายน้ำ", en: "Floodgate / sluice" },
  monitoring: { th: "จุดตรวจวัดระดับน้ำ", en: "Monitoring point" },
  retention: { th: "พื้นที่รับน้ำ / แก้มลิง", en: "Retention basin" },
  other: { th: "โครงสร้างระบายน้ำอื่น", en: "Other drainage asset" },
};

export const WATER_KIND_LABEL: Record<WaterKind | "area", Bi> = {
  river: { th: "แม่น้ำ", en: "River" },
  canal: { th: "คลอง", en: "Canal" },
  stream: { th: "ลำน้ำ / ลำคลองสาขา", en: "Stream" },
  drain: { th: "รางระบายน้ำ", en: "Drain" },
  other: { th: "ทางน้ำ", en: "Waterway" },
  area: { th: "พื้นน้ำ", en: "Water body" },
};

export const MAP_STRINGS = {
  approxZonesNote: {
    th: "เขตชุมชนโดยประมาณเพื่อการสาธิต — ไม่ใช่ขอบเขตทางการ",
    en: "Approximate demonstration zones — not official boundaries",
  },
  approxShort: { th: "ขอบเขตโดยประมาณ", en: "Approximate boundary" },
  hotspotsNote: { th: "พื้นที่ (ไม่ใช่ตำแหน่งจุดจริง)", en: "Area-level, not site locations — illustrative" },
  rainEstimatedLabel: { th: "ประมาณการ (ERA5 reanalysis)", en: "Estimated (ERA5 reanalysis)" },
  offlineBadge: { th: "แผนที่ฐานออฟไลน์ — แสดงข้อมูลภูมิศาสตร์ที่รวมไว้", en: "Basemap offline — showing bundled data" },
  municipalityBoundary: { th: "เขตเทศบาลนครหาดใหญ่", en: "Hat Yai municipal boundary" },
  community: { th: "ชุมชน", en: "Community" },
} satisfies Record<string, Bi>;

/** Date + time (Asia/Bangkok). Thai uses the Buddhist calendar via formatters.formatDate. */
export function formatDateTime(iso: string | null | undefined, lang: Lang): string {
  const date = formatDate(iso, lang);
  if (!iso || iso.length <= 10) return date;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return date;
  const time = new Intl.DateTimeFormat(lang === "th" ? "th-TH" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok", hour12: false }).format(d);
  return lang === "th" ? `${date} ${time} น.` : `${date}, ${time}`;
}
