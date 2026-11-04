"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { useCityBundle } from "@/lib/data/loader";
import { rainClass24h } from "@/lib/simulation/model";
import { useLang, useTr } from "@/lib/i18n";
import { formatDate, formatNumber } from "@/lib/formatters";
import { useDashboard, type Lang } from "@/store/dashboard-store";
import { cn } from "@/lib/utils";
import { MetricReadout, StatusBadge } from "@/components/dashboard/StatusBadge";
import { PanelNote, UnavailableBlock } from "@/components/dashboard/MetricGrid";
import { RainfallChart } from "@/components/charts/RainfallChart";
import { ChartSkeleton } from "@/components/charts/chart-kit";
import { RAIN_CLASS_LABELS, TMD_CLASSES } from "@/components/charts/palette";
import { meanRainSeries } from "@/components/charts/derive";
import { HourlyRainPanel } from "@/components/charts/HourlyRainPanel";

const S = {
  region: { th: "ฝน", en: "Rainfall" },
  title: { th: "ฝนรายวันเฉลี่ยทั้งเมือง · 180 วัน", en: "City mean daily rainfall · 180 days" },
  gridFallback: {
    th: "ไม่มีอนุกรมฝนรายพื้นที่ แสดงค่าเฉลี่ยจากจุดกริดแบบจำลองแทน (เลือกวันบนไทม์ไลน์ไม่ได้)",
    en: "No per-area series; showing the reanalysis grid mean instead (timeline date selection unavailable)",
  },
  selected: { th: "วันที่เลือก", en: "Selected date" },
  none: { th: "ยังไม่ได้เลือกวัน (แสดงสภาวะฐาน)", en: "No date selected (baseline shown)" },
  cityMean: { th: "ค่าเฉลี่ยเมือง", en: "City mean" },
  prev: { th: "วันก่อนหน้า", en: "Previous day" },
  next: { th: "วันถัดไป", en: "Next day" },
  clear: { th: "ล้างวันที่", en: "Clear date" },
  scenarioOn: {
    th: "กำลังแสดงสถานการณ์จำลอง วันที่ที่เลือกจะมีผลกับแบบจำลองเมื่อปิดโหมดจำลอง",
    en: "A scenario is active; the selected date drives the model once the scenario is turned off",
  },
  stations: { th: "สถานีวัดฝน (ค่าล่าสุดจากสถานี)", en: "Rain stations (latest reading)" },
  stationNote: { th: "ค่าจากสถานีเป็นค่าล่าสุด ไม่ขึ้นกับวันที่เลือก", en: "Station values are latest readings, independent of the selected date" },
  station: { th: "สถานี", en: "Station" },
  rain24: { th: "ฝน 24 ชม.", en: "Rain 24 h" },
  time: { th: "เวลา", en: "Time" },
  noStations: { th: "ไม่มีข้อมูลสถานีวัดฝนสำหรับเมืองนี้", en: "No rain-station data for this city" },
  tmd: { th: "เกณฑ์ปริมาณฝน 24 ชม. (กรมอุตุนิยมวิทยา)", en: "24-h rainfall classes (TMD)" },
  mm: { th: "มม.", en: "mm" },
  noRain: { th: "ไม่มีข้อมูลอนุกรมฝนสำหรับเมืองนี้", en: "No rainfall series for this city" },
  hourly: { th: "ฝนรายชั่วโมงช่วงเหตุการณ์", en: "Hourly rainfall during events" },
};

const timeFmt = new Map<Lang, Intl.DateTimeFormat>();
function shortTime(iso: string | undefined, lang: Lang) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let f = timeFmt.get(lang);
  if (!f) {
    f = new Intl.DateTimeFormat(lang === "th" ? "th-TH-u-ca-buddhist" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
    timeFmt.set(lang, f);
  }
  return f.format(d);
}

export function RainfallPanel() {
  const t = useTr();
  const lang = useLang();
  const { bundle, status } = useCityBundle();
  const dateIndex = useDashboard((s) => s.dateIndex);
  const setDateIndex = useDashboard((s) => s.setDateIndex);
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  const timelineMode = useDashboard((s) => s.timelineMode);
  const setTimelineMode = useDashboard((s) => s.setTimelineMode);

  const rs = bundle?.rainAreas ?? null;
  const series = rs ?? bundle?.rainGrid ?? null;
  const len = rs?.dates.length ?? 0;
  const mean = useMemo(() => (rs ? meanRainSeries(rs) : null), [rs]);

  // Keep the selected date visible: when it is older than the 180-day window, end the window 30 days after it.
  const endIndex = rs && dateIndex !== null && dateIndex < len - 180 ? Math.min(len - 1, dateIndex + 30) : null;

  const select = (i: number) => {
    if (!rs) return;
    const n = Math.max(0, Math.min(len - 1, i));
    setDateIndex(n);
    if (!scenarioActive && timelineMode !== "historical") setTimelineMode("historical");
  };

  const stations = useMemo(
    () => [...(bundle?.stations ?? [])].sort((a, b) => (b.rain24h?.value ?? -1) - (a.rain24h?.value ?? -1)),
    [bundle?.stations],
  );

  if (!bundle) {
    return (
      <div className="grid h-full grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_300px]" aria-busy={status === "loading"}>
        <ChartSkeleton height={150} />
        <ChartSkeleton height={150} />
      </div>
    );
  }

  const selDate = rs && dateIndex !== null ? rs.dates[dateIndex] : null;
  const selVal = mean && dateIndex !== null ? (mean[dateIndex] ?? null) : null;
  const selCls = rainClass24h(selVal);

  return (
    <div className="ui-scroll h-full min-h-0 overflow-y-auto" role="region" aria-label={t(S.region)}>
      <div className="grid grid-cols-1 gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,320px)] xl:grid-cols-[minmax(0,1fr)_minmax(260px,320px)_200px]">
        <div className="flex min-w-0 flex-col gap-3">
          {!series ? (
            <UnavailableBlock>{t(S.noRain)}</UnavailableBlock>
          ) : (
            <>
              <RainfallChart
                series={series}
                days={180}
                endIndex={endIndex}
                selectedIndex={rs ? dateIndex : null}
                onSelectIndex={rs ? select : undefined}
                title={t(S.title)}
                height={170}
              />
              {!rs && <PanelNote tone="warn">{t(S.gridFallback)}</PanelNote>}
              {rs && (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1" role="group" aria-label={t(S.selected)}>
                    <button
                      type="button"
                      onClick={() => select((dateIndex ?? len) - 1)}
                      disabled={dateIndex === 0}
                      aria-label={t(S.prev)}
                      className="inline-flex size-7 items-center justify-center rounded-md border border-ui-border text-ui-text-2 hover:border-ui-border-strong hover:text-ui-text disabled:opacity-40"
                    >
                      <ChevronLeft className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => select((dateIndex ?? len - 2) + 1)}
                      disabled={dateIndex === null || dateIndex >= len - 1}
                      aria-label={t(S.next)}
                      className="inline-flex size-7 items-center justify-center rounded-md border border-ui-border text-ui-text-2 hover:border-ui-border-strong hover:text-ui-text disabled:opacity-40"
                    >
                      <ChevronRight className="size-3.5" aria-hidden />
                    </button>
                  </div>
                  <div className="min-w-0 text-[11.5px]" aria-live="polite">
                    {selDate ? (
                      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-ui-text-2">{t(S.selected)}:</span>
                        <span className="font-medium text-ui-text">{formatDate(selDate, lang, "long")}</span>
                        <span className="text-ui-text-2">
                          · {t(S.cityMean)} <span className="ui-num text-ui-text">{selVal === null ? t({ th: "ยังไม่มีข้อมูล", en: "Unavailable" }) : `${formatNumber(selVal, lang, 1)} ${t(S.mm)}`}</span>
                          {selCls && ` (${t(RAIN_CLASS_LABELS[selCls])})`}
                        </span>
                        <StatusBadge status={rs.provenance.status} size="xs" />
                      </span>
                    ) : (
                      <span className="text-ui-text-2">{t(S.none)}</span>
                    )}
                  </div>
                  {dateIndex !== null && (
                    <button
                      type="button"
                      onClick={() => setDateIndex(null)}
                      className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-ui-border px-2 text-[11px] text-ui-text-2 hover:border-ui-border-strong hover:text-ui-text"
                    >
                      <RotateCcw className="size-3" aria-hidden />
                      {t(S.clear)}
                    </button>
                  )}
                </div>
              )}
              {scenarioActive && rs && <PanelNote tone="sim">{t(S.scenarioOn)}</PanelNote>}
            </>
          )}
          {!!bundle.rainHourly?.length && (
            <section className="mt-2 flex min-w-0 flex-col gap-2 border-t border-ui-border/60 pt-3" aria-label={t(S.hourly)}>
              <h3 className="text-[12.5px] font-medium text-ui-text">{t(S.hourly)}</h3>
              <HourlyRainPanel events={bundle.rainHourly} daily={rs} height={170} />
            </section>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-[12.5px] font-medium text-ui-text">{t(S.stations)}</div>
          {!bundle.stations ? (
            <UnavailableBlock>{t(S.noStations)}</UnavailableBlock>
          ) : (
            <>
              <div className="ui-scroll max-h-[220px] overflow-y-auto rounded-md border border-ui-border/70">
                <table className="w-full text-[11px]">
                  <caption className="sr-only">{t(S.stations)}</caption>
                  <thead className="sticky top-0 bg-ui-elevated">
                    <tr className="text-left text-[10.5px] text-ui-text-2">
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        {t(S.station)}
                      </th>
                      <th scope="col" className="px-2 py-1.5 text-right font-medium">
                        {t(S.rain24)}
                      </th>
                      <th scope="col" className="px-2 py-1.5 text-right font-medium">
                        {t(S.time)}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stations.map((st) => (
                      <tr key={st.id} className="border-t border-ui-border/50 align-top">
                        <th scope="row" className="px-2 py-1 text-left font-normal text-ui-text">
                          <span className="line-clamp-1">{lang === "th" && st.nameTh ? st.nameTh : st.nameEn}</span>
                          <span className="block text-[10px] text-ui-text-2">{st.agency}</span>
                        </th>
                        <td className="px-2 py-1 text-right">
                          <span className="inline-flex flex-col items-end gap-0.5">
                            <MetricReadout metric={st.rain24h} decimals={1} animate={false} valueClassName="text-ui-text" />
                            <StatusBadge status={st.rain24h?.provenance.status ?? "unavailable"} size="xs" showLabel={false} />
                          </span>
                        </td>
                        <td className="ui-num px-2 py-1 text-right text-[10.5px] text-ui-text-2">{shortTime(st.observedAt, lang)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10.5px] text-ui-text-2">{t(S.stationNote)}</p>
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-2 lg:col-span-2 xl:col-span-1">
          <div className="text-[12.5px] font-medium text-ui-text">{t(S.tmd)}</div>
          <ul className="flex flex-col gap-1.5 text-[11px]">
            {TMD_CLASSES.map((c) => (
              <li key={c.id} className={cn("flex items-center gap-2 rounded-md border border-ui-border/60 px-2 py-1.5", selCls === c.id && "border-ui-cyan/60")}>
                <span aria-hidden className="inline-block h-3 w-4 rounded-[3px] border border-ui-border-strong" style={{ background: c.swatch }} />
                <span className="text-ui-text">{t(c.label)}</span>
                <span className="ui-num ml-auto text-ui-text-2">
                  {c.range} {t(S.mm)}
                </span>
                {selCls === c.id && <span className="sr-only">{t(S.selected)}</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
