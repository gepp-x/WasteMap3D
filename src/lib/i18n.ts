"use client";

import { useCallback } from "react";
import { useDashboard, type Lang } from "@/store/dashboard-store";

/** Inline bilingual string. Modules keep their own strings next to the component (no shared dictionary to collide on). */
export interface Bi {
  th: string;
  en: string;
}

export const tr = (lang: Lang, s: Bi) => (lang === "th" ? s.th : s.en);

/** `const t = useTr(); t({ th: "ขยะ", en: "Waste" })` */
export function useTr() {
  const lang = useDashboard((s) => s.lang);
  return useCallback((s: Bi) => tr(lang, s), [lang]);
}

export function useLang() {
  return useDashboard((s) => s.lang);
}

/** Shared vocabulary used across modules. */
export const COMMON = {
  unavailable: { th: "ยังไม่มีข้อมูล", en: "Unavailable" },
  simulationBanner: { th: "การจำลอง — ไม่ใช่การพยากรณ์น้ำท่วมอย่างเป็นทางการ", en: "SIMULATION — NOT AN OFFICIAL FLOOD FORECAST" },
  illustrativeFlood: {
    th: "ภาพจำลองน้ำท่วม 3 มิติเชิงสาธิต — ไม่ใช่การพยากรณ์ความลึกน้ำท่วมเชิงพื้นที่",
    en: "Illustrative 3D Flood Scenario — Not Geospatial Flood-Depth Prediction",
  },
  modeledDrainageStress: { th: "แรงกดดันระบบระบายน้ำ (แบบจำลอง, %)", en: "Modeled Drainage Stress (%)" },
  modeledRisk: { th: "ความเสี่ยงน้ำท่วม (แบบจำลอง)", en: "Modeled Flood Risk" },
  city: { th: "เมือง", en: "City" },
  district: { th: "เขต", en: "District" },
  communityZone: { th: "เขตชุมชน", en: "Community zone" },
  source: { th: "แหล่งข้อมูล", en: "Source" },
  close: { th: "ปิด", en: "Close" },
  reset: { th: "รีเซ็ต", en: "Reset" },
} satisfies Record<string, Bi>;
