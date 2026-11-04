"use client";

import { useMemo, type ReactNode } from "react";
import {
  CalendarRange,
  Database,
  Lightbulb,
  Maximize2,
  Menu,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Route,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLang, useTr, type Bi } from "@/lib/i18n";
import { useCityBundle } from "@/lib/data/loader";
import { CITIES } from "@/lib/data/cities";
import { primaryWasteMetric } from "@/lib/metrics";
import { formatDate, formatYear } from "@/lib/formatters";
import type { DataProvenance } from "@/lib/types";
import { useDashboard, type Lang } from "@/store/dashboard-store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BrandMark } from "@/components/dashboard/BrandMark";
import { CitySwitcher } from "@/components/dashboard/CitySwitcher";
import { Kbd, SegmentedControl } from "@/components/dashboard/ViewModeSwitch";
import { SwapText } from "@/components/motion/AnimatedPanel";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { openModal, shortcutKey } from "@/hooks/use-keyboard-shortcuts";
import { useStorySteps } from "@/hooks/use-story";
import { STORY_LABEL, toggleGuidedStory } from "@/components/dashboard/StoryMode";

/* ------------------------------------------------------------------ */
/*  Shared chrome primitives (used by sidebar, mobile shell, dialogs)  */
/* ------------------------------------------------------------------ */

/** Icon button with tooltip + accessible name. `pressed` exposes toggle state. */
export function ToolButton({
  icon: Icon,
  label,
  onClick,
  pressed,
  shortcut,
  side = "bottom",
  size = "icon",
  className,
  children,
  badge,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  size?: "icon" | "icon-sm" | "icon-lg";
  className?: string;
  children?: ReactNode;
  /** Small status dot (e.g. simulation running). */
  badge?: "simulated";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={children ? "default" : size}
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              "relative text-ui-text-2 hover:bg-ui-elevated hover:text-ui-text aria-pressed:bg-ui-elevated aria-pressed:text-ui-text",
              className,
            )}
          />
        }
      >
        <Icon aria-hidden />
        {children}
        {badge === "simulated" && (
          <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-status-simulated ring-2 ring-ui-bg" />
        )}
      </TooltipTrigger>
      <TooltipContent side={side}>
        <span>{label}</span>
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/** Eyebrow label — uppercase tracking for Latin, natural spacing for Thai script. */
export function Eyebrow({ children, className, as: Comp = "span", id }: { children: ReactNode; className?: string; as?: "span" | "h2" | "h3" | "h4" | "p"; id?: string }) {
  const lang = useLang();
  return (
    <Comp id={id} className={cn("ui-eyebrow block", lang === "th" && "text-[11.5px] tracking-normal normal-case", className)}>
      {children}
    </Comp>
  );
}

/* ------------------------------------------------------------------ */
/*  Dataset period (computed from provenance, never hardcoded)         */
/* ------------------------------------------------------------------ */

function yearsOf(p: DataProvenance | undefined): number[] {
  if (!p || p.status === "unavailable") return [];
  const ys: number[] = [];
  if (p.referenceYear) ys.push(p.referenceYear);
  for (const d of [p.observedFrom, p.observedTo]) if (d) ys.push(Number(d.slice(0, 4)));
  return ys.filter((y) => Number.isFinite(y) && y > 1900);
}

function yearRange(years: number[], lang: Lang) {
  const min = Math.min(...years);
  const max = Math.max(...years);
  const prefix = lang === "th" ? "พ.ศ. " : "";
  return min === max ? `${prefix}${formatYear(min, lang)}` : `${prefix}${formatYear(min, lang)}–${formatYear(max, lang)}`;
}

export function useDatasetPeriod() {
  const { bundle } = useCityBundle();
  const lang = useLang();
  return useMemo(() => {
    const ds = bundle?.dataset;
    if (!ds) return null;
    const rows: { label: Bi; text: string }[] = [];
    const all: number[] = [];

    const pop = yearsOf(ds.totals.population?.provenance);
    if (pop.length) {
      rows.push({ label: { th: "ประชากร", en: "Population" }, text: yearRange(pop, lang) });
      all.push(...pop);
    }
    const primary = primaryWasteMetric(ds);
    const hist = ds.wasteHistory.filter((y) => y.value !== null && y.status !== "unavailable").map((y) => y.year);
    const waste = hist.length ? hist : yearsOf(ds.totals[primary]?.provenance);
    if (waste.length) {
      rows.push({
        label: primary === "wasteCollected" ? { th: "ขยะที่จัดเก็บได้", en: "Waste collected" } : { th: "ขยะที่เกิดขึ้น", en: "Waste generated" },
        text: yearRange(waste, lang),
      });
      all.push(...waste);
    }
    const dates = bundle.rainAreas?.dates ?? bundle.rainGrid?.dates;
    if (dates && dates.length) {
      const first = dates[0];
      const last = dates[dates.length - 1];
      rows.push({ label: { th: "ฝนรายวัน", en: "Daily rainfall" }, text: `${formatDate(first, lang)} – ${formatDate(last, lang)}` });
      all.push(Number(first.slice(0, 4)), Number(last.slice(0, 4)));
    } else {
      const rain = yearsOf(ds.totals.rainfallAnnual?.provenance);
      if (rain.length) {
        rows.push({ label: { th: "ฝนรายปี", en: "Annual rainfall" }, text: yearRange(rain, lang) });
        all.push(...rain);
      }
    }
    const valid = all.filter((y) => Number.isFinite(y));
    return { rows, range: valid.length ? yearRange(valid, lang) : null, generatedAt: ds.generatedAt };
  }, [bundle, lang]);
}

function PeriodChip({ className }: { className?: string }) {
  const t = useTr();
  const lang = useLang();
  const cityId = useDashboard((s) => s.cityId);
  const period = useDatasetPeriod();
  const city = CITIES[cityId];
  const text = period?.range ? `${t({ th: "ข้อมูล", en: "Data" })} ${period.range}` : t({ th: city.periodLabelTh, en: city.periodLabelEn });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border border-ui-border px-2.5 text-[11.5px] text-ui-text-2 transition-colors hover:border-ui-border-strong hover:text-ui-text",
              className,
            )}
            onClick={() => openModal("sourcesOpen")}
            aria-label={`${t({ th: "ช่วงเวลาของชุดข้อมูล", en: "Dataset period" })}: ${text}. ${t({ th: "เปิดแหล่งข้อมูล", en: "Open data sources" })}`}
          />
        }
      >
        <CalendarRange aria-hidden className="size-3.5 shrink-0 text-ui-cyan" />
        <span className="truncate ui-num">{text}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-80">
        <div className="flex flex-col gap-1 py-0.5 text-left">
          <span className="font-semibold">{t({ th: "ช่วงอ้างอิงของข้อมูล", en: "Reference periods" })}</span>
          {period?.rows.length ? (
            period.rows.map((r) => (
              <span key={r.label.en} className="flex justify-between gap-4">
                <span className="opacity-75">{t(r.label)}</span>
                <span className="ui-num">{r.text}</span>
              </span>
            ))
          ) : (
            <span className="opacity-75">{t({ th: city.periodLabelTh, en: city.periodLabelEn })}</span>
          )}
          <span className="mt-1 opacity-60">{t({ th: "คลิกเพื่อดูแหล่งข้อมูลทั้งหมด", en: "Click for all data sources" })}</span>
          {period?.generatedAt && (
            <span className="mt-1 opacity-60">
              {t({ th: "ประมวลผลชุดข้อมูลเมื่อ", en: "Dataset built" })} {formatDate(period.generatedAt, lang)}
            </span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/*  Mode indicator — Historical ↔ Simulation                           */
/* ------------------------------------------------------------------ */

export function ModeIndicator({ compact = false, onOpenLab, className }: { compact?: boolean; onOpenLab: () => void; className?: string }) {
  const t = useTr();
  const active = useDashboard((s) => s.scenarioActive);
  const label = active
    ? t(compact ? { th: "การจำลอง", en: "Simulation" } : { th: "การจำลอง · Simulation", en: "Simulation" })
    : t(compact ? { th: "ข้อมูลย้อนหลัง", en: "Historical" } : { th: "ข้อมูลย้อนหลัง · Historical", en: "Historical" });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onOpenLab}
            aria-label={`${t({ th: "โหมดข้อมูล", en: "Data mode" })}: ${label}. ${t({ th: "เปิดห้องทดลองสถานการณ์", en: "Open the Scenario Lab" })}`}
            className={cn(
              "relative inline-flex items-center overflow-hidden rounded-full border font-medium transition-colors duration-300",
              compact ? "h-6 px-2 text-[10.5px]" : "h-7 px-2.5 text-[11.5px]",
              active
                ? "ui-sim-stripes border-status-simulated/55 text-status-simulated"
                : "border-ui-border bg-ui-surface text-ui-text-2 hover:border-ui-border-strong hover:text-ui-text",
              className,
            )}
          />
        }
      >
        <SwapText id={active ? "sim" : "hist"} className="gap-1.5">
          <span aria-hidden className={active ? "text-status-simulated" : "text-status-observed"}>
            {active ? "◇" : "●"}
          </span>
          {label}
        </SwapText>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72 text-left">
        {active
          ? t({
              th: "กำลังแสดงผลลัพธ์จากแบบจำลองเชิงสาธิต — ไม่ใช่การพยากรณ์น้ำท่วมอย่างเป็นทางการ ข้อมูลจริงไม่ถูกแก้ไข",
              en: "Showing illustrative model output — not an official flood forecast. Observed data is never modified.",
            })
          : t({
              th: "กำลังแสดงข้อมูลย้อนหลังจากแหล่งข้อมูลสาธารณะ คลิกเพื่อเปิดห้องทดลองสถานการณ์",
              en: "Showing historical data from public sources. Click to open the Scenario Lab.",
            })}
      </TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/*  Language switch                                                    */
/* ------------------------------------------------------------------ */

export function LangSwitch({ size = "sm" }: { size?: "sm" | "md" }) {
  const lang = useDashboard((s) => s.lang);
  const setLang = useDashboard((s) => s.setLang);
  return (
    <SegmentedControl
      value={lang}
      onChange={setLang}
      ariaLabel={lang === "th" ? "ภาษา (Language)" : "Language (ภาษา)"}
      size={size}
      options={[
        { value: "th", label: "TH", ariaLabel: "ภาษาไทย", tooltip: "ภาษาไทย" },
        { value: "en", label: "EN", ariaLabel: "English", tooltip: "English" },
      ]}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Brand                                                              */
/* ------------------------------------------------------------------ */

export function BrandBlock({ compact = false, textClassName }: { compact?: boolean; textClassName?: string }) {
  const t = useTr();
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2.5">
      <BrandMark size={compact ? 26 : 30} />
      <div className={cn("flex min-w-0 flex-col leading-tight", textClassName)}>
        <h1 className="truncate text-[12.5px] font-semibold tracking-[0.2em] text-ui-text uppercase">
          Urban Intelligence
          <span className="sr-only"> — {t({ th: "หอสังเกตการณ์ขยะและน้ำท่วม", en: "Waste & Flood Observatory" })}</span>
        </h1>
        <p aria-hidden className={cn("truncate text-ui-text-2", compact ? "text-[10.5px]" : "text-[11.5px]")}>
          {t({ th: "หอสังเกตการณ์ขยะและน้ำท่วม", en: "Waste & Flood Observatory" })}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Guided story entry                                                 */
/* ------------------------------------------------------------------ */

function StoryHeaderButton() {
  const t = useTr();
  const active = useDashboard((s) => s.storyActive);
  const { ready } = useStorySteps();
  const label = active
    ? t({ th: "ออกจากทัวร์เล่าเรื่องเมือง (Esc)", en: "Exit the guided story (Esc)" })
    : ready
      ? t({ th: "เล่าเรื่องเมือง — ทัวร์ข้อมูลแบบมีผู้นำทาง", en: "Guided story — a guided tour of the data" })
      : t({ th: "เล่าเรื่องเมือง (กำลังโหลดข้อมูล)", en: "Guided story (loading data)" });
  return (
    <ToolButton icon={Route} label={label} pressed={active} disabled={!ready && !active} onClick={toggleGuidedStory} className="px-2.5">
      <span className="hidden text-[12.5px] 2xl:inline">{t(STORY_LABEL)}</span>
    </ToolButton>
  );
}

/* ------------------------------------------------------------------ */
/*  Header                                                             */
/* ------------------------------------------------------------------ */

export function Header({ variant, onOpenMenu, onOpenLab }: { variant: "desktop" | "tablet"; onOpenMenu?: () => void; onOpenLab: () => void }) {
  const t = useTr();
  const setPanel = useDashboard((s) => s.setPanel);
  const rightOpen = useDashboard((s) => s.rightOpen);
  const leftOpen = useDashboard((s) => s.leftOpen);
  const { isFullscreen, supported: fsSupported, toggle: toggleFs } = useFullscreen();

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-ui-border bg-ui-bg/95 px-3">
      {variant === "tablet" && onOpenMenu && (
        <ToolButton
          icon={Menu}
          label={t({ th: "เปิดแผงควบคุมและชั้นข้อมูล", en: "Open controls & layers" })}
          onClick={onOpenMenu}
          pressed={leftOpen}
          shortcut={shortcutKey("layers")}
        />
      )}
      <BrandBlock textClassName="sr-only lg:not-sr-only lg:flex" />
      <p className="hidden min-w-0 border-l border-ui-border pl-3 text-[11.5px] leading-tight text-ui-text-3 2xl:block">
        {t({ th: "เข้าใจเมือง เห็นความเชื่อมโยง", en: "Understand the City. See the Connections." })}
      </p>

      <div className="mx-auto flex min-w-0 items-center gap-2">
        <CitySwitcher className="hidden lg:inline-flex" />
        <CitySwitcher compact className="lg:hidden" />
        <PeriodChip className="hidden xl:inline-flex" />
        <ModeIndicator onOpenLab={onOpenLab} className="hidden xl:inline-flex" />
        <ModeIndicator compact onOpenLab={onOpenLab} className="xl:hidden" />
      </div>

      <nav aria-label={t({ th: "เครื่องมือ", en: "Tools" })} className="flex shrink-0 items-center gap-0.5">
        <StoryHeaderButton />
        <ToolButton icon={Lightbulb} label={t({ th: "ข้อค้นพบสำคัญ", en: "Insights" })} onClick={() => openModal("insightsOpen")} className="px-2.5">
          <span className="hidden text-[12.5px] xl:inline">{t({ th: "ข้อค้นพบ", en: "Insights" })}</span>
        </ToolButton>
        <ToolButton icon={Database} label={t({ th: "แหล่งข้อมูลและวิธีการ", en: "Data sources & methods" })} onClick={() => openModal("sourcesOpen")} />
        <ToolButton icon={Settings2} label={t({ th: "การตั้งค่า", en: "Settings" })} onClick={() => openModal("settingsOpen")} />
        <ToolButton
          icon={rightOpen ? PanelRightClose : PanelRightOpen}
          label={rightOpen ? t({ th: "ซ่อนแผงรายละเอียด", en: "Hide details panel" }) : t({ th: "แสดงแผงรายละเอียด", en: "Show details panel" })}
          pressed={rightOpen}
          onClick={() => setPanel("rightOpen", !rightOpen)}
        />
        {fsSupported && (
          <ToolButton
            icon={isFullscreen ? Minimize2 : Maximize2}
            label={isFullscreen ? t({ th: "ออกจากโหมดเต็มจอ", en: "Exit fullscreen" }) : t({ th: "เต็มจอ", en: "Fullscreen" })}
            pressed={isFullscreen}
            onClick={toggleFs}
            shortcut={shortcutKey("fullscreen")}
          />
        )}
        <span aria-hidden className="mx-1.5 h-5 w-px bg-ui-border" />
        <LangSwitch />
      </nav>
    </header>
  );
}
