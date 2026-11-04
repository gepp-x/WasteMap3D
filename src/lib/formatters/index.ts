import type { MetricValue } from "@/lib/types";
import type { Lang } from "@/store/dashboard-store";
import { COMMON, tr } from "@/lib/i18n";

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(lang: Lang, decimals: number, compact = false) {
  const key = `${lang}-${decimals}-${compact}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(lang === "th" ? "th-TH" : "en-US", {
      minimumFractionDigits: compact ? 0 : decimals,
      maximumFractionDigits: decimals,
      notation: compact ? "compact" : "standard",
    });
    nfCache.set(key, f);
  }
  return f;
}

export function formatNumber(v: number | null | undefined, lang: Lang, decimals = 0, compact = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return tr(lang, COMMON.unavailable);
  return nf(lang, decimals, compact).format(v);
}

/** Unit labels (display). Keep unit strings in data as canonical ASCII ("t/day", "kg/person/day", "mm", "%", "persons", "km2", "persons/km2", "t", "index", "score"). */
const UNIT_LABELS: Record<string, { th: string; en: string }> = {
  "t/day": { th: "ตัน/วัน", en: "t/day" },
  "t/year": { th: "ตัน/ปี", en: "t/yr" },
  t: { th: "ตัน", en: "t" },
  "kg/person/day": { th: "กก./คน/วัน", en: "kg/person/day" },
  "t/day/km2": { th: "ตัน/วัน/ตร.กม.", en: "t/day/km²" },
  mm: { th: "มม.", en: "mm" },
  "mm/year": { th: "มม./ปี", en: "mm/yr" },
  "mm/h": { th: "มม./ชม.", en: "mm/h" },
  "%": { th: "%", en: "%" },
  persons: { th: "คน", en: "people" },
  km2: { th: "ตร.กม.", en: "km²" },
  "persons/km2": { th: "คน/ตร.กม.", en: "people/km²" },
  index: { th: "ดัชนี", en: "index" },
  score: { th: "คะแนน", en: "score" },
};

export function unitLabel(unit: string, lang: Lang) {
  const u = UNIT_LABELS[unit];
  return u ? tr(lang, u) : unit;
}

export function formatMetric(m: MetricValue | null | undefined, lang: Lang, decimals = 0, withUnit = true): string {
  if (!m || m.value === null || m.provenance.status === "unavailable") return tr(lang, COMMON.unavailable);
  const n = formatNumber(m.value, lang, decimals);
  return withUnit ? `${n} ${unitLabel(m.unit, lang)}` : n;
}

/** Thai dates use the Buddhist calendar (พ.ศ.); English uses Gregorian. */
export function formatDate(iso: string | undefined | null, lang: Lang, style: "short" | "long" | "month" = "short"): string {
  if (!iso) return tr(lang, COMMON.unavailable);
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00+07:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const locale = lang === "th" ? "th-TH-u-ca-buddhist" : "en-GB";
  const opts: Intl.DateTimeFormatOptions =
    style === "month"
      ? { month: "short", year: "numeric", timeZone: "Asia/Bangkok" }
      : style === "long"
        ? { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bangkok" }
        : { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

/** Gregorian year → display year (BE in Thai). */
export function formatYear(year: number, lang: Lang) {
  return lang === "th" ? `${year + 543}` : `${year}`;
}

export const beToCe = (be: number) => be - 543;
export const ceToBe = (ce: number) => ce + 543;
