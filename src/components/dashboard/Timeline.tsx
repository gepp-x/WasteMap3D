"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { LayoutGroup, motion } from "motion/react";
import { CalendarRange, CalendarX2, Clock3, FlaskConical, History, Pause, Play, Sigma, TriangleAlert } from "lucide-react";
import { useDashboard, type TimelineMode } from "@/store/dashboard-store";
import { useCityBundle } from "@/lib/data/loader";
import { useScenario } from "@/lib/simulation/use-scenario";
import { rainClass24h, type RainClass, type TimelineStep } from "@/lib/simulation/model";
import { useLang, useTr, type Bi } from "@/lib/i18n";
import { formatDate, formatNumber, formatYear } from "@/lib/formatters";
import { SPRING, useReducedMotionPref } from "@/lib/animation/tokens";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { RAIN_CLASS_META } from "@/components/dashboard/ParamSlider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  PLAYBACK_BASE_RATE,
  cityMeanSeries,
  formatElapsed,
  indexFromRatio,
  nextSpeed,
  stepIndex,
  useTimelinePlayback,
} from "@/hooks/use-timeline-playback";
import type { FloodEvent } from "@/lib/types";
import { hourlyEventsOn, partitionFloodEvents } from "@/lib/story/build-story";
import { cn } from "@/lib/utils";

const S = {
  region: { th: "ไทม์ไลน์", en: "Timeline" },
  mode: { th: "โหมดไทม์ไลน์", en: "Timeline mode" },
  historical: { th: "ย้อนหลัง", en: "Historical" },
  simulated: { th: "จำลองเหตุการณ์", en: "Simulated event" },
  play: { th: "เล่น", en: "Play" },
  pause: { th: "หยุดชั่วคราว", en: "Pause" },
  speed: { th: "ความเร็วการเล่น", en: "Playback speed" },
  speedHint: { th: "กดเพื่อเปลี่ยนความเร็ว", en: "Press to change speed" },
  daysPerSec: { th: "วัน/วินาที", en: "days/s" },
  hoursPerSec: { th: "ชม. จำลอง/วินาที", en: "simulated h/s" },
  scrubHistorical: { th: "เลือกวันที่ของฝนย้อนหลัง", en: "Select a historical rainfall date" },
  scrubScenario: { th: "เลื่อนเวลาเหตุการณ์จำลอง", en: "Scrub the simulated event" },
  keys: {
    th: "ลูกศร: ทีละขั้น · Shift+ลูกศร: ทีละช่วงใหญ่ · Space: เล่น/หยุด",
    en: "Arrows: step · Shift+arrows: larger step · Space: play/pause",
  },
  noDate: { th: "ค่าฐาน · ยังไม่เลือกวันที่", en: "Baseline · no date selected" },
  clearDate: { th: "ล้างวันที่ — กลับสู่ค่าฐาน", en: "Clear date — return to baseline" },
  cityMean: { th: "ฝนเฉลี่ยทั้งเมือง", en: "City-mean rain" },
  reanalysis: { th: "ข้อมูลฝนย้อนหลังแบบจำลอง (reanalysis)", en: "Reanalysis rainfall" },
  sqrtScale: { th: "แท่งกราฟ: ฝนเฉลี่ยรายวันทั้งเมือง (สเกลรากที่สอง)", en: "Bars: city-mean daily rain (square-root scale)" },
  loading: { th: "กำลังโหลดข้อมูลฝน…", en: "Loading rainfall…" },
  error: { th: "โหลดข้อมูลไม่สำเร็จ", en: "Could not load data" },
  noRain: { th: "ยังไม่มีข้อมูลฝนรายวันสำหรับเมืองนี้", en: "No daily rainfall series for this city yet" },
  simRunning: { th: "การจำลองทำงานอยู่ — เลือกวันที่เพื่อหยุดจำลอง", en: "Simulation running — picking a date ends it" },
  floodEvent: { th: "เหตุการณ์น้ำท่วม", en: "Flood event" },
  jumpPeak: { th: "คลิกเพื่อไปยังวันที่ฝนเฉลี่ยสูงสุดของเหตุการณ์", en: "Click to jump to the event's wettest day" },
  partial: { th: "เหตุการณ์นี้อยู่นอกช่วงข้อมูลฝนรายวันบางส่วน — แสดงเฉพาะวันที่มีข้อมูล", en: "Partly outside the daily rainfall record — only the covered days are marked" },
  outOfRange: { th: "เหตุการณ์นอกช่วงข้อมูลฝนรายวัน", en: "Events outside the daily rainfall record" },
  outOfRangeBody: {
    th: "มีแหล่งอ้างอิง แต่เกิดก่อน/หลังช่วงข้อมูลฝนรายวันจึงเลื่อนไทม์ไลน์ไปไม่ได้ — คลิกเพื่อเปิดรายการเหตุการณ์น้ำท่วมพร้อมแหล่งอ้างอิง",
    en: "Documented, but before/after the daily rainfall record, so the timeline cannot jump there — click for the flood-event list and sources.",
  },
  alsoOutside: { th: "เหตุการณ์อื่นนอกช่วงข้อมูล", en: "Also documented, outside this record" },
  record: { th: "ช่วงข้อมูลฝนรายวัน", en: "Daily record" },
  viewHourly: { th: "ดูรายชั่วโมง", en: "View hourly" },
  viewHourlyAria: { th: "ดูฝนรายชั่วโมงของเหตุการณ์นี้ในแท็บฝน", en: "Show this event's hourly rainfall in the Rainfall tab" },
  ctaTitle: { th: "ยังไม่มีเหตุการณ์จำลอง", en: "No simulated event yet" },
  ctaBody: { th: "สร้างพายุสมมติในห้องทดลองสถานการณ์ แล้วเล่นตามเวลาทีละ 15 นาที", en: "Create a hypothetical storm in the Scenario Lab, then play it in 15-minute steps" },
  openLab: { th: "เปิดห้องทดลอง", en: "Open Scenario Lab" },
  summary: { th: "ทั้งเหตุการณ์", en: "Full storm" },
  summaryAria: { th: "แสดงผลสรุปทั้งเหตุการณ์", en: "Show the full-storm summary" },
  intensity: { th: "ความเข้ม", en: "Intensity" },
  cumulative: { th: "สะสม", en: "Cumulative" },
  rainStops: { th: "ฝนหยุด", en: "Rain stops" },
  simulatedLabel: { th: "ข้อมูลจำลอง", en: "Simulated" },
  inHours: { th: "ใน", en: "over" },
  hours: { th: "ชม.", en: "h" },
} satisfies Record<string, Bi>;

const mmLabel = (lang: string) => (lang === "th" ? "มม." : "mm");
const mmhLabel = (lang: string) => (lang === "th" ? "มม./ชม." : "mm/h");

/** Positions a full-width playhead wrapper with a GPU transform (pos in domain units). */
function placeHead(el: HTMLElement | null, pos: number | null, lo: number, hi: number) {
  if (!el) return;
  if (pos === null || !Number.isFinite(pos) || hi <= lo) {
    el.style.opacity = "0";
    return;
  }
  const pct = Math.min(100, Math.max(0, ((pos - lo) / (hi - lo)) * 100));
  el.style.opacity = "1";
  el.style.transform = `translateX(${pct}%)`;
}

/* ------------------------------------------------------------------ */
/*  Shared controls                                                    */
/* ------------------------------------------------------------------ */

function ModeSwitch() {
  const t = useTr();
  const mode = useDashboard((s) => s.timelineMode);
  const setMode = useDashboard((s) => s.setTimelineMode);
  const groupId = useId();
  const items: { id: TimelineMode; icon: typeof History; label: Bi }[] = [
    { id: "historical", icon: History, label: S.historical },
    { id: "scenario", icon: FlaskConical, label: S.simulated },
  ];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const next = mode === "historical" ? "scenario" : "historical";
    setMode(next);
    const btn = e.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`);
    btn?.focus();
  };
  return (
    <div role="radiogroup" aria-label={t(S.mode)} onKeyDown={onKeyDown} className="relative flex shrink-0 rounded-lg border border-ui-border bg-ui-bg-deep/60 p-0.5">
      <LayoutGroup id={groupId}>
        {items.map((it) => {
          const on = mode === it.id;
          const Icon = it.icon;
          return (
            <Tooltip key={it.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={t(it.label)}
                    tabIndex={on ? 0 : -1}
                    data-mode={it.id}
                    onClick={() => setMode(it.id)}
                    className={cn(
                      "relative flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60",
                      on ? "text-ui-text" : "text-ui-text-3 hover:text-ui-text-2",
                    )}
                  />
                }
              >
                {on && (
                  <motion.span
                    layoutId="timeline-mode-pill"
                    aria-hidden
                    className={cn("absolute inset-0 rounded-md border", it.id === "scenario" ? "border-ui-violet/40 bg-ui-violet/12" : "border-ui-border-strong bg-ui-elevated-2")}
                    transition={SPRING.snappy}
                  />
                )}
                <Icon className={cn("relative size-3.5", on && it.id === "scenario" && "text-ui-violet")} aria-hidden />
                <span className="relative hidden xl:inline">{t(it.label)}</span>
              </TooltipTrigger>
              <TooltipContent className="xl:hidden">{t(it.label)}</TooltipContent>
            </Tooltip>
          );
        })}
      </LayoutGroup>
    </div>
  );
}

function PlayButton({ playing, disabled, onToggle, tone }: { playing: boolean; disabled?: boolean; onToggle: () => void; tone: "cyan" | "violet" }) {
  const t = useTr();
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-label={playing ? t(S.pause) : t(S.play)}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60 disabled:cursor-not-allowed disabled:opacity-40",
        tone === "cyan" ? "border-ui-cyan/35 bg-ui-cyan/10 text-ui-cyan hover:bg-ui-cyan/18" : "border-ui-violet/40 bg-ui-violet/12 text-ui-violet hover:bg-ui-violet/20",
      )}
    >
      {playing ? <Pause className="size-3.5" fill="currentColor" aria-hidden /> : <Play className="size-3.5 translate-x-px" fill="currentColor" aria-hidden />}
    </button>
  );
}

function SpeedButton({ mode, disabled }: { mode: TimelineMode; disabled?: boolean }) {
  const t = useTr();
  const lang = useLang();
  const speed = useDashboard((s) => s.playbackSpeed);
  const setSpeed = useDashboard((s) => s.setPlaybackSpeed);
  const rate = PLAYBACK_BASE_RATE[mode] * speed;
  const rateText =
    mode === "historical" ? `≈ ${formatNumber(rate, lang, 0)} ${t(S.daysPerSec)}` : `${formatNumber(rate / 4, lang, rate / 4 < 1 ? 1 : 0)} ${t(S.hoursPerSec)}`;
  const label = `${t(S.speed)} ${speed}× (${rateText}) — ${t(S.speedHint)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => setSpeed(nextSpeed(speed))}
            disabled={disabled}
            aria-label={label}
            className="ui-num hidden h-8 w-10 shrink-0 items-center justify-center rounded-lg border border-ui-border text-[11.5px] font-semibold text-ui-text-2 transition-colors outline-none hover:border-ui-border-strong hover:text-ui-text focus-visible:ring-2 focus-visible:ring-ui-cyan/60 disabled:opacity-40 sm:flex"
          />
        }
      >
        {speed}×
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/*  Scrubber (role="slider")                                           */
/* ------------------------------------------------------------------ */

interface ScrubberProps {
  /** Position domain used for drawing (index → x). */
  domain: [number, number];
  /** Selectable range (may start after the domain, e.g. scenario step 0 is the summary). */
  min: number;
  max: number;
  value: number | null;
  playing: boolean;
  onScrub: (i: number) => void;
  onTogglePlay: () => void;
  ariaLabel: string;
  valueText: string;
  hoverLabel: (i: number) => string;
  largeStep: number;
  pageStep: number;
  headRef: RefObject<HTMLDivElement | null>;
  tone: "cyan" | "violet";
  children?: ReactNode;
  overlay?: ReactNode;
}

function Scrubber({ domain, min, max, value, playing, onScrub, onTogglePlay, ariaLabel, valueText, hoverLabel, largeStep, pageStep, headRef, tone, children, overlay }: ScrubberProps) {
  const t = useTr();
  const trackRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const raf = useRef(0);
  const pending = useRef<number | null>(null);
  const keysId = useId();
  const [lo, hi] = domain;

  // Paused: the committed value positions the head. Playing: the playback loop drives it per frame.
  useLayoutEffect(() => {
    if (!playing) placeHead(headRef.current, value, lo, hi);
  }, [value, playing, lo, hi, headRef]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const indexAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return min;
    const domainIdx = indexFromRatio((clientX - r.left) / r.width, lo, hi);
    return Math.min(max, Math.max(min, domainIdx));
  };

  const schedule = (i: number) => {
    pending.current = i;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = pending.current;
      pending.current = null;
      if (p !== null) onScrub(p);
    });
  };

  const showHover = (clientX: number) => {
    const el = hoverRef.current;
    const r = trackRef.current?.getBoundingClientRect();
    if (!el || !r) return;
    const i = indexAt(clientX);
    const x = ((i - lo) / Math.max(1, hi - lo)) * r.width;
    el.textContent = hoverLabel(i);
    const w = el.offsetWidth;
    el.style.transform = `translateX(${Math.min(Math.max(0, x - w / 2), Math.max(0, r.width - w))}px)`;
    el.style.opacity = "1";
  };
  const hideHover = () => {
    if (hoverRef.current) hoverRef.current.style.opacity = "0";
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    dragging.current = true;
    schedule(indexAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") showHover(e.clientX);
    if (dragging.current) schedule(indexAt(e.clientX));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = stepIndex(value, e.shiftKey ? largeStep : 1, min, max);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = stepIndex(value, -(e.shiftKey ? largeStep : 1), min, max);
        break;
      case "PageUp":
        next = stepIndex(value, pageStep, min, max);
        break;
      case "PageDown":
        next = stepIndex(value, -pageStep, min, max);
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      case " ":
      case "Spacebar":
        e.preventDefault();
        onTogglePlay();
        return;
      default:
        return;
    }
    e.preventDefault();
    onScrub(next);
  };

  return (
    <div className="relative h-10 min-w-0 flex-1">
      <span id={keysId} className="sr-only">
        {t(S.keys)}
      </span>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value ?? undefined}
        aria-valuetext={valueText}
        aria-describedby={keysId}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={hideHover}
        className="group/scrub absolute inset-0 cursor-pointer touch-none overflow-x-clip rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60"
      >
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-ui-border" />
        {children}
        <div ref={headRef} aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-full opacity-0 will-change-transform">
          <span className={cn("absolute inset-y-0 left-0 w-px -translate-x-1/2", tone === "cyan" ? "bg-ui-cyan" : "bg-ui-violet")} />
          <span
            className={cn(
              "absolute -top-0.5 left-0 size-2 -translate-x-1/2 rotate-45 rounded-[2px] border",
              tone === "cyan" ? "border-ui-cyan bg-ui-bg" : "border-ui-violet bg-ui-bg",
            )}
          />
        </div>
      </div>
      {overlay}
      <div
        ref={hoverRef}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 z-10 rounded-md border border-ui-border bg-ui-elevated px-1.5 py-0.5 text-[10.5px] whitespace-nowrap text-ui-text opacity-0 shadow-lg transition-opacity duration-100"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Historical mode                                                    */
/* ------------------------------------------------------------------ */

const HIST_COLORS: Record<Exclude<RainClass, "none">, string> = {
  light: "rgba(37, 217, 242, 0.32)",
  moderate: "rgba(37, 217, 242, 0.6)",
  heavy: RAIN_CLASS_META.heavy.color,
  veryHeavy: RAIN_CLASS_META.veryHeavy.color,
};

/** One <path> per TMD class (cheap even for thousands of days). Null days get a faint baseline tick, never a zero bar. */
function buildHistogram(values: (number | null)[]) {
  let max = 0;
  for (const v of values) if (v !== null && v > max) max = v;
  const d: Record<Exclude<RainClass, "none">, string[]> = { light: [], moderate: [], heavy: [], veryHeavy: [] };
  const nulls: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      nulls.push(`M${i - 0.4} 100V97h0.8V100Z`);
      return;
    }
    const cls = rainClass24h(v);
    if (!cls || cls === "none" || max <= 0) return;
    const h = Math.max(3, Math.sqrt(v / max) * 82);
    d[cls].push(`M${i - 0.4} 100V${(100 - h).toFixed(2)}h0.8V100Z`);
  });
  return {
    paths: (Object.keys(d) as Exclude<RainClass, "none">[]).map((k) => ({ cls: k, d: d[k].join("") })),
    nulls: nulls.join(""),
  };
}

function yearTicks(dates: string[]) {
  const out: { i: number; year: number }[] = [];
  let prev = "";
  dates.forEach((iso, i) => {
    const y = iso.slice(0, 4);
    if (y !== prev) {
      if (prev !== "" || iso.slice(5, 10) === "01-01") out.push({ i, year: Number(y) });
      prev = y;
    }
  });
  return out;
}

interface EventMark {
  event: FloodEvent;
  from: number;
  to: number;
  peak: number;
}

function EventMarker({ mark, n, onJump, outside, partial }: { mark: EventMark; n: number; onJump: (i: number) => void; outside: FloodEvent[]; partial: boolean }) {
  const t = useTr();
  const lang = useLang();
  const span = Math.max(1, n - 1);
  const left = (mark.from / span) * 100;
  const width = Math.max(0.6, ((mark.to - mark.from) / span) * 100);
  const center = ((mark.from + mark.to) / 2 / span) * 100;
  const title = lang === "th" ? mark.event.titleTh : mark.event.titleEn;
  const range = mark.event.from === mark.event.to ? formatDate(mark.event.from, lang) : `${formatDate(mark.event.from, lang)} – ${formatDate(mark.event.to, lang)}`;
  return (
    <>
      <span aria-hidden className="pointer-events-none absolute top-1 h-[3px] rounded-full bg-ui-orange/70" style={{ left: `${left}%`, width: `${width}%` }} />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`${t(S.floodEvent)}: ${title} (${range}) — ${t(S.jumpPeak)}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onJump(mark.peak)}
              className="absolute -top-2 z-[1] grid size-4 -translate-x-1/2 place-items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/70"
              style={{ left: `${center}%` }}
            />
          }
        >
          <span aria-hidden className="size-2 rotate-45 rounded-[2px] border border-ui-orange bg-ui-bg shadow-[0_0_0_2px_rgba(6,17,30,0.9)]" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72 flex-col items-start gap-0.5 text-left">
          <span className="text-[10px] tracking-wide uppercase opacity-70">{t(S.floodEvent)}</span>
          <span className="text-[12px] font-semibold">{title}</span>
          <span className="text-[11px] opacity-80">{range}</span>
          <span className="line-clamp-3 text-[11px] opacity-80">{lang === "th" ? mark.event.summaryTh : mark.event.summaryEn}</span>
          {partial && <span className="text-[10.5px] opacity-80">{t(S.partial)}</span>}
          <span className="mt-0.5 text-[10.5px] opacity-70">{t(S.jumpPeak)}</span>
          {outside.length > 0 && (
            <span className="mt-1 text-[10.5px] opacity-70">
              {t(S.alsoOutside)}: {outside.map((e) => (lang === "th" ? e.titleTh : e.titleEn)).join(" · ")}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </>
  );
}

/** Documented events that fall outside the daily record: listed, never placed on the track. */
function OutOfRangeEvents({ events, first, last }: { events: FloodEvent[]; first: string; last: string }) {
  const t = useTr();
  const lang = useLang();
  const reduced = useReducedMotionPref();
  const range = (e: FloodEvent) => (e.from === e.to ? formatDate(e.from, lang) : `${formatDate(e.from, lang)} – ${formatDate(e.to, lang)}`);
  const label = `${t(S.outOfRange)}: ${events.map((e) => `${lang === "th" ? e.titleTh : e.titleEn} (${range(e)})`).join("; ")}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={() => {
              // the full list (summaries + sources) lives in the details panel: city overview, or the area's Flood tab
              // (PanelSection heading ids are `${id}-${uid}`)
              const st = useDashboard.getState();
              st.setPanel("rightOpen", true);
              if (st.sheetSnap === "collapsed") st.setSheetSnap("half");
              if (st.selectedAreaId) st.setDetailTab("flood");
              const target = st.selectedAreaId ? `${st.selectedAreaId}-f-events` : "city-events";
              requestAnimationFrame(() =>
                requestAnimationFrame(() => document.querySelector(`[id^="${target}-"]`)?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" })),
              );
            }}
            className="relative grid size-8 shrink-0 place-items-center rounded-lg border border-ui-border text-ui-orange/90 transition-colors outline-none hover:border-ui-border-strong focus-visible:ring-2 focus-visible:ring-ui-cyan/60"
          />
        }
      >
        <CalendarRange className="size-3.5" aria-hidden />
        <span aria-hidden className="ui-num absolute -top-1 -right-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-ui-orange px-0.5 text-[9px] leading-none font-semibold text-ui-bg">
          {events.length}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-80 flex-col items-start gap-1 text-left">
        <span className="text-[10px] tracking-wide uppercase opacity-70">{t(S.outOfRange)}</span>
        {events.map((e) => (
          <span key={e.id} className="flex flex-col">
            <span className="text-[12px] font-semibold">{lang === "th" ? e.titleTh : e.titleEn}</span>
            <span className="text-[11px] opacity-80">{range(e)}</span>
          </span>
        ))}
        <span className="text-[10.5px] opacity-70">
          {t(S.record)}: {formatDate(first, lang)} – {formatDate(last, lang)}
        </span>
        <span className="text-[10.5px] opacity-70">{t(S.outOfRangeBody)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Opens the Rainfall tab (hourly chart) when the selected day lies inside an hourly-rain event. */
function ViewHourlyButton() {
  const t = useTr();
  const open = () => {
    const st = useDashboard.getState();
    st.setPlaying(false);
    st.setBottomTab("rainfall");
    st.setPanel("bottomOpen", true);
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            onClick={open}
            aria-label={t(S.viewHourlyAria)}
            className="h-8 shrink-0 gap-1 border-ui-cyan/35 px-2 text-[11px] text-ui-cyan hover:bg-ui-cyan/10 hover:text-ui-cyan"
          />
        }
      >
        <Clock3 aria-hidden className="size-3.5" />
        <span className="hidden lg:inline">{t(S.viewHourly)}</span>
      </TooltipTrigger>
      <TooltipContent>{t(S.viewHourlyAria)}</TooltipContent>
    </Tooltip>
  );
}

function leaveScenario() {
  const st = useDashboard.getState();
  if (st.scenarioActive) st.setScenarioActive(false);
}

function HistoricalTimeline() {
  const t = useTr();
  const lang = useLang();
  const { bundle, status, cityId } = useCityBundle();
  const dateIndex = useDashboard((s) => s.dateIndex);
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  const playing = useDashboard((s) => s.playing);
  const headRef = useRef<HTMLDivElement>(null);

  const rain = bundle?.rainAreas ?? null;
  const dates = useMemo(() => rain?.dates ?? [], [rain]);
  const n = dates.length;
  const mean = useMemo(() => (rain ? cityMeanSeries(rain.series, rain.dates.length) : []), [rain]);
  const hist = useMemo(() => buildHistogram(mean), [mean]);
  const years = useMemo(() => yearTicks(dates), [dates]);
  // Events inside the record get a marker; documented events outside it are listed, never dropped silently.
  const { events, outside } = useMemo(() => {
    if (!rain || !bundle?.floodEvents) return { events: [] as EventMark[], outside: [] as FloodEvent[] };
    const p = partitionFloodEvents(
      bundle.floodEvents.filter((e) => e.cityId === cityId),
      rain,
    );
    return { events: p.inRange as EventMark[], outside: p.outOfRange };
  }, [rain, bundle, cityId]);
  const hourlyOnDay = useMemo(
    () => (dateIndex !== null && dates[dateIndex] ? hourlyEventsOn(bundle?.rainHourly, dates[dateIndex]) : []),
    [bundle, dateIndex, dates],
  );

  useTimelinePlayback({
    enabled: n > 1,
    length: n,
    minIndex: 0,
    unitsPerSecond: PLAYBACK_BASE_RATE.historical,
    read: () => useDashboard.getState().dateIndex,
    write: (i) => useDashboard.getState().setDateIndex(i),
    onFrame: (pos) => placeHead(headRef.current, pos, 0, n - 1),
  });

  const scrub = (i: number) => {
    leaveScenario();
    useDashboard.getState().setDateIndex(i);
  };
  const jump = (i: number) => {
    useDashboard.getState().setPlaying(false);
    scrub(i);
  };
  const togglePlay = () => {
    const wasPlaying = useDashboard.getState().playing;
    leaveScenario();
    useDashboard.getState().setPlaying(!wasPlaying);
  };
  const clear = () => {
    const st = useDashboard.getState();
    st.setPlaying(false);
    st.setDateIndex(null);
  };

  if (status === "error") {
    return (
      <p className="flex min-w-0 flex-1 items-center gap-2 text-[12px] text-ui-text-2">
        <TriangleAlert className="size-3.5 text-ui-orange" aria-hidden />
        {t(S.error)}
      </p>
    );
  }
  if (!bundle) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2" aria-busy="true" aria-label={t(S.loading)}>
        <Skeleton className="size-8 rounded-lg bg-ui-elevated" />
        <Skeleton className="h-8 min-w-0 flex-1 rounded-md bg-ui-elevated/70" />
        <Skeleton className="hidden h-8 w-36 rounded-md bg-ui-elevated/70 sm:block" />
      </div>
    );
  }
  if (!rain || n === 0) {
    return (
      <p className="flex min-w-0 flex-1 items-center gap-2 text-[12px] text-ui-text-2">
        <StatusBadge status="unavailable" size="xs" />
        <span className="truncate">{t(S.noRain)}</span>
      </p>
    );
  }

  const idx = dateIndex !== null && dateIndex < n ? dateIndex : null;
  const dayMean = idx !== null ? mean[idx] : null;
  const prov = rain.provenance;
  const source = prov.sourceName ?? t(S.reanalysis);
  const valueText =
    idx === null ? t(S.noDate) : `${formatDate(dates[idx], lang, "long")} — ${t(S.cityMean)} ${dayMean === null ? formatNumber(null, lang) : `${formatNumber(dayMean, lang, 1)} ${mmLabel(lang)}`}`;
  const hoverLabel = (i: number) => {
    const v = mean[i];
    return `${formatDate(dates[i], lang)} · ${v === null ? formatNumber(null, lang) : `${formatNumber(v, lang, 1)} ${mmLabel(lang)}`}`;
  };

  return (
    <>
      <PlayButton playing={playing} disabled={n < 2} onToggle={togglePlay} tone="cyan" />
      <SpeedButton mode="historical" disabled={n < 2} />
      <Scrubber
        domain={[0, n - 1]}
        min={0}
        max={n - 1}
        value={idx}
        playing={playing}
        onScrub={scrub}
        onTogglePlay={togglePlay}
        ariaLabel={t(S.scrubHistorical)}
        valueText={valueText}
        hoverLabel={hoverLabel}
        largeStep={7}
        pageStep={30}
        headRef={headRef}
        tone="cyan"
        overlay={
          <div className="pointer-events-none absolute inset-0 [&>button]:pointer-events-auto">
            {events.map((m) => (
              <EventMarker
                key={m.event.id}
                mark={m}
                n={n}
                onJump={jump}
                outside={outside}
                partial={m.event.from.slice(0, 10) < dates[0] || m.event.to.slice(0, 10) > dates[n - 1]}
              />
            ))}
          </div>
        }
      >
        <svg viewBox={`0 0 ${Math.max(1, n - 1)} 100`} preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-[30px] w-full" role="img" aria-label={t(S.sqrtScale)}>
          {hist.nulls && <path d={hist.nulls} fill="var(--ui-text-3)" opacity={0.35} />}
          {hist.paths.map((p) => (p.d ? <path key={p.cls} d={p.d} fill={HIST_COLORS[p.cls]} /> : null))}
        </svg>
        {years.map((y) => (
          <span key={y.i} aria-hidden className="pointer-events-none absolute top-0 bottom-0 border-l border-ui-border/70" style={{ left: `${(y.i / Math.max(1, n - 1)) * 100}%` }}>
            <span className="ui-num absolute top-0 left-1 text-[9px] leading-none text-ui-text-3">{formatYear(y.year, lang)}</span>
          </span>
        ))}
      </Scrubber>

      <div className="flex w-[104px] shrink-0 flex-col justify-center leading-tight sm:w-[176px]" aria-live="polite">
        <span className="truncate text-[11.5px] font-medium text-ui-text sm:text-[12px]">
          {idx === null ? (
            <span className="text-ui-text-2">{t(S.noDate)}</span>
          ) : (
            <>
              {formatDate(dates[idx], lang)}
              <span className="ui-num ml-1.5 text-ui-cyan">{dayMean === null ? formatNumber(null, lang) : `${formatNumber(dayMean, lang, 1)} ${mmLabel(lang)}`}</span>
            </>
          )}
        </span>
        {scenarioActive ? (
          <span className="hidden truncate text-[10px] text-ui-violet sm:block">{t(S.simRunning)}</span>
        ) : (
          <span className="hidden min-w-0 items-center gap-1 text-[10px] text-ui-text-3 sm:flex" title={prov.methodology ?? source}>
            <StatusBadge status={prov.status} size="xs" />
            <span className="truncate">{source}</span>
          </span>
        )}
      </div>

      {hourlyOnDay.length > 0 && <ViewHourlyButton />}
      {outside.length > 0 && <OutOfRangeEvents events={outside} first={dates[0]} last={dates[n - 1]} />}

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={clear}
              disabled={dateIndex === null}
              aria-label={t(S.clearDate)}
              className="grid size-8 shrink-0 place-items-center rounded-lg border border-ui-border text-ui-text-2 transition-colors outline-none hover:border-ui-border-strong hover:text-ui-text focus-visible:ring-2 focus-visible:ring-ui-cyan/60 disabled:cursor-not-allowed disabled:opacity-35"
            />
          }
        >
          <CalendarX2 className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipContent>{t(S.clearDate)}</TooltipContent>
      </Tooltip>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Simulated-event mode                                               */
/* ------------------------------------------------------------------ */

function hyetographPaths(steps: TimelineStep[]) {
  const n = steps.length;
  let maxI = 0;
  for (const s of steps) maxI = Math.max(maxI, s.intensityMmH);
  const total = n ? steps[n - 1].cumulativeMm : 0;
  const y = (v: number, max: number) => (max > 0 ? 100 - (v / max) * 86 : 100).toFixed(2);
  let area = `M0 100`;
  let line = "";
  steps.forEach((s, i) => {
    area += `L${i} ${y(s.intensityMmH, maxI)}`;
    line += `${i ? "L" : "M"}${i} ${y(s.cumulativeMm, total)}`;
  });
  area += `L${Math.max(0, n - 1)} 100Z`;
  return { area, line };
}

function ScenarioCTA() {
  const t = useTr();
  const open = () => {
    const st = useDashboard.getState();
    st.setPanel("leftOpen", true);
    st.setPanel("labOpen", true);
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[12px] font-medium text-ui-text">{t(S.ctaTitle)}</div>
        <div className="hidden truncate text-[11px] text-ui-text-3 sm:block">{t(S.ctaBody)}</div>
      </div>
      <Button size="sm" variant="outline" onClick={open} className="shrink-0 border-ui-violet/40 text-ui-violet hover:bg-ui-violet/10 hover:text-ui-violet">
        <FlaskConical aria-hidden />
        <span className="hidden sm:inline">{t(S.openLab)}</span>
        <span className="sr-only sm:hidden">{t(S.openLab)}</span>
      </Button>
    </div>
  );
}

function ActiveScenarioTimeline() {
  const t = useTr();
  const lang = useLang();
  const { hyetograph, params } = useScenario();
  const scenarioStep = useDashboard((s) => s.scenarioStep);
  const playing = useDashboard((s) => s.playing);
  const headRef = useRef<HTMLDivElement>(null);
  const gradientId = `hyeto-${useId().replace(/:/g, "")}`;
  const n = hyetograph.length;
  const last = Math.max(1, n - 1);
  const paths = useMemo(() => hyetographPaths(hyetograph), [hyetograph]);
  const rainEnd = useMemo(() => {
    const i = hyetograph.findIndex((s) => s.t >= params.rainDurationH - 1e-9);
    return i < 0 ? last : i;
  }, [hyetograph, params.rainDurationH, last]);

  useTimelinePlayback({
    enabled: n > 1,
    length: n,
    minIndex: 1,
    unitsPerSecond: PLAYBACK_BASE_RATE.scenario,
    read: () => useDashboard.getState().scenarioStep,
    write: (i) => useDashboard.getState().setScenarioStep(i),
    onFrame: (pos) => placeHead(headRef.current, pos, 0, last),
  });

  // Mirrors useScenario(): a step beyond a shortened hyetograph shows its last step.
  const stepIdx = scenarioStep > 0 && n > 1 ? Math.min(scenarioStep, n - 1) : 0;
  const step = stepIdx > 0 ? hyetograph[stepIdx] : null;
  const total = n ? hyetograph[n - 1].cumulativeMm : null;

  const scrub = (i: number) => useDashboard.getState().setScenarioStep(i);
  const togglePlay = () => {
    const st = useDashboard.getState();
    st.setPlaying(!st.playing);
  };
  const showSummary = () => {
    const st = useDashboard.getState();
    st.setPlaying(false);
    st.setScenarioStep(0);
  };

  const stepText = (s: TimelineStep) =>
    `T+${formatElapsed(s.t)} · ${t(S.intensity)} ${formatNumber(s.intensityMmH, lang, 0)} ${mmhLabel(lang)} · ${t(S.cumulative)} ${formatNumber(s.cumulativeMm, lang, 1)} ${mmLabel(lang)}`;
  const summaryText = `${t(S.summary)} · ${formatNumber(total, lang, 0)} ${mmLabel(lang)} ${t(S.inHours)} ${formatNumber(params.rainDurationH, lang, 1)} ${t(S.hours)}`;
  const hoverLabel = (i: number) => {
    const s = hyetograph[i];
    return s ? `T+${formatElapsed(s.t)} · ${formatNumber(s.intensityMmH, lang, 0)} ${mmhLabel(lang)}` : "";
  };

  return (
    <>
      <PlayButton playing={playing} disabled={n < 2} onToggle={togglePlay} tone="violet" />
      <SpeedButton mode="scenario" disabled={n < 2} />
      <button
        type="button"
        onClick={showSummary}
        aria-pressed={scenarioStep === 0}
        aria-label={t(S.summaryAria)}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60",
          scenarioStep === 0 ? "border-ui-violet/45 bg-ui-violet/12 text-ui-violet" : "border-ui-border text-ui-text-2 hover:border-ui-border-strong hover:text-ui-text",
        )}
      >
        <Sigma className="size-3.5" aria-hidden />
        <span className="hidden md:inline">{t(S.summary)}</span>
      </button>
      <Scrubber
        domain={[0, last]}
        min={1}
        max={last}
        value={step ? stepIdx : null}
        playing={playing}
        onScrub={scrub}
        onTogglePlay={togglePlay}
        ariaLabel={t(S.scrubScenario)}
        valueText={step ? stepText(step) : summaryText}
        hoverLabel={hoverLabel}
        largeStep={4}
        pageStep={8}
        headRef={headRef}
        tone="violet"
      >
        <svg viewBox={`0 0 ${last} 100`} preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-[34px] w-full" aria-hidden>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--ui-violet)" stopOpacity="0.55" />
              <stop offset="1" stopColor="var(--ui-violet)" stopOpacity="0.06" />
            </linearGradient>
          </defs>
          <path d={paths.area} fill={`url(#${gradientId})`} />
          <path d={paths.line} fill="none" stroke="var(--ui-cyan)" strokeOpacity={0.7} strokeWidth={1} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
        </svg>
        <span aria-hidden className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-ui-text-3/70" style={{ left: `${(rainEnd / last) * 100}%` }}>
          <span className="absolute top-0 left-1 text-[9px] leading-none whitespace-nowrap text-ui-text-3">{t(S.rainStops)}</span>
        </span>
      </Scrubber>

      <div className="flex w-[104px] shrink-0 flex-col justify-center leading-tight sm:w-[176px]" aria-live="polite">
        <span className="truncate text-[11.5px] font-medium text-ui-text sm:text-[12px]">
          {step ? (
            <>
              <span className="ui-num">T+{formatElapsed(step.t)}</span>
              <span className="ui-num ml-1.5 text-ui-violet">
                {formatNumber(step.intensityMmH, lang, 0)} {mmhLabel(lang)}
              </span>
            </>
          ) : (
            <>
              {t(S.summary)}
              <span className="ui-num ml-1.5 text-ui-violet">
                {formatNumber(total, lang, 0)} {mmLabel(lang)}
              </span>
            </>
          )}
        </span>
        <span className="hidden min-w-0 items-center gap-1 text-[10px] text-ui-text-3 sm:flex">
          <StatusBadge status="simulated" size="xs" />
          <span className="truncate">
            {step
              ? `${t(S.cumulative)} ${formatNumber(step.cumulativeMm, lang, 1)} ${mmLabel(lang)}`
              : `${t(S.inHours)} ${formatNumber(params.rainDurationH, lang, 1)} ${t(S.hours)} · ${t(S.simulatedLabel)}`}
          </span>
        </span>
      </div>
    </>
  );
}

function ScenarioEventTimeline() {
  const active = useDashboard((s) => s.scenarioActive);
  return active ? <ActiveScenarioTimeline /> : <ScenarioCTA />;
}

/* ------------------------------------------------------------------ */
/*  Bar                                                                */
/* ------------------------------------------------------------------ */

/**
 * Timeline bar under the stage (~56 px). Historical replay of daily reanalysis rainfall, or a scrub/playable
 * hyetograph of the simulated event. All values come from the dataset or useScenario().
 */
export function Timeline() {
  const t = useTr();
  const mode = useDashboard((s) => s.timelineMode);
  return (
    <div role="region" aria-label={t(S.region)} className="relative flex h-14 w-full min-w-0 items-center gap-1.5 border-t border-ui-border bg-ui-surface/95 px-2 sm:gap-2 sm:px-3">
      <ModeSwitch />
      <span aria-hidden className="h-7 w-px shrink-0 bg-ui-border" />
      {mode === "historical" ? <HistoricalTimeline /> : <ScenarioEventTimeline />}
    </div>
  );
}
