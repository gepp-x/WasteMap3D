"use client";

import { useCallback, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, Layers } from "lucide-react";
import { useDashboard } from "@/store/dashboard-store";
import { useLang, useTr, type Bi } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { formatDate, formatNumber, unitLabel } from "@/lib/formatters";
import { METRICS } from "@/lib/metrics";
import { useReducedMotionPref } from "@/lib/animation/tokens";
import type { DataStatus } from "@/lib/types";
import type { ChoroplethModel, LegendClass } from "@/lib/map/choropleth";
import { STRESS_CLASSES } from "@/lib/map/choropleth";
import { COLORS, HEAT_RAMP, STATION_NONE_COLOR, STATION_STEPS, WATER_KIND_COLOR } from "@/lib/map/data-layers";
import { DRAIN_KINDS, type DrainKind, type WaterKind } from "@/lib/map/features";
import { AREA_KIND, DRAIN_KIND_LABEL, MAP_STRINGS, WATER_KIND_LABEL, formatDateTime } from "@/lib/map/labels";
import { COMMUNITY_TEXT } from "@/lib/map/communities";
import { GAUGE_CLASSES, GAUGE_SCHEME, GAUGE_SNAPSHOT } from "@/lib/map/water-levels";
import { GaugeGlyph } from "./GaugeGlyph";
import type { MapModel } from "./use-map-model";

const S = {
  legend: { th: "คำอธิบายแผนที่", en: "Map legend" },
  toggle: { th: "แสดง/ซ่อนคำอธิบายแผนที่", en: "Show/hide map legend" },
  noChoropleth: { th: "ไม่ได้เปิดชั้นข้อมูลแผนที่สี — เลือกได้จากแผงชั้นข้อมูล", en: "No choropleth active — pick one in the layer panel" },
  quantile: { th: "แบ่ง 5 ชั้นแบบควอนไทล์", en: "5 quantile classes" },
  riskScheme: { th: "เกณฑ์คงที่ของแบบจำลองเชิงสาธิต", en: "Fixed classes of the illustrative model" },
  rainScheme: { th: "เกณฑ์ฝน 24 ชม. ของกรมอุตุนิยมวิทยา", en: "TMD 24-hour rainfall classes" },
  noData: { th: "ยังไม่มีข้อมูล", en: "Unavailable" },
  count: { th: "จำนวน", en: "Count" },
  live: { th: "ค่าจำลองที่ปรับตามสถานการณ์/ไทม์ไลน์", en: "Simulated — follows the scenario / timeline" },
  timeline: { th: "แสดงค่าของวันที่เลือกบนไทม์ไลน์", en: "Showing values for the selected timeline date" },
  date: { th: "วันที่", en: "Date" },
  meanAnnual: { th: "ค่าเฉลี่ยรายปี (คำนวณจากข้อมูลรายวัน)", en: "Mean annual (from daily series)" },
  missingDate: { th: "ไม่มีข้อมูลกริดสำหรับวันที่เลือก", en: "No grid data for the selected date" },
  noGrid: { th: "ไม่มีข้อมูลกริดฝนสำหรับเมืองนี้", en: "No rainfall grid for this city" },
  low: { th: "ต่ำ", en: "Low" },
  high: { th: "สูง", en: "High" },
  stations: { th: "สถานีวัดฝน — ฝนสะสม 24 ชม.", en: "Rain gauges — 24 h rainfall" },
  noStations: { th: "ไม่มีข้อมูลสถานีสำหรับเมืองนี้", en: "No station data for this city" },
  noValue: { th: "ไม่มีค่า", en: "No reading" },
  asOf: { th: "ข้อมูล ณ", en: "As of" },
  water: { th: "แหล่งน้ำและระบบระบายน้ำ", en: "Water & drainage" },
  noWater: { th: "ไม่มีข้อมูลแหล่งน้ำ/ระบบระบายน้ำ", en: "No waterway / drainage data" },
  stressRing: { th: "วงรอบ = แรงกดดันระบายน้ำของพื้นที่ (แบบจำลอง)", en: "Ring = area drainage stress (modeled)" },
  flowNote: { th: "เส้นเคลื่อนไหวแสดงการไหลเชิงภาพประกอบ", en: "Moving dashes illustrate flow" },
  hotspots: { th: "จุดสะสมขยะระดับพื้นที่", en: "Area-level waste hotspots" },
  noHotspots: { th: "ไม่มีข้อมูลสำหรับสร้างจุดสะสม", en: "No data to derive hotspots" },
  ringSize: { th: "ขนาดวง ∝ ค่าของพื้นที่ · วงกะพริบ = 20% สูงสุด", en: "Ring size ∝ area value · pulsing = top 20%" },
  boundaries: { th: "ขอบเขต", en: "Boundaries" },
  areaOutline: { th: "ขอบเขตพื้นที่", en: "Area boundary" },
  gauges: { th: "สถานีวัดระดับน้ำ — สถานการณ์น้ำ", en: "Water-level gauges — situation" },
  noGauges: { th: "ไม่มีข้อมูลสถานีวัดระดับน้ำสำหรับเมืองนี้", en: "No water-level gauge data for this city" },
  gaugeLabel: { th: "ตัวเลขข้างสถานี = ระดับน้ำ (ม.รทก.)", en: "Number beside a gauge = level (m MSL)" },
  communities: { th: "ชุมชน (เทศบาลนครหาดใหญ่)", en: "Communities (Hat Yai Municipality)" },
  communitiesSub: { th: "รายชื่อตามประกาศเทศบาล · ตำแหน่งแยกตามความน่าเชื่อถือ", en: "Official list · locations split by reliability" },
  unplaced: { th: "{n} ชุมชนไม่มีตำแหน่ง (แสดงเฉพาะในรายชื่อ)", en: "{n} communities without a location (list only)" },
  pumpOfficial: { th: "สถานีสูบน้ำ (ทะเบียนทางการ กทม.)", en: "Pump station (official BMA register)" },
  pumpOsm: { th: "สถานีสูบน้ำ (OpenStreetMap)", en: "Pump station (OpenStreetMap)" },
} satisfies Record<string, Bi>;

/* ------------------------------------------------------------------ small primitives */

function subscribeMq(query: string) {
  return (cb: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  };
}
function useMediaQuery(query: string, serverDefault: boolean) {
  const subscribe = useCallback((cb: () => void) => subscribeMq(query)(cb), [query]);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverDefault,
  );
}

const HATCH_BG = "repeating-linear-gradient(-45deg, rgba(124,150,172,0.55) 0 1px, rgba(11,27,44,0.55) 1px 4px)";

function Swatch({ color, kind = "rect", className }: { color?: string; kind?: "rect" | "hatch" | "line" | "dash" | "ring" | "dot"; className?: string }) {
  if (kind === "line" || kind === "dash")
    return (
      <span aria-hidden className={cn("inline-flex h-3 w-5 shrink-0 items-center", className)}>
        <span className={cn("w-full", kind === "dash" ? "border-t-[1.5px] border-dashed" : "h-[2.5px] rounded-full")} style={kind === "dash" ? { borderColor: color } : { background: color }} />
      </span>
    );
  if (kind === "ring") return <span aria-hidden className={cn("inline-block size-3 shrink-0 rounded-full border-2", className)} style={{ borderColor: color }} />;
  if (kind === "dot") return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full", className)} style={{ background: color }} />;
  return (
    <span
      aria-hidden
      className={cn("inline-block h-3 w-[18px] shrink-0 rounded-[3px] ring-1 ring-white/10 ring-inset", className)}
      style={{ background: kind === "hatch" ? HATCH_BG : color }}
    />
  );
}

function DrainGlyph({ kind, official = false }: { kind: DrainKind; official?: boolean }) {
  const common = { fill: "#08192a", stroke: "#9feffc", strokeWidth: 1.2, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  return (
    <svg aria-hidden viewBox={official ? "-2 -2 20 20" : "0 0 16 16"} className={cn("shrink-0", official ? "size-[18px]" : "size-4")}>
      {official && <circle cx="8" cy="8" r="9.6" fill="#9feffc" />}
      {kind === "pump" && (
        <>
          <circle cx="8" cy="8" r="6.6" {...common} />
          <path d="M8 8 L11.6 6.2 Q10.7 9.4 8 8 Z M8 8 L6.6 11.7 Q5.1 8.8 8 8 Z M8 8 L5.4 4.6 Q8.6 3.8 8 8 Z" fill="#9feffc" />
        </>
      )}
      {kind === "gate" && (
        <>
          <rect x="1.8" y="1.8" width="12.4" height="12.4" {...common} />
          <path d="M5 4v8M11 4v8" {...common} fill="none" />
          <rect x="5.8" y="7.4" width="4.4" height="3" fill="#9feffc" />
        </>
      )}
      {kind === "monitoring" && (
        <>
          <path d="M8 1.4 14.6 8 8 14.6 1.4 8Z" {...common} />
          <circle cx="8" cy="8" r="2" fill="#9feffc" />
        </>
      )}
      {kind === "retention" && (
        <>
          <rect x="1.6" y="1.6" width="12.8" height="12.8" rx="3.6" {...common} />
          <path d="M4 6.8c1.4-1.6 2.6 1.6 4 0s2.6 1.6 4 0M4 10.2c1.4-1.6 2.6 1.6 4 0s2.6 1.6 4 0" {...common} fill="none" />
        </>
      )}
      {kind === "other" && <circle cx="8" cy="8" r="4.2" {...common} />}
    </svg>
  );
}

function Section({ title, sub, badges, children, labelId }: { title: string; sub?: ReactNode; badges?: DataStatus[]; children?: ReactNode; labelId: string }) {
  return (
    <section aria-labelledby={labelId} className="border-t border-ui-border pt-2.5 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-2">
        <h3 id={labelId} className="text-[12px] leading-snug font-semibold text-ui-text">
          {title}
        </h3>
        {badges && badges.length > 0 && (
          <span className="flex shrink-0 flex-wrap justify-end gap-1">
            {badges.map((s) => (
              <StatusBadge key={s} status={s} size="xs" />
            ))}
          </span>
        )}
      </div>
      {sub && <div className="mt-0.5 text-[10.5px] leading-snug text-ui-text-3">{sub}</div>}
      {children && <div className="mt-2">{children}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ sections */

function ChoroplethSection({ ch, model }: { ch: ChoroplethModel; model: MapModel }) {
  const t = useTr();
  const lang = useLang();
  const id = useId();
  const kind = model.base?.areas.list[0]?.kind ?? "district";
  const fmt = (v: number | null) => {
    if (v === null) return "";
    const d = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? Math.min(1, ch.def.decimals) : ch.def.decimals;
    return formatNumber(v, lang, d);
  };
  const range = (c: LegendClass) => {
    if (ch.scheme === "rain") {
      if (c.to !== null && c.from === 0) return `< ${fmt(c.to)}`;
      if (c.to === null) return `> ${fmt(c.from)}`;
      return `${fmt(c.from)} – ${fmt(c.to)}`;
    }
    return `${fmt(c.from)} – ${fmt(c.to)}`;
  };
  const scheme = ch.scheme === "risk" ? S.riskScheme : ch.scheme === "rain" ? S.rainScheme : S.quantile;
  return (
    <Section
      labelId={id}
      title={t(ch.def.label)}
      badges={ch.statuses}
      sub={
        <>
          <span>{unitLabel(ch.def.unit, lang)}</span>
          <span aria-hidden> · </span>
          <span>{t(scheme)}</span>
          {ch.date && (
            <span className="block">
              {t(S.date)} {formatDate(ch.date, lang, "long")}
            </span>
          )}
        </>
      }
    >
      {ch.liveKind === "scenario" && (
        <p className="ui-sim-stripes mb-2 rounded-md border border-status-simulated/40 px-2 py-1 text-[10.5px] text-status-simulated">
          <span aria-hidden>◇ </span>
          {t(S.live)}
        </p>
      )}
      {ch.liveKind === "timeline" && (
        <p className="mb-2 rounded-md border border-ui-border-strong bg-ui-bg/40 px-2 py-1 text-[10.5px] text-ui-text-2">{t(S.timeline)}</p>
      )}
      <table className="w-full border-separate border-spacing-y-[3px] text-[11px]">
        <caption className="sr-only">{t(ch.def.label)}</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">{t({ th: "สี", en: "Colour" })}</th>
            <th scope="col">{t({ th: "ช่วงค่า", en: "Range" })}</th>
            <th scope="col">{t(S.count)}</th>
          </tr>
        </thead>
        <tbody>
          {ch.classes.map((c, i) => (
            <tr key={i}>
              <td className="w-6 pr-2 align-middle">
                <Swatch color={c.color} />
              </td>
              <td className="align-middle">
                <span className="ui-num text-ui-text">{range(c)}</span>
                {c.label && <span className="ml-1.5 text-ui-text-2">{t(c.label)}</span>}
              </td>
              <td className="ui-num w-8 text-right align-middle text-ui-text-3">{formatNumber(c.count, lang)}</td>
            </tr>
          ))}
          <tr>
            <td className="w-6 pr-2 align-middle">
              <Swatch kind="hatch" />
            </td>
            <td className="align-middle text-ui-text-2">{t(S.noData)}</td>
            <td className="ui-num w-8 text-right align-middle text-ui-text-3">{formatNumber(ch.nullCount, lang)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-1 text-right text-[9.5px] tracking-wide text-ui-text-3">
        {lang === "th" ? `จำนวน${AREA_KIND[kind].th}` : `${AREA_KIND[kind].en}s`}
      </p>
    </Section>
  );
}

function RainEstimatedSection({ model }: { model: MapModel }) {
  const t = useTr();
  const lang = useLang();
  const id = useId();
  const g = model.rainGrid;
  const gradient = `linear-gradient(90deg, ${HEAT_RAMP.slice(1)
    .map(([p, c]) => `${c} ${Math.round(p * 100)}%`)
    .join(", ")})`;
  if (!g) return <Section labelId={id} title={t(MAP_STRINGS.rainEstimatedLabel)} sub={t(S.noGrid)} />;
  const sub = g.mode === "missing-date" ? t(S.missingDate) : g.mode === "date" ? `${t(S.date)} ${formatDate(g.date, lang, "long")}` : t(S.meanAnnual);
  return (
    <Section labelId={id} title={t(MAP_STRINGS.rainEstimatedLabel)} badges={[g.status]} sub={sub}>
      {g.points > 0 && (
        <>
          <div aria-hidden className="h-2 rounded-full ring-1 ring-white/10 ring-inset" style={{ background: gradient }} />
          <div className="mt-1 flex justify-between text-[10.5px] text-ui-text-2">
            <span>
              {t(S.low)} <span className="ui-num text-ui-text">{formatNumber(g.min, lang, g.unit === "mm" ? 1 : 0)}</span>
            </span>
            <span>
              {t(S.high)} <span className="ui-num text-ui-text">{formatNumber(g.max, lang, g.unit === "mm" ? 1 : 0)}</span> {unitLabel(g.unit, lang)}
            </span>
          </div>
        </>
      )}
    </Section>
  );
}

function StationsSection({ model }: { model: MapModel }) {
  const t = useTr();
  const lang = useLang();
  const id = useId();
  const sum = model.base?.stationSummary;
  if (!model.bundle?.stations || !sum?.total) return <Section labelId={id} title={t(S.stations)} sub={t(S.noStations)} />;
  const labels: Bi[] = [
    { th: "เล็กน้อย", en: "Light" },
    { th: "ปานกลาง", en: "Moderate" },
    { th: "หนัก", en: "Heavy" },
    { th: "หนักมาก", en: "Very heavy" },
  ];
  return (
    <Section labelId={id} title={t(S.stations)} badges={sum.statuses} sub={sum.latest ? `${t(S.asOf)} ${formatDateTime(sum.latest, lang)}` : undefined}>
      <ul className="flex flex-wrap items-end gap-x-3 gap-y-1.5 text-[10.5px] text-ui-text-2">
        {STATION_STEPS.map(([v, c], i) => (
          <li key={v} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block rounded-full border border-[#d9f4ff]/80" style={{ background: c, width: 7 + i * 3, height: 7 + i * 3 }} />
            <span>
              {t(labels[i])} <span className="ui-num text-ui-text-3">≥{formatNumber(v, lang, v < 1 ? 1 : 0)}</span>
            </span>
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-[7px] rounded-full" style={{ background: STATION_NONE_COLOR }} />
          <span>{t({ th: "ไม่มีฝน", en: "Dry" })}</span>
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-[9px] rounded-full border border-ui-text-3" />
          <span>{t(S.noValue)}</span>
        </li>
      </ul>
    </Section>
  );
}

function WaterSection({ model }: { model: MapModel }) {
  const t = useTr();
  const lang = useLang();
  const id = useId();
  const reduced = useReducedMotionPref();
  const effects = useDashboard((s) => s.effectsEnabled);
  const ww = model.base?.waterways;
  const dr = model.base?.drainage;
  if (!ww && !dr) return <Section labelId={id} title={t(S.water)} sub={t(S.noWater)} />;
  const kinds = (["river", "canal", "stream", "drain"] as WaterKind[]).filter((k) => ww?.kinds.has(k));
  const drainKinds = DRAIN_KINDS.filter((k) => dr?.kinds.has(k));
  const hasDrainPoints = !!dr?.items.some((i) => i.geom === "point");
  return (
    <Section labelId={id} title={t(S.water)} sub={ww?.lineCount && effects && !reduced ? t(S.flowNote) : undefined}>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px] text-ui-text-2">
        {kinds.map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <Swatch kind="line" color={WATER_KIND_COLOR[k]} />
            {t(WATER_KIND_LABEL[k])}
          </li>
        ))}
        {!!ww?.areaCount && (
          <li className="flex items-center gap-1.5">
            <Swatch color={COLORS.water} className="ring-[#1d5378]" />
            {t(WATER_KIND_LABEL.area)}
          </li>
        )}
        {drainKinds.flatMap((k) => {
          const c = dr?.counts[k];
          if (k === "pump" && c && c.official > 0) {
            return [
              <li key="pump-official" className="col-span-2 flex items-center gap-1.5">
                <DrainGlyph kind="pump" official />
                {t(S.pumpOfficial)}
                <span className="ui-num ml-auto text-ui-text-3">{formatNumber(c.official, lang)}</span>
              </li>,
              ...(c.osm + c.other > 0
                ? [
                    <li key="pump-osm" className="col-span-2 flex items-center gap-1.5">
                      <DrainGlyph kind="pump" />
                      {t(S.pumpOsm)}
                      <span className="ui-num ml-auto text-ui-text-3">{formatNumber(c.osm + c.other, lang)}</span>
                    </li>,
                  ]
                : []),
            ];
          }
          return [
            <li key={k} className="flex items-center gap-1.5">
              <DrainGlyph kind={k} />
              {t(DRAIN_KIND_LABEL[k])}
            </li>,
          ];
        })}
      </ul>
      {hasDrainPoints && (
        <div className="mt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-ui-text-2">{t(S.stressRing)}</span>
            <StatusBadge status="simulated" size="xs" />
          </div>
          <div className="mt-1 flex gap-0.5" aria-hidden>
            {STRESS_CLASSES.map((c) => (
              <span key={c.from} className="h-1.5 flex-1 rounded-full" style={{ background: c.color }} />
            ))}
          </div>
          <div className="mt-0.5 flex justify-between text-[9.5px] text-ui-text-3">
            <span className="ui-num">0%</span>
            <span className="ui-num">100%</span>
          </div>
        </div>
      )}
    </Section>
  );
}

function HotspotSection({ model }: { model: MapModel }) {
  const t = useTr();
  const id = useId();
  const h = model.base?.hotspots;
  if (!h) return <Section labelId={id} title={t(S.hotspots)} sub={t(S.noHotspots)} />;
  return (
    <Section labelId={id} title={t(S.hotspots)} badges={h.statuses} sub={t(METRICS[h.metricId].label)}>
      <div className="flex items-center gap-2 text-[10.5px] text-ui-text-2">
        <span aria-hidden className="relative inline-grid size-5 shrink-0 place-items-center">
          <span className="absolute inset-0 rounded-full border border-[#f6a34b]/60" />
          <span className="size-2.5 rounded-full border border-[#f6a34b] bg-[#f6a34b]/30" />
        </span>
        <span>{t(S.ringSize)}</span>
      </div>
      <p className="mt-1.5 rounded-md border border-ui-border bg-ui-bg/40 px-2 py-1 text-[10.5px] text-ui-text-2">{t(MAP_STRINGS.hotspotsNote)}</p>
    </Section>
  );
}

function WaterLevelSection({ model }: { model: MapModel }) {
  const t = useTr();
  const lang = useLang();
  const id = useId();
  const g = model.base?.waterLevels;
  if (!g) return <Section labelId={id} title={t(S.gauges)} sub={t(S.noGauges)} />;
  return (
    <Section
      labelId={id}
      title={t(S.gauges)}
      badges={g.statuses}
      sub={
        <>
          <span className="block">{t(GAUGE_SCHEME)}</span>
          {g.latest && (
            <span className="block">
              {t(S.asOf)} {formatDateTime(g.latest, lang)}
            </span>
          )}
        </>
      }
    >
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px] text-ui-text-2">
        {GAUGE_CLASSES.filter((c) => c.id !== "unknown" || g.counts.unknown > 0).map((c) => (
          <li key={c.id} className="flex items-center gap-1.5">
            <GaugeGlyph cls={c.id} />
            <span className="min-w-0 truncate">
              {t(c.label)}
              {c.from !== null || c.to !== null ? (
                <span className="ui-num ml-1 text-ui-text-3">{c.to === null ? `>${c.from}%` : c.from === null ? `≤${c.to}%` : `${c.from}–${c.to}%`}</span>
              ) : null}
            </span>
            <span className="ui-num ml-auto text-ui-text-3">{formatNumber(g.counts[c.id], lang)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[10px] leading-snug text-ui-text-3">
        {t(S.gaugeLabel)} · {t(GAUGE_SNAPSHOT)}
      </p>
    </Section>
  );
}

function CommunitySection({ model }: { model: MapModel }) {
  const t = useTr();
  const lang = useLang();
  const id = useId();
  const c = model.base?.communities;
  if (!c) return null;
  return (
    <Section labelId={id} title={t(S.communities)} sub={t(S.communitiesSub)}>
      <ul className="space-y-1.5 text-[10.5px] text-ui-text-2">
        <li className="flex items-center gap-2">
          <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full bg-[#c7b8ff] ring-[1.5px] ring-[#06111e]" />
          <span className="min-w-0 flex-1">{t(COMMUNITY_TEXT.verified)}</span>
          <StatusBadge status="observed" size="xs" />
          <span className="ui-num w-6 text-right text-ui-text-3">{formatNumber(c.verified, lang)}</span>
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="inline-block size-3 shrink-0 rounded-full border-[1.5px] border-dashed border-[#b9a9f5] bg-[#06111e]/50" />
          <span className="min-w-0 flex-1 text-ui-text">{t(COMMUNITY_TEXT.illustrative)}</span>
          <StatusBadge status="simulated" size="xs" />
          <span className="ui-num w-6 text-right text-ui-text-3">{formatNumber(c.illustrative, lang)}</span>
        </li>
      </ul>
      {c.unplaced > 0 && <p className="mt-1.5 text-[10px] text-ui-text-3">{t(S.unplaced).replace("{n}", formatNumber(c.unplaced, lang))}</p>}
    </Section>
  );
}

function BoundarySection({ model }: { model: MapModel }) {
  const t = useTr();
  const id = useId();
  const hasMunicipality = !!model.bundle?.municipality?.features?.length;
  const approx = !!model.base?.hasApproximate;
  if (!hasMunicipality && !approx) return null;
  return (
    <Section labelId={id} title={t(S.boundaries)}>
      <ul className="space-y-1 text-[10.5px] text-ui-text-2">
        {hasMunicipality && (
          <li className="flex items-center gap-1.5">
            <Swatch kind="line" color={COLORS.municipality} />
            {t(MAP_STRINGS.municipalityBoundary)}
          </li>
        )}
        {approx && (
          <li className="flex items-start gap-1.5">
            <Swatch kind="dash" color="#a7c4d8" className="mt-0.5" />
            <span>{t(MAP_STRINGS.approxZonesNote)}</span>
          </li>
        )}
      </ul>
    </Section>
  );
}

/* ------------------------------------------------------------------ legend */

/** Collapsible bottom-left legend: active choropleth + every visible overlay + boundary notes. */
export function MapLegend({ model }: { model: MapModel }) {
  const t = useTr();
  const layers = useDashboard((s) => s.layers);
  const wide = useMediaQuery("(min-width: 640px)", true);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // open by default only when the stage has room for it; the legend never hides the map on short screens
  const tall = useMediaQuery("(min-height: 1000px)", true);
  const open = userOpen ?? (wide && tall);
  const ch = model.choropleth;
  const ready = !!model.base;

  return (
    <Collapsible open={open} onOpenChange={(o) => setUserOpen(o)} className="ui-panel-float w-[288px] max-w-[calc(100vw-5.5rem)] overflow-hidden">
      <CollapsibleTrigger
        aria-label={t(S.toggle)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-ui-elevated/50 focus-visible:ring-2 focus-visible:ring-ui-cyan focus-visible:ring-inset"
      >
        <Layers className="size-3.5 shrink-0 text-ui-cyan" aria-hidden />
        <span className="ui-eyebrow shrink-0">{t(S.legend)}</span>
        {!open && ch && <span className="min-w-0 truncate text-[11.5px] text-ui-text-2">{t(ch.def.short)}</span>}
        <ChevronDown aria-hidden className={cn("ml-auto size-3.5 shrink-0 text-ui-text-3 transition-transform duration-200", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-300 ease-[cubic-bezier(0.2,0,0,1)] data-[ending-style]:h-0 data-[starting-style]:h-0">
        {/* Capped by the map's own height (CityMap is a size container) so the legend never climbs under the
            stage's top chrome on short stages (laptop heights, split view). */}
        <div className="ui-scroll max-h-[min(calc(100cqh-8.5rem),460px)] space-y-2.5 overflow-y-auto px-3 pt-1 pb-3">
          {!ready ? (
            <div className="space-y-2 py-1" aria-hidden>
              <div className="h-3 w-2/3 animate-pulse rounded bg-ui-elevated-2" />
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="h-3 w-[18px] animate-pulse rounded-[3px] bg-ui-elevated-2" />
                  <div className="h-2.5 flex-1 animate-pulse rounded bg-ui-elevated" />
                </div>
              ))}
            </div>
          ) : (
            <>
              {ch ? <ChoroplethSection ch={ch} model={model} /> : <p className="text-[11px] text-ui-text-3">{t(S.noChoropleth)}</p>}
              {layers.rainEstimated.visible && <RainEstimatedSection model={model} />}
              {layers.rainObserved.visible && <StationsSection model={model} />}
              {layers.waterways.visible && <WaterSection model={model} />}
              {layers.waterLevel.visible && <WaterLevelSection model={model} />}
              {layers.hotspots.visible && <HotspotSection model={model} />}
              {layers.communities.visible && <CommunitySection model={model} />}
              <BoundarySection model={model} />
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
