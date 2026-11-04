"use client";

import { useId, useState, type ReactNode } from "react";
import { LayoutGroup, MotionConfig, motion, type Variants } from "motion/react";
import { BookOpen, ChevronDown, FlaskConical, RotateCcw, X } from "lucide-react";
import { useDashboard } from "@/store/dashboard-store";
import { useLang, useTr, type Bi } from "@/lib/i18n";
import { formatNumber } from "@/lib/formatters";
import { useScenario } from "@/lib/simulation/use-scenario";
import {
  BASELINE_SCENARIO,
  DEFAULT_ASSUMPTIONS,
  L_SAT,
  MIN_COMPLETENESS,
  MODEL_VERSION,
  P_REF_MM,
  RISK_CLASSES,
  SCENARIO_PRESETS,
  WEIGHTS,
  type FactorKey,
  type ScenarioParams,
} from "@/lib/simulation/model";
import { RISK_COLORS } from "@/lib/data/status";
import { DURATION, EASE, STAGGER, useReducedMotionPref } from "@/lib/animation/tokens";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { PresetCard, PRESET_ORDER } from "@/components/dashboard/PresetCard";
import { ParamSlider, type ParamKey } from "@/components/dashboard/ParamSlider";
import { BeforeAfter, FACTOR_LABELS } from "@/components/dashboard/BeforeAfter";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const PARAM_ORDER: ParamKey[] = ["rainIntensityMmH", "rainDurationH", "drainageCapacityReduction", "obstruction", "upstreamRunoff", "collectionEfficiency"];

const S = {
  title: { th: "ห้องทดลองสถานการณ์", en: "Scenario Lab" },
  eyebrow: { th: "Scenario Lab", en: "ห้องทดลองสถานการณ์" },
  close: { th: "ปิดห้องทดลองสถานการณ์", en: "Close Scenario Lab" },
  running: { th: "กำลังจำลอง", en: "Simulating" },
  off: { th: "ปิดการจำลอง — แผนที่แสดงค่าฐาน", en: "Simulation off — map shows baseline" },
  toggle: { th: "เปิดใช้การจำลอง", en: "Run simulation" },
  custom: { th: "กำหนดเอง", en: "Custom" },
  presets: { th: "สถานการณ์สำเร็จรูป", en: "Presets" },
  presetsGroup: { th: "เลือกสถานการณ์สำเร็จรูป", en: "Choose a preset scenario" },
  params: { th: "ปรับพารามิเตอร์", en: "Parameters" },
  paramsHint: { th: "เส้นขีดบนแถบ = ค่าฐาน (สภาวะปกติ)", en: "Tick on each track = baseline (normal conditions)" },
  beforeAfter: { th: "ก่อน / หลัง", en: "Before / after" },
  compare: { th: "เทียบกับสถานการณ์ฐาน", en: "Compare with baseline" },
  how: { th: "วิธีคำนวณ", en: "How this works" },
  reset: { th: "รีเซ็ตเป็นค่าฐาน", en: "Reset to baseline" },
  disclaimer: { th: "การจำลองเชิงสาธิต — ไม่ใช่การพยากรณ์อย่างเป็นทางการ", en: "Illustrative simulation — not an official forecast" },
} satisfies Record<string, Bi>;

const HOW = {
  intro: {
    th: "คะแนนความเสี่ยง 0–100 เป็นดัชนีอธิบายได้ (explainable index) ที่รวมปัจจัย 4 ด้าน แต่ละด้านปรับให้อยู่ในช่วง 0–1 ก่อนถ่วงน้ำหนัก",
    en: "The 0–100 risk score is an explainable index combining four factors, each normalised to 0–1 before weighting.",
  },
  R: {
    th: `R = min(1, P ÷ ${P_REF_MM} มม.) — P คือปริมาณฝนรวมของพายุ (ความเข้ม × ระยะเวลา) ปรับตามสัดส่วนฝนรายปีของพื้นที่เทียบค่าเฉลี่ยเมือง`,
    en: `R = min(1, P ÷ ${P_REF_MM} mm) — P is storm depth (intensity × duration), scaled by the area's annual rainfall relative to the city mean.`,
  },
  D: {
    th: `D = min(1, L ÷ ${L_SAT}) — L = ภาระน้ำ ÷ ความสามารถที่ใช้ได้; ภาระ = ความเข้ม × (1 + 0.6·น้ำหลาก) × ตัวคูณระยะเวลา; ความสามารถ = ${DEFAULT_ASSUMPTIONS.designIntensityMmH} มม./ชม. × (1 − ส่วนที่ลดลง) × (1 − 0.4·W_eff)`,
    en: `D = min(1, L ÷ ${L_SAT}) — L = load ÷ usable capacity; load = intensity × (1 + 0.6·runoff) × duration factor; capacity = ${DEFAULT_ASSUMPTIONS.designIntensityMmH} mm/h × (1 − loss) × (1 − 0.4·W_eff)`,
  },
  E: {
    th: "E = ดัชนีความเปราะบางเชิงพื้นที่ 0–1 ของแต่ละพื้นที่จากชุดข้อมูล (ดูที่มาในแท็บข้อมูล) ไม่เปลี่ยนตามสถานการณ์",
    en: "E = per-area geographic exposure index (0–1) from the dataset (see the Data tab for its basis); scenarios do not change it.",
  },
  W: {
    th: "W_eff = min(1, W × (0.4 + 1.2·การอุดตัน) × (1 + 2·(1 − ประสิทธิภาพเก็บขยะ))) — W คือดัชนีความเสี่ยงขยะอุดตันของพื้นที่ ขยะเป็นปัจจัยที่อาจมีส่วน ไม่ใช่สาเหตุที่พิสูจน์แล้ว",
    en: "W_eff = min(1, W × (0.4 + 1.2·obstruction) × (1 + 2·(1 − collection efficiency))) — W is the area's obstruction susceptibility. Waste is a possible contributing factor, not a proven cause.",
  },
  classes: { th: "ระดับความเสี่ยง", en: "Risk classes" },
  capacity: {
    th: `สมมติฐานความสามารถระบายน้ำ: ระบบรับฝนได้ ${DEFAULT_ASSUMPTIONS.designIntensityMmH} มม./ชม. เมื่อทำงานเต็มที่ ใช้ค่าเดียวกันทุกพื้นที่ อ้างอิงคำกล่าวของผู้แทน กทม. ที่สื่อรายงาน (ราว 60 มม./ชม.) ไม่ใช่ค่าออกแบบรายพื้นที่ และหาดใหญ่ยังไม่มีตัวเลขสาธารณะที่ตรวจสอบได้ จึงเป็นสมมติฐานเชิงสาธิต (L = 1 คือภาระเท่ากับความสามารถพอดี ⇒ D ≈ ${formatPctPlain(1 / L_SAT)}%)`,
    en: `Capacity assumption: the network handles ${DEFAULT_ASSUMPTIONS.designIntensityMmH} mm/h at full capacity, applied uniformly to every area. It follows BMA officials' publicly reported statements (≈ 60 mm/h), not per-area design values; no verifiable figure exists for Hat Yai, so there it is purely illustrative (L = 1, load exactly at capacity ⇒ D ≈ ${formatPctPlain(1 / L_SAT)} %).`,
  },
  missing: {
    th: `ข้อมูลที่ขาด: ปัจจัยที่ไม่มีข้อมูลจะไม่ถูกนับเป็น 0 แต่น้ำหนักของปัจจัยที่เหลือจะถูกปรับสัดส่วนใหม่ให้รวมเป็น 1 และจะคำนวณคะแนนก็ต่อเมื่อน้ำหนักที่มีข้อมูลรองรับรวมกัน ≥ ${formatPctPlain(MIN_COMPLETENESS)}%`,
    en: `Missing data: a missing factor is never counted as 0 — the remaining weights are renormalised to sum to 1, and a score is produced only when ≥ ${formatPctPlain(MIN_COMPLETENESS)} % of the model weight is backed by data.`,
  },
  version: { th: "รุ่นแบบจำลอง", en: "Model version" },
} satisfies Record<string, Bi>;

function formatPctPlain(v: number) {
  return Math.round(v * 1000) / 10;
}

const sameParams = (a: ScenarioParams, b: ScenarioParams) => (Object.keys(a) as (keyof ScenarioParams)[]).every((k) => a[k] === b[k]);

const sectionVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: DURATION.ui, ease: EASE.outExpo } },
};
const listVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: STAGGER } },
};

function Section({ title, right, children, className }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <motion.section variants={sectionVariants} aria-labelledby={id} className={cn("border-b border-ui-border/60 px-3 py-3", className)}>
      <div className="mb-2 flex min-h-5 items-center justify-between gap-2">
        <h3 id={id} className="ui-eyebrow">
          {title}
        </h3>
        {right}
      </div>
      {children}
    </motion.section>
  );
}

function StatusStrip() {
  const t = useTr();
  const active = useDashboard((s) => s.scenarioActive);
  const presetId = useDashboard((s) => s.presetId);
  const setScenarioActive = useDashboard((s) => s.setScenarioActive);
  const name: Bi = presetId === "custom" ? S.custom : { th: SCENARIO_PRESETS[presetId].th, en: SCENARIO_PRESETS[presetId].en };
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-[10px] border px-2.5 py-2 transition-colors",
        active ? "ui-sim-stripes border-ui-violet/40" : "border-ui-border bg-ui-bg-deep/40 hover:border-ui-border-strong",
      )}
    >
      <span aria-hidden className={cn("text-[11px]", active ? "text-ui-violet" : "text-ui-text-3")}>
        {active ? "◇" : "○"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-ui-text">{active ? `${t(S.running)}: ${t(name)}` : t(S.off)}</span>
        <span className="block text-[10.5px] text-ui-text-3">{t(S.toggle)}</span>
      </span>
      <Switch checked={active} onCheckedChange={(v) => setScenarioActive(v)} />
    </label>
  );
}

function HowItWorks() {
  const t = useTr();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const factors = Object.keys(WEIGHTS) as FactorKey[];
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-ui-border/60">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12.5px] font-medium text-ui-text-2 transition-colors outline-none hover:text-ui-text focus-visible:bg-ui-elevated/60 focus-visible:text-ui-text">
        <BookOpen className="size-3.5 text-ui-text-3" aria-hidden />
        <span className="flex-1">{t(S.how)}</span>
        <ChevronDown className={cn("size-3.5 text-ui-text-3 transition-transform duration-200", open && "rotate-180")} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-300 ease-(--ease-standard) data-ending-style:h-0 data-starting-style:h-0">
        <div className="space-y-3 px-3 pb-3 text-[11.5px] leading-relaxed text-ui-text-2">
          <p>{t(HOW.intro)}</p>
          <div className="overflow-x-auto rounded-lg border border-ui-border bg-ui-bg-deep/60 px-2.5 py-2 font-mono text-[11.5px] whitespace-nowrap text-ui-text">
            Risk = 100 × ({factors.map((k, i) => `${i ? " + " : ""}${formatNumber(WEIGHTS[k], "en", 2)}·${k}`).join("")})
          </div>
          <dl className="space-y-2">
            {factors.map((k) => (
              <div key={k}>
                <dt className="text-[11.5px] font-medium text-ui-text">
                  <span className="ui-num mr-1">{k}</span>
                  {t(FACTOR_LABELS[k])}
                  <span className="ml-1.5 text-[10.5px] font-normal text-ui-text-3">
                    {lang === "th" ? "น้ำหนัก" : "weight"} {formatNumber(WEIGHTS[k], lang, 2)}
                  </span>
                </dt>
                <dd className="mt-0.5 text-[11px] text-ui-text-2">{t(HOW[k])}</dd>
              </div>
            ))}
          </dl>
          <div>
            <div className="mb-1 text-[11px] font-medium text-ui-text">{t(HOW.classes)}</div>
            <ul className="grid grid-cols-2 gap-1">
              {RISK_CLASSES.map((c) => (
                <li key={c.id} className="flex items-center gap-1.5 rounded-md border border-ui-border/70 px-2 py-1 text-[11px]">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: RISK_COLORS[c.id] }} />
                  <span className="text-ui-text">{t({ th: c.th, en: c.en })}</span>
                  <span className="ui-num ml-auto text-ui-text-3 tabular-nums">
                    {c.min}–{c.max}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p>{t(HOW.capacity)}</p>
          <p>{t(HOW.missing)}</p>
          <p className="text-[10.5px] text-ui-text-3">
            {t(HOW.version)} {MODEL_VERSION} · docs/SIMULATION_MODEL.md
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Scenario Lab panel body (fits 296–380 px; also used in the mobile sheet).
 * Presets and sliders write to the store; every number in the comparison comes from useScenario().
 */
export function ScenarioLab({ onClose }: { onClose?: () => void }) {
  const t = useTr();
  const reduced = useReducedMotionPref();
  const scenario = useScenario();
  const presetId = useDashboard((s) => s.presetId);
  const active = useDashboard((s) => s.scenarioActive);
  const params = useDashboard((s) => s.scenario);
  const compare = useDashboard((s) => s.compareBaseline);
  const applyPreset = useDashboard((s) => s.applyPreset);
  const resetScenario = useDashboard((s) => s.resetScenario);
  const setCompareBaseline = useDashboard((s) => s.setCompareBaseline);
  const setPanel = useDashboard((s) => s.setPanel);
  const layoutGroupId = useId();
  const titleId = useId();

  const close = () => (onClose ? onClose() : setPanel("labOpen", false));
  const atBaseline = !active && sameParams(params, BASELINE_SCENARIO);

  return (
    <MotionConfig reducedMotion={reduced ? "always" : "never"}>
      <section aria-labelledby={titleId} className="flex h-full min-h-0 w-full flex-col text-ui-text">
        <header className="flex shrink-0 items-center gap-2.5 border-b border-ui-border px-3 py-2.5">
          <span aria-hidden className="ui-sim-stripes grid size-8 shrink-0 place-items-center rounded-lg border border-ui-violet/35 text-ui-violet">
            <FlaskConical className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="ui-eyebrow truncate leading-4">{t(S.eyebrow)}</div>
            <h2 id={titleId} className="truncate text-[15px] leading-5 font-semibold">
              {t(S.title)}
            </h2>
          </div>
          <StatusBadge status="simulated" size="xs" className="shrink-0 tracking-wide" />
          <Button variant="ghost" size="icon-sm" onClick={close} aria-label={t(S.close)} className="shrink-0 text-ui-text-2 hover:text-ui-text">
            <X aria-hidden />
          </Button>
        </header>

        <motion.div initial="hidden" animate="show" variants={listVariants} className="ui-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <motion.div variants={sectionVariants} className="px-3 pt-3">
            <StatusStrip />
          </motion.div>

          <Section title={t(S.presets)}>
            <LayoutGroup id={layoutGroupId}>
              <div role="group" aria-label={t(S.presetsGroup)} className="space-y-1.5">
                {PRESET_ORDER.map((id) => (
                  <PresetCard key={id} id={id} active={active && presetId === id} onSelect={applyPreset} />
                ))}
              </div>
            </LayoutGroup>
          </Section>

          <Section
            title={t(S.params)}
            right={
              active && presetId === "custom" ? (
                <span className="rounded-full border border-ui-violet/40 px-1.5 text-[10px] leading-4 text-ui-violet">{t(S.custom)}</span>
              ) : undefined
            }
          >
            <p className="-mt-1 mb-1 text-[10.5px] text-ui-text-3">{t(S.paramsHint)}</p>
            <div className="divide-y divide-ui-border/50">
              {PARAM_ORDER.map((k) => (
                <ParamSlider key={k} param={k} />
              ))}
            </div>
          </Section>

          <Section
            title={t(S.beforeAfter)}
            right={
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ui-text-2">
                <span>{t(S.compare)}</span>
                <Switch size="sm" checked={compare} onCheckedChange={(v) => setCompareBaseline(v)} />
              </label>
            }
          >
            <BeforeAfter scenario={scenario} />
          </Section>

          <motion.div variants={sectionVariants}>
            <HowItWorks />
          </motion.div>
        </motion.div>

        <footer className="shrink-0 space-y-2 border-t border-ui-border px-3 py-2.5">
          <Button variant="outline" size="sm" onClick={resetScenario} disabled={atBaseline} className="w-full">
            <RotateCcw aria-hidden />
            {t(S.reset)}
          </Button>
          <p role="note" className="ui-sim-stripes flex items-start gap-1.5 rounded-md border border-ui-violet/30 px-2 py-1.5 text-[10.5px] leading-snug text-ui-text-2">
            <span aria-hidden className="text-ui-violet">
              ◇
            </span>
            <span>{t(S.disclaimer)}</span>
          </p>
        </footer>
      </section>
    </MotionConfig>
  );
}
