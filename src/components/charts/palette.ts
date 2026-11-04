import type { WasteCategory } from "@/lib/types";
import type { FactorKey, RainClass, RiskClass } from "@/lib/simulation/model";
import type { Bi } from "@/lib/i18n";
import { RISK_COLORS } from "@/lib/data/status";
import { CHART_THEME } from "@/components/charts/EChart";

/**
 * Chart colour roles for the analytics module (dark navy surface only).
 *
 * Categorical slots come from the dataviz reference palette's dark column and were run through
 * `validate_palette.js --mode dark --surface #0e2032` (the panel surface):
 *   composition order  #199e70,#3987e5,#c98500,#9085e9,#d95926  → all checks PASS (worst adjacent CVD ΔE 17.3, normal 20.9)
 *   factor order       #3987e5,#199e70,#9085e9,#d95926          → all checks PASS
 *   compare A/B        #3987e5,#d95926 (--pairs all)            → PASS (CVD ΔE 26.8, normal 31.8)
 * These hues are deliberately distinct from the reserved data-status tokens (observed/derived/estimated/simulated),
 * so a series colour never impersonates a provenance status.
 */
export const VIZ = {
  /** Chart surface — used for the 2px surface gap / surface ring between marks. */
  surface: "#0d1e30",
  ink: CHART_THEME.textStrong,
  ink2: CHART_THEME.text,
  grid: CHART_THEME.split,
  axis: CHART_THEME.axis,
  /** De-emphasis / "Other" gray (5.2:1 on the panel surface). */
  other: "#7f93a5",
  /** Missing / unavailable mark tone. */
  missing: "#3a5268",
  /** Rainfall sequential hue (single series) and its emphasis step. */
  rain: "#1f95d0",
  rainMuted: "rgba(31,149,208,0.55)",
  rainSelected: "#25d9f2",
  /** Compare slots (identity of area A vs area B). */
  seriesA: "#3987e5",
  seriesB: "#d95926",
  /** Context series (baseline) — de-emphasised. */
  baseline: "#7f93a5",
  /** Accent for the one series a chart is about. */
  accent: "#25d9f2",
  /** Second measure in the same chart (e.g. waste generated beside waste collected); amber slot of the composition order. */
  secondary: "#c98500",
} as const;

export const COMPOSITION_ORDER: WasteCategory[] = ["organic", "plastic", "paper", "glassMetal", "hazardous", "other"];

export const COMPOSITION_COLORS: Record<WasteCategory, string> = {
  organic: "#199e70",
  plastic: "#3987e5",
  paper: "#c98500",
  glassMetal: "#9085e9",
  hazardous: "#d95926",
  other: VIZ.other,
};

export const COMPOSITION_LABELS: Record<WasteCategory, Bi> = {
  organic: { th: "ขยะอินทรีย์/เศษอาหาร", en: "Organic / food" },
  plastic: { th: "พลาสติก", en: "Plastic" },
  paper: { th: "กระดาษ", en: "Paper" },
  glassMetal: { th: "แก้วและโลหะ", en: "Glass & metal" },
  hazardous: { th: "ขยะอันตราย", en: "Hazardous" },
  other: { th: "อื่น ๆ", en: "Other" },
};

export const FACTOR_ORDER: FactorKey[] = ["R", "D", "E", "W"];

export const FACTOR_COLORS: Record<FactorKey, string> = {
  R: "#3987e5",
  D: "#199e70",
  E: "#9085e9",
  W: "#d95926",
};

export const FACTOR_LABELS: Record<FactorKey, Bi> = {
  R: { th: "ปริมาณฝน (R)", en: "Rainfall (R)" },
  D: { th: "แรงกดดันระบบระบายน้ำ (D)", en: "Drainage stress (D)" },
  E: { th: "ความเปราะบางเชิงพื้นที่ (E)", en: "Geographic exposure (E)" },
  W: { th: "ขยะอุดตันทางระบายน้ำ (W)", en: "Waste obstruction (W)" },
};

export const FACTOR_HELP: Record<FactorKey, Bi> = {
  R: { th: "ความลึกฝนของพายุเทียบกับ 150 มม.", en: "Storm depth relative to 150 mm" },
  D: { th: "ภาระน้ำเทียบกับความจุระบายน้ำที่สมมติ", en: "Load relative to assumed drainage capacity" },
  E: { th: "ดัชนีความเปราะบางของพื้นที่จากชุดข้อมูล", en: "Area exposure index from the dataset" },
  W: { th: "ความเสี่ยงขยะอุดตัน ปรับตามสถานการณ์", en: "Obstruction susceptibility, scenario-adjusted" },
};

export const RISK_CLASS_COLORS: Record<RiskClass, string> = {
  low: RISK_COLORS.low,
  moderate: RISK_COLORS.moderate,
  high: RISK_COLORS.high,
  veryHigh: RISK_COLORS.veryHigh,
};

/** TMD 24-hour rainfall classes — thresholds are the TMD definitions mirrored by `rainClass24h()`. */
export const TMD_CLASSES: { id: Exclude<RainClass, "none">; min: number; max: number | null; range: string; label: Bi; tint: string; swatch: string }[] = [
  { id: "light", min: 0.1, max: 10, range: "0.1–10.0", label: { th: "ฝนเล็กน้อย", en: "Light" }, tint: "rgba(37,217,242,0.035)", swatch: "rgba(37,217,242,0.16)" },
  { id: "moderate", min: 10, max: 35, range: "10.1–35.0", label: { th: "ฝนปานกลาง", en: "Moderate" }, tint: "rgba(37,217,242,0.06)", swatch: "rgba(37,217,242,0.3)" },
  { id: "heavy", min: 35, max: 90, range: "35.1–90.0", label: { th: "ฝนหนัก", en: "Heavy" }, tint: "rgba(37,217,242,0.09)", swatch: "rgba(37,217,242,0.5)" },
  { id: "veryHeavy", min: 90, max: null, range: "≥ 90.1", label: { th: "ฝนหนักมาก", en: "Very heavy" }, tint: "rgba(37,217,242,0.13)", swatch: "rgba(37,217,242,0.75)" },
];

export const RAIN_CLASS_LABELS: Record<RainClass, Bi> = {
  none: { th: "ไม่มีฝน", en: "No rain" },
  light: { th: "ฝนเล็กน้อย", en: "Light rain" },
  moderate: { th: "ฝนปานกลาง", en: "Moderate rain" },
  heavy: { th: "ฝนหนัก", en: "Heavy rain" },
  veryHeavy: { th: "ฝนหนักมาก", en: "Very heavy rain" },
};

/** `#rrggbb` → rgba() with alpha. */
export function withAlpha(hex: string, a: number) {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
