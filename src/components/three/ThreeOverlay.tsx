"use client";

import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import {
  Box,
  Building,
  ChevronDown,
  Crosshair,
  Droplets,
  Earth,
  Gauge,
  Grid3x3,
  LoaderCircle,
  RotateCcw,
  ScanEye,
  TriangleAlert,
  Info,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useDashboard, type CameraPreset, type QualityMode } from "@/store/dashboard-store";
import { useDataStore } from "@/lib/data/loader";
import { CITIES } from "@/lib/data/cities";
import { RISK_COLORS } from "@/lib/data/status";
import { RISK_CLASSES } from "@/lib/simulation/model";
import { COMMON, tr, useLang, useTr, type Bi } from "@/lib/i18n";
import { formatMetric, formatNumber, unitLabel } from "@/lib/formatters";
import type { AreaRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { AreaVisualSet } from "@/lib/three/area-visuals";
import { UNAVAILABLE_COLOR } from "@/lib/three/area-visuals";
import { cityFrame, gridLabel, neighborhoodFrame, DEFAULT_WINDOW_HALF_M } from "@/lib/three/frame";
import { heightShares } from "@/lib/three/building-geometry";
import { useThreeUi } from "@/lib/three/ui-store";

/* ------------------------------------------------------------------ */
/*  Strings (kept next to the component)                               */
/* ------------------------------------------------------------------ */
const S = {
  eyebrow: { th: "ดิจิทัลทวิน 3 มิติ", en: "3D digital twin" },
  scopeGroup: { th: "ระดับการแสดงผล 3 มิติ", en: "3D level of detail" },
  scopeCity: { th: "เมือง", en: "City" },
  scopeNbhd: { th: "ย่าน", en: "Neighborhood" },
  scopeNbhdHint: { th: "เลือกพื้นที่บนแผนที่ ในฉาก 3 มิติ หรือในตารางอันดับก่อน เพื่อดูอาคารระดับย่าน", en: "Select an area on the map, in 3D or in the ranking first to explore its buildings" },
  scopeNbhdGo: { th: "ดูอาคารจริงจาก OpenStreetMap ในหน้าต่าง 1 กม. รอบพื้นที่ที่เลือก", en: "Explore real OpenStreetMap buildings in a 1 km window around the selection" },
  camGroup: { th: "มุมกล้อง", en: "Camera views" },
  overview: { th: "ภาพรวม", en: "Overview" },
  isometric: { th: "มุมเฉียง (ไอโซเมตริก)", en: "Isometric" },
  topdown: { th: "มุมบนลงล่าง", en: "Top-down" },
  focus: { th: "โฟกัสพื้นที่ที่เลือก", en: "Focus selection" },
  focusNone: { th: "โฟกัสพื้นที่ที่เลือก (ยังไม่ได้เลือกพื้นที่)", en: "Focus selection (no area selected)" },
  reset: { th: "รีเซ็ตมุมมอง (กลับสู่ภาพรวมเมือง)", en: "Reset view (back to the city overview)" },
  quality: { th: "คุณภาพการแสดงผล", en: "Render quality" },
  qualityNext: { th: "คลิกเพื่อเปลี่ยนเป็น", en: "Click to switch to" },
  auto: { th: "อัตโนมัติ", en: "Auto" },
  tierHigh: { th: "สูง", en: "High" },
  tierBalanced: { th: "สมดุล", en: "Balanced" },
  tierLow: { th: "ประหยัด", en: "Low" },
  heightIs: { th: "ความสูงและสีแท่ง", en: "Prism height & colour" },
  heightNote: { th: "ความสูงแท่งแทนค่าข้อมูล ไม่ใช่ความสูงจริงของพื้นที่", en: "Prism height encodes the value, not physical height" },
  quantile: { th: "สีแบ่งตามควอนไทล์ (เหมือนแผนที่ 2 มิติ)", en: "Colours use quantile classes (same as the 2D map)" },
  riskOutline: { th: "เส้นขอบฐานสีส้ม/แดง = ความเสี่ยงแบบจำลองระดับสูง/สูงมาก", en: "Orange/red base outline = modeled High / Very High risk" },
  approxZones: { th: "ขอบเขตเขตชุมชนหาดใหญ่เป็นแนวเขตโดยประมาณเพื่อการสาธิต", en: "Hat Yai community-zone boundaries are approximate (illustrative)" },
  grid: { th: "เส้นกริด", en: "Grid" },
  legendToggle: { th: "แสดง/ซ่อนคำอธิบายสัญลักษณ์", en: "Show/hide legend" },
  bldTitle: { th: "อาคาร (OpenStreetMap)", en: "Buildings (OpenStreetMap)" },
  bldLow: { th: "เตี้ย", en: "Low-rise" },
  bldHigh: { th: "สูง", en: "High-rise" },
  bldEstimated: { th: "สีจางกว่า = ความสูงประมาณการ (ไม่มีแท็กใน OSM)", en: "Muted tone = estimated height (no OSM height tag)" },
  bldTint: { th: "อาคารแต้มสีอ่อนตามระดับความเสี่ยงแบบจำลองของพื้นที่", en: "Buildings are lightly tinted by the area’s modeled risk class" },
  nbhdOf: { th: "ย่านรอบ", en: "Around" },
  windowSize: { th: "หน้าต่างข้อมูล", en: "Data window" },
  floodNote: { th: "ระดับน้ำเป็นภาพเปรียบเทียบจากคะแนนความเสี่ยงแบบจำลอง ไม่มีการแสดงความลึกเป็นตัวเลข", en: "Water level is a visual metaphor of the modeled risk score — no depth values are shown." },
  loadingAreas: { th: "กำลังโหลดข้อมูลพื้นที่…", en: "Loading area data…" },
  loadingBuildings: { th: "กำลังโหลดอาคารจาก OpenStreetMap…", en: "Loading OpenStreetMap buildings…" },
  loadError: { th: "ไม่สามารถโหลดข้อมูลพื้นที่สำหรับฉาก 3 มิติ", en: "Couldn’t load area data for the 3D scene" },
  retry: { th: "ลองอีกครั้ง", en: "Try again" },
  clickToSelect: { th: "คลิกเพื่อเลือกพื้นที่", en: "Click to select" },
  approxShape: { th: "ขอบเขตโดยประมาณ", en: "Approximate boundary" },
  modeledRisk: { th: "ความเสี่ยง (แบบจำลอง)", en: "Modeled risk" },
  shownOf: { th: "แสดง", en: "Showing" },
  buildingsWord: { th: "อาคาร", en: "buildings" },
  ofWord: { th: "จาก", en: "of" },
  byQuality: { th: "(ตามระดับคุณภาพ)", en: "(quality tier cap)" },
  noBuildings: { th: "ไม่พบอาคารในหน้าต่างข้อมูลนี้", en: "No buildings in this data window" },
  boundaryOsm: { th: "ขอบเขตพื้นที่: © OpenStreetMap contributors", en: "Boundaries: © OpenStreetMap contributors" },
  boundaryOfficial: { th: "ขอบเขตพื้นที่: ข้อมูลภูมิสารสนเทศทางการ", en: "Boundaries: official GIS data" },
  municipality: { th: "เทศบาล", en: "Municipality" },
} satisfies Record<string, Bi>;

const TIER_LABEL = { high: S.tierHigh, balanced: S.tierBalanced, low: S.tierLow } as const;
const QUALITY_CYCLE: QualityMode[] = ["auto", "high", "balanced", "low"];
const BUILDING_RAMP = ["#2a3e57", "#3d5d84", "#86a6cf"];

export interface ThreeOverlayProps {
  visuals: AreaVisualSet | null;
  scenarioSource: "baseline" | "scenario" | "historical";
  bundleStatus: "idle" | "loading" | "ready" | "error";
  bundleError?: string;
  areasById: Map<string, AreaRecord>;
  tooltipRef: RefObject<HTMLDivElement | null>;
  showCanvasUi: boolean;
}

/**
 * HTML chrome over the canvas. Layout avoids the Stage's own chrome (view-mode switch top-left,
 * simulation banner top-centre): a slim camera toolbar top-right, the info card (scope toggle +
 * legend) bottom-left, illustrative labels and credits bottom-right.
 */
export function ThreeOverlay({ visuals, scenarioSource, bundleStatus, bundleError, areasById, tooltipRef, showCanvasUi }: ThreeOverlayProps) {
  const displayScope = useThreeUi((s) => s.displayScope);
  const floodVisible = useThreeUi((s) => s.floodVisible);
  const showRisk = scenarioSource !== "baseline";

  // Size container: the bottom group may only use the height left under the Stage's own top chrome
  // (view-mode switch, simulation banner); the camera toolbar floats top-right outside the flow, and
  // the info card's legend scrolls instead of being clipped by short stages (laptops, split view).
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-10 flex flex-col justify-end gap-2 p-2.5 pt-16 [container-type:size] sm:p-3.5 sm:pt-[4.5rem]",
        // the simulation banner (top centre) is taller than the view-mode switch
        showRisk && "max-sm:pt-32 sm:pt-24",
      )}
    >
      {showCanvasUi && (
        <>
          <div className={cn("absolute top-2.5 right-2.5 sm:top-3.5 sm:right-3.5", showRisk && "max-sm:top-28")}>
            <CameraToolbar />
          </div>

          {bundleStatus === "error" && <LoadErrorCard message={bundleError} />}

          <div className="flex min-h-0 flex-col-reverse items-stretch gap-2 @2xl:flex-row @2xl:justify-between">
            <div className="flex min-h-0 min-w-0 flex-col items-start justify-end gap-2">
              <StatusChips bundleStatus={bundleStatus} />
              <InfoCard
                areasById={areasById}
                legend={
                  displayScope === "neighborhood" ? (
                    <BuildingLegend showRisk={showRisk} />
                  ) : (
                    <HeightLegend visuals={visuals} showRisk={showRisk} areasById={areasById} loading={bundleStatus !== "ready"} />
                  )
                }
              />
            </div>
            <div className="flex min-w-0 shrink-0 flex-col items-start justify-end gap-2 @2xl:items-end">
              {floodVisible && <FloodLabel />}
              {displayScope === "neighborhood" ? <BuildingCredit /> : <BoundaryCredit areasById={areasById} />}
            </div>
          </div>
        </>
      )}
      <HoverTooltip tooltipRef={tooltipRef} visuals={visuals} areasById={areasById} showRisk={showRisk} enabled={showCanvasUi && displayScope === "city"} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Info card: scope toggle + context + legend                         */
/* ------------------------------------------------------------------ */
function InfoCard({ areasById, legend }: { areasById: Map<string, AreaRecord>; legend: ReactNode }) {
  const t = useTr();
  const lang = useLang();
  const scope = useDashboard((s) => s.threeScope);
  const setScope = useDashboard((s) => s.setThreeScope);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const cityId = useDashboard((s) => s.cityId);
  const stats = useThreeUi((s) => s.buildingStats);
  const displayScope = useThreeUi((s) => s.displayScope);
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.innerHeight >= 1000);
  const selected = selectedId ? areasById.get(selectedId) : undefined;
  const city = CITIES[cityId];
  const canNbhd = !!selected;

  const btn = (active: boolean) =>
    cn(
      "relative inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/70",
      active ? "bg-ui-cyan/15 text-ui-cyan shadow-[inset_0_0_0_1px_rgba(37,217,242,0.45)]" : "text-ui-text-2 hover:bg-ui-elevated-2 hover:text-ui-text",
    );

  const half = stats?.halfSizeM ?? DEFAULT_WINDOW_HALF_M;
  const km = formatNumber((half * 2) / 1000, lang, 1);

  return (
    <section aria-label={t(S.eyebrow)} className="ui-panel-float pointer-events-auto flex min-h-0 w-[min(304px,calc(100vw-1.25rem))] flex-col px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="ui-eyebrow flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-ui-cyan" aria-hidden />
          {t(S.eyebrow)}
        </p>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={t(S.legendToggle)}
          className="inline-flex size-6 items-center justify-center rounded text-ui-text-3 outline-none hover:text-ui-text focus-visible:ring-2 focus-visible:ring-ui-cyan/70"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", !open && "rotate-180")} aria-hidden />
        </button>
      </div>

      <div role="group" aria-label={t(S.scopeGroup)} className="mt-1.5 inline-flex gap-0.5 self-start rounded-lg border border-ui-border bg-ui-bg-deep/60 p-0.5">
        <button type="button" className={btn(scope === "city")} aria-pressed={scope === "city"} onClick={() => setScope("city")}>
          <Earth className="size-3.5" aria-hidden />
          {t(S.scopeCity)}
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(btn(scope === "neighborhood"), !canNbhd && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-ui-text-2")}
                aria-pressed={scope === "neighborhood"}
                aria-disabled={!canNbhd}
                onClick={() => {
                  if (canNbhd) setScope("neighborhood");
                }}
              />
            }
          >
            <Building className="size-3.5" aria-hidden />
            {t(S.scopeNbhd)}
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-64">
            {t(canNbhd ? S.scopeNbhdGo : S.scopeNbhdHint)}
          </TooltipContent>
        </Tooltip>
      </div>

      <p className="mt-1.5 truncate text-[11.5px] leading-4 text-ui-text-2">
        {displayScope === "neighborhood" && selected ? (
          <>
            {t(S.nbhdOf)} <span className="font-medium text-ui-text">{lang === "th" ? selected.nameTh : selected.nameEn}</span>
            <span className="text-ui-text-3">
              {" · "}
              {t(S.windowSize)} {km} × {km} {lang === "th" ? "กม." : "km"}
            </span>
          </>
        ) : (
          <>
            <span className="font-medium text-ui-text">{lang === "th" ? city.nameTh : city.nameEn}</span>
            {areasById.size > 0 && (
              <span className="text-ui-text-3">
                {" · "}
                {formatNumber(areasById.size, lang)} {lang === "th" ? city.areaKindTh : `${city.areaKindEn.toLowerCase()}s`}
              </span>
            )}
          </>
        )}
      </p>

      {open && <div className="ui-scroll mt-2.5 min-h-0 overflow-y-auto overscroll-contain border-t border-ui-border pt-2.5">{legend}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Status chips (loading, notices)                                    */
/* ------------------------------------------------------------------ */
function Chip({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div
      role="status"
      className={cn(
        "ui-panel-float pointer-events-auto flex max-w-[min(360px,calc(100vw-6rem))] shrink-0 items-center gap-2 px-2.5 py-1.5 text-[11.5px] leading-4",
        tone === "warn" ? "border-ui-orange/50 text-ui-text" : "text-ui-text-2",
      )}
    >
      {children}
    </div>
  );
}

function StatusChips({ bundleStatus }: { bundleStatus: ThreeOverlayProps["bundleStatus"] }) {
  const t = useTr();
  const scope = useDashboard((s) => s.threeScope);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const bStatus = useDataStore((s) => (selectedId ? s.buildings[selectedId]?.status : undefined));
  const notice = useThreeUi((s) => s.notice);
  const clearNotice = useThreeUi((s) => s.clearNotice);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => clearNotice(), 6500);
    return () => window.clearTimeout(id);
  }, [notice, clearNotice]);

  return (
    <>
      {bundleStatus === "loading" && (
        <Chip>
          <LoaderCircle className="size-3.5 animate-spin text-ui-cyan" aria-hidden />
          {t(S.loadingAreas)}
        </Chip>
      )}
      {scope === "neighborhood" && bStatus === "loading" && (
        <Chip>
          <LoaderCircle className="size-3.5 animate-spin text-ui-cyan" aria-hidden />
          {t(S.loadingBuildings)}
        </Chip>
      )}
      {notice && (
        <Chip tone="warn">
          <TriangleAlert className="size-3.5 shrink-0 text-ui-orange" aria-hidden />
          <span>{t(notice.text)}</span>
        </Chip>
      )}
    </>
  );
}

function LoadErrorCard({ message }: { message?: string }) {
  const t = useTr();
  const cityId = useDashboard((s) => s.cityId);
  const loadCity = useDataStore((s) => s.loadCity);
  return (
    <div className="pointer-events-none flex flex-1 items-center justify-center">
      <div role="alert" className="ui-panel pointer-events-auto max-w-sm p-4">
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-ui-orange" aria-hidden />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ui-text">{t(S.loadError)}</p>
            {message && <p className="mt-1 break-words font-mono text-[11px] text-ui-text-3">{message}</p>}
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => void loadCity(cityId)}>
            <RotateCcw aria-hidden />
            {t(S.retry)}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Camera + quality toolbar                                           */
/* ------------------------------------------------------------------ */
function ToolButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (!disabled) onClick();
            }}
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-md text-ui-text-2 transition-colors outline-none hover:bg-ui-elevated-2 hover:text-ui-cyan focus-visible:ring-2 focus-visible:ring-ui-cyan/70 [&_svg]:size-4",
              disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-ui-text-2",
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

function CameraToolbar() {
  const t = useTr();
  const setPreset = useDashboard((s) => s.setCameraPreset);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const quality = useDashboard((s) => s.quality);
  const tier = useDashboard((s) => s.qualityTier);
  const setQuality = useDashboard((s) => s.setQuality);

  const go = (p: CameraPreset) => () => setPreset(p);
  const reset = () => {
    const ui = useThreeUi.getState();
    const dash = useDashboard.getState();
    if (dash.threeScope === "neighborhood" || ui.displayScope === "neighborhood") {
      ui.setLanding("overview");
      dash.setThreeScope("city");
    } else dash.setCameraPreset("overview");
  };

  const nextQuality = QUALITY_CYCLE[(QUALITY_CYCLE.indexOf(quality) + 1) % QUALITY_CYCLE.length];
  const qualityText = `${t(TIER_LABEL[tier])}${quality === "auto" ? ` · ${t(S.auto)}` : ""}`;
  const nextText = nextQuality === "auto" ? t(S.auto) : t(TIER_LABEL[nextQuality]);

  return (
    <div className="pointer-events-auto flex flex-col items-end gap-2">
      <div role="toolbar" aria-label={t(S.camGroup)} aria-orientation="vertical" className="ui-panel-float flex flex-col gap-0.5 p-1">
        <ToolButton label={t(S.overview)} onClick={go("overview")}>
          <ScanEye aria-hidden />
        </ToolButton>
        <ToolButton label={t(S.isometric)} onClick={go("isometric")}>
          <Box aria-hidden />
        </ToolButton>
        <ToolButton label={t(S.topdown)} onClick={go("topdown")}>
          <Grid3x3 aria-hidden />
        </ToolButton>
        <ToolButton label={t(selectedId ? S.focus : S.focusNone)} onClick={go("focus")} disabled={!selectedId}>
          <Crosshair aria-hidden />
        </ToolButton>
        <div className="mx-1.5 my-0.5 h-px bg-ui-border" aria-hidden />
        <ToolButton label={t(S.reset)} onClick={reset}>
          <RotateCcw aria-hidden />
        </ToolButton>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => setQuality(nextQuality)}
              aria-label={`${t(S.quality)}: ${qualityText}. ${t(S.qualityNext)} ${nextText}`}
              className="ui-panel-float inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] text-ui-text-2 outline-none transition-colors hover:text-ui-text focus-visible:ring-2 focus-visible:ring-ui-cyan/70"
            />
          }
        >
          <Gauge className="size-3.5 text-ui-cyan" aria-hidden />
          <span className="hidden sm:inline">{t(S.quality)}:</span>
          <span className="font-medium text-ui-text">{qualityText}</span>
        </TooltipTrigger>
        <TooltipContent side="left">
          {t(S.qualityNext)} {nextText}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Legends                                                            */
/* ------------------------------------------------------------------ */
function LegendShell({ title, badge, children, footnotes }: { title: ReactNode; badge?: ReactNode; children: ReactNode; footnotes?: ReactNode }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">{title}</div>
        {badge && <div className="shrink-0 pt-0.5">{badge}</div>}
      </div>
      <div className="mt-2">{children}</div>
      {footnotes && <div className="mt-2 hidden space-y-1 border-t border-ui-border/70 pt-2 text-[10.5px] leading-[1.45] text-ui-text-3 @md:block">{footnotes}</div>}
    </div>
  );
}

function Footnote({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5">
      <span className="mt-[3px] shrink-0 text-ui-text-3 [&_svg]:size-3" aria-hidden>
        {icon ?? <Info />}
      </span>
      <span>{children}</span>
    </p>
  );
}

function HeightLegend({ visuals, showRisk, areasById, loading }: { visuals: AreaVisualSet | null; showRisk: boolean; areasById: Map<string, AreaRecord>; loading: boolean }) {
  const t = useTr();
  const lang = useLang();
  const cityId = useDashboard((s) => s.cityId);
  const minorM = useMemo(() => cityFrame(CITIES[cityId]).grid.minorM, [cityId]);
  const approximate = useMemo(() => [...areasById.values()].some((a) => a.geometryStatus === "approximate"), [areasById]);

  if (!visuals) {
    return (
      <LegendShell title={<p className="ui-eyebrow">{t(S.heightIs)}</p>}>
        <div className="space-y-2" aria-busy={loading}>
          <div className="h-3.5 w-40 animate-pulse rounded bg-ui-elevated-2" />
          <div className="h-2 w-full animate-pulse rounded-full bg-ui-elevated-2" />
          <div className="h-2.5 w-24 animate-pulse rounded bg-ui-elevated-2" />
        </div>
      </LegendShell>
    );
  }

  const def = visuals.def;
  return (
    <LegendShell
      title={
        <div>
          <p className="ui-eyebrow">{t(S.heightIs)}</p>
          <p className="mt-0.5 truncate text-[12.5px] font-medium leading-5 text-ui-text">
            {t(def.label)} <span className="text-[11px] font-normal text-ui-text-3">({unitLabel(def.unit, lang)})</span>
          </p>
        </div>
      }
      badge={<StatusBadge status={visuals.status} size="xs" />}
      footnotes={
        <>
          <Footnote>{t(S.heightNote)}</Footnote>
          {!visuals.isRisk && <Footnote>{t(S.quantile)}</Footnote>}
          {showRisk && !visuals.isRisk && <Footnote icon={<TriangleAlert />}>{t(S.riskOutline)}</Footnote>}
          {approximate && <Footnote icon={<TriangleAlert />}>{t(S.approxZones)}</Footnote>}
          <Footnote icon={<Grid3x3 />}>
            {t(S.grid)} {gridLabel(minorM, lang)}
          </Footnote>
        </>
      }
    >
      {visuals.isRisk ? (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
          {RISK_CLASSES.map((c) => (
            <li key={c.id} className="flex items-center gap-1.5 text-[11px] text-ui-text-2">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: RISK_COLORS[c.id] }} aria-hidden />
              <span className="text-ui-text">{lang === "th" ? c.th : c.en}</span>
              <span className="ui-num text-ui-text-3">
                {c.min}–{c.max}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div>
          <div className="flex h-2 overflow-hidden rounded-full" aria-hidden>
            {visuals.legend.map((s, i) => (
              <span key={i} className="flex-1" style={{ background: s.color }} />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10.5px] text-ui-text-3">
            <span className="ui-num">{formatNumber(visuals.min, lang, def.decimals)}</span>
            <span className="ui-num">{formatNumber(visuals.max, lang, def.decimals)}</span>
          </div>
        </div>
      )}
      {visuals.hasNull && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-ui-text-3">
          <span className="size-2.5 rounded-[3px] border border-ui-border-strong" style={{ background: UNAVAILABLE_COLOR }} aria-hidden />○ {t(COMMON.unavailable)}
        </p>
      )}
    </LegendShell>
  );
}

function BuildingLegend({ showRisk }: { showRisk: boolean }) {
  const t = useTr();
  const lang = useLang();
  const stats = useThreeUi((s) => s.buildingStats);
  const minorM = useMemo(() => neighborhoodFrame("legend", [0, 0], stats?.halfSizeM ?? DEFAULT_WINDOW_HALF_M).grid.minorM, [stats?.halfSizeM]);
  return (
    <LegendShell
      title={<p className="ui-eyebrow">{t(S.bldTitle)}</p>}
      footnotes={
        <>
          <Footnote>{t(S.bldEstimated)}</Footnote>
          {showRisk && <Footnote icon={<TriangleAlert />}>{t(S.bldTint)}</Footnote>}
          <Footnote icon={<Grid3x3 />}>
            {t(S.grid)} {gridLabel(minorM, lang)}
          </Footnote>
        </>
      }
    >
      <div className="flex h-2 overflow-hidden rounded-full" aria-hidden>
        {BUILDING_RAMP.map((c) => (
          <span key={c} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-ui-text-3">
        <span>{t(S.bldLow)}</span>
        <span>{t(S.bldHigh)}</span>
      </div>
    </LegendShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Labels + credits                                                   */
/* ------------------------------------------------------------------ */
function FloodLabel() {
  const t = useTr();
  return (
    <div role="status" aria-live="polite" className="ui-panel-float ui-sim-stripes pointer-events-auto max-w-[min(360px,calc(100vw-1.5rem))] border-status-simulated/60 px-3 py-2">
      <div className="flex items-start gap-2">
        <Droplets className="mt-0.5 size-4 shrink-0 text-status-simulated" aria-hidden />
        <div className="min-w-0">
          <p className="text-[12px] font-semibold leading-snug text-ui-text">{t(COMMON.illustrativeFlood)}</p>
          <p className="mt-0.5 hidden text-[10.5px] leading-snug text-ui-text-2 @md:block">{t(S.floodNote)}</p>
        </div>
      </div>
    </div>
  );
}

function BuildingCredit() {
  const t = useTr();
  const lang = useLang();
  const stats = useThreeUi((s) => s.buildingStats);
  if (!stats) return null;
  const { taggedPct, estimatedPct } = heightShares(stats);
  const x = taggedPct === null ? "—" : formatNumber(taggedPct, lang);
  const y = estimatedPct === null ? "—" : formatNumber(estimatedPct, lang);
  const capped = stats.shown < stats.total;
  return (
    <p className="ui-panel-float pointer-events-auto max-w-[min(440px,calc(100vw-1.5rem))] px-2.5 py-1.5 text-[10.5px] leading-snug text-ui-text-2">
      {stats.total === 0 ? (
        t(S.noBuildings)
      ) : (
        <>
          {t({
            th: `รูปทรงอาคาร: © OpenStreetMap contributors · ความสูง: จากแท็ก OSM ${x}% / ประมาณการ ${y}%`,
            en: `Footprints: © OpenStreetMap contributors · Heights: OSM-tagged ${x}% / estimated ${y}%`,
          })}
          {capped && (
            <span className="block text-ui-text-3">
              {t(S.shownOf)} {formatNumber(stats.shown, lang)} {t(S.ofWord)} {formatNumber(stats.total, lang)} {t(S.buildingsWord)} {t(S.byQuality)}
            </span>
          )}
        </>
      )}
    </p>
  );
}

function BoundaryCredit({ areasById }: { areasById: Map<string, AreaRecord> }) {
  const t = useTr();
  const kinds = useMemo(() => new Set([...areasById.values()].map((a) => a.geometryStatus)), [areasById]);
  if (!kinds.size) return null;
  const parts: string[] = [];
  if (kinds.has("osm")) parts.push(t(S.boundaryOsm));
  if (kinds.has("official")) parts.push(t(S.boundaryOfficial));
  if (kinds.has("approximate")) parts.push(t(S.approxZones));
  return <p className="ui-panel-float pointer-events-auto max-w-[min(440px,100%)] px-2.5 py-1.5 text-[10px] leading-snug text-ui-text-3">{parts.join(" · ")}</p>;
}

/* ------------------------------------------------------------------ */
/*  Hover tooltip (positioned by the stage's pointermove — no React state per move) */
/* ------------------------------------------------------------------ */
function HoverTooltip({
  tooltipRef,
  visuals,
  areasById,
  showRisk,
  enabled,
}: {
  tooltipRef: RefObject<HTMLDivElement | null>;
  visuals: AreaVisualSet | null;
  areasById: Map<string, AreaRecord>;
  showRisk: boolean;
  enabled: boolean;
}) {
  const t = useTr();
  const lang = useLang();
  const hovered = useDashboard((s) => s.hoveredAreaId);
  const rec = enabled && hovered ? areasById.get(hovered) : undefined;
  const vis = rec ? visuals?.byId.get(rec.id) : undefined;
  const risk = vis?.riskClass ? RISK_CLASSES.find((c) => c.id === vis.riskClass) : undefined;
  const kind = rec ? (rec.kind === "district" ? COMMON.district : rec.kind === "community-zone" ? COMMON.communityZone : S.municipality) : null;

  return (
    <div
      ref={tooltipRef}
      data-inside="false"
      aria-hidden
      className={cn("pointer-events-none absolute left-0 top-0 z-30 opacity-0 transition-opacity duration-150 will-change-transform", rec && "data-[inside=true]:opacity-100")}
    >
      {rec && (
        <div className="ui-panel-float min-w-48 max-w-64 px-3 py-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[13px] font-semibold text-ui-text">{lang === "th" ? rec.nameTh : rec.nameEn}</span>
            {kind && <span className="shrink-0 text-[10px] uppercase tracking-wider text-ui-text-3">{tr(lang, kind)}</span>}
          </div>
          {visuals && (
            <div className="mt-1.5 flex items-baseline justify-between gap-3">
              <span className="text-[11px] text-ui-text-2">{t(visuals.def.short)}</span>
              <span className="ui-num text-[13px] font-medium text-ui-text">{formatMetric(vis?.metric, lang, visuals.def.decimals)}</span>
            </div>
          )}
          <div className="mt-1 flex items-center justify-between gap-2">
            <StatusBadge status={vis?.metric.provenance.status ?? "unavailable"} size="xs" />
            {showRisk && risk && !visuals?.isRisk && (
              <span className="text-[10.5px] text-ui-text-2">
                {t(S.modeledRisk)}: <span style={{ color: RISK_COLORS[risk.id] }}>{lang === "th" ? risk.th : risk.en}</span>
              </span>
            )}
          </div>
          {rec.geometryStatus === "approximate" && <p className="mt-1 text-[10px] text-ui-yellow">◐ {t(S.approxShape)}</p>}
          <p className="mt-1.5 text-[10px] text-ui-text-3">{t(S.clickToSelect)}</p>
        </div>
      )}
    </div>
  );
}
