"use client";

import { useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";
import { animate, motion, useDragControls, useMotionValue, useTransform, type PanInfo } from "motion/react";
import { BarChart3, Database, Ellipsis, FlaskConical, Info, Languages, Layers, Lightbulb, Maximize2, Minimize2, Route, Search, Settings2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTr } from "@/lib/i18n";
import { useDashboard, type DashboardState } from "@/store/dashboard-store";
import { SPRING, useReducedMotionPref } from "@/lib/animation/tokens";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrandMark } from "@/components/dashboard/BrandMark";
import { CitySwitcher } from "@/components/dashboard/CitySwitcher";
import { ModeIndicator, ToolButton } from "@/components/dashboard/Header";
import { KPIStrip } from "@/components/dashboard/KPIStrip";
import { Stage } from "@/components/dashboard/Stage";
import { SearchBox, requestSearchFocus } from "@/components/dashboard/SearchBox";
import { RightPanel } from "@/components/dashboard/RightPanel";
import { LayerControl } from "@/components/dashboard/LayerControl";
import { ScenarioLab } from "@/components/dashboard/ScenarioLab";
import { BottomDock } from "@/components/dashboard/BottomDock";
import { Timeline } from "@/components/dashboard/Timeline";
import { openShortcutsHelp, useShortcutsHelp } from "@/components/dashboard/ShortcutsHelp";
import { useFullscreen, toggleFullscreen } from "@/hooks/use-fullscreen";
import { openModal, useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useStorySteps } from "@/hooks/use-story";
import { STORY_LABEL, toggleGuidedStory } from "@/components/dashboard/StoryMode";

type MobileTab = "details" | "layers" | "scenario" | "analysis";
type Snap = DashboardState["sheetSnap"];

/** Mobile-only UI state (tab + search row). */
export const useMobileUi = create<{ tab: MobileTab; searchOpen: boolean; setTab: (t: MobileTab) => void; setSearchOpen: (v: boolean) => void }>()((set) => ({
  tab: "details",
  searchOpen: false,
  setTab: (tab) => set({ tab }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}));

const HEADER_H = 52;
/** Height of the sheet chrome that stays visible when collapsed (handle + tab bar). */
const SHEET_CHROME = 78;

function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  window.visualViewport?.addEventListener("resize", cb);
  return () => {
    window.removeEventListener("resize", cb);
    window.visualViewport?.removeEventListener("resize", cb);
  };
}
const viewportHeight = () => window.innerHeight;

function snapHeights(vh: number) {
  const full = Math.max(SHEET_CHROME + 120, vh - HEADER_H - 12);
  return { collapsed: SHEET_CHROME, half: Math.min(full, Math.round(vh * 0.5)), full } satisfies Record<Snap, number>;
}

/* ------------------------------------------------------------------ */
/*  Header                                                             */
/* ------------------------------------------------------------------ */

function openSheetTab(tab: MobileTab) {
  useMobileUi.getState().setTab(tab);
  const s = useDashboard.getState();
  if (s.sheetSnap === "collapsed") s.setSheetSnap("half");
}

function openLabMobile() {
  openSheetTab("scenario");
}

/**
 * Phones have no left column or analysis dock: the shared "open the Scenario Lab" (labOpen) and
 * "show the analysis dock" (bottomOpen, e.g. Compare / drainage KPI) requests issued by panels are
 * consumed here and mapped to bottom-sheet tabs, then reset so the next request is a fresh transition.
 */
function usePhonePanelRequests() {
  useEffect(() => {
    const s = useDashboard.getState();
    if (s.labOpen) s.setPanel("labOpen", false);
    if (s.bottomOpen) s.setPanel("bottomOpen", false);
    return useDashboard.subscribe((st, prev) => {
      if (st.labOpen && !prev.labOpen) {
        st.setPanel("labOpen", false);
        openSheetTab("scenario");
      } else if (st.bottomOpen && !prev.bottomOpen) {
        st.setPanel("bottomOpen", false);
        openSheetTab("analysis");
      }
    });
  }, []);
}

function MobileHeader() {
  const t = useTr();
  const lang = useDashboard((s) => s.lang);
  const setLang = useDashboard((s) => s.setLang);
  const storyActive = useDashboard((s) => s.storyActive);
  const { ready: storyReady } = useStorySteps();
  const searchOpen = useMobileUi((s) => s.searchOpen);
  const setSearchOpen = useMobileUi((s) => s.setSearchOpen);
  const { isFullscreen, supported, toggle } = useFullscreen();

  return (
    <>
      <header className="relative z-30 flex shrink-0 items-center gap-2 border-b border-ui-border bg-ui-bg/95 px-3" style={{ height: HEADER_H }}>
        <BrandMark size={32} />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <h1 className="max-w-full truncate text-[11px] leading-none font-semibold tracking-[-0.01em] text-ui-text">
            GEPP Urban Intelligence
            <span className="sr-only"> — {t({ th: "หอสังเกตการณ์ขยะและน้ำท่วม", en: "Waste & Flood Observatory" })}</span>
          </h1>
          <ModeIndicator compact onOpenLab={openLabMobile} />
        </div>
        <CitySwitcher compact />
        <ToolButton
          icon={searchOpen ? X : Search}
          label={searchOpen ? t({ th: "ปิดการค้นหา", en: "Close search" }) : t({ th: "ค้นหาพื้นที่", en: "Search areas" })}
          pressed={searchOpen}
          onClick={() => setSearchOpen(!searchOpen)}
          className="size-9"
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-lg" aria-label={t({ th: "เมนูเพิ่มเติม", en: "More" })} className="size-9 text-ui-text-2" />}
          >
            <Ellipsis aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 border border-ui-border bg-ui-elevated">
            <DropdownMenuItem onClick={toggleGuidedStory} disabled={!storyReady && !storyActive} className="min-h-10">
              <Route aria-hidden />
              {storyActive ? t({ th: "ออกจากทัวร์เล่าเรื่องเมือง", en: "Exit the guided story" }) : t(STORY_LABEL)}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openModal("insightsOpen")} className="min-h-10">
              <Lightbulb aria-hidden />
              {t({ th: "ข้อค้นพบสำคัญ", en: "Insights" })}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openModal("sourcesOpen")} className="min-h-10">
              <Database aria-hidden />
              {t({ th: "แหล่งข้อมูลและวิธีการ", en: "Data sources & methods" })}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openModal("settingsOpen")} className="min-h-10">
              <Settings2 aria-hidden />
              {t({ th: "การตั้งค่า", en: "Settings" })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setLang(lang === "th" ? "en" : "th")} className="min-h-10">
              <Languages aria-hidden />
              {lang === "th" ? "Switch to English" : "เปลี่ยนเป็นภาษาไทย"}
            </DropdownMenuItem>
            {supported && (
              <DropdownMenuItem onClick={toggle} className="min-h-10">
                {isFullscreen ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
                {isFullscreen ? t({ th: "ออกจากโหมดเต็มจอ", en: "Exit fullscreen" }) : t({ th: "เต็มจอ", en: "Fullscreen" })}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {searchOpen && (
        <div className="relative z-30 shrink-0 border-b border-ui-border bg-ui-bg/95 px-3 py-2">
          <SearchBox autoFocus onSelect={() => setSearchOpen(false)} />
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Bottom sheet                                                       */
/* ------------------------------------------------------------------ */

const TABS: { id: MobileTab; icon: typeof Info; label: { th: string; en: string } }[] = [
  { id: "details", icon: Info, label: { th: "รายละเอียด", en: "Details" } },
  { id: "layers", icon: Layers, label: { th: "ชั้นข้อมูล", en: "Layers" } },
  { id: "scenario", icon: FlaskConical, label: { th: "สถานการณ์", en: "Scenario" } },
  { id: "analysis", icon: BarChart3, label: { th: "วิเคราะห์", en: "Analysis" } },
];

const NEXT_SNAP: Record<Snap, Snap> = { collapsed: "half", half: "full", full: "collapsed" };

function BottomSheet() {
  const t = useTr();
  const reduced = useReducedMotionPref();
  const snap = useDashboard((s) => s.sheetSnap);
  const setSnap = useDashboard((s) => s.setSheetSnap);
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  const tab = useMobileUi((s) => s.tab);
  const setTab = useMobileUi((s) => s.setTab);
  const vh = useSyncExternalStore(subscribeResize, viewportHeight, () => 800);
  const heights = snapHeights(vh);
  const sheetH = heights.full;
  const offsetFor = (s: Snap) => sheetH - heights[s];

  const y = useMotionValue(offsetFor(snap));
  const contentH = useTransform(y, (v) => Math.max(0, sheetH - v - SHEET_CHROME));
  // analysis dock fills the visible sheet below the 56 px timeline (+1 px tab border)
  const dockH = useTransform(contentH, (h) => Math.max(280, h - 57));
  const controls = useDragControls();

  // A new selection opens the details tab — except while comparing, where picking side A is itself a
  // selection. Subscribed (not derived during render): setTab updates another store, which React
  // forbids while rendering.
  useEffect(
    () =>
      useDashboard.subscribe((s, prev) => {
        if (!s.selectedAreaId || s.selectedAreaId === prev.selectedAreaId) return;
        if (useMobileUi.getState().tab === "analysis" && s.bottomTab === "compare") return;
        useMobileUi.getState().setTab("details");
      }),
    [],
  );

  // Store snap → animated position (spring; instant under reduced motion).
  const target = offsetFor(snap);
  useEffect(() => {
    const c = animate(y, target, reduced ? { duration: 0 } : SPRING.gentle);
    return () => c.stop();
  }, [target, reduced, y]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const projected = y.get() + info.velocity.y * 0.2;
    const order: Snap[] = ["full", "half", "collapsed"];
    let best: Snap = snap;
    let bestDist = Infinity;
    for (const s of order) {
      const d = Math.abs(offsetFor(s) - projected);
      if (d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    animate(y, offsetFor(best), reduced ? { duration: 0 } : SPRING.gentle);
    setSnap(best);
  };

  const snapLabel: Record<Snap, string> = {
    collapsed: t({ th: "ย่ออยู่", en: "collapsed" }),
    half: t({ th: "ครึ่งจอ", en: "half screen" }),
    full: t({ th: "เต็มจอ", en: "full screen" }),
  };

  return (
    <motion.section
      aria-label={t({ th: "แผงข้อมูล", en: "Data sheet" })}
      className="absolute inset-x-0 bottom-0 z-40 flex flex-col rounded-t-2xl border-t border-ui-border-strong bg-ui-surface shadow-[0_-18px_48px_-16px_rgba(0,0,0,0.7)]"
      style={{ y, height: sheetH }}
      drag="y"
      dragControls={controls}
      dragListener={false}
      dragConstraints={{ top: 0, bottom: offsetFor("collapsed") }}
      dragElastic={0.06}
      dragMomentum={false}
      onDragEnd={onDragEnd}
    >
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as MobileTab);
          if (snap === "collapsed") setSnap("half");
        }}
        className="min-h-0 flex-1 flex-col gap-0"
      >
        <div className="shrink-0 touch-none" style={{ height: SHEET_CHROME }} onPointerDown={(e) => controls.start(e)}>
          <button
            type="button"
            onClick={() => setSnap(NEXT_SNAP[snap])}
            aria-label={`${t({ th: "ปรับขนาดแผงข้อมูล", en: "Resize data sheet" })} (${snapLabel[snap]})`}
            aria-expanded={snap !== "collapsed"}
            className="flex h-6 w-full cursor-grab items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60 focus-visible:ring-inset active:cursor-grabbing"
          >
            <span aria-hidden className="h-1 w-10 rounded-full bg-ui-border-strong" />
          </button>
          <TabsList variant="line" className="w-full justify-around rounded-none border-b border-ui-border px-2 group-data-horizontal/tabs:h-12">
            {TABS.map(({ id, icon: Icon, label }) => (
              <TabsTrigger key={id} value={id} className="h-11 flex-col gap-0.5 px-1 text-[11px]">
                <span className="relative">
                  <Icon aria-hidden className="size-4" />
                  {id === "scenario" && scenarioActive && <span aria-hidden className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-status-simulated" />}
                </span>
                {t(label)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <motion.div style={{ height: contentH }} className="ui-scroll min-h-0 overflow-y-auto overscroll-contain">
          <div className="[&>[role=region]]:border-t-0">
            <Timeline />
          </div>
          <TabsContent value="details" className="min-h-[60vh] border-t border-ui-border">
            <RightPanel />
          </TabsContent>
          <TabsContent value="layers" className="border-t border-ui-border px-2 py-3">
            <LayerControl />
          </TabsContent>
          <TabsContent value="scenario" className="border-t border-ui-border">
            <ScenarioLab onClose={() => setTab("details")} />
          </TabsContent>
          <TabsContent value="analysis" className="border-t border-ui-border">
            <motion.div style={{ height: dockH }} className="min-h-0">
              <BottomDock />
            </motion.div>
          </TabsContent>
        </motion.div>
      </Tabs>
    </motion.section>
  );
}

/* ------------------------------------------------------------------ */
/*  Shell                                                              */
/* ------------------------------------------------------------------ */

/** < 768 px: compact header, KPI chip row, full-bleed stage, draggable bottom sheet. */
export function MobileShell() {
  const t = useTr();
  usePhonePanelRequests();
  useKeyboardShortcuts({
    onToggleLayers: () => {
      useMobileUi.getState().setTab("layers");
      const s = useDashboard.getState();
      s.setSheetSnap(s.sheetSnap === "collapsed" ? "half" : "collapsed");
    },
    onFocusSearch: () => {
      useMobileUi.getState().setSearchOpen(true);
      requestSearchFocus();
    },
    onOpenLab: openLabMobile,
    onOpenHelp: openShortcutsHelp,
    onFullscreen: toggleFullscreen,
    onEscape: () => {
      const ui = useMobileUi.getState();
      if (ui.searchOpen) {
        ui.setSearchOpen(false);
        return true;
      }
      return false;
    },
    isModalOpen: () => useShortcutsHelp.getState().open,
  });

  return (
    <div className="relative flex h-dvh w-full flex-col overflow-hidden bg-ui-bg">
      <a href="#stage" className="sr-only z-50 rounded-md bg-ui-cyan px-3 py-2 text-[13px] text-ui-bg focus:not-sr-only focus:absolute focus:top-2 focus:left-2">
        {t({ th: "ข้ามไปยังแผนที่", en: "Skip to the map" })}
      </a>
      <MobileHeader />
      <KPIStrip variant="chips" className="shrink-0 border-b border-ui-border/60" />
      <div className="relative min-h-0 flex-1" style={{ marginBottom: SHEET_CHROME - 14 }}>
        <Stage compact className={cn("absolute inset-0")} />
      </div>
      <BottomSheet />
    </div>
  );
}
