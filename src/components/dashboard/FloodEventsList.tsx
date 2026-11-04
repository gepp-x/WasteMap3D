"use client";

import { useMemo, useState } from "react";
import { CalendarRange, ExternalLink, History } from "lucide-react";
import type { FloodEvent, SourceRef } from "@/lib/types";
import { useCityBundle, useSources } from "@/lib/data/loader";
import { useLang, useTr } from "@/lib/i18n";
import { formatDate, formatNumber, formatYear } from "@/lib/formatters";
import { useDashboard } from "@/store/dashboard-store";
import { cn } from "@/lib/utils";
import { MetricReadout, StatusBadge } from "@/components/dashboard/StatusBadge";
import { UnavailableBlock } from "@/components/dashboard/MetricGrid";

const S = {
  none: { th: "ยังไม่มีบันทึกเหตุการณ์น้ำท่วมสำหรับเมืองนี้", en: "No flood-event records for this city yet" },
  peak: { th: "ฝนสูงสุด", en: "Peak rainfall" },
  source: { th: "แหล่งข้อมูล", en: "Source" },
  showAll: { th: "แสดงทั้งหมด ({n})", en: "Show all ({n})" },
  showLess: { th: "แสดงน้อยลง", en: "Show fewer" },
  newTab: { th: "(เปิดในแท็บใหม่)", en: "(opens in a new tab)" },
  list: { th: "เหตุการณ์น้ำท่วมในอดีต", en: "Past flood events" },
  days: { th: "{n} วัน", en: "{n} days" },
  oneDay: { th: "1 วัน", en: "1 day" },
  onTimeline: { th: "ดูบนไทม์ไลน์", en: "Show on timeline" },
  onTimelineAria: { th: "เลื่อนไทม์ไลน์ไปยังวันที่ {d}", en: "Move the timeline to {d}" },
  outside: { th: "อยู่นอกช่วงข้อมูลฝนรายวันของไทม์ไลน์ ({a}–{b})", en: "Outside the timeline's daily rainfall series ({a}–{b})" },
  strip: { th: "ลำดับเหตุการณ์ตามเวลา", en: "Events over time" },
  more: { th: "อ่านต่อ", en: "Read more" },
  less: { th: "ย่อ", en: "Collapse" },
};

const DAY = 86_400_000;
const toMs = (iso: string) => new Date(`${iso}T00:00:00+07:00`).getTime();
const spanDays = (ev: FloodEvent) => (ev.to && ev.to >= ev.from ? Math.round((toMs(ev.to) - toMs(ev.from)) / DAY) + 1 : 1);

/**
 * Historical flood events (newest first): BE dates, duration, summary, peak-rainfall MetricReadout and a
 * source link. With several events a compact year strip shows them in time; events inside the daily
 * rainfall series can move the shared historical timeline to their dates.
 */
export function FloodEventsList({ events, max = 3, dense = false, className }: { events: FloodEvent[] | null | undefined; max?: number; dense?: boolean; className?: string }) {
  const t = useTr();
  const lang = useLang();
  const sources = useSources();
  const { bundle } = useCityBundle();
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const sorted = useMemo(() => [...(events ?? [])].filter((e) => e && e.from).sort((a, b) => b.from.localeCompare(a.from)), [events]);
  const byId = useMemo(() => new Map<string, SourceRef>((sources.data ?? []).map((s) => [s.id, s] as const)), [sources.data]);
  const dates = bundle?.rainAreas?.dates ?? null;

  if (!sorted.length) return <UnavailableBlock className={className}>{t(S.none)}</UnavailableBlock>;

  const goTo = (ev: FloodEvent) => {
    if (!dates) return;
    // the first day of the event inside the series (events can start before the series begins)
    const i = dates.findIndex((d) => d >= ev.from && d <= (ev.to || ev.from));
    if (i < 0) return;
    const st = useDashboard.getState();
    // Pause (not reset) a running scenario: its parameters stay in the lab and it can be re-enabled.
    if (st.scenarioActive) st.setScenarioActive(false);
    else if (st.timelineMode !== "historical") st.setTimelineMode("historical");
    st.setDateIndex(i);
  };
  const inSeries = (ev: FloodEvent) => !!dates?.length && dates.some((d) => d >= ev.from && d <= (ev.to || ev.from));

  const shown = expanded ? sorted : sorted.slice(0, max);
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {sorted.length > 1 && <YearStrip events={sorted} label={t(S.strip)} />}
      <ol className="flex flex-col gap-2" aria-label={t(S.list)}>
        {shown.map((ev) => {
          const src = byId.get(ev.sourceId);
          const srcName = src ? (lang === "th" && src.nameTh ? src.nameTh : src.nameEn) : ev.sourceId;
          const n = spanDays(ev);
          const sameDay = n <= 1;
          const summary = lang === "th" ? ev.summaryTh : ev.summaryEn;
          const long = (summary?.length ?? 0) > 220;
          const isOpen = !!open[ev.id];
          const canGo = inSeries(ev);
          return (
            <li key={ev.id} className="rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12.5px] leading-5 font-medium text-ui-text">{lang === "th" ? ev.titleTh : ev.titleEn}</div>
                  <div className="mt-0.5 inline-flex flex-wrap items-center gap-1 text-[10.5px] text-ui-text-2">
                    <CalendarRange className="size-3" aria-hidden />
                    <time dateTime={ev.from}>{formatDate(ev.from, lang)}</time>
                    {!sameDay && (
                      <>
                        <span aria-hidden>–</span>
                        <time dateTime={ev.to}>{formatDate(ev.to, lang)}</time>
                      </>
                    )}
                    <span className="ui-num text-ui-text-3">· {n <= 1 ? t(S.oneDay) : t(S.days).replace("{n}", formatNumber(n, lang))}</span>
                  </div>
                </div>
                {ev.peakRainMm && (
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="text-[10px] text-ui-text-2">{t(S.peak)}</span>
                    <MetricReadout metric={ev.peakRainMm} decimals={0} animate={false} valueClassName="text-[13px] font-semibold text-ui-text" />
                    <StatusBadge status={ev.peakRainMm.provenance.status} size="xs" />
                  </div>
                )}
              </div>
              {!dense && summary && (
                <p className={cn("mt-1.5 text-[11.5px] leading-[1.6] text-ui-text-2", long && !isOpen && "line-clamp-3")}>
                  {summary}
                </p>
              )}
              {!dense && long && (
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [ev.id]: !o[ev.id] }))}
                  aria-expanded={isOpen}
                  className="mt-0.5 rounded px-0.5 text-[10.5px] font-medium text-ui-cyan hover:underline"
                >
                  {t(isOpen ? S.less : S.more)}
                </button>
              )}
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="min-w-0 text-[10.5px] text-ui-text-2">
                  {t(S.source)}:{" "}
                  {src?.url ? (
                    <a href={src.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-ui-text underline decoration-ui-border-strong underline-offset-2 hover:decoration-ui-cyan">
                      {srcName}
                      <ExternalLink className="size-2.5" aria-hidden />
                      <span className="sr-only">{t(S.newTab)}</span>
                    </a>
                  ) : (
                    <span className="text-ui-text">{srcName}</span>
                  )}
                </div>
                {canGo ? (
                  <button
                    type="button"
                    onClick={() => goTo(ev)}
                    aria-label={t(S.onTimelineAria).replace("{d}", formatDate(ev.from, lang, "long"))}
                    className="inline-flex h-6 items-center gap-1 rounded-md border border-ui-border px-1.5 text-[10.5px] font-medium text-ui-text-2 transition-colors hover:border-ui-cyan/60 hover:text-ui-text"
                  >
                    <History className="size-3" aria-hidden />
                    {t(S.onTimeline)}
                  </button>
                ) : dates && dates.length > 0 ? (
                  <span className="text-[10px] text-ui-text-3">
                    {t(S.outside).replace("{a}", formatYear(Number(dates[0].slice(0, 4)), lang)).replace("{b}", formatYear(Number(dates[dates.length - 1].slice(0, 4)), lang))}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {sorted.length > max && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="self-start rounded-md px-1.5 py-1 text-[11px] font-medium text-ui-cyan hover:bg-ui-elevated/60"
        >
          {expanded ? t(S.showLess) : t(S.showAll).replace("{n}", String(sorted.length))}
        </button>
      )}
    </div>
  );
}

/** Compact year axis with one tick per event (decorative; the list below carries every fact). */
function YearStrip({ events, label }: { events: FloodEvent[]; label: string }) {
  const lang = useLang();
  const years = events.map((e) => Number(e.from.slice(0, 4))).filter(Number.isFinite);
  const y0 = Math.min(...years);
  const y1 = Math.max(...years, y0 + 1);
  const pos = (iso: string) => {
    const y = Number(iso.slice(0, 4));
    const doy = (toMs(iso) - toMs(`${y}-01-01`)) / (365.25 * DAY);
    return ((y + doy - y0) / (y1 + 1 - y0)) * 100;
  };
  return (
    <div className="px-1 pt-1 pb-0.5" aria-hidden title={label}>
      <div className="relative h-5">
        <div className="absolute inset-x-0 top-2.5 h-px bg-ui-border-strong" />
        {events.map((e) => (
          <span key={e.id} className="absolute top-1 size-3 -translate-x-1/2 rotate-45 rounded-[2px] border border-[var(--ui-orange)] bg-[color-mix(in_srgb,var(--ui-orange)_35%,transparent)]" style={{ left: `${pos(e.from)}%` }} />
        ))}
      </div>
      <div className="flex justify-between text-[9.5px] text-ui-text-3">
        <span className="ui-num">{formatYear(y0, lang)}</span>
        <span className="ui-num">{formatYear(y1, lang)}</span>
      </div>
    </div>
  );
}
