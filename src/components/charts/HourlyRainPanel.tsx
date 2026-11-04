"use client";

import { useMemo, useState } from "react";
import { CalendarSearch, Crosshair } from "lucide-react";
import type { HourlyRainEvent, RainSeries } from "@/lib/types";
import { useLang, useTr } from "@/lib/i18n";
import { formatDate } from "@/lib/formatters";
import { useDashboard } from "@/store/dashboard-store";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HourlyRainChart } from "./HourlyRainChart";
import { eventForDate, hourlyStats, localDateOf } from "./derive";

const S = {
  pick: { th: "เลือกเหตุการณ์ฝน", en: "Choose a rain event" },
  inEvent: { th: "วันที่บนไทม์ไลน์อยู่ในช่วงเหตุการณ์นี้", en: "The timeline date falls inside this event" },
  goPeak: { th: "ไปยังวันที่ฝนหนักที่สุดบนไทม์ไลน์", en: "Jump the timeline to the wettest day" },
  outOfRange: {
    th: "ช่วงเหตุการณ์อยู่นอกอนุกรมฝนรายวันของไทม์ไลน์ จึงเลือกวันบนไทม์ไลน์จากกราฟนี้ไม่ได้",
    en: "This event is outside the timeline's daily series, so it cannot drive the timeline",
  },
  scope: { th: "ค่าของจุดอ้างอิงเดียวของเมือง ไม่ใช่ค่ารายพื้นที่", en: "One reference point for the city, not a per-area value" },
};

const dayRange = (ev: HourlyRainEvent) => (ev.times.length ? [localDateOf(ev.times[0]), localDateOf(ev.times[ev.times.length - 1])] : [null, null]);

/**
 * Hourly rainfall for the city's documented events: event selector, chart and timeline coupling.
 * The event containing the historical timeline date is chosen automatically and that day highlighted;
 * clicking a bar (or "jump to the wettest day") moves the shared timeline when the date is in its series.
 */
export function HourlyRainPanel({ events, daily, height = 180, compact = false, className }: { events: HourlyRainEvent[] | null | undefined; daily: RainSeries | null | undefined; height?: number; compact?: boolean; className?: string }) {
  const t = useTr();
  const lang = useLang();
  const dateIndex = useDashboard((s) => s.dateIndex);
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  // A manual pick wins until the timeline date changes; then the event containing the new date is shown.
  const [picked, setPicked] = useState<{ id: string; at: string | null } | null>(null);

  const list = useMemo(() => (events ?? []).filter((e) => e && Array.isArray(e.times) && e.times.length > 0), [events]);
  const timelineDate = !scenarioActive && dateIndex !== null ? (daily?.dates[dateIndex] ?? null) : null;
  const auto = eventForDate(list, timelineDate);
  const manual = picked ? list.find((e) => e.id === picked.id) : undefined;
  const current = (manual && (!auto || picked?.at === timelineDate) ? manual : null) ?? auto ?? manual ?? list[0] ?? null;
  const items = useMemo(() => Object.fromEntries(list.map((e) => [e.id, lang === "th" ? e.titleTh : e.titleEn])), [list, lang]);

  const dates = daily?.dates;
  const indexOfDate = (d: string) => (dates ? dates.indexOf(d) : -1);
  const [from, to] = current ? dayRange(current) : [null, null];
  const inSeries = !!(from && to && dates && (indexOfDate(from) >= 0 || indexOfDate(to) >= 0));

  const peakDay = useMemo(() => {
    if (!current) return null;
    const st = hourlyStats(current);
    let best: { date: string; mm: number } | null = null;
    for (const d of st.daily) if (d.mm !== null && (!best || d.mm > best.mm)) best = { date: d.date, mm: d.mm };
    return best;
  }, [current]);

  const selectDate = (d: string) => {
    const i = indexOfDate(d);
    if (i < 0) return;
    const st = useDashboard.getState();
    st.setDateIndex(i);
    if (!st.scenarioActive && st.timelineMode !== "historical") st.setTimelineMode("historical");
  };

  if (!list.length || !current) return null;
  const peakIdx = peakDay ? indexOfDate(peakDay.date) : -1;

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      {(list.length > 1 || !compact) && (
        <div className="flex flex-wrap items-center gap-2">
          {list.length > 1 && (
            <Select
              value={current.id}
              onValueChange={(v) => v && setPicked({ id: v as string, at: timelineDate })}
              items={items}
            >
              <SelectTrigger size="sm" aria-label={t(S.pick)} className="h-7 max-w-full min-w-[200px] text-[12px]">
                <CalendarSearch className="size-3.5 text-ui-text-2" aria-hidden />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {list.map((e) => {
                  const [a, b] = dayRange(e);
                  return (
                    <SelectItem key={e.id} value={e.id} className="text-[12px]">
                      {items[e.id]}
                      {a && <span className="ml-1 text-[10.5px] text-ui-text-2">{a === b ? formatDate(a, lang) : `${formatDate(a, lang)} – ${formatDate(b, lang)}`}</span>}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
          {auto && auto.id === current.id && (
            <span className="inline-flex items-center gap-1 rounded-full border border-ui-cyan/50 bg-ui-cyan/10 px-2 py-0.5 text-[10.5px] text-ui-text" aria-live="polite">
              <span aria-hidden>◐</span>
              {t(S.inEvent)}
            </span>
          )}
          {inSeries && peakDay && peakIdx >= 0 && peakIdx !== dateIndex && (
            <button
              type="button"
              onClick={() => selectDate(peakDay.date)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-ui-border px-2 text-[11px] font-medium text-ui-text-2 transition-colors hover:border-ui-border-strong hover:text-ui-text"
            >
              <Crosshair className="size-3.5" aria-hidden />
              {t(S.goPeak)} ({formatDate(peakDay.date, lang)})
            </button>
          )}
        </div>
      )}
      <HourlyRainChart event={current} highlightDate={timelineDate} onSelectDate={inSeries ? selectDate : undefined} height={height} />
      <p className="text-[10.5px] leading-4 text-ui-text-2">
        {t(S.scope)}
        {current.provenance?.geographicScope ? ` — ${current.provenance.geographicScope}` : ""}
        {!inSeries && dates?.length ? ` · ${t(S.outOfRange)}` : ""}
      </p>
    </div>
  );
}
