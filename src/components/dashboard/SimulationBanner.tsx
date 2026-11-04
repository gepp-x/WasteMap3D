"use client";

import { useEffect, useMemo, useRef } from "react";
import gsap from "gsap";
import { AnimatePresence, motion } from "motion/react";
import { CalendarX2, RotateCcw } from "lucide-react";
import { useDashboard } from "@/store/dashboard-store";
import { useScenario } from "@/lib/simulation/use-scenario";
import { SCENARIO_PRESETS } from "@/lib/simulation/model";
import { COMMON, useLang, useTr, type Bi } from "@/lib/i18n";
import { formatDate, formatNumber } from "@/lib/formatters";
import { DURATION, EASE, GSAP_EASE, useReducedMotionPref } from "@/lib/animation/tokens";
import { AnimatedNumber } from "@/components/motion/AnimatedNumber";
import { useOnScenarioPulse, useScenarioEffectsEnabled } from "@/components/motion/ScenarioTransition";
import { STATUS_META } from "@/lib/data/status";
import { formatElapsed } from "@/hooks/use-timeline-playback";
import { cn } from "@/lib/utils";

const S = {
  custom: { th: "กำหนดเอง", en: "Custom scenario" },
  stormDepth: { th: "ฝนรวม", en: "Storm depth" },
  cumulative: { th: "ฝนสะสม", en: "Cumulative rain" },
  meanRisk: { th: "ความเสี่ยงเฉลี่ย", en: "Mean risk" },
  meanRiskHint: { th: "ค่าเฉลี่ยถ่วงด้วยประชากร คะแนน 0–100", en: "Population-weighted, 0–100 score" },
  reset: { th: "รีเซ็ต", en: "Reset" },
  resetAria: { th: "รีเซ็ตการจำลองกลับสู่ค่าฐาน", en: "Reset the simulation to baseline" },
  histPrefix: { th: "แบบจำลองความเสี่ยงจากฝนประมาณการวันที่", en: "Modelled risk for reanalysis rainfall on" },
  histSuffix: { th: "— เชิงสาธิต", en: "— illustrative" },
  cityRain: { th: "ฝนเฉลี่ยทั้งเมือง", en: "City-mean rain" },
  clearDate: { th: "ล้างวันที่", en: "Clear date" },
  clearDateAria: { th: "ล้างวันที่ — กลับสู่ค่าฐาน", en: "Clear date — return to baseline" },
} satisfies Record<string, Bi>;

const mm = (lang: string) => (lang === "th" ? "มม." : "mm");

/**
 * Stage sweep: on each debounced scenario pulse a hairline cyan → violet front crosses the stage and a
 * faint vignette breathes once, so map, 3D, KPI and chart updates read as one environmental update.
 * GSAP timeline, 0.68 s total, transforms/opacity only. Skipped under reduced motion or when effects are off.
 */
function ScenarioSweep() {
  const enabled = useScenarioEffectsEnabled();
  const rootRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLDivElement>(null);
  const vignetteRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);

  useOnScenarioPulse(() => {
    const root = rootRef.current;
    const front = frontRef.current;
    const vignette = vignetteRef.current;
    if (!enabled || !root || !front || !vignette) return;
    tlRef.current?.kill();
    tlRef.current = gsap
      .timeline({ defaults: { overwrite: "auto" } })
      .set(root, { autoAlpha: 1 })
      .set(front, { xPercent: -100, opacity: 1 })
      .to(front, { xPercent: 0, duration: 0.6, ease: GSAP_EASE.camera }, 0)
      .fromTo(vignette, { opacity: 0 }, { opacity: 1, duration: 0.16, ease: GSAP_EASE.standard }, 0)
      .to(vignette, { opacity: 0, duration: 0.46, ease: GSAP_EASE.standard }, 0.18)
      .to(front, { opacity: 0, duration: 0.1, ease: "power1.out" }, 0.56)
      .set(root, { autoAlpha: 0 }, 0.68);
  });

  useEffect(() => {
    if (enabled) return;
    tlRef.current?.kill();
    tlRef.current = null;
    if (rootRef.current) gsap.set(rootRef.current, { autoAlpha: 0 });
  }, [enabled]);

  useEffect(
    () => () => {
      tlRef.current?.kill();
      tlRef.current = null;
    },
    [],
  );

  return (
    <div ref={rootRef} aria-hidden className="pointer-events-none invisible absolute inset-0 z-20 overflow-hidden opacity-0">
      <div
        ref={vignetteRef}
        className="absolute inset-0 opacity-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 45%, transparent 58%, color-mix(in srgb, var(--ui-violet) 14%, transparent) 86%, color-mix(in srgb, var(--ui-cyan) 10%, transparent) 100%)",
        }}
      />
      <div
        ref={frontRef}
        className="absolute inset-y-0 left-0 w-full will-change-transform"
        style={{ background: "linear-gradient(90deg, transparent 0%, transparent 82%, color-mix(in srgb, var(--ui-cyan) 5%, transparent) 94%, color-mix(in srgb, var(--ui-violet) 12%, transparent) 99.6%, transparent 100%)" }}
      >
        <div className="absolute inset-y-0 right-0 w-[1.5px]" style={{ background: "linear-gradient(180deg, var(--ui-cyan), var(--ui-violet) 70%, transparent)" }} />
      </div>
    </div>
  );
}

function Readout({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1 whitespace-nowrap" title={hint}>
      <span className="text-[10.5px] text-ui-text-3">{label}</span>
      <span className="ui-num text-[12.5px] font-semibold text-ui-text tabular-nums">{children}</span>
    </span>
  );
}

const bannerMotion = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};

/**
 * Overlay placed inside the (relative) stage container. Renders nothing when neither a scenario nor a
 * historical replay is active. Only its buttons receive pointer events.
 */
export function SimulationBanner() {
  const t = useTr();
  const lang = useLang();
  const reduced = useReducedMotionPref();
  const scenario = useScenario();
  const presetId = useDashboard((s) => s.presetId);
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  const resetScenario = useDashboard((s) => s.resetScenario);
  const setDateIndex = useDashboard((s) => s.setDateIndex);
  const setPlaying = useDashboard((s) => s.setPlaying);

  const { source, step, hyetograph, summary, list, date } = scenario;
  const total = hyetograph.length ? hyetograph[hyetograph.length - 1].cumulativeMm : null;
  const cityRain = useMemo(() => {
    const vals = list.map((x) => x.rain24h).filter((v): v is number => v !== null && Number.isFinite(v));
    return vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
  }, [list]);

  const presetName: Bi = presetId === "custom" ? S.custom : { th: SCENARIO_PRESETS[presetId].th, en: SCENARIO_PRESETS[presetId].en };
  const primary = lang === "th" ? COMMON.simulationBanner.th : COMMON.simulationBanner.en;
  const secondary = lang === "th" ? COMMON.simulationBanner.en : COMMON.simulationBanner.th;
  const transition = { duration: reduced ? 0 : DURATION.ui, ease: EASE.outExpo };
  const sim = STATUS_META.simulated;
  const est = STATUS_META.estimated;

  return (
    <>
      <ScenarioSweep />
      <div className="pointer-events-none absolute inset-x-0 top-12 z-30 flex justify-center px-2 sm:top-3 sm:px-40">
        <AnimatePresence mode="wait" initial={false}>
          {scenarioActive && (
            <motion.div
              key="scenario"
              {...bannerMotion}
              transition={transition}
              className="relative flex max-w-[min(640px,100%)] items-stretch overflow-hidden rounded-xl border border-ui-violet/35 bg-[rgba(9,22,37,0.9)] shadow-[var(--shadow-float)] backdrop-blur-md"
            >
              <span aria-hidden className="ui-sim-stripes w-2 shrink-0 border-r border-ui-violet/40" />
              <div className="flex min-w-0 flex-1 flex-col gap-1 py-1.5 pr-1.5 pl-2.5 sm:py-2 sm:pl-3">
                <div className="flex min-w-0 items-start gap-2">
                  <span aria-hidden className="mt-px text-[12px] text-ui-violet">
                    {sim.glyph}
                  </span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="truncate text-[12px] font-semibold text-ui-text sm:text-[12.5px]">{primary}</p>
                    <p className="hidden truncate text-[10px] tracking-[0.08em] text-ui-text-3 uppercase sm:block">{secondary}</p>
                  </div>
                  <button
                    type="button"
                    onClick={resetScenario}
                    aria-label={t(S.resetAria)}
                    className="pointer-events-auto flex h-7 shrink-0 items-center gap-1 rounded-md border border-ui-border px-2 text-[11px] font-medium text-ui-text-2 transition-colors outline-none hover:border-ui-border-strong hover:text-ui-text focus-visible:ring-2 focus-visible:ring-ui-cyan/60"
                  >
                    <RotateCcw className="size-3" aria-hidden />
                    <span className="hidden sm:inline">{t(S.reset)}</span>
                  </button>
                </div>
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 pl-[18px]">
                  <span className="truncate text-[11px] font-medium text-ui-violet">{t(presetName)}</span>
                  {step ? (
                    <Readout label={`T+${formatElapsed(step.t)} · ${t(S.cumulative)}`}>
                      {formatNumber(step.cumulativeMm, lang, 1)} <span className="text-[10px] font-normal text-ui-text-2">{mm(lang)}</span>
                    </Readout>
                  ) : (
                    <Readout label={t(S.stormDepth)}>
                      {formatNumber(total, lang, 0)} <span className="text-[10px] font-normal text-ui-text-2">{mm(lang)}</span>
                    </Readout>
                  )}
                  <Readout label={t(S.meanRisk)} hint={t(S.meanRiskHint)}>
                    <AnimatedNumber value={summary.meanScore} decimals={1} />
                  </Readout>
                </div>
              </div>
            </motion.div>
          )}
          {!scenarioActive && source === "historical" && (
            <motion.div
              key="historical"
              {...bannerMotion}
              transition={transition}
              className="relative flex max-w-[min(640px,100%)] items-stretch overflow-hidden rounded-xl border border-ui-yellow/30 bg-[rgba(9,22,37,0.9)] shadow-[var(--shadow-float)] backdrop-blur-md"
            >
              <span aria-hidden className="w-1 shrink-0 bg-ui-yellow/70" />
              <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1.5 pl-2.5 sm:py-2 sm:pl-3">
                <span aria-hidden className="text-[12px] text-ui-yellow">
                  {est.glyph}
                </span>
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="text-[11.5px] font-medium text-ui-text sm:text-[12px]">
                    {t(S.histPrefix)} <span className="font-semibold whitespace-nowrap">{formatDate(date, lang)}</span> {t(S.histSuffix)}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3">
                    <Readout label={t(S.cityRain)}>
                      {formatNumber(cityRain, lang, 1)} {cityRain !== null && <span className="text-[10px] font-normal text-ui-text-2">{mm(lang)}</span>}
                    </Readout>
                    <Readout label={t(S.meanRisk)} hint={t(S.meanRiskHint)}>
                      <AnimatedNumber value={summary.meanScore} decimals={1} />
                    </Readout>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    setDateIndex(null);
                  }}
                  aria-label={t(S.clearDateAria)}
                  className={cn(
                    "pointer-events-auto flex h-7 shrink-0 items-center gap-1 rounded-md border border-ui-border px-2 text-[11px] font-medium text-ui-text-2 transition-colors outline-none",
                    "hover:border-ui-border-strong hover:text-ui-text focus-visible:ring-2 focus-visible:ring-ui-cyan/60",
                  )}
                >
                  <CalendarX2 className="size-3" aria-hidden />
                  <span className="hidden sm:inline">{t(S.clearDate)}</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
