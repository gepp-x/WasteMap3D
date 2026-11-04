"use client";

import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { create } from "zustand";
import { MotionConfig, animate, motion, useMotionValue } from "motion/react";
import { ChevronUp, PanelRightOpen, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTr, type Bi } from "@/lib/i18n";
import { useDashboard, type DashboardState } from "@/store/dashboard-store";
import { DURATION, EASE, motionDuration, useReducedMotionPref } from "@/lib/animation/tokens";
import { useBreakpoint, type Breakpoint } from "@/hooks/use-media-query";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { toggleFullscreen } from "@/hooks/use-fullscreen";
import { Sheet, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Header, ToolButton } from "@/components/dashboard/Header";
import { BrandMark } from "@/components/dashboard/BrandMark";
import { LeftSidebar, RAIL_WIDTH, SIDEBAR_WIDTH } from "@/components/dashboard/LeftSidebar";
import { KPIStrip } from "@/components/dashboard/KPIStrip";
import { Stage } from "@/components/dashboard/Stage";
import { RightPanel } from "@/components/dashboard/RightPanel";
import { BottomDock } from "@/components/dashboard/BottomDock";
import { Timeline } from "@/components/dashboard/Timeline";
import { MobileShell } from "@/components/dashboard/MobileShell";
import { SettingsDialog } from "@/components/dashboard/SettingsDialog";
import { DataSourceDrawer } from "@/components/dashboard/DataSourceDrawer";
import { InsightExplorer } from "@/components/dashboard/InsightExplorer";
import { ShortcutsHelp, openShortcutsHelp, useShortcutsHelp } from "@/components/dashboard/ShortcutsHelp";
import { requestSearchFocus } from "@/components/dashboard/SearchBox";
import { CrossFade, ResizableColumn, ShellSheetContent, SlideOver } from "@/components/motion/AnimatedPanel";
import { EntranceItem, EntranceRoot } from "@/components/motion/Entrance";

const RIGHT_RAIL = 44;

/* Resizable desktop columns (bounds mirror store.setColumnWidth's clamps). */
const LEFT_BOUNDS = { min: 256, max: 420, default: SIDEBAR_WIDTH } as const;
const RIGHT_BOUNDS = { min: 320, max: 560, default: 384 } as const;
/** Narrowest stage the columns may squeeze it to (px). */
const MIN_STAGE = 480;
/** Row padding (p-2 → 16) + two 8 px gaps between the three columns. */
const ROW_CHROME = 32;
const COLUMNS_KEY = "urban-intelligence.columns.v1";

/** Restore persisted column widths once, then persist every committed change (storage may be unavailable). */
function useColumnPersistence() {
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLUMNS_KEY);
      if (raw) {
        const v = JSON.parse(raw) as { left?: unknown; right?: unknown };
        const s = useDashboard.getState();
        if (typeof v.left === "number" && Number.isFinite(v.left)) s.setColumnWidth("left", v.left);
        if (typeof v.right === "number" && Number.isFinite(v.right)) s.setColumnWidth("right", v.right);
      }
    } catch {
      /* private mode / blocked storage: keep the defaults */
    }
    return useDashboard.subscribe((s, prev) => {
      if (s.leftWidth === prev.leftWidth && s.rightWidth === prev.rightWidth) return;
      try {
        window.localStorage.setItem(COLUMNS_KEY, JSON.stringify({ left: s.leftWidth, right: s.rightWidth }));
      } catch {
        /* ignore */
      }
    });
  }, []);
}

/** Widest a column may become while the other keeps its current width and the stage keeps MIN_STAGE. */
function columnRoom(row: HTMLElement | null, side: "left" | "right") {
  if (!row) return side === "left" ? LEFT_BOUNDS.max : RIGHT_BOUNDS.max;
  const s = useDashboard.getState();
  const other = side === "left" ? (s.rightOpen ? s.rightWidth : RIGHT_RAIL) : s.leftOpen ? s.leftWidth : RAIL_WIDTH;
  return row.clientWidth - ROW_CHROME - other - MIN_STAGE;
}

/** When the window shrinks (or widths are restored / a column opens), give space back to the stage — right column first — so it keeps MIN_STAGE. */
function useFitColumns(row: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const fit = () => {
      const el = row.current;
      if (!el) return;
      const s = useDashboard.getState();
      const left = s.leftOpen ? s.leftWidth : RAIL_WIDTH;
      const right = s.rightOpen ? s.rightWidth : RIGHT_RAIL;
      let excess = left + right + ROW_CHROME + MIN_STAGE - el.clientWidth;
      if (excess <= 0) return;
      if (s.rightOpen) {
        const take = Math.min(excess, s.rightWidth - RIGHT_BOUNDS.min);
        if (take > 0) s.setColumnWidth("right", s.rightWidth - take);
        excess -= Math.max(0, take);
      }
      if (excess > 0 && s.leftOpen) {
        const take = Math.min(excess, s.leftWidth - LEFT_BOUNDS.min);
        if (take > 0) s.setColumnWidth("left", s.leftWidth - take);
      }
    };
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    };
    fit();
    window.addEventListener("resize", onResize);
    // restored widths (persistence) or a column opening can also squeeze the stage
    const unsub = useDashboard.subscribe((s, p) => {
      if (s.leftWidth !== p.leftWidth || s.rightWidth !== p.rightWidth || s.leftOpen !== p.leftOpen || s.rightOpen !== p.rightOpen) onResize();
    });
    return () => {
      cancelAnimationFrame(raf);
      unsub();
      window.removeEventListener("resize", onResize);
    };
  }, [row, enabled]);
}
const DOCK_MIN = 180;
const DOCK_MAX = 420;
const DOCK_DEFAULT = 260;

/* ------------------------------------------------------------------ */
/*  Layout defaults per breakpoint                                     */
/* ------------------------------------------------------------------ */

/** Breakpoint the store's panel flags were last configured for (null until first mount). */
const useShellLayout = create<{ applied: Breakpoint | null }>()(() => ({ applied: null }));

function applyLayoutDefaults(bp: Breakpoint) {
  const s = useDashboard.getState();
  if (bp === "desktop") {
    s.setPanel("leftOpen", true);
    s.setPanel("rightOpen", true);
    // keep the map the visual focus: on shorter desktop screens the analysis dock starts collapsed
    s.setPanel("bottomOpen", window.innerHeight >= 1050);
  } else if (bp === "tablet") {
    s.setPanel("leftOpen", false);
    s.setPanel("rightOpen", s.selectedAreaId !== null);
    s.setPanel("bottomOpen", false);
  } else {
    s.setPanel("leftOpen", false);
    s.setPanel("labOpen", false);
    // reduced effects by default on phones
    if (s.quality === "auto") s.setQualityTier("low");
  }
  useShellLayout.setState({ applied: bp });
}

/* ------------------------------------------------------------------ */
/*  Bottom dock frame: collapse + drag-to-resize (180–420 px)          */
/* ------------------------------------------------------------------ */

const DOCK_TABS: Record<DashboardState["bottomTab"], Bi> = {
  ranking: { th: "อันดับพื้นที่", en: "Ranking" },
  rainfall: { th: "ฝน", en: "Rainfall" },
  drainage: { th: "การระบายน้ำ", en: "Drainage" },
  compare: { th: "เปรียบเทียบ", en: "Compare" },
};

function DockFrame() {
  const t = useTr();
  const reduced = useReducedMotionPref();
  const open = useDashboard((s) => s.bottomOpen);
  const tab = useDashboard((s) => s.bottomTab);
  const setPanel = useDashboard((s) => s.setPanel);
  const [height, setHeight] = useState(DOCK_DEFAULT);
  const h = useMotionValue(open ? DOCK_DEFAULT : 0);
  const [drag, setDrag] = useState<{ id: number; y: number; h: number } | null>(null);

  // Open/close tween. Height changes while open are written straight to the motion value
  // (drag / keys), so only `open` triggers an animation; the latest committed height is read lazily.
  const tweenTo = useEffectEvent((isOpen: boolean) =>
    animate(h, isOpen ? height : 0, { duration: motionDuration(DURATION.panel, reduced), ease: EASE.outExpo }),
  );
  useEffect(() => {
    const c = tweenTo(open);
    return () => c.stop();
  }, [open]);

  const clampH = (v: number) => Math.min(DOCK_MAX, Math.max(DOCK_MIN, v));
  const commit = (v: number) => {
    const c = clampH(v);
    h.set(c);
    setHeight(c);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: e.pointerId, y: e.clientY, h: h.get() });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag && drag.id === e.pointerId) h.set(clampH(drag.h - (e.clientY - drag.y)));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.id !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDrag(null);
    setHeight(h.get());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp") commit(height + 20);
    else if (e.key === "ArrowDown") commit(height - 20);
    else if (e.key === "Home") commit(DOCK_MIN);
    else if (e.key === "End") commit(DOCK_MAX);
    else return;
    e.preventDefault();
  };

  return (
    <div className="flex shrink-0 flex-col">
      <div className="relative flex h-7 shrink-0 items-center border-t border-ui-border/70 px-2">
        <button
          type="button"
          onClick={() => setPanel("bottomOpen", !open)}
          aria-expanded={open}
          aria-controls="bottom-dock-body"
          className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-ui-text-3 transition-colors outline-none hover:bg-ui-elevated hover:text-ui-text focus-visible:ring-2 focus-visible:ring-ui-cyan/60"
        >
          <ChevronUp aria-hidden className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} />
          {open
            ? t({ th: "ซ่อนแผงวิเคราะห์", en: "Hide analysis dock" })
            : `${t({ th: "แสดงแผงวิเคราะห์", en: "Show analysis dock" })} · ${t(DOCK_TABS[tab])}`}
        </button>
        {open && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t({ th: "ปรับความสูงแผงวิเคราะห์", en: "Resize analysis dock" })}
            aria-valuemin={DOCK_MIN}
            aria-valuemax={DOCK_MAX}
            aria-valuenow={Math.round(height)}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => commit(DOCK_DEFAULT)}
            onKeyDown={onKeyDown}
            className="group absolute top-0 left-1/2 flex h-full w-28 -translate-x-1/2 cursor-row-resize touch-none items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60"
          >
            <span
              aria-hidden
              className={cn("h-1 w-9 rounded-full transition-colors", drag ? "bg-ui-cyan" : "bg-ui-border-strong group-hover:bg-ui-text-3")}
            />
          </div>
        )}
      </div>
      <motion.div id="bottom-dock-body" style={{ height: h }} inert={!open} className="min-h-0 overflow-hidden">
        <BottomDock />
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Desktop / tablet shell                                             */
/* ------------------------------------------------------------------ */

function RightRail() {
  const t = useTr();
  const setPanel = useDashboard((s) => s.setPanel);
  const selected = useDashboard((s) => s.selectedAreaId);
  return (
    <div className="flex h-full flex-col items-center py-2" style={{ width: RIGHT_RAIL }}>
      <ToolButton
        icon={PanelRightOpen}
        side="left"
        label={t({ th: "แสดงแผงรายละเอียด", en: "Show details panel" })}
        onClick={() => setPanel("rightOpen", true)}
      />
      {selected && <span aria-hidden className="mt-1 size-1.5 rounded-full bg-ui-cyan" />}
    </div>
  );
}

function DesktopShell({ tablet }: { tablet: boolean }) {
  const t = useTr();
  const leftOpen = useDashboard((s) => s.leftOpen);
  const rightOpen = useDashboard((s) => s.rightOpen);
  const leftWidth = useDashboard((s) => s.leftWidth);
  const rightWidth = useDashboard((s) => s.rightWidth);
  const setPanel = useDashboard((s) => s.setPanel);
  const setColumnWidth = useDashboard((s) => s.setColumnWidth);
  const rowRef = useRef<HTMLDivElement>(null);
  useFitColumns(rowRef, !tablet);

  const openLab = () => {
    setPanel("labOpen", true);
    setPanel("leftOpen", true);
  };

  useKeyboardShortcuts({
    onToggleLayers: () => {
      const s = useDashboard.getState();
      if (!s.leftOpen) s.setPanel("labOpen", false);
      s.setPanel("leftOpen", !s.leftOpen);
    },
    onFocusSearch: () => {
      setPanel("labOpen", false);
      setPanel("leftOpen", true);
      requestSearchFocus();
    },
    onOpenLab: openLab,
    onOpenHelp: openShortcutsHelp,
    onFullscreen: toggleFullscreen,
    onEscape: tablet
      ? () => {
          const s = useDashboard.getState();
          if (s.leftOpen) {
            s.setPanel("leftOpen", false);
            return true;
          }
          if (s.rightOpen) {
            s.setPanel("rightOpen", false);
            if (s.selectedAreaId) s.selectArea(null);
            return true;
          }
          return false;
        }
      : undefined,
    isModalOpen: () => useShortcutsHelp.getState().open,
  });

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-ui-bg">
      <a href="#stage" className="sr-only z-50 rounded-md bg-ui-cyan px-3 py-2 text-[13px] text-ui-bg focus:not-sr-only focus:absolute focus:top-2 focus:left-2">
        {t({ th: "ข้ามไปยังแผนที่", en: "Skip to the map" })}
      </a>
      <EntranceRoot className="flex min-h-0 flex-1 flex-col">
        <EntranceItem kind="header" className="relative z-30">
          <Header variant={tablet ? "tablet" : "desktop"} onOpenMenu={() => setPanel("leftOpen", !leftOpen)} onOpenLab={openLab} />
        </EntranceItem>

        <div ref={rowRef} className="flex min-h-0 flex-1 gap-2 p-2">
          {!tablet && (
            <EntranceItem kind="left" className="flex min-h-0">
              <ResizableColumn
                id="shell-left-column"
                side="left"
                open={leftOpen}
                width={leftWidth}
                min={LEFT_BOUNDS.min}
                max={LEFT_BOUNDS.max}
                defaultWidth={LEFT_BOUNDS.default}
                collapsedWidth={RAIL_WIDTH}
                onCommit={(px) => setColumnWidth("left", px)}
                maxAvailable={() => columnRoom(rowRef.current, "left")}
                label={t({ th: "แผงควบคุมและชั้นข้อมูล", en: "Controls and layers" })}
                handleLabel={t({ th: "ปรับความกว้างแผงควบคุม (ลูกศรซ้าย/ขวา, ดับเบิลคลิกเพื่อคืนค่า)", en: "Resize the controls column (arrow keys; double-click to reset)" })}
                className="ui-panel"
              >
                <LeftSidebar variant="docked" />
              </ResizableColumn>
            </EntranceItem>
          )}

          <main className="flex min-w-0 flex-1 flex-col gap-2">
            <KPIStrip className="shrink-0" />
            <EntranceItem kind="stage" className="relative min-h-0 flex-1">
              <Stage />
              {tablet && (
                <SlideOver
                  open={rightOpen}
                  label={t({ th: "รายละเอียดพื้นที่", en: "Area details" })}
                  className="ui-panel-float absolute top-2 right-2 bottom-2 z-40 flex w-[min(380px,calc(100%-1rem))] flex-col overflow-hidden"
                >
                  <div className="flex h-10 shrink-0 items-center justify-end border-b border-ui-border px-1.5">
                    <ToolButton
                      icon={X}
                      size="icon-sm"
                      side="left"
                      label={t({ th: "ปิดแผงรายละเอียด", en: "Close details" })}
                      onClick={() => setPanel("rightOpen", false)}
                    />
                  </div>
                  <div className="min-h-0 flex-1">
                    <RightPanel />
                  </div>
                </SlideOver>
              )}
            </EntranceItem>
            <EntranceItem kind="dock" className="ui-panel flex shrink-0 flex-col overflow-hidden">
              <div className="[&>[role=region]]:border-t-0">
                <Timeline />
              </div>
              <DockFrame />
            </EntranceItem>
          </main>

          {!tablet && (
            <EntranceItem kind="right" className="flex min-h-0">
              <ResizableColumn
                id="shell-right-column"
                side="right"
                open={rightOpen}
                width={rightWidth}
                min={RIGHT_BOUNDS.min}
                max={RIGHT_BOUNDS.max}
                defaultWidth={RIGHT_BOUNDS.default}
                collapsedWidth={RIGHT_RAIL}
                onCommit={(px) => setColumnWidth("right", px)}
                maxAvailable={() => columnRoom(rowRef.current, "right")}
                label={t({ th: "รายละเอียดเมืองและพื้นที่", en: "City and area details" })}
                handleLabel={t({ th: "ปรับความกว้างแผงรายละเอียด (ลูกศรซ้าย/ขวา, ดับเบิลคลิกเพื่อคืนค่า)", en: "Resize the details column (arrow keys; double-click to reset)" })}
                className="ui-panel"
              >
                <CrossFade id={rightOpen ? "panel" : "rail"} direction={-1} className="h-full">
                  {rightOpen ? (
                    <div className="flex h-full min-h-0 flex-col" style={{ width: "var(--col-w)" }}>
                      <RightPanel />
                    </div>
                  ) : (
                    <RightRail />
                  )}
                </CrossFade>
              </ResizableColumn>
            </EntranceItem>
          )}
        </div>
      </EntranceRoot>

      {tablet && (
        <Sheet open={leftOpen} onOpenChange={(v) => setPanel("leftOpen", v)}>
          <ShellSheetContent
            side="left"
            showCloseButton={false}
            closeLabel={t({ th: "ปิด", en: "Close" })}
            className="w-[320px] max-w-[88vw] gap-0 border-ui-border bg-ui-surface p-0 sm:max-w-[88vw]"
          >
            <SheetTitle className="sr-only">{t({ th: "แผงควบคุมและชั้นข้อมูล", en: "Controls and layers" })}</SheetTitle>
            <SheetDescription className="sr-only">
              {t({ th: "ค้นหาพื้นที่ เลือกรูปแบบการแสดงผล ชั้นข้อมูล และสถานการณ์จำลอง", en: "Search areas, choose display mode, layers and scenarios" })}
            </SheetDescription>
            <LeftSidebar variant="drawer" onNavigate={() => setPanel("leftOpen", false)} onClose={() => setPanel("leftOpen", false)} />
          </ShellSheetContent>
        </Sheet>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Pre-mount skeleton (identical on server and first client render)   */
/* ------------------------------------------------------------------ */

function ShellSkeleton() {
  return (
    <div className="ui-grid-bg flex h-dvh w-full flex-col bg-ui-bg" aria-busy>
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-ui-border px-3">
        <BrandMark size={30} />
        <span className="text-[12.5px] font-semibold tracking-[0.2em] text-ui-text uppercase">Urban Intelligence</span>
      </div>
      <div className="flex flex-1 items-center justify-center">
        <BrandMark size={44} className="animate-pulse opacity-70" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App shell                                                          */
/* ------------------------------------------------------------------ */

/**
 * Responsive application shell.
 *  ≥ 1280 px  desktop: header · sidebar/rail · KPI + stage + timeline + dock · details column
 *  768–1279   tablet:  sidebar in a drawer, details as an overlay, dock collapsed by default
 *  < 768      mobile:  MobileShell (chips, full-bleed stage, bottom sheet)
 * Renders a neutral skeleton until the breakpoint is known on the client (no hydration mismatch).
 */
export function AppShell() {
  const bp = useBreakpoint();
  useColumnPersistence();
  const applied = useShellLayout((s) => s.applied);
  const reduced = useReducedMotionPref();
  const userReduced = useDashboard((s) => s.reducedMotion);
  const lang = useDashboard((s) => s.lang);
  const quality = useDashboard((s) => s.quality);

  // configure panel flags for the current breakpoint before the shell first renders
  useEffect(() => {
    if (bp) applyLayoutDefaults(bp);
  }, [bp]);

  // phones fall back to the low tier whenever the user returns to "auto"
  useEffect(() => {
    if (bp === "mobile" && quality === "auto") useDashboard.getState().setQualityTier("low");
  }, [bp, quality]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    const el = document.documentElement;
    if (userReduced) el.dataset.reducedMotion = "true";
    else delete el.dataset.reducedMotion;
  }, [userReduced]);

  const ready = bp !== null && applied !== null;

  return (
    <MotionConfig reducedMotion={reduced ? "always" : "user"}>
      {!ready ? <ShellSkeleton /> : bp === "mobile" ? <MobileShell /> : <DesktopShell tablet={bp === "tablet"} />}
      <SettingsDialog onAfterReset={() => bp && applyLayoutDefaults(bp)} />
      <DataSourceDrawer />
      <InsightExplorer />
      <ShortcutsHelp />
    </MotionConfig>
  );
}
