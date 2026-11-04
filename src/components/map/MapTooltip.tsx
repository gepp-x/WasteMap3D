"use client";

import type { Ref } from "react";
import { MousePointerClick } from "lucide-react";
import { useLang, useTr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { MetricReadout, StatusBadge } from "@/components/dashboard/StatusBadge";
import { areaMetric } from "@/lib/metrics";
import { RISK_CLASSES } from "@/lib/simulation/model";
import { RISK_COLORS } from "@/lib/data/status";
import { AREA_KIND, DRAIN_KIND_LABEL, MAP_STRINGS, WATER_KIND_LABEL, formatDateTime } from "@/lib/map/labels";
import type { MetricValue } from "@/lib/types";
import { formatNumber } from "@/lib/formatters";
import { COMMUNITY_TEXT } from "@/lib/map/communities";
import { GAUGE_CLASS, GAUGE_SNAPSHOT, formatLevel, gaugeName, situationLabel } from "@/lib/map/water-levels";
import type { MapModel } from "./use-map-model";

export type HoverTarget =
  | { kind: "area"; areaId: string }
  | { kind: "station"; index: number; areaId: string | null }
  | { kind: "drainage"; index: number; areaId: string | null }
  | { kind: "water"; index: number; areaId: string | null }
  | { kind: "community"; index: number; areaId: string | null }
  | { kind: "gauge"; index: number; areaId: string | null };

const S = {
  clickHint: { th: "คลิกเพื่อดูรายละเอียดพื้นที่", en: "Click for area details" },
  selected: { th: "พื้นที่ที่เลือก", en: "Selected area" },
  noLayer: { th: "ยังไม่ได้เปิดชั้นข้อมูลแผนที่สี", en: "No choropleth layer active" },
  riskLabel: { th: "ความเสี่ยง (แบบจำลอง)", en: "Modeled risk" },
  station: { th: "สถานีวัดปริมาณฝน", en: "Rain gauge" },
  rain24h: { th: "ฝนสะสม 24 ชม.", en: "Rain, 24 h" },
  observedAt: { th: "เวลาตรวจวัด", en: "Observed" },
  inArea: { th: "อยู่ในพื้นที่", en: "Within" },
  areaStress: { th: "แรงกดดันระบายน้ำของพื้นที่", en: "Area drainage stress" },
  unnamed: { th: "ไม่ระบุชื่อ", en: "Unnamed" },
  liveScenario: { th: "ค่าตามสถานการณ์จำลอง", en: "Live scenario value" },
  gauge: { th: "สถานีวัดระดับน้ำ", en: "Water-level gauge" },
  level: { th: "ระดับน้ำ", en: "Water level" },
  bank: { th: "ระดับตลิ่ง", en: "Bank level" },
  capacity: { th: "ความจุลำน้ำ", en: "Channel capacity" },
  freeboard: { th: "ต่ำกว่าตลิ่ง", en: "Below bank" },
  overBank: { th: "สูงกว่าตลิ่ง", en: "Above bank" },
  situation: { th: "สถานการณ์ตามหน่วยงาน", en: "Agency situation" },
  official: { th: "ทะเบียนทางการ กทม. (สำนักการระบายน้ำ)", en: "Official BMA register (DDS)" },
  osm: { th: "ทำแผนที่โดย OpenStreetMap", en: "Mapped in OpenStreetMap" },
  clickZone: { th: "คลิกเพื่อเลือกเขตของชุมชนนี้", en: "Click to select this community's zone" },
} as const;

function GaugeLine({ label, value, status }: { label: string; value: string | null; status?: MetricValue["provenance"]["status"] }) {
  const t = useTr();
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-ui-text-2">{label}</span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("ui-num text-[12.5px]", value ? "font-semibold text-ui-text" : "text-ui-text-3")}>{value ?? t({ th: "ยังไม่มีข้อมูล", en: "Unavailable" })}</span>
        {value && status && <StatusBadge status={status} size="xs" showLabel={false} />}
      </span>
    </div>
  );
}

function Row({ label, metric, decimals, live }: { label: string; metric: MetricValue | undefined; decimals: number; live?: boolean }) {
  const status = metric && metric.value !== null ? metric.provenance.status : "unavailable";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-ui-text-2">{label}</span>
        <StatusBadge status={status} size="xs" />
      </div>
      <MetricReadout metric={metric} decimals={decimals} animate={false} valueClassName={cn("text-[17px] font-semibold text-ui-text", live && "text-status-simulated")} />
    </div>
  );
}

/**
 * Hover card. Always mounted (so the pointer handler can position it before React paints the
 * content); positioned imperatively via the forwarded ref, content re-renders only when the hovered
 * target changes. Purely informational → pointer-events none, aria-hidden (the same facts are in
 * the details panel and announced on selection).
 */
export function MapTooltip({ ref, target, model }: { ref: Ref<HTMLDivElement>; target: HoverTarget | null; model: MapModel }) {
  const t = useTr();
  const lang = useLang();
  const base = model.base;

  let body: React.ReactNode = null;
  if (target && base) {
    if (target.kind === "area") {
      const area = base.areas.byId.get(target.areaId);
      if (area) {
        const ch = model.choropleth;
        const sc = model.scenario.byId.get(area.id);
        const showRisk = !!sc && (ch?.metricId === "modeledFloodRisk" || model.scenario.source !== "baseline");
        const rc = sc?.current.riskClass ? RISK_CLASSES.find((c) => c.id === sc.current.riskClass) : undefined;
        const primary = lang === "th" ? area.nameTh : area.nameEn;
        const secondary = lang === "th" ? area.nameEn : area.nameTh;
        body = (
          <>
            <p className="ui-eyebrow">{t(AREA_KIND[area.kind])}</p>
            <p className="mt-0.5 text-[15px] leading-snug font-semibold text-ui-text">{primary}</p>
            <p className="text-[11.5px] text-ui-text-2">{secondary}</p>
            {area.geometryStatus === "approximate" && (
              <p className="mt-1 flex items-center gap-1 text-[10.5px] text-ui-text-3">
                <span aria-hidden className="inline-block h-0 w-4 border-t border-dashed border-ui-text-3" />
                {t(MAP_STRINGS.approxShort)}
              </p>
            )}
            <div className="mt-2.5 border-t border-ui-border pt-2">
              {ch ? (
                <Row label={t(ch.def.label)} metric={ch.values.get(area.id)} decimals={ch.def.decimals} live={ch.values.get(area.id)?.provenance.status === "simulated"} />
              ) : (
                <p className="text-[11px] text-ui-text-3">{t(S.noLayer)}</p>
              )}
            </div>
            {showRisk && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-ui-text-2">{t(S.riskLabel)}</span>
                {rc && sc?.current.score !== null && sc?.current.score !== undefined ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                    style={{
                      color: RISK_COLORS[rc.id],
                      borderColor: `color-mix(in srgb, ${RISK_COLORS[rc.id]} 45%, transparent)`,
                      background: `color-mix(in srgb, ${RISK_COLORS[rc.id]} 10%, transparent)`,
                    }}
                  >
                    <span aria-hidden>◆</span>
                    {t({ th: rc.th, en: rc.en })}
                    <span className="ui-num opacity-80">· {Math.round(sc.current.score)}</span>
                  </span>
                ) : (
                  <span className="text-[11px] text-ui-text-3">{t({ th: "ยังไม่มีข้อมูล", en: "Unavailable" })}</span>
                )}
              </div>
            )}
            <p className="mt-2.5 flex items-center gap-1.5 text-[10.5px] text-ui-text-3">
              <MousePointerClick className="size-3" aria-hidden />
              {t(S.clickHint)}
            </p>
          </>
        );
      }
    } else if (target.kind === "station") {
      const st = model.bundle?.stations?.[target.index];
      if (st) {
        body = (
          <>
            <p className="ui-eyebrow">{t(S.station)}</p>
            <p className="mt-0.5 text-[14px] leading-snug font-semibold text-ui-text">{(lang === "th" ? st.nameTh : st.nameEn) ?? st.nameEn}</p>
            <p className="text-[11px] text-ui-text-2">{st.agency}</p>
            <div className="mt-2.5 border-t border-ui-border pt-2">
              <Row label={t(S.rain24h)} metric={st.rain24h} decimals={1} />
              <p className="mt-1.5 text-[10.5px] text-ui-text-3">
                {t(S.observedAt)}: {formatDateTime(st.observedAt ?? st.rain24h?.provenance.observedTo, lang)}
              </p>
            </div>
          </>
        );
      }
    } else if (target.kind === "drainage") {
      const it = base.drainage?.items[target.index];
      if (it) {
        const area = it.areaId ? base.areas.byId.get(it.areaId) : undefined;
        const sc = area ? model.scenario.byId.get(area.id) : undefined;
        const name = (lang === "th" ? it.nameTh : it.nameEn) ?? it.nameTh ?? it.nameEn;
        body = (
          <>
            <p className="ui-eyebrow">{t(DRAIN_KIND_LABEL[it.kind])}</p>
            <p className="mt-0.5 text-[14px] leading-snug font-semibold text-ui-text">{name ?? t(S.unnamed)}</p>
            {it.operator && <p className="text-[11px] text-ui-text-2">{it.operator}</p>}
            {it.origin !== "other" && (
              <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-ui-text-2">
                <StatusBadge status="observed" size="xs" />
                {t(it.origin === "official" ? S.official : S.osm)}
              </p>
            )}
            {area && (
              <div className="mt-2.5 border-t border-ui-border pt-2">
                <p className="mb-1.5 text-[11px] text-ui-text-2">
                  {t(S.inArea)} <span className="text-ui-text">{lang === "th" ? area.nameTh : area.nameEn}</span>
                </p>
                {sc && <Row label={t(S.areaStress)} metric={areaMetric(area, "drainageStress", { result: sc.current })} decimals={0} live />}
              </div>
            )}
          </>
        );
      }
    } else if (target.kind === "water") {
      const it = base.waterways?.items[target.index];
      if (it) {
        const name = (lang === "th" ? it.nameTh : it.nameEn) ?? it.nameTh ?? it.nameEn;
        body = (
          <>
            <p className="ui-eyebrow">{t(WATER_KIND_LABEL[it.isArea ? "area" : it.kind])}</p>
            <p className="mt-0.5 text-[14px] leading-snug font-semibold text-ui-text">{name ?? t(S.unnamed)}</p>
          </>
        );
      }
    } else if (target.kind === "community") {
      const it = base.communities?.items[target.index];
      if (it) {
        const zone = it.zoneId ? base.areas.byId.get(it.zoneId) : undefined;
        const illustrative = it.locationStatus === "illustrative";
        body = (
          <>
            <p className="ui-eyebrow">{t(MAP_STRINGS.community)}</p>
            <p className="mt-0.5 text-[14px] leading-snug font-semibold text-ui-text">{(lang === "en" && it.nameEn) || it.nameTh}</p>
            {zone && <p className="text-[11px] text-ui-text-2">{lang === "th" ? zone.nameTh : zone.nameEn}</p>}
            <p
              className={cn(
                "mt-1.5 flex items-start gap-1.5 rounded-md border px-1.5 py-1 text-[10.5px] leading-snug",
                illustrative ? "border-dashed border-[#b9a9f5]/60 text-ui-text" : "border-ui-border text-ui-text-2",
              )}
            >
              <span aria-hidden className={cn("mt-[3px] inline-block size-2 shrink-0 rounded-full", illustrative ? "border border-dashed border-[#b9a9f5]" : "bg-[#c7b8ff]")} />
              {t(illustrative ? COMMUNITY_TEXT.illustrative : COMMUNITY_TEXT.verified)}
            </p>
            {(it.households !== null || it.population !== null) && (
              <div className="mt-2 grid grid-cols-2 gap-2 border-t border-ui-border pt-2">
                <div>
                  <p className="text-[10.5px] text-ui-text-2">{t(COMMUNITY_TEXT.households)}</p>
                  <p className="ui-num text-[13px] font-semibold text-ui-text">{it.households !== null ? formatNumber(it.households, lang) : "—"}</p>
                </div>
                <div>
                  <p className="text-[10.5px] text-ui-text-2">{t(COMMUNITY_TEXT.population)}</p>
                  <p className="ui-num text-[13px] font-semibold text-ui-text">{it.population !== null ? formatNumber(it.population, lang) : "—"}</p>
                </div>
                <p className="col-span-2 flex items-center gap-1.5 text-[10px] text-ui-text-3">
                  <StatusBadge status="observed" size="xs" /> {t(COMMUNITY_TEXT.published)}
                </p>
              </div>
            )}
            <p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-ui-text-3">
              <MousePointerClick className="size-3" aria-hidden />
              {t(S.clickZone)}
            </p>
          </>
        );
      }
    } else if (target.kind === "gauge") {
      const g = base.waterLevels?.items.find((x) => x.index === target.index);
      if (g) {
        const st = g.station;
        const cls = GAUGE_CLASS[g.cls];
        const cap = st.capacityPct && st.capacityPct.value !== null && st.capacityPct.provenance.status !== "unavailable" ? st.capacityPct : null;
        const status = st.waterLevel?.value !== null && st.waterLevel?.value !== undefined ? st.waterLevel.provenance.status : "unavailable";
        body = (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="ui-eyebrow">{t(S.gauge)}</p>
              <StatusBadge status={status} size="xs" />
            </div>
            <p className="mt-0.5 text-[14px] leading-snug font-semibold text-ui-text">{gaugeName(st, lang)}</p>
            <p className="text-[11px] text-ui-text-2">
              {[st.waterway, st.agency].filter(Boolean).join(" · ")}
            </p>
            <div className="mt-2.5 flex flex-col gap-1 border-t border-ui-border pt-2">
              <GaugeLine label={t(S.level)} value={formatLevel(st.waterLevel, lang)} status={st.waterLevel?.provenance.status} />
              <GaugeLine label={t(S.bank)} value={formatLevel(st.bankLevel, lang)} status={st.bankLevel?.provenance.status} />
              {g.freeboardM !== null && (
                <GaugeLine label={t(g.freeboardM >= 0 ? S.freeboard : S.overBank)} value={`${formatNumber(Math.abs(g.freeboardM), lang, 2)} ${lang === "th" ? "ม." : "m"}`} status="derived" />
              )}
              <GaugeLine label={t(S.capacity)} value={cap ? `${formatNumber(cap.value, lang, 0)}%` : null} status={cap?.provenance.status} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                style={{ color: cls.color, borderColor: `color-mix(in srgb, ${cls.color} 50%, transparent)`, background: `color-mix(in srgb, ${cls.color} 12%, transparent)` }}
              >
                <span aria-hidden>▽</span>
                {t(cls.label)}
              </span>
              {st.situation && g.classFrom !== "capacity" && <span className="text-[10.5px] text-ui-text-2">{t(S.situation)}: {t(situationLabel(st.situation))}</span>}
            </div>
            <p className="mt-2 text-[10.5px] text-ui-text-3">
              {t(S.observedAt)}: {formatDateTime(st.observedAt ?? st.waterLevel?.provenance.observedTo, lang)}
            </p>
            <p className="text-[10px] text-ui-text-3">{t(GAUGE_SNAPSHOT)}</p>
          </>
        );
      }
    }
  }

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-0 left-0 z-30 w-[248px] will-change-transform",
        "transition-opacity duration-150",
        body ? "opacity-100" : "opacity-0",
      )}
      style={{ transform: "translate3d(-9999px, -9999px, 0)" }}
    >
      {body && <div className="ui-panel-float px-3 py-2.5">{body}</div>}
    </div>
  );
}

