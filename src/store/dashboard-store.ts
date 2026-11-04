"use client";

import { create } from "zustand";
import type { CityId } from "@/lib/types";
import { BASELINE_SCENARIO, SCENARIO_PRESETS, type PresetId, type ScenarioParams } from "@/lib/simulation/model";

export type ViewMode = "2d" | "3d" | "split";
export type Lang = "th" | "en";
export type QualityMode = "auto" | "high" | "balanced" | "low";
export type TimelineMode = "historical" | "scenario";

/** Map layers (spec §6). Ids are stable and shared by map, 3D and legend. */
export type LayerId =
  | "wasteVolume"
  | "wastePerCapita"
  | "rainObserved"
  | "rainEstimated"
  | "waterways"
  | "floodRisk"
  | "hotspots"
  | "populationDensity"
  | "waterLevel"
  | "communities";

/** Choropleth layers are mutually exclusive; overlays can stack. */
export const CHOROPLETH_LAYERS: LayerId[] = ["wasteVolume", "wastePerCapita", "floodRisk", "populationDensity", "rainEstimated"];

export interface LayerState {
  visible: boolean;
  opacity: number;
}

export type ThreeScope = "city" | "neighborhood";
export type CameraPreset = "overview" | "isometric" | "topdown" | "focus";

export interface DashboardState {
  // ---- context
  cityId: CityId;
  lang: Lang;
  viewMode: ViewMode;

  // ---- selection (shared between 2D map, 3D scene, panels, charts)
  selectedAreaId: string | null;
  hoveredAreaId: string | null;
  compareAreaId: string | null;
  /** Incremented to ask map/3D to re-focus the current selection (e.g. ranking row click). */
  focusNonce: number;

  // ---- layers
  layers: Record<LayerId, LayerState>;
  /** Active choropleth (one of CHOROPLETH_LAYERS) or null for none. */
  activeChoropleth: LayerId | null;

  // ---- 3D
  threeScope: ThreeScope;
  cameraPreset: CameraPreset;
  cameraNonce: number;
  /** Incremented by resetAll() so the 2D map / 3D camera return to their home view. */
  resetNonce: number;
  quality: QualityMode;
  /** Resolved tier after auto-detection / performance monitor. */
  qualityTier: "high" | "balanced" | "low";
  webglSupported: boolean | null;

  // ---- scenario lab
  scenarioActive: boolean;
  scenario: ScenarioParams;
  presetId: PresetId | "custom";
  compareBaseline: boolean;
  scenarioNonce: number;

  // ---- timeline
  timelineMode: TimelineMode;
  /** Index into the city's daily rainfall series (historical mode). */
  dateIndex: number | null;
  /** Index into the simulated hyetograph (scenario mode). */
  scenarioStep: number;
  playing: boolean;
  playbackSpeed: 0.5 | 1 | 2 | 4;

  // ---- preferences
  reducedMotion: boolean;
  effectsEnabled: boolean;

  // ---- UI chrome
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  labOpen: boolean;
  sourcesOpen: boolean;
  settingsOpen: boolean;
  insightsOpen: boolean;
  detailTab: "overview" | "waste" | "rain" | "flood" | "data";
  bottomTab: "ranking" | "rainfall" | "drainage" | "compare";
  /** Mobile bottom-sheet snap: collapsed | half | full */
  sheetSnap: "collapsed" | "half" | "full";
  /** Desktop column widths (px), user-resizable. */
  leftWidth: number;
  rightWidth: number;
  /** "3D City" mode: the MapLibre map tilted into a continuous city of extruded OSM buildings. */
  cityMode3d: boolean;
  /** Guided storytelling tour (interruptible; never blocks normal use). */
  storyActive: boolean;
  storyStep: number;
}

export interface DashboardActions {
  setCity: (id: CityId) => void;
  setLang: (l: Lang) => void;
  setViewMode: (m: ViewMode) => void;
  selectArea: (id: string | null, opts?: { focus?: boolean; openDetails?: boolean }) => void;
  hoverArea: (id: string | null) => void;
  setCompareArea: (id: string | null) => void;
  requestFocus: () => void;
  setLayerVisible: (id: LayerId, visible: boolean) => void;
  setLayerOpacity: (id: LayerId, opacity: number) => void;
  setActiveChoropleth: (id: LayerId | null) => void;
  setThreeScope: (s: ThreeScope) => void;
  setCameraPreset: (p: CameraPreset) => void;
  setQuality: (q: QualityMode) => void;
  setQualityTier: (t: DashboardState["qualityTier"]) => void;
  setWebglSupported: (v: boolean) => void;
  setScenarioActive: (v: boolean) => void;
  applyPreset: (id: PresetId) => void;
  setScenarioParam: <K extends keyof ScenarioParams>(k: K, v: ScenarioParams[K]) => void;
  resetScenario: () => void;
  setCompareBaseline: (v: boolean) => void;
  setTimelineMode: (m: TimelineMode) => void;
  setDateIndex: (i: number | null) => void;
  setScenarioStep: (i: number) => void;
  setPlaying: (v: boolean) => void;
  setPlaybackSpeed: (s: DashboardState["playbackSpeed"]) => void;
  setReducedMotion: (v: boolean) => void;
  setEffectsEnabled: (v: boolean) => void;
  setPanel: (p: "leftOpen" | "rightOpen" | "bottomOpen" | "labOpen" | "sourcesOpen" | "settingsOpen" | "insightsOpen", v: boolean) => void;
  setDetailTab: (t: DashboardState["detailTab"]) => void;
  setBottomTab: (t: DashboardState["bottomTab"]) => void;
  setSheetSnap: (s: DashboardState["sheetSnap"]) => void;
  setColumnWidth: (side: "left" | "right", px: number) => void;
  setCityMode3d: (v: boolean) => void;
  startStory: () => void;
  setStoryStep: (i: number) => void;
  stopStory: () => void;
  resetAll: () => void;
}

const defaultLayers = (): Record<LayerId, LayerState> => ({
  wasteVolume: { visible: true, opacity: 0.78 },
  wastePerCapita: { visible: false, opacity: 0.78 },
  rainObserved: { visible: false, opacity: 1 },
  rainEstimated: { visible: false, opacity: 0.55 },
  waterways: { visible: true, opacity: 0.9 },
  floodRisk: { visible: false, opacity: 0.78 },
  hotspots: { visible: false, opacity: 1 },
  populationDensity: { visible: false, opacity: 0.78 },
  waterLevel: { visible: false, opacity: 1 },
  communities: { visible: true, opacity: 1 },
});

const initialState: DashboardState = {
  cityId: "bangkok",
  lang: "th",
  viewMode: "2d",
  selectedAreaId: null,
  hoveredAreaId: null,
  compareAreaId: null,
  focusNonce: 0,
  layers: defaultLayers(),
  activeChoropleth: "wasteVolume",
  threeScope: "city",
  cameraPreset: "overview",
  cameraNonce: 0,
  resetNonce: 0,
  quality: "auto",
  qualityTier: "balanced",
  webglSupported: null,
  scenarioActive: false,
  scenario: { ...BASELINE_SCENARIO },
  presetId: "normal",
  compareBaseline: true,
  scenarioNonce: 0,
  timelineMode: "historical",
  dateIndex: null,
  scenarioStep: 0,
  playing: false,
  playbackSpeed: 1,
  reducedMotion: false,
  effectsEnabled: true,
  leftOpen: true,
  rightOpen: true,
  bottomOpen: true,
  labOpen: false,
  sourcesOpen: false,
  settingsOpen: false,
  insightsOpen: false,
  detailTab: "overview",
  bottomTab: "ranking",
  sheetSnap: "collapsed",
  cityMode3d: false,
  leftWidth: 296,
  rightWidth: 384,
  storyActive: false,
  storyStep: 0,
};

export const useDashboard = create<DashboardState & DashboardActions>()((set, get) => ({
  ...initialState,

  setCity: (id) => {
    if (get().cityId === id) return;
    set({
      cityId: id,
      selectedAreaId: null,
      hoveredAreaId: null,
      compareAreaId: null,
      threeScope: "city",
      cameraPreset: "overview",
      cameraNonce: get().cameraNonce + 1,
      dateIndex: null,
      scenarioStep: 0,
      playing: false,
      // a scenario is calibrated to one city's inputs: switching city returns to the baseline
      scenarioActive: false,
      scenario: { ...BASELINE_SCENARIO },
      presetId: "normal",
      timelineMode: "historical",
      scenarioNonce: get().scenarioNonce + 1,
      storyActive: false,
      storyStep: 0,
    });
  },
  setLang: (lang) => set({ lang }),
  // the 3D City lives on the 2D map stage; any other view mode leaves it
  setViewMode: (viewMode) => set(viewMode === "2d" ? { viewMode } : { viewMode, cityMode3d: false }),
  selectArea: (id, opts) => {
    const s = get();
    set({
      selectedAreaId: id,
      focusNonce: opts?.focus === false ? s.focusNonce : s.focusNonce + 1,
      rightOpen: opts?.openDetails === false ? s.rightOpen : id ? true : s.rightOpen,
      sheetSnap: id && s.sheetSnap === "collapsed" ? "half" : s.sheetSnap,
      threeScope: id ? s.threeScope : "city",
    });
  },
  hoverArea: (hoveredAreaId) => {
    if (get().hoveredAreaId !== hoveredAreaId) set({ hoveredAreaId });
  },
  setCompareArea: (compareAreaId) => set({ compareAreaId }),
  requestFocus: () => set({ focusNonce: get().focusNonce + 1 }),
  setLayerVisible: (id, visible) =>
    set((s) => {
      const layers = { ...s.layers, [id]: { ...s.layers[id], visible } };
      let activeChoropleth = s.activeChoropleth;
      if (CHOROPLETH_LAYERS.includes(id)) {
        if (visible) {
          for (const c of CHOROPLETH_LAYERS) if (c !== id) layers[c] = { ...layers[c], visible: false };
          activeChoropleth = id;
        } else if (activeChoropleth === id) {
          activeChoropleth = null;
        }
      }
      return { layers, activeChoropleth };
    }),
  setLayerOpacity: (id, opacity) => set((s) => ({ layers: { ...s.layers, [id]: { ...s.layers[id], opacity } } })),
  setActiveChoropleth: (id) => {
    if (id === null) {
      const layers = { ...get().layers };
      for (const c of CHOROPLETH_LAYERS) layers[c] = { ...layers[c], visible: false };
      set({ activeChoropleth: null, layers });
    } else get().setLayerVisible(id, true);
  },
  setThreeScope: (threeScope) => set({ threeScope }),
  setCameraPreset: (cameraPreset) => set({ cameraPreset, cameraNonce: get().cameraNonce + 1 }),
  setQuality: (quality) => set({ quality }),
  setQualityTier: (qualityTier) => {
    if (get().qualityTier !== qualityTier) set({ qualityTier });
  },
  setWebglSupported: (webglSupported) => set({ webglSupported }),
  setScenarioActive: (scenarioActive) =>
    set({ scenarioActive, timelineMode: scenarioActive ? "scenario" : "historical", scenarioStep: 0, playing: false, scenarioNonce: get().scenarioNonce + 1 }),
  applyPreset: (id) =>
    set({
      presetId: id,
      scenario: { ...SCENARIO_PRESETS[id].params },
      scenarioActive: true,
      timelineMode: "scenario",
      scenarioStep: 0,
      scenarioNonce: get().scenarioNonce + 1,
    }),
  setScenarioParam: (k, v) =>
    set((s) => ({ scenario: { ...s.scenario, [k]: v }, presetId: "custom", scenarioActive: true, scenarioNonce: s.scenarioNonce + 1 })),
  resetScenario: () =>
    set({
      scenario: { ...BASELINE_SCENARIO },
      presetId: "normal",
      scenarioActive: false,
      timelineMode: "historical",
      scenarioStep: 0,
      playing: false,
      scenarioNonce: get().scenarioNonce + 1,
    }),
  setCompareBaseline: (compareBaseline) => set({ compareBaseline }),
  setTimelineMode: (timelineMode) => set({ timelineMode, playing: false }),
  setDateIndex: (dateIndex) => set({ dateIndex }),
  setScenarioStep: (scenarioStep) => set({ scenarioStep }),
  setPlaying: (playing) => set({ playing }),
  setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
  setEffectsEnabled: (effectsEnabled) => set({ effectsEnabled }),
  setPanel: (p, v) => set({ [p]: v } as Partial<DashboardState>),
  setDetailTab: (detailTab) => set({ detailTab }),
  setBottomTab: (bottomTab) => set({ bottomTab }),
  setSheetSnap: (sheetSnap) => set({ sheetSnap }),
  setCityMode3d: (cityMode3d) => set(cityMode3d ? { cityMode3d, viewMode: "2d" } : { cityMode3d }),
  setColumnWidth: (side, px) =>
    side === "left" ? set({ leftWidth: Math.round(Math.min(420, Math.max(256, px))) }) : set({ rightWidth: Math.round(Math.min(560, Math.max(320, px))) }),
  startStory: () => set({ storyActive: true, storyStep: 0, playing: false }),
  setStoryStep: (storyStep) => set({ storyStep }),
  stopStory: () => set({ storyActive: false, storyStep: 0 }),
  resetAll: () => {
    const s = get();
    set({
      ...initialState,
      cityId: s.cityId,
      lang: s.lang,
      layers: defaultLayers(),
      // detected capabilities are not preferences: keep them (QualityManager re-derives the tier when `quality` changes)
      webglSupported: s.webglSupported,
      qualityTier: s.qualityTier,
      // panel layout is owned by the shell, which re-applies its breakpoint defaults after a reset
      leftOpen: s.leftOpen,
      rightOpen: s.rightOpen,
      bottomOpen: s.bottomOpen,
      // nonces stay monotonic so engines never mistake a reset for a missed request
      focusNonce: s.focusNonce,
      cameraNonce: s.cameraNonce + 1,
      scenarioNonce: s.scenarioNonce + 1,
      resetNonce: s.resetNonce + 1,
    });
  },
}));
