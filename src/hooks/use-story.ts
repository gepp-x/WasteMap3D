"use client";

import { useMemo } from "react";
import { create } from "zustand";
import { useCityBundle } from "@/lib/data/loader";
import { buildStory, type StoryStep, type StoryView } from "@/lib/story/build-story";
import { useDashboard, type DashboardState } from "@/store/dashboard-store";
import { BREAKPOINTS } from "@/hooks/use-media-query";

/**
 * Guided story controller.
 *
 * The tour is a thin layer over the dashboard store: each step's `view` is applied through the
 * store's own actions (selectArea, setViewMode, applyPreset, …), so every engine — map, 3D twin,
 * KPIs, charts — reacts exactly as it would to a user. Nothing here touches data.
 *
 * `storyActive` / `storyStep` live in the dashboard store (switching city or resetting the
 * dashboard ends the tour). Shell-local UI state — auto-advance and the view to restore on exit —
 * lives in the small store below.
 */

/** Store fields the tour may change, captured on start and restored on exit. */
const SNAPSHOT_KEYS = [
  "cityId",
  "viewMode",
  "threeScope",
  "cameraPreset",
  "selectedAreaId",
  "compareAreaId",
  "layers",
  "activeChoropleth",
  "scenarioActive",
  "scenario",
  "presetId",
  "timelineMode",
  "dateIndex",
  "scenarioStep",
  "rightOpen",
  "bottomOpen",
  "bottomTab",
  "detailTab",
  "sheetSnap",
] as const satisfies readonly (keyof DashboardState)[];

export type ViewSnapshot = Pick<DashboardState, (typeof SNAPSHOT_KEYS)[number]>;

export function captureView(s: DashboardState): ViewSnapshot {
  const out = {} as Record<string, unknown>;
  for (const k of SNAPSHOT_KEYS) out[k] = s[k];
  return out as ViewSnapshot;
}

interface StoryUi {
  /** Auto-advance (default off: the tour is manual until the viewer presses play). */
  autoPlay: boolean;
  /** True when auto-advance was paused by the viewer interacting with the dashboard. */
  pausedByUser: boolean;
  /** View captured when the tour started (null when no tour is running). */
  snapshot: ViewSnapshot | null;
  /** Element focused before the tour started (focus returns there on exit). */
  returnFocus: HTMLElement | null;
}

export const useStoryUi = create<StoryUi>()(() => ({ autoPlay: false, pausedByUser: false, snapshot: null, returnFocus: null }));

export function setStoryAutoPlay(v: boolean) {
  useStoryUi.setState({ autoPlay: v, pausedByUser: false });
}

/** Pause auto-advance because the viewer started exploring on their own (keeps the tour open). */
export function pauseStoryForInteraction() {
  if (useStoryUi.getState().autoPlay) useStoryUi.setState({ autoPlay: false, pausedByUser: true });
}

const isPhone = () => typeof window !== "undefined" && window.matchMedia(`(max-width: ${BREAKPOINTS.tablet - 0.02}px)`).matches;

/** Steps for the current city (rebuilt only when its data or WebGL support changes). */
export function useStorySteps(): { steps: StoryStep[]; ready: boolean } {
  const { bundle } = useCityBundle();
  const webgl = useDashboard((s) => s.webglSupported);
  return useMemo(() => {
    if (!bundle) return { steps: [], ready: false };
    const steps = buildStory(
      {
        dataset: bundle.dataset,
        floodEvents: bundle.floodEvents,
        rainAreas: bundle.rainAreas,
        waterLevels: bundle.waterLevels,
        rainHourly: bundle.rainHourly,
      },
      { webgl },
    );
    return { steps, ready: steps.length > 0 };
  }, [bundle, webgl]);
}

/** Start the tour from step 1, remembering the current view so Exit can restore it. */
export function startGuidedStory() {
  const s = useDashboard.getState();
  if (s.storyActive) return;
  // the tour drives the stage: close modal surfaces so it is visible straight away
  s.setPanel("insightsOpen", false);
  s.setPanel("sourcesOpen", false);
  s.setPanel("settingsOpen", false);
  const active = typeof document !== "undefined" ? document.activeElement : null;
  useStoryUi.setState({
    snapshot: captureView(s),
    autoPlay: false,
    pausedByUser: false,
    returnFocus: active instanceof HTMLElement && active !== document.body ? active : null,
  });
  s.startStory();
}

/** Restore a captured view in one store update (nonces bumped so map / 3D / scenario transitions replay). */
export function restoreView(snap: ViewSnapshot) {
  const s = useDashboard.getState();
  if (snap.cityId !== s.cityId) return; // the city changed mid-tour: its own reset already applies
  const { cityId: _city, ...rest } = snap;
  void _city;
  useDashboard.setState({
    ...rest,
    playing: false,
    scenarioNonce: s.scenarioNonce + 1,
    cameraNonce: s.cameraNonce + 1,
    focusNonce: snap.selectedAreaId ? s.focusNonce + 1 : s.focusNonce,
    resetNonce: snap.selectedAreaId ? s.resetNonce : s.resetNonce + 1,
  });
}

/** End the tour. `restore` (default) puts back the view the viewer had before starting. */
export function exitGuidedStory({ restore = true }: { restore?: boolean } = {}) {
  const ui = useStoryUi.getState();
  const s = useDashboard.getState();
  useStoryUi.setState({ snapshot: null, autoPlay: false, pausedByUser: false, returnFocus: null });
  if (s.storyActive) s.stopStory();
  if (restore && ui.snapshot) restoreView(ui.snapshot);
  const el = ui.returnFocus;
  if (el && el.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
}

/** Tour ended elsewhere (city switch, dashboard reset): forget the snapshot without restoring. */
export function discardStorySnapshot() {
  if (useStoryUi.getState().snapshot) useStoryUi.setState({ snapshot: null, autoPlay: false, pausedByUser: false, returnFocus: null });
}

export function goToStoryStep(i: number, total: number) {
  if (total <= 0) return;
  useDashboard.getState().setStoryStep(Math.min(total - 1, Math.max(0, i)));
}

/**
 * Apply one step to the store. Order matters: scenario before layers (the risk choropleth reflects
 * it), selection before 3D scope (clearing a selection resets the scope to "city").
 */
export function applyStoryView(view: StoryView) {
  const phone = isPhone();
  const s = useDashboard.getState();
  if (s.playing) s.setPlaying(false);

  // scenario / timeline
  if (view.scenario === "baseline") {
    if (s.scenarioActive || s.presetId !== "normal" || s.timelineMode !== "historical") useDashboard.getState().resetScenario();
    if (useDashboard.getState().dateIndex !== view.dateIndex) useDashboard.getState().setDateIndex(view.dateIndex);
  } else {
    const cur = useDashboard.getState();
    if (!(cur.scenarioActive && cur.presetId === view.scenario && cur.timelineMode === "scenario")) cur.applyPreset(view.scenario);
    if (useDashboard.getState().scenarioStep !== 0) useDashboard.getState().setScenarioStep(0);
  }

  // layers
  const st = useDashboard.getState();
  if (st.activeChoropleth !== view.choropleth) st.setActiveChoropleth(view.choropleth);
  for (const id of view.overlays) if (!useDashboard.getState().layers[id].visible) useDashboard.getState().setLayerVisible(id, true);

  // selection + camera
  if (view.areaId) {
    useDashboard.getState().selectArea(view.areaId, { focus: true, openDetails: !phone });
  } else {
    const cur = useDashboard.getState();
    if (cur.selectedAreaId) cur.selectArea(null);
    // fly the 2D map back to the whole city (same request a dashboard reset uses)
    useDashboard.setState({ resetNonce: useDashboard.getState().resetNonce + 1 });
  }

  // view mode: phones show one pane at a time, so a split step becomes the 3D pane
  const mode = phone && view.viewMode === "split" ? "3d" : view.viewMode;
  const cur = useDashboard.getState();
  if (cur.viewMode !== mode) cur.setViewMode(mode);
  if (view.areaId && cur.threeScope !== view.threeScope) useDashboard.getState().setThreeScope(view.threeScope);
  if (mode !== "2d") useDashboard.getState().setCameraPreset(view.cameraPreset);

  // dock / sheet
  if (phone) {
    // keep the stage visible under the story card
    if (useDashboard.getState().sheetSnap !== "collapsed") useDashboard.getState().setSheetSnap("collapsed");
  } else if (view.dockTab) {
    useDashboard.getState().setBottomTab(view.dockTab);
    useDashboard.getState().setPanel("bottomOpen", true);
  }
}
