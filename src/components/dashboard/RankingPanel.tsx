"use client";

import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { create } from "zustand";
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from "lucide-react";
import type { DataStatus } from "@/lib/types";
import { useCityBundle } from "@/lib/data/loader";
import { useScenario } from "@/lib/simulation/use-scenario";
import { METRICS, primaryWasteMetric, type MetricId } from "@/lib/metrics";
import { STATUS_META } from "@/lib/data/status";
import { useLang, useTr } from "@/lib/i18n";
import { formatDate, formatNumber, unitLabel } from "@/lib/formatters";
import { DURATION, EASE } from "@/lib/animation/tokens";
import { useDashboard, type Lang } from "@/store/dashboard-store";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useMotionPrefs } from "@/components/dashboard/MetricGrid";
import { UNAVAILABLE_METRIC, baselineAreaMetric, liveAreaMetric, metricOf, rankAreas, type RankedRow } from "@/components/charts/derive";

export type RankMetric = "wasteCollected" | "wasteGenerated" | "wastePerCapita" | "population" | "wasteDensity" | "wasteAccumulated" | "modeledFloodRisk" | "drainageStress";

/** Both waste measures are offered separately — generated and collected are different quantities. */
const RANK_METRICS: RankMetric[] = ["wasteCollected", "wasteGenerated", "wastePerCapita", "population", "wasteDensity", "wasteAccumulated", "modeledFloodRisk", "drainageStress"];
const LIVE: RankMetric[] = ["modeledFloodRisk", "drainageStress"];

/** Ranking preferences survive tab switches (module-local store; not shared state). `null` = the city's primary waste measure. */
const useRankingPrefs = create<{ metric: RankMetric | null; dir: "desc" | "asc"; setMetric: (m: RankMetric) => void; toggleDir: () => void }>()((set) => ({
  metric: null,
  dir: "desc",
  setMetric: (metric) => set({ metric }),
  toggleDir: () => set((s) => ({ dir: s.dir === "desc" ? "asc" : "desc" })),
}));

const S = {
  title: { th: "จัดอันดับพื้นที่", en: "Area ranking" },
  metric: { th: "ตัวชี้วัดสำหรับจัดอันดับ", en: "Ranking metric" },
  desc: { th: "เรียงจากมากไปน้อย", en: "Sorted high to low" },
  asc: { th: "เรียงจากน้อยไปมาก", en: "Sorted low to high" },
  toggle: { th: "สลับลำดับการเรียง", en: "Toggle sort order" },
  unit: { th: "หน่วย", en: "Unit" },
  areas: { th: "{n} พื้นที่มีข้อมูล", en: "{n} areas with data" },
  unavailable: { th: "ยังไม่มีข้อมูล", en: "Unavailable" },
  unavailableGroup: { th: "ยังไม่มีข้อมูล ({n})", en: "Unavailable ({n})" },
  live: { th: "ค่าแบบจำลองตามสถานการณ์ปัจจุบัน", en: "Live model values for the current conditions" },
  srcBaseline: { th: "สภาวะฐาน", en: "Baseline" },
  srcScenario: { th: "สถานการณ์จำลอง", en: "Scenario" },
  srcHistorical: { th: "ย้อนหลัง {d}", en: "Historical {d}" },
  up: { th: "ขึ้น {n} อันดับจากสภาวะฐาน", en: "Up {n} places vs baseline" },
  down: { th: "ลง {n} อันดับจากสภาวะฐาน", en: "Down {n} places vs baseline" },
  listLabel: { th: "รายการพื้นที่เรียงตาม {m}", en: "Areas ranked by {m}" },
  rank: { th: "อันดับ", en: "Rank" },
  hint: { th: "ใช้ปุ่มลูกศรเลื่อน · Enter เพื่อเลือกพื้นที่", en: "Arrow keys to move · Enter to select" },
  estNote: {
    th: "ค่าของตัวชี้วัดนี้เป็นค่าประมาณการรายพื้นที่ อันดับจึงสะท้อนวิธีประมาณการ ไม่ใช่การตรวจวัดของแต่ละพื้นที่",
    en: "This metric is an area-level estimate, so the ranking reflects the estimation method, not per-area measurement",
  },
};



export function RankingPanel({ compact = false }: { compact?: boolean }) {
  const t = useTr();
  const lang = useLang();
  const { bundle } = useCityBundle();
  const sc = useScenario();
  const pref = useRankingPrefs((s) => s.metric);
  const dir = useRankingPrefs((s) => s.dir);
  const setMetric = useRankingPrefs((s) => s.setMetric);
  const toggleDir = useRankingPrefs((s) => s.toggleDir);
  const selectArea = useDashboard((s) => s.selectArea);
  const hoverArea = useDashboard((s) => s.hoverArea);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const { reduced } = useMotionPrefs();
  const listRef = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  const ds = bundle?.dataset;
  const primary = primaryWasteMetric(ds);
  const metric: RankMetric = pref ?? primary;
  const id: MetricId = metric;
  const def = METRICS[id];
  const live = LIVE.includes(metric);

  const rows = useMemo<RankedRow[]>(() => {
    if (!ds) return [];
    return rankAreas(ds.areas, (a) => (live ? liveAreaMetric(a, id, sc.byId.get(a.id), sc.date) : (metricOf(a, id) ?? UNAVAILABLE_METRIC(def.unit))), dir);
  }, [ds, id, live, sc.byId, sc.date, dir, def.unit]);

  const baseRanks = useMemo(() => {
    if (!ds || !live || sc.source === "baseline") return null;
    const m = new Map<string, number>();
    for (const r of rankAreas(ds.areas, (a) => baselineAreaMetric(a, id, sc.byId.get(a.id)), dir)) if (r.rank !== null) m.set(r.area.id, r.rank);
    return m;
  }, [ds, live, sc.source, sc.byId, id, dir]);

  const valued = rows.filter((r) => r.value !== null);
  const missing = rows.filter((r) => r.value === null);
  const max = valued.reduce((m, r) => Math.max(m, r.value ?? 0), 0);
  const unit = unitLabel(def.unit, lang);
  const metricLabel = t(def.label);
  const scope = valued[0]?.metric.provenance.geographicScope;
  const estimatedNote = !live && valued.some((r) => r.metric.provenance.status === "estimated");
  const anchorId = focusId && rows.some((r) => r.area.id === focusId) ? focusId : selectedId && rows.some((r) => r.area.id === selectedId) ? selectedId : (rows[0]?.area.id ?? null);

  const items = useMemo(() => Object.fromEntries(RANK_METRICS.map((m) => [m, t(METRICS[m].label)])), [t]);
  // which metrics have any value in this city (others stay selectable but are marked)
  const hasData = useMemo(() => {
    const out = new Set<RankMetric>();
    for (const m of RANK_METRICS) if (LIVE.includes(m) || ds?.areas.some((a) => a.metrics[m]?.value !== null && a.metrics[m]?.value !== undefined)) out.add(m);
    return out;
  }, [ds]);

  const onSelect = useCallback((areaId: string) => selectArea(areaId, { focus: true }), [selectArea]);
  const onHover = useCallback((areaId: string | null) => hoverArea(areaId), [hoverArea]);
  const onFocusRow = useCallback((areaId: string) => {
    setFocusId(areaId);
    hoverArea(areaId);
  }, [hoverArea]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const els = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-rank-row]") ?? []);
    if (!els.length) return;
    const i = els.findIndex((el) => el === document.activeElement);
    const n = e.key === "Home" ? 0 : e.key === "End" ? els.length - 1 : e.key === "ArrowDown" ? Math.min(els.length - 1, i + 1) : Math.max(0, i - 1);
    e.preventDefault();
    els[n]?.focus();
  };

  const sourceText =
    sc.source === "scenario" ? t(S.srcScenario) : sc.source === "historical" ? t(S.srcHistorical).replace("{d}", formatDate(sc.date, lang)) : t(S.srcBaseline);
  const layoutTransition = reduced ? { duration: 0 } : { duration: DURATION.scenario, ease: EASE.outExpo };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("flex flex-wrap items-center gap-2 border-b border-ui-border/70", compact ? "px-3 py-2" : "px-4 py-3")}>
        {!compact && <h3 className="mr-auto text-[13.5px] font-semibold text-ui-text">{t(S.title)}</h3>}
        <Select value={metric} onValueChange={(v) => v && setMetric(v as RankMetric)} items={items}>
          <SelectTrigger size="sm" aria-label={t(S.metric)} className="h-7 max-w-[240px] min-w-[170px] text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANK_METRICS.map((m) => (
              <SelectItem key={m} value={m} className="text-[12px]">
                {items[m]}
                {LIVE.includes(m) && <span className="text-[10px] text-status-simulated">◇</span>}
                {!hasData.has(m) && <span className="text-[10px] text-ui-text-3">({t(S.unavailable)})</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={toggleDir}
          aria-label={`${t(S.toggle)} — ${t(dir === "desc" ? S.desc : S.asc)}`}
          title={t(dir === "desc" ? S.desc : S.asc)}
          className="inline-flex size-7 items-center justify-center rounded-md border border-ui-border text-ui-text-2 hover:border-ui-border-strong hover:text-ui-text"
        >
          {dir === "desc" ? <ArrowDownWideNarrow className="size-3.5" aria-hidden /> : <ArrowUpNarrowWide className="size-3.5" aria-hidden />}
        </button>
        <div className={cn("flex items-center gap-1.5 text-[10.5px] text-ui-text-2", compact && "ml-auto")}>
          <span>
            {t(S.unit)}: {unit}
          </span>
          {ds && <span>· {t(S.areas).replace("{n}", formatNumber(valued.length, lang))}</span>}
          {live && (
            <span className="inline-flex items-center gap-1" title={t(S.live)}>
              · <StatusBadge status="simulated" size="xs" /> {sourceText}
            </span>
          )}
        </div>
        {estimatedNote && (
          <p className="w-full text-[10.5px] leading-4 text-ui-text-2">
            <StatusBadge status="estimated" size="xs" className="mr-1" />
            {t(S.estNote)}
            {scope ? ` — ${scope}` : ""}
          </p>
        )}
      </div>

      {!ds ? (
        <div className="flex flex-col gap-1.5 p-3" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-6 bg-ui-elevated/60" />
          ))}
        </div>
      ) : (
        <motion.div
          ref={listRef}
          layoutScroll
          role="listbox"
          aria-label={t(S.listLabel).replace("{m}", metricLabel)}
          onKeyDown={onKeyDown}
          onMouseLeave={() => onHover(null)}
          className={cn("ui-scroll relative min-h-0 flex-1 overflow-y-auto", compact ? "px-1.5 py-1" : "px-2 py-2")}
        >
          <ol role="none" className="flex flex-col">
            {valued.map((r) => (
              <motion.li key={r.area.id} role="none" layout="position" transition={{ layout: layoutTransition }}>
                <RankRow
                  row={r}
                  max={max}
                  decimals={def.decimals}
                  lang={lang}
                  compact={compact}
                  rankDelta={baseRanks && r.rank !== null && baseRanks.has(r.area.id) ? baseRanks.get(r.area.id)! - r.rank : null}
                  tabbable={r.area.id === anchorId}
                  onSelect={onSelect}
                  onHover={onHover}
                  onFocusRow={onFocusRow}
                  upText={t(S.up)}
                  downText={t(S.down)}
                  unavailableText={t(S.unavailable)}
                />
              </motion.li>
            ))}
          </ol>
          {missing.length > 0 && (
            <>
              <div className="ui-eyebrow mt-2 px-2 py-1" role="presentation">
                {t(S.unavailableGroup).replace("{n}", formatNumber(missing.length, lang))}
              </div>
              <ol role="none" className="flex flex-col">
                {missing.map((r) => (
                  <motion.li key={r.area.id} role="none" layout="position" transition={{ layout: layoutTransition }}>
                    <RankRow
                      row={r}
                      max={max}
                      decimals={def.decimals}
                      lang={lang}
                      compact={compact}
                      rankDelta={null}
                      tabbable={r.area.id === anchorId}
                      onSelect={onSelect}
                      onHover={onHover}
                      onFocusRow={onFocusRow}
                      upText={t(S.up)}
                      downText={t(S.down)}
                      unavailableText={t(S.unavailable)}
                    />
                  </motion.li>
                ))}
              </ol>
            </>
          )}
          {!compact && <p className="px-2 pt-2 text-[10.5px] text-ui-text-2">{t(S.hint)}</p>}
        </motion.div>
      )}
    </div>
  );
}

const RankRow = memo(function RankRow({
  row,
  max,
  decimals,
  lang,
  compact,
  rankDelta,
  tabbable,
  onSelect,
  onHover,
  onFocusRow,
  upText,
  downText,
  unavailableText,
}: {
  row: RankedRow;
  max: number;
  decimals: number;
  lang: Lang;
  compact: boolean;
  rankDelta: number | null;
  tabbable: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onFocusRow: (id: string) => void;
  upText: string;
  downText: string;
  unavailableText: string;
}) {
  const id = row.area.id;
  const selected = useDashboard((s) => s.selectedAreaId === id);
  const hovered = useDashboard((s) => s.hoveredAreaId === id);
  const status: DataStatus = row.metric.provenance.status ?? "unavailable";
  const pct = row.value !== null && max > 0 ? Math.max(0, Math.min(1, row.value / max)) : 0;
  const name = lang === "th" ? row.area.nameTh : row.area.nameEn;
  const valueText = row.value === null ? unavailableText : formatNumber(row.value, lang, decimals);
  const moved = rankDelta !== null && rankDelta !== 0;
  const deltaLabel = moved ? (rankDelta! > 0 ? upText : downText).replace("{n}", String(Math.abs(rankDelta!))) : "";

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-rank-row
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onSelect(id)}
      onMouseEnter={() => onHover(id)}
      onFocus={() => onFocusRow(id)}
      onBlur={() => onHover(null)}
      aria-label={`${row.rank !== null ? `#${row.rank} ` : ""}${name}: ${valueText}${row.value !== null ? ` (${STATUS_META[status].label[lang]})` : ""}${deltaLabel ? `, ${deltaLabel}` : ""}`}
      className={cn(
        "group relative grid w-full items-center gap-x-2 rounded-md text-left transition-colors duration-(--motion-fast) focus-visible:outline-offset-[-2px]",
        compact ? "min-h-7 grid-cols-[1.75rem_minmax(0,1fr)_minmax(64px,34%)_auto] px-1.5 py-0.5" : "min-h-9 grid-cols-[2rem_minmax(0,1fr)_minmax(80px,32%)_auto] px-2 py-1",
        selected ? "bg-[color-mix(in_srgb,var(--ui-cyan)_12%,transparent)]" : hovered ? "bg-ui-elevated/80" : "hover:bg-ui-elevated/60",
      )}
    >
      <span className="ui-num flex items-center gap-0.5 text-[11px] text-ui-text-2" aria-hidden>
        {row.rank ?? "—"}
        {moved && (
          <span className={cn("text-[9px]", rankDelta! > 0 ? "text-[var(--risk-high)]" : "text-[var(--risk-low)]")}>
            {rankDelta! > 0 ? "▲" : "▼"}
            {Math.abs(rankDelta!)}
          </span>
        )}
      </span>
      <span className={cn("min-w-0 truncate", compact ? "text-[12px]" : "text-[12.5px]", selected ? "font-medium text-ui-text" : "text-ui-text")} aria-hidden>
        {name}
        {!compact && lang === "th" && <span className="ml-1.5 text-[10.5px] text-ui-text-2">{row.area.nameEn}</span>}
      </span>
      <span className="relative h-1.5 rounded-full bg-ui-border/50" aria-hidden>
        {row.value !== null && (
          <span
            className="absolute inset-y-0 left-0 w-full origin-left rounded-full transition-transform duration-(--motion-scenario) ease-(--ease-out-expo)"
            style={{ transform: `scaleX(${pct})`, background: selected || hovered ? "var(--ui-cyan)" : "color-mix(in srgb, var(--ui-cyan) 62%, transparent)" }}
          />
        )}
      </span>
      <span className="flex items-center justify-end gap-1.5" aria-hidden>
        <span className={cn("ui-num text-right", compact ? "min-w-[3.5rem] text-[11.5px]" : "min-w-[4rem] text-[12px]", row.value === null ? "text-[10.5px] text-ui-text-2" : "text-ui-text")}>{valueText}</span>
        <StatusBadge status={status} size="xs" showLabel={!compact} />
      </span>
    </button>
  );
});
