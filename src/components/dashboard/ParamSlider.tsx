"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { CircleHelp } from "lucide-react";
import { useDashboard, type Lang } from "@/store/dashboard-store";
import { useLang, useTr, type Bi } from "@/lib/i18n";
import { formatNumber } from "@/lib/formatters";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BASELINE_SCENARIO, DEFAULT_ASSUMPTIONS, PARAM_BOUNDS, P_REF_MM, rainClass24h, type RainClass, type ScenarioParams } from "@/lib/simulation/model";
import { cn } from "@/lib/utils";

export type ParamKey = keyof ScenarioParams;

/** TMD 24-hour rainfall classes (กรมอุตุนิยมวิทยา) — label, range and colour (always shown with text). */
export const RAIN_CLASS_META: Record<RainClass, { label: Bi; range: Bi; color: string }> = {
  none: { label: { th: "ไม่มีฝน", en: "No rain" }, range: { th: "< 0.1 มม.", en: "< 0.1 mm" }, color: "var(--ui-text-3)" },
  light: { label: { th: "ฝนเล็กน้อย", en: "Light rain" }, range: { th: "0.1–10 มม.", en: "0.1–10 mm" }, color: "var(--ui-teal)" },
  moderate: { label: { th: "ฝนปานกลาง", en: "Moderate rain" }, range: { th: "10.1–35 มม.", en: "10.1–35 mm" }, color: "var(--ui-cyan)" },
  heavy: { label: { th: "ฝนหนัก", en: "Heavy rain" }, range: { th: "35.1–90 มม.", en: "35.1–90 mm" }, color: "var(--ui-yellow)" },
  veryHeavy: { label: { th: "ฝนหนักมาก", en: "Very heavy rain" }, range: { th: "≥ 90.1 มม.", en: "≥ 90.1 mm" }, color: "var(--ui-orange)" },
};

const pct = (v: number, lang: Lang) => formatNumber(Math.round(v * 100), lang, 0);

/** Display metadata for each scenario parameter. Help text states the modelling assumption explicitly. */
export const PARAM_META: Record<ParamKey, { label: Bi; unit: Bi; help: Bi; format: (v: number, lang: Lang) => string }> = {
  rainIntensityMmH: {
    label: { th: "ความเข้มฝน", en: "Rain intensity" },
    unit: { th: "มม./ชม.", en: "mm/h" },
    format: (v, lang) => formatNumber(v, lang, 0),
    help: {
      th: `ความเข้มฝนเฉลี่ยของพายุสมมติ ปริมาณฝนรวม = ความเข้ม × ระยะเวลา และปัจจัยฝน R = ปริมาณฝนรวม ÷ ${P_REF_MM} มม. (สูงสุด 1) ค่าในแต่ละพื้นที่ปรับตามสัดส่วนฝนรายปีของพื้นที่นั้นเทียบกับค่าเฉลี่ยเมือง`,
      en: `Mean intensity of a hypothetical storm. Storm depth = intensity × duration; rainfall factor R = depth ÷ ${P_REF_MM} mm (capped at 1). Each area is scaled by its annual rainfall relative to the city mean.`,
    },
  },
  rainDurationH: {
    label: { th: "ระยะเวลาฝนตก", en: "Storm duration" },
    unit: { th: "ชม.", en: "h" },
    format: (v, lang) => formatNumber(v, lang, Number.isInteger(v) ? 0 : 1),
    help: {
      th: "ฝนที่ตกนานทำให้พื้นที่เก็บน้ำในระบบท่อเต็ม แบบจำลองคูณภาระน้ำด้วย 0.85 + 0.05 × ชั่วโมง (สูงสุด 1.25 เท่า) และระยะเวลายังเพิ่มปริมาณฝนรวม",
      en: "Longer storms exhaust in-network storage: drainage load is multiplied by 0.85 + 0.05 × hours (capped at 1.25×). Duration also increases total storm depth.",
    },
  },
  drainageCapacityReduction: {
    label: { th: "ความสามารถระบายน้ำลดลง", en: "Drainage capacity loss" },
    unit: { th: "%", en: "%" },
    format: pct,
    help: {
      th: `สมมติว่าระบบระบายน้ำทำงานได้ลดลง (เช่น ระดับน้ำในคลองสูง หรือการบำรุงรักษาค้าง) ความสามารถที่ใช้ได้ = ความสามารถออกแบบที่สมมติ ${DEFAULT_ASSUMPTIONS.designIntensityMmH} มม./ชม. × (1 − ค่าที่ลดลง) — เป็นสมมติฐานเชิงสาธิต`,
      en: `Hypothetical loss of drainage performance (e.g. high canal levels, maintenance backlog). Usable capacity = assumed design capacity of ${DEFAULT_ASSUMPTIONS.designIntensityMmH} mm/h × (1 − loss). Illustrative assumption.`,
    },
  },
  obstruction: {
    label: { th: "การอุดตันจากขยะ", en: "Waste-related obstruction" },
    unit: { th: "%", en: "%" },
    format: pct,
    help: {
      th: "สัดส่วนสมมติของปากท่อระบายน้ำที่ถูกขยะอุดบางส่วน ใช้ปรับดัชนีความเสี่ยงขยะอุดตันของแต่ละพื้นที่: W_eff = W × (0.4 + 1.2 × ค่านี้) × … และลดความสามารถระบายน้ำที่เหลือได้สูงสุด 40% — ขยะเป็นปัจจัยที่อาจมีส่วน ไม่ใช่สาเหตุที่พิสูจน์แล้ว",
      en: "Assumed share of drain inlets partially blocked by solid waste. Scales each area's obstruction susceptibility: W_eff = W × (0.4 + 1.2 × this) × … and removes up to 40 % of remaining capacity. Waste is a possible contributing factor, not a proven cause.",
    },
  },
  upstreamRunoff: {
    label: { th: "น้ำหลากจากต้นน้ำ", en: "Upstream runoff" },
    unit: { th: "%", en: "%" },
    format: pct,
    help: {
      th: "ปริมาณน้ำที่ไหลเข้าจากพื้นที่ต้นน้ำหรือนอกเขต (0–100%) เพิ่มภาระระบบระบายน้ำ: ภาระ × (1 + 0.6 × ค่านี้)",
      en: "External inflow from upstream catchments (0–100 %). Increases drainage load: load × (1 + 0.6 × this).",
    },
  },
  collectionEfficiency: {
    label: { th: "ประสิทธิภาพการเก็บขยะ", en: "Collection efficiency" },
    unit: { th: "%", en: "%" },
    format: pct,
    help: {
      th: "สัดส่วนขยะที่เก็บขนได้ ยิ่งต่ำ ขยะตกค้างยิ่งมาก แบบจำลองคูณดัชนีขยะอุดตันด้วย 1 + 2 × (1 − ประสิทธิภาพ)",
      en: "Share of waste that is collected. Lower efficiency leaves more waste in the street: the obstruction index is multiplied by 1 + 2 × (1 − efficiency).",
    },
  },
};

const S = {
  baseline: { th: "ค่าฐาน", en: "Baseline" },
  modified: { th: "ปรับจากค่าฐาน", en: "Changed from baseline" },
  help: { th: "คำอธิบายสมมติฐาน", en: "About this assumption" },
  stormDepth: { th: "ฝนรวมของพายุ", en: "Storm depth" },
  tmd: { th: "เกณฑ์ กรมอุตุฯ (24 ชม.)", en: "TMD 24 h class" },
} satisfies Record<string, Bi>;

/** Small pill showing the TMD class of a 24-hour depth (glyph + text, never colour only). */
export function RainClassChip({ depthMm, className }: { depthMm: number | null; className?: string }) {
  const t = useTr();
  const lang = useLang();
  const cls = rainClass24h(depthMm);
  if (!cls || depthMm === null) return null;
  const m = RAIN_CLASS_META[cls];
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 text-[10.5px] leading-[18px] whitespace-nowrap", className)}
      style={{ color: m.color, borderColor: `color-mix(in srgb, ${m.color} 40%, transparent)`, background: `color-mix(in srgb, ${m.color} 9%, transparent)` }}
      title={`${t(S.tmd)}: ${t(m.range)}`}
    >
      <span>{t(m.label)}</span>
      <span className="sr-only">
        {" "}
        ({formatNumber(depthMm, lang, 0)} {lang === "th" ? "มม." : "mm"})
      </span>
    </span>
  );
}

/**
 * One scenario parameter bound to `store.scenario[param]`.
 * The thumb follows the pointer immediately (local draft); store commits are coalesced to one per
 * animation frame so the model, map and 3D scene recompute at most once per frame while dragging.
 */
export function ParamSlider({ param, className }: { param: ParamKey; className?: string }) {
  const t = useTr();
  const lang = useLang();
  const id = useId();
  const meta = PARAM_META[param];
  const bounds = PARAM_BOUNDS[param];
  const storeValue = useDashboard((s) => s.scenario[param]);
  const duration = useDashboard((s) => s.scenario.rainDurationH);
  const setScenarioParam = useDashboard((s) => s.setScenarioParam);
  const [draft, setDraft] = useState<number | null>(null);
  const raf = useRef(0);
  const pending = useRef<number | null>(null);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const value = draft ?? storeValue;
  const baseline = BASELINE_SCENARIO[param];
  const span = bounds.max - bounds.min;
  const baselinePct = ((baseline - bounds.min) / span) * 100;
  const changed = Math.abs(value - baseline) > bounds.step / 2;

  const handleChange = (v: number) => {
    setDraft(v);
    pending.current = v;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = pending.current;
      pending.current = null;
      if (p !== null && p !== useDashboard.getState().scenario[param]) setScenarioParam(param, p);
    });
  };

  const handleCommit = (v: number) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
    pending.current = null;
    if (v !== useDashboard.getState().scenario[param]) setScenarioParam(param, v);
    setDraft(null);
  };

  const shown = meta.format(value, lang);
  const unit = t(meta.unit);
  const depth = param === "rainIntensityMmH" ? Math.round(value * duration * 10) / 10 : null;

  return (
    <div className={cn("group/param py-2", className)}>
      <div className="flex items-center gap-1.5">
        <span id={`${id}-label`} className="min-w-0 truncate text-[12.5px] font-medium text-ui-text">
          {t(meta.label)}
        </span>
        {changed && (
          <span className="size-1.5 shrink-0 rounded-full bg-ui-violet" role="img" aria-label={t(S.modified)} title={t(S.modified)} />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`${t(S.help)}: ${t(meta.label)}`}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-ui-text-3 transition-colors hover:text-ui-text-2 focus-visible:text-ui-cyan"
              />
            }
          >
            <CircleHelp className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-72 text-left text-[11.5px] leading-relaxed">
            {t(meta.help)}
          </TooltipContent>
        </Tooltip>
        <span className="ml-auto flex items-baseline gap-1 pl-2 whitespace-nowrap">
          <span className="ui-num text-[15px] font-semibold text-ui-text tabular-nums">{shown}</span>
          <span className="text-[11px] text-ui-text-2">{unit}</span>
        </span>
      </div>

      <SliderPrimitive.Root
        value={value}
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        largeStep={bounds.step * 10}
        thumbAlignment="edge"
        onValueChange={(v) => handleChange(v as number)}
        onValueCommitted={(v) => handleCommit(v as number)}
        className="mt-1.5 w-full"
        aria-labelledby={`${id}-label`}
      >
        <SliderPrimitive.Control className="relative flex h-5 w-full cursor-pointer touch-none items-center select-none">
          <SliderPrimitive.Track className="relative h-[3px] w-full rounded-full bg-ui-elevated-2">
            <SliderPrimitive.Indicator className="rounded-full bg-linear-to-r from-ui-cyan/55 to-ui-cyan" />
            <span
              aria-hidden
              className="absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-ui-text-2/70"
              style={{ left: `${baselinePct}%` }}
            />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            getAriaLabel={() => t(meta.label)}
            getAriaValueText={(_formatted, v) => `${meta.format(v, lang)} ${unit}`}
            className="relative block size-3.5 rounded-full border-2 border-ui-cyan bg-ui-bg shadow-[0_0_0_3px_rgba(6,17,30,0.9)] transition-[box-shadow,transform] outline-none select-none after:absolute after:-inset-2.5 hover:scale-110 focus-visible:shadow-[0_0_0_3px_rgba(6,17,30,0.9),0_0_0_5px_rgba(37,217,242,0.55)] data-dragging:scale-110"
          />
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>

      <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-ui-text-3 tabular-nums">
        <span>{meta.format(bounds.min, lang)}</span>
        {depth !== null ? (
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <span className="truncate">
              {t(S.stormDepth)} <span className="ui-num text-ui-text-2">{formatNumber(depth, lang, depth % 1 ? 1 : 0)}</span> {lang === "th" ? "มม." : "mm"}
            </span>
            <RainClassChip depthMm={depth} />
          </span>
        ) : (
          <span>
            {t(S.baseline)} {meta.format(baseline, lang)}
          </span>
        )}
        <span>{meta.format(bounds.max, lang)}</span>
      </div>
    </div>
  );
}
