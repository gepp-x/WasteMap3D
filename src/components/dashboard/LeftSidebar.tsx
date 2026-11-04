"use client";

import { ArrowLeft, FlaskConical, Layers, PanelLeftClose, PanelLeftOpen, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTr } from "@/lib/i18n";
import { useCityBundle } from "@/lib/data/loader";
import { CITIES } from "@/lib/data/cities";
import { primaryWasteMetric } from "@/lib/metrics";
import { SCENARIO_PRESETS, type PresetId } from "@/lib/simulation/model";
import { useDashboard } from "@/store/dashboard-store";
import { useReducedMotionPref } from "@/lib/animation/tokens";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MetricReadout } from "@/components/dashboard/StatusBadge";
import { Eyebrow, ToolButton } from "@/components/dashboard/Header";
import { SearchBox, requestSearchFocus } from "@/components/dashboard/SearchBox";
import { ViewModeSwitch } from "@/components/dashboard/ViewModeSwitch";
import { LayerControl } from "@/components/dashboard/LayerControl";
import { ScenarioLab } from "@/components/dashboard/ScenarioLab";
import { CrossFade } from "@/components/motion/AnimatedPanel";
import { shortcutKey } from "@/hooks/use-keyboard-shortcuts";

export const SIDEBAR_WIDTH = 296;
export const RAIL_WIDTH = 56;

const PRESET_ORDER: PresetId[] = ["normal", "heavyRain", "extremeRain", "drainageObstruction", "combinedStress"];

/** Scroll a sidebar section into view once the expanded sidebar has rendered. */
function revealSection(id: string, reduced: boolean) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" })),
  );
}

/* ------------------------------------------------------------------ */
/*  Sections                                                           */
/* ------------------------------------------------------------------ */

function SectionHeading({ id, children, action }: { id: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <Eyebrow as="h2" id={id}>
        {children}
      </Eyebrow>
      {action}
    </div>
  );
}

function CityFacts() {
  const t = useTr();
  const cityId = useDashboard((s) => s.cityId);
  const { bundle, status } = useCityBundle();
  const ds = bundle?.dataset;
  const city = CITIES[cityId];
  const primary = primaryWasteMetric(ds);
  const approx = ds?.areas.some((a) => a.geometryStatus === "approximate") ?? false;
  const kind = t({ th: city.areaKindTh, en: city.areaKindEn });

  return (
    <section aria-labelledby="sb-facts" className="px-4 pt-4">
      <SectionHeading id="sb-facts">{t({ th: "ข้อมูลเมืองโดยย่อ", en: "City at a glance" })}</SectionHeading>
      <p className="text-[15px] leading-tight font-semibold text-ui-text">{t({ th: city.nameTh, en: city.nameEn })}</p>
      {status === "error" ? (
        <p role="alert" className="mt-2 text-[12px] text-ui-orange">
          {t({ th: "โหลดข้อมูลของเมืองไม่สำเร็จ", en: "City data failed to load" })}
        </p>
      ) : !ds ? (
        <div className="mt-3 grid grid-cols-2 gap-2" aria-busy>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-11 bg-ui-elevated" />
          ))}
        </div>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3">
          <div className="min-w-0">
            <dt className="text-[11px] text-ui-text-3">{t({ th: "ประชากร", en: "Population" })}</dt>
            <dd className="mt-0.5 text-[15px] font-semibold text-ui-text">
              <MetricReadout metric={ds.totals.population} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-ui-text-3">{t({ th: `จำนวน${city.areaKindTh}`, en: `${city.areaKindEn}s` })}</dt>
            <dd className="mt-0.5 flex items-baseline gap-1 text-[15px] font-semibold text-ui-text">
              <span className="ui-num">{ds.areas.length}</span>
              <span className="text-[11px] font-normal text-ui-text-2">{kind}</span>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-ui-text-3">{primary === "wasteCollected" ? t({ th: "ขยะที่จัดเก็บได้", en: "Waste collected" }) : t({ th: "ขยะที่เกิดขึ้น", en: "Waste generated" })}</dt>
            <dd className="mt-0.5 text-[15px] font-semibold text-ui-text">
              <MetricReadout metric={ds.totals[primary]} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-ui-text-3">{t({ th: "พื้นที่รวม", en: "Total area" })}</dt>
            <dd className="mt-0.5 text-[15px] font-semibold text-ui-text">
              <MetricReadout metric={ds.totals.areaKm2} decimals={1} />
            </dd>
          </div>
        </dl>
      )}
      {approx && (
        <p className="mt-3 rounded-md border border-status-estimated/30 bg-status-estimated/5 px-2.5 py-1.5 text-[11px] leading-relaxed text-ui-text-2">
          <span aria-hidden className="mr-1 text-status-estimated">◐</span>
          {t({
            th: "เขตชุมชนเป็นเขตการบริหารจัดการ ไม่ใช่เขตการปกครอง ขอบเขตบนแผนที่เป็นค่าประมาณ",
            en: "Community zones are management zones, not administrative districts; map boundaries are approximate.",
          })}
        </p>
      )}
    </section>
  );
}

function ScenarioEntry({ onOpenLab }: { onOpenLab: () => void }) {
  const t = useTr();
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  const presetId = useDashboard((s) => s.presetId);
  const applyPreset = useDashboard((s) => s.applyPreset);
  const resetScenario = useDashboard((s) => s.resetScenario);
  return (
    <section aria-labelledby="sb-scenario" className={cn("relative mx-4 mb-4 overflow-hidden rounded-xl border p-3.5", scenarioActive ? "border-status-simulated/40 bg-status-simulated/5" : "border-ui-border bg-ui-bg-deep/40")}>
      {scenarioActive && <span aria-hidden className="ui-sim-stripes absolute inset-x-0 top-0 h-[3px]" />}
      <SectionHeading id="sb-scenario">{t({ th: "สถานการณ์จำลอง", en: "Scenarios" })}</SectionHeading>
      <p className="text-[12px] leading-relaxed text-ui-text-2">
        {scenarioActive
          ? t({
              th: `กำลังจำลอง: ${presetId === "custom" ? "กำหนดเอง" : SCENARIO_PRESETS[presetId].th} — ข้อมูลจริงไม่ถูกแก้ไข`,
              en: `Simulating: ${presetId === "custom" ? "Custom" : SCENARIO_PRESETS[presetId].en} — observed data is untouched`,
            })
          : t({ th: "ทดลองฝน การระบายน้ำ และการเก็บขยะ แล้วดูผลต่อความเสี่ยงน้ำท่วม", en: "Test rain, drainage and waste collection, and see the effect on flood risk." })}
      </p>
      <div role="group" aria-label={t({ th: "สถานการณ์สำเร็จรูป", en: "Preset scenarios" })} className="mt-2.5 flex flex-wrap gap-1.5">
        {PRESET_ORDER.map((id) => {
          const p = SCENARIO_PRESETS[id];
          const active = scenarioActive && presetId === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              title={t({ th: p.descTh, en: p.descEn })}
              onClick={() => applyPreset(id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60",
                active
                  ? "border-status-simulated/60 bg-status-simulated/15 text-status-simulated"
                  : "border-ui-border text-ui-text-2 hover:border-ui-border-strong hover:text-ui-text",
              )}
            >
              {t({ th: p.th, en: p.en })}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={onOpenLab} className="flex-1">
          <FlaskConical aria-hidden />
          {t({ th: "เปิดห้องทดลองสถานการณ์", en: "Open Scenario Lab" })}
        </Button>
        {scenarioActive && (
          <Button size="sm" variant="ghost" onClick={resetScenario} className="text-ui-text-2">
            <X aria-hidden />
            {t({ th: "ออกจากการจำลอง", en: "Exit simulation" })}
          </Button>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Bodies                                                             */
/* ------------------------------------------------------------------ */

function MainBody({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTr();
  const setPanel = useDashboard((s) => s.setPanel);
  return (
    <div className="ui-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <CityFacts />
      <section aria-labelledby="sb-search" className="px-4 pt-5">
        <SectionHeading id="sb-search">{t({ th: "ค้นหาพื้นที่", en: "Find an area" })}</SectionHeading>
        <SearchBox onSelect={onNavigate} />
      </section>
      <section aria-labelledby="sb-mode" className="px-4 pt-5">
        <SectionHeading id="sb-mode">{t({ th: "รูปแบบการแสดงผล", en: "Display mode" })}</SectionHeading>
        <ViewModeSwitch variant="sidebar" />
      </section>
      <section id="sidebar-layers" aria-labelledby="sb-layers" className="scroll-mt-2 px-2.5 pt-5 pb-4">
        <div className="px-1.5">
          <SectionHeading id="sb-layers">{t({ th: "ชั้นข้อมูล", en: "Map layers" })}</SectionHeading>
        </div>
        <LayerControl />
      </section>
      <ScenarioEntry onOpenLab={() => setPanel("labOpen", true)} />
    </div>
  );
}

function LabBody() {
  const t = useTr();
  const setPanel = useDashboard((s) => s.setPanel);
  const close = () => setPanel("labOpen", false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-ui-border px-2 py-1.5">
        <Button variant="ghost" size="sm" onClick={close} className="text-ui-text-2 hover:text-ui-text">
          <ArrowLeft aria-hidden />
          {t({ th: "กลับสู่แผงควบคุม", en: "Back to controls" })}
        </Button>
      </div>
      <div className="ui-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ScenarioLab onClose={close} />
      </div>
    </div>
  );
}

function Rail() {
  const t = useTr();
  const reduced = useReducedMotionPref();
  const setPanel = useDashboard((s) => s.setPanel);
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  const expand = () => setPanel("leftOpen", true);
  return (
    <nav aria-label={t({ th: "แถบเครื่องมือ", en: "Tool rail" })} className="flex h-full w-14 flex-col items-center gap-1 py-2">
      <ToolButton icon={PanelLeftOpen} side="right" label={t({ th: "ขยายแผงควบคุม", en: "Expand controls" })} shortcut={shortcutKey("layers")} onClick={expand} />
      <span aria-hidden className="my-1 h-px w-6 bg-ui-border" />
      <ToolButton
        icon={Search}
        side="right"
        label={t({ th: "ค้นหาพื้นที่", en: "Search areas" })}
        shortcut={shortcutKey("search")}
        onClick={() => {
          expand();
          requestSearchFocus();
        }}
      />
      <ViewModeSwitch variant="rail" className="my-1" />
      <ToolButton
        icon={Layers}
        side="right"
        label={t({ th: "ชั้นข้อมูล", en: "Map layers" })}
        onClick={() => {
          expand();
          revealSection("sidebar-layers", reduced);
        }}
      />
      <ToolButton
        icon={FlaskConical}
        side="right"
        label={t({ th: "ห้องทดลองสถานการณ์", en: "Scenario Lab" })}
        shortcut={shortcutKey("lab")}
        badge={scenarioActive ? "simulated" : undefined}
        onClick={() => {
          setPanel("labOpen", true);
          expand();
        }}
      />
    </nav>
  );
}

/**
 * Left column. "docked" (desktop) collapses to a 56 px icon rail; "drawer" (tablet) lives in a Sheet.
 * When the Scenario Lab is open the body cross-fades to it, with a back button.
 */
export function LeftSidebar({ variant = "docked", onNavigate, onClose }: { variant?: "docked" | "drawer"; onNavigate?: () => void; onClose?: () => void }) {
  const t = useTr();
  const leftOpen = useDashboard((s) => s.leftOpen);
  const labOpen = useDashboard((s) => s.labOpen);
  const setPanel = useDashboard((s) => s.setPanel);
  const expanded = variant === "drawer" || leftOpen;

  return (
    <CrossFade id={expanded ? "full" : "rail"} className="h-full">
      {expanded ? (
        <div className="flex h-full min-h-0 flex-col" style={{ width: variant === "docked" ? `var(--col-w, ${SIDEBAR_WIDTH}px)` : undefined }}>
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-ui-border pr-1.5 pl-4">
            <Eyebrow as="p">{labOpen ? t({ th: "ห้องทดลองสถานการณ์", en: "Scenario Lab" }) : t({ th: "แผงควบคุม", en: "Controls" })}</Eyebrow>
            {variant === "docked" ? (
              <ToolButton
                icon={PanelLeftClose}
                size="icon-sm"
                side="right"
                label={t({ th: "ย่อเป็นแถบไอคอน", en: "Collapse to icon rail" })}
                shortcut={shortcutKey("layers")}
                onClick={() => setPanel("leftOpen", false)}
              />
            ) : (
              onClose && <ToolButton icon={X} size="icon-sm" label={t({ th: "ปิดแผงควบคุม", en: "Close controls" })} onClick={onClose} />
            )}
          </div>
          <CrossFade id={labOpen ? "lab" : "main"} direction={labOpen ? 1 : -1} className="min-h-0 flex-1">
            {labOpen ? <LabBody /> : <MainBody onNavigate={onNavigate} />}
          </CrossFade>
        </div>
      ) : (
        <Rail />
      )}
    </CrossFade>
  );
}
