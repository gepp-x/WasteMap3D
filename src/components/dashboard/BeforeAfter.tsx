"use client";

import { useMemo } from "react";
import { ArrowRight, MapPin } from "lucide-react";
import { useDashboard } from "@/store/dashboard-store";
import { useLang, useTr, type Bi } from "@/lib/i18n";
import { formatDate, formatNumber } from "@/lib/formatters";
import { AnimatedNumber } from "@/components/motion/AnimatedNumber";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { RISK_COLORS } from "@/lib/data/status";
import { MIN_COMPLETENESS, RISK_CLASSES, WEIGHTS, riskClass, type FactorKey, type RiskResult } from "@/lib/simulation/model";
import type { AreaScenario, ScenarioState } from "@/lib/simulation/use-scenario";
import { formatElapsed } from "@/hooks/use-timeline-playback";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Pure helpers (unit-tested in tests/unit/use-scenario-logic.test.ts) */
/* ------------------------------------------------------------------ */

export type ScenarioRow = Pick<AreaScenario, "area" | "baseline" | "current" | "delta">;

export interface SideSummary {
  /** Population-weighted mean score over areas with both population and a score. */
  meanScore: number | null;
  maxScore: number | null;
  /** Population-weighted mean modelled drainage stress (%). */
  meanDrainageStress: number | null;
  /** Share (0–1) of population (areas with known population) living in High / Very High areas. */
  exposedShare: number | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Summary of one side of a before/after comparison. Mirrors the semantics of useScenario().summary
 * (population weights, null scores excluded — never counted as 0) so baseline and current are comparable.
 */
export function summarizeSide(list: ScenarioRow[], side: "baseline" | "current"): SideSummary {
  let w = 0;
  let s = 0;
  let d = 0;
  let exposed = 0;
  let popTotal = 0;
  let max: number | null = null;
  for (const row of list) {
    const r = row[side];
    const pop = row.area.metrics.population?.value ?? null;
    const sc = r.score;
    if (sc !== null) max = max === null ? sc : Math.max(max, sc);
    if (pop !== null && Number.isFinite(pop)) {
      popTotal += pop;
      if (sc !== null) {
        w += pop;
        s += pop * sc;
        d += pop * r.drainageStressPct;
        if (sc >= 50) exposed += pop;
      }
    }
  }
  return {
    meanScore: w ? round1(s / w) : null,
    maxScore: max,
    meanDrainageStress: w ? round1(d / w) : null,
    exposedShare: popTotal ? exposed / popTotal : null,
  };
}

/** Null-safe difference rounded to `decimals`; null when either side is unavailable. */
export function deltaOf(before: number | null, after: number | null, decimals = 1): number | null {
  if (before === null || after === null || !Number.isFinite(before) || !Number.isFinite(after)) return null;
  const f = 10 ** decimals;
  return Math.round((after - before) * f) / f;
}

/** Areas whose modelled score increased the most (ties: higher current score, then id — deterministic). */
export function topIncreases<T extends ScenarioRow>(list: T[], n = 5): T[] {
  return list
    .filter((x) => x.delta !== null && x.delta > 0)
    .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0) || (b.current.score ?? 0) - (a.current.score ?? 0) || a.area.id.localeCompare(b.area.id))
    .slice(0, n);
}

export interface FactorRow {
  key: FactorKey;
  weight: number;
  appliedWeight: number;
  before: number | null;
  after: number | null;
  valueBefore: number | null;
  valueAfter: number | null;
  missing: boolean;
  /** Maximum points this factor can contribute with the applied (renormalised) weight. */
  maxPoints: number;
}

/** Factor contribution rows (R, D, E, W) for a before/after pair. Missing factors carry null points, never 0. */
export function factorRows(before: RiskResult, after: RiskResult): FactorRow[] {
  return (Object.keys(WEIGHTS) as FactorKey[]).map((key) => {
    const b = before.factors[key];
    const a = after.factors[key];
    return {
      key,
      weight: WEIGHTS[key],
      appliedWeight: a.appliedWeight,
      before: b.missing ? null : b.points,
      after: a.missing ? null : a.points,
      valueBefore: b.value,
      valueAfter: a.value,
      missing: a.missing,
      maxPoints: Math.round(a.appliedWeight * 1000) / 10,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Strings                                                            */
/* ------------------------------------------------------------------ */

export const FACTOR_LABELS: Record<FactorKey, Bi> = {
  R: { th: "ฝน", en: "Rainfall" },
  D: { th: "แรงกดดันระบายน้ำ", en: "Drainage stress" },
  E: { th: "ความเปราะบางเชิงพื้นที่", en: "Geographic exposure" },
  W: { th: "ขยะอุดตันทางระบายน้ำ", en: "Waste obstruction" },
};

const S = {
  city: { th: "ภาพรวมเมือง", en: "City summary" },
  baselineCol: { th: "ฐาน", en: "Baseline" },
  currentCol: { th: "สถานการณ์", en: "Scenario" },
  replayCol: { th: "วันที่เลือก", en: "Replay" },
  meanScore: { th: "ความเสี่ยงเฉลี่ย (ถ่วงประชากร)", en: "Mean risk (pop.-weighted)" },
  maxScore: { th: "ความเสี่ยงสูงสุด", en: "Highest area risk" },
  drainage: { th: "แรงกดดันระบายน้ำเฉลี่ย", en: "Mean drainage stress" },
  exposed: { th: "ประชากรในพื้นที่เสี่ยงสูง–สูงมาก", en: "Population in High / Very High" },
  scoreUnit: { th: "คะแนน", en: "pts" },
  area: { th: "พื้นที่ที่เลือก", en: "Selected area" },
  pickArea: {
    th: "เลือกพื้นที่บนแผนที่หรือในตารางอันดับ เพื่อดูคะแนนก่อน/หลังและที่มาของคะแนนแต่ละปัจจัย",
    en: "Select an area on the map or in the ranking to see its before/after score and factor contributions.",
  },
  factors: { th: "ที่มาของคะแนน", en: "Score contributions" },
  points: { th: "คะแนน", en: "pts" },
  ofMax: { th: "จากสูงสุด", en: "of max" },
  missingFactor: { th: "ไม่มีข้อมูล", en: "No data" },
  renormalised: {
    th: "ปัจจัยที่ไม่มีข้อมูลไม่ถูกนับเป็น 0 — น้ำหนักที่เหลือถูกปรับสัดส่วนใหม่ ความครบถ้วนของข้อมูล",
    en: "Missing factors are not counted as 0 — remaining weights are renormalised. Data completeness",
  },
  insufficient: {
    th: "ข้อมูลไม่พอสำหรับคำนวณคะแนน (ความครบถ้วนต่ำกว่าเกณฑ์",
    en: "Not enough data to score this area (completeness below the",
  },
  insufficientEnd: { th: ")", en: " threshold)" },
  top: { th: "พื้นที่ที่ความเสี่ยงเพิ่มขึ้นมากที่สุด", en: "Largest increases" },
  noIncrease: { th: "ไม่มีพื้นที่ใดที่คะแนนความเสี่ยงเพิ่มขึ้นจากค่าฐาน", en: "No area's modelled risk increased versus baseline." },
  inactive: {
    th: "ยังไม่ได้เปิดการจำลอง — เลือกสถานการณ์สำเร็จรูปหรือปรับพารามิเตอร์ด้านบน ค่าด้านล่างคือผลแบบจำลองในสภาวะปกติ",
    en: "No scenario running — pick a preset or adjust a parameter above. Values below are the modelled normal-conditions baseline.",
  },
  compareOff: {
    th: "ปิดการเทียบกับฐานอยู่ — แสดงเฉพาะค่าปัจจุบัน",
    en: "Baseline comparison is off — showing current values only.",
  },
  atStep: { th: "ณ เวลาเหตุการณ์", en: "At event time" },
  fullStorm: { th: "สรุปทั้งเหตุการณ์", en: "Full-storm summary" },
  focus: { th: "เลือกและซูมไปที่", en: "Select and focus" },
  communityZone: { th: "เขตชุมชน", en: "Community zone" },
  district: { th: "เขต", en: "District" },
  approx: { th: "ขอบเขตโดยประมาณ", en: "Approximate boundary" },
  increase: { th: "เพิ่มขึ้น", en: "increase" },
  decrease: { th: "ลดลง", en: "decrease" },
  noChange: { th: "ไม่เปลี่ยนแปลง", en: "no change" },
  pp: { th: " จุด", en: " pp" },
  replay: { th: "ผลแบบจำลองจากฝนประมาณการวันที่", en: "Modelled from reanalysis rainfall on" },
} satisfies Record<string, Bi>;

/* ------------------------------------------------------------------ */
/*  Small presentational pieces                                        */
/* ------------------------------------------------------------------ */

/** Signed change chip: arrow glyph + sign + value (never colour only). Higher = worse by default. */
export function DeltaChip({ value, decimals = 1, suffix = "", higherIsWorse = true, className }: { value: number | null; decimals?: number; suffix?: string; higherIsWorse?: boolean; className?: string }) {
  const t = useTr();
  const lang = useLang();
  if (value === null) return null;
  const eps = 0.5 * 10 ** -decimals;
  const dir = value > eps ? 1 : value < -eps ? -1 : 0;
  const worse = dir !== 0 && (dir > 0) === higherIsWorse;
  const color = dir === 0 ? "var(--ui-text-3)" : worse ? "var(--ui-orange)" : "var(--ui-green)";
  const glyph = dir > 0 ? "▲" : dir < 0 ? "▼" : "•";
  const label = dir > 0 ? S.increase : dir < 0 ? S.decrease : S.noChange;
  const abs = formatNumber(Math.abs(value), lang, decimals);
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 rounded-md px-1 text-[10.5px] leading-[18px] font-medium whitespace-nowrap tabular-nums", className)}
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      aria-label={`${t(label)} ${abs}${suffix}`}
    >
      <span aria-hidden className="text-[8px]">
        {glyph}
      </span>
      <span aria-hidden>
        {dir > 0 ? "+" : dir < 0 ? "−" : "±"}
        {abs}
        {suffix}
      </span>
    </span>
  );
}

/** Risk class pill: colour dot + class name. */
export function RiskClassChip({ score, className }: { score: number | null; className?: string }) {
  const t = useTr();
  const cls = riskClass(score);
  if (!cls) return null;
  const meta = RISK_CLASSES.find((c) => c.id === cls)!;
  const color = RISK_COLORS[cls];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10.5px] whitespace-nowrap text-ui-text-2", className)}>
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: color }} />
      {t({ th: meta.th, en: meta.en })}
    </span>
  );
}

function SubHeading({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <h4 className="ui-eyebrow">{children}</h4>
      {right}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  City summary                                                       */
/* ------------------------------------------------------------------ */

function CitySummary({ scenario, compare }: { scenario: ScenarioState; compare: boolean }) {
  const t = useTr();
  const lang = useLang();
  const base = useMemo(() => summarizeSide(scenario.list, "baseline"), [scenario.list]);
  const cur = scenario.summary;
  const currentLabel = scenario.source === "historical" ? S.replayCol : S.currentCol;

  const pp = t(S.pp);
  const rows: { label: Bi; before: number | null; after: number | null; decimals: number; suffix: string; deltaSuffix: string }[] = [
    { label: S.meanScore, before: base.meanScore, after: cur.meanScore, decimals: 1, suffix: "", deltaSuffix: "" },
    { label: S.maxScore, before: base.maxScore, after: cur.maxScore, decimals: 1, suffix: "", deltaSuffix: "" },
    { label: S.drainage, before: base.meanDrainageStress, after: cur.meanDrainageStress, decimals: 1, suffix: "%", deltaSuffix: pp },
    {
      label: S.exposed,
      before: base.exposedShare === null ? null : round1(base.exposedShare * 100),
      after: cur.exposedPopulationShare === null ? null : round1(cur.exposedPopulationShare * 100),
      decimals: 1,
      suffix: "%",
      deltaSuffix: pp,
    },
  ];

  const cols = compare ? "grid-cols-[minmax(0,1fr)_auto_auto]" : "grid-cols-[minmax(0,1fr)_auto]";

  return (
    <div>
      <SubHeading right={<StatusBadge status="simulated" size="xs" />}>{t(S.city)}</SubHeading>
      <div className="overflow-hidden rounded-[10px] border border-ui-border/80 bg-ui-bg-deep/40">
        {compare && (
          <div className={cn("grid items-center gap-x-2 border-b border-ui-border/60 px-2.5 py-1 text-[10px] text-ui-text-3", cols)}>
            <span />
            <span className="w-12 text-right">{t(S.baselineCol)}</span>
            <span className="w-[86px] text-right">{t(currentLabel)}</span>
          </div>
        )}
        <dl>
          {rows.map((r) => (
            <div key={r.label.en} className={cn("grid items-center gap-x-2 border-b border-ui-border/40 px-2.5 py-1.5 last:border-b-0", cols)}>
              <dt className="min-w-0 text-[11.5px] leading-tight text-ui-text-2">{t(r.label)}</dt>
              {compare && (
                <dd className="ui-num w-12 text-right text-[12px] text-ui-text-3 tabular-nums">
                  {r.before === null ? <span className="text-[10px]">{formatNumber(null, lang)}</span> : `${formatNumber(r.before, lang, r.decimals)}${r.suffix}`}
                </dd>
              )}
              <dd className="flex w-[86px] flex-col items-end gap-0.5">
                <span className="ui-num text-[13.5px] font-semibold text-ui-text tabular-nums">
                  <AnimatedNumber value={r.after} decimals={r.decimals} />
                  {r.after !== null && r.suffix}
                </span>
                {compare && <DeltaChip value={deltaOf(r.before, r.after, r.decimals)} decimals={r.decimals} suffix={r.deltaSuffix} />}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Selected area                                                      */
/* ------------------------------------------------------------------ */

function AreaDetail({ row, compare }: { row: AreaScenario; compare: boolean }) {
  const t = useTr();
  const lang = useLang();
  const { area, baseline, current } = row;
  const rows = useMemo(() => factorRows(baseline, current), [baseline, current]);
  const kind = area.kind === "community-zone" ? S.communityZone : S.district;

  return (
    <div className="rounded-[10px] border border-ui-border/80 bg-ui-bg-deep/40 p-2.5">
      <div className="flex items-start gap-2">
        <MapPin className="mt-0.5 size-3.5 shrink-0 text-ui-cyan" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ui-text">{lang === "th" ? area.nameTh : area.nameEn}</div>
          <div className="truncate text-[10.5px] text-ui-text-3">
            {t(kind)}
            {area.geometryStatus === "approximate" && ` · ${t(S.approx)}`}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <div className="flex items-baseline gap-1.5">
            {compare && (
              <>
                <span className="ui-num text-[12px] text-ui-text-3 tabular-nums">{baseline.score === null ? "—" : formatNumber(baseline.score, lang, 1)}</span>
                <ArrowRight className="size-3 self-center text-ui-text-3" aria-hidden />
              </>
            )}
            <span className="ui-num text-[18px] leading-none font-semibold text-ui-text tabular-nums">
              <AnimatedNumber value={current.score} decimals={1} />
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <RiskClassChip score={current.score} />
            {compare && <DeltaChip value={row.delta} />}
          </div>
        </div>
      </div>

      {current.score === null ? (
        <p className="mt-2 text-[11px] leading-snug text-ui-text-2">
          {t(S.insufficient)} {formatNumber(MIN_COMPLETENESS * 100, lang, 0)}%{t(S.insufficientEnd)} · {formatNumber(current.completeness * 100, lang, 0)}%
        </p>
      ) : (
        <>
          <div className="mt-2.5 mb-1 flex items-center justify-between text-[10px] text-ui-text-3">
            <span className="ui-eyebrow text-[9.5px]!">{t(S.factors)}</span>
            <span>{t(S.points)}</span>
          </div>
          <ul className="space-y-1.5">
            {rows.map((f) => (
              <FactorBar key={f.key} row={f} compare={compare} />
            ))}
          </ul>
          {current.missing.length > 0 && (
            <p className="mt-2 border-t border-ui-border/50 pt-1.5 text-[10.5px] leading-snug text-ui-text-3">
              {current.missing.map((k) => `${k} (${t(FACTOR_LABELS[k])})`).join(", ")} — {t(S.renormalised)} {formatNumber(current.completeness * 100, lang, 0)}%.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function FactorBar({ row, compare }: { row: FactorRow; compare: boolean }) {
  const t = useTr();
  const lang = useLang();
  const max = row.maxPoints || 1;
  const after = row.after === null ? 0 : Math.min(100, (row.after / max) * 100);
  const before = row.before === null ? 0 : Math.min(100, (row.before / max) * 100);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5">
      <span className="flex min-w-0 items-baseline gap-1 text-[11px] text-ui-text-2">
        <span className="ui-num w-3 shrink-0 font-semibold text-ui-text">{row.key}</span>
        <span className="truncate">{t(FACTOR_LABELS[row.key])}</span>
        <span className="shrink-0 text-[9.5px] text-ui-text-3">×{formatNumber(row.appliedWeight, lang, 2)}</span>
      </span>
      <span className="ui-num text-right text-[11.5px] text-ui-text tabular-nums">
        {row.missing ? (
          <span className="text-[10px] text-ui-text-3">{t(S.missingFactor)}</span>
        ) : (
          <>
            {compare && row.before !== null && <span className="mr-1 text-ui-text-3">{formatNumber(row.before, lang, 1)} →</span>}
            {formatNumber(row.after, lang, 1)}
            <span className="ml-0.5 text-[9.5px] text-ui-text-3">
              /{formatNumber(row.maxPoints, lang, 0)}
            </span>
          </>
        )}
      </span>
      <span className="relative col-span-2 h-1 overflow-hidden rounded-full bg-ui-elevated-2" aria-hidden>
        {row.missing ? (
          <span className="absolute inset-0 ui-sim-stripes opacity-60" />
        ) : (
          <>
            <span
              className="absolute inset-0 origin-left rounded-full bg-ui-violet/80 transition-transform duration-700 ease-(--ease-out-expo)"
              style={{ transform: `scaleX(${after / 100})` }}
            />
            {compare && <span className="absolute inset-y-[-1px] w-px bg-ui-text/70" style={{ left: `${before}%` }} />}
          </>
        )}
      </span>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Top increases                                                      */
/* ------------------------------------------------------------------ */

function TopIncreases({ scenario }: { scenario: ScenarioState }) {
  const t = useTr();
  const lang = useLang();
  const selectArea = useDashboard((s) => s.selectArea);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const top = useMemo(() => topIncreases(scenario.list, 5), [scenario.list]);
  return (
    <div>
      <SubHeading>{t(S.top)}</SubHeading>
      {top.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-ui-border/80 px-2.5 py-2 text-[11px] text-ui-text-3">{t(S.noIncrease)}</p>
      ) : (
        <ol className="space-y-1">
          {top.map((x, i) => {
            const name = lang === "th" ? x.area.nameTh : x.area.nameEn;
            const selected = selectedId === x.area.id;
            return (
              <li key={x.area.id}>
                <button
                  type="button"
                  onClick={() => selectArea(x.area.id, { focus: true })}
                  aria-current={selected ? "true" : undefined}
                  aria-label={`${t(S.focus)} ${name}`}
                  className={cn(
                    "grid w-full grid-cols-[16px_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60",
                    selected ? "border-ui-cyan/40 bg-ui-cyan/[0.06]" : "border-transparent hover:border-ui-border hover:bg-ui-elevated/60",
                  )}
                >
                  <span className="ui-num text-[11px] text-ui-text-3">{i + 1}</span>
                  <span className="truncate text-[12px] text-ui-text">{name}</span>
                  <span className="ui-num text-[11px] whitespace-nowrap text-ui-text-2 tabular-nums">
                    {formatNumber(x.baseline.score, lang, 0)} → <span className="font-semibold text-ui-text">{formatNumber(x.current.score, lang, 0)}</span>
                  </span>
                  <DeltaChip value={x.delta} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

/**
 * Before / after comparison for the Scenario Lab: city summary, selected-area factor breakdown and the
 * areas with the largest modelled increase. Values come from useScenario() only (never invented).
 */
export function BeforeAfter({ scenario }: { scenario: ScenarioState }) {
  const t = useTr();
  const lang = useLang();
  const compare = useDashboard((s) => s.compareBaseline);
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const row = selectedId ? (scenario.byId.get(selectedId) ?? null) : null;

  if (!scenario.ready) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-3 w-24 bg-ui-elevated" />
        <Skeleton className="h-32 w-full rounded-[10px] bg-ui-elevated/70" />
        <Skeleton className="h-20 w-full rounded-[10px] bg-ui-elevated/70" />
      </div>
    );
  }

  const comparing = compare && scenario.source !== "baseline";

  return (
    <div className="space-y-3.5">
      {!scenarioActive && scenario.source !== "historical" && <p className="text-[11px] leading-snug text-ui-text-3">{t(S.inactive)}</p>}
      {scenario.source === "historical" && scenario.date && (
        <p className="text-[11px] leading-snug text-ui-text-3">
          <StatusBadge status="estimated" size="xs" className="mr-1 align-middle" />
          {t(S.replay)} {formatDate(scenario.date, lang, "long")}
        </p>
      )}
      {scenario.source === "scenario" && (
        <p className="text-[10.5px] text-ui-text-3">{scenario.step ? `${t(S.atStep)} T+${formatElapsed(scenario.step.t)}` : t(S.fullStorm)}</p>
      )}
      {!compare && scenario.source !== "baseline" && <p className="text-[10.5px] text-ui-text-3">{t(S.compareOff)}</p>}

      <CitySummary scenario={scenario} compare={comparing} />

      <div>
        <SubHeading>{t(S.area)}</SubHeading>
        {row ? <AreaDetail row={row} compare={comparing} /> : <p className="rounded-[10px] border border-dashed border-ui-border/80 px-2.5 py-2 text-[11px] leading-snug text-ui-text-3">{t(S.pickArea)}</p>}
      </div>

      {comparing && <TopIncreases scenario={scenario} />}
    </div>
  );
}
