"use client";

import { create } from "zustand";
import type { Bi } from "@/lib/i18n";
import type { CameraPreset, ThreeScope } from "@/store/dashboard-store";

/**
 * Small store shared between the R3F scene (inside <Canvas>) and the HTML overlay (outside it).
 * Only edge-triggered updates land here (scope swap, data ready, flood shown/hidden) — never
 * per-frame values.
 */

export interface BuildingStats {
  areaId: string;
  total: number;
  shown: number;
  tagged: number;
  levels: number;
  estimated: number;
  halfSizeM: number;
  /** Water features in the window (drives continuous rendering for the flow shader). */
  waterCount: number;
}

interface ThreeUiState {
  /** Scope currently rendered (lags store.threeScope during the camera transition). */
  displayScope: ThreeScope;
  transitioning: boolean;
  floodVisible: boolean;
  buildingStats: BuildingStats | null;
  notice: { text: Bi; nonce: number } | null;
  /** Preset to land on after the next scope transition (e.g. Reset → city overview). */
  landing: CameraPreset | null;
  setDisplayScope: (s: ThreeScope) => void;
  setTransitioning: (v: boolean) => void;
  setFloodVisible: (v: boolean) => void;
  setBuildingStats: (b: BuildingStats | null) => void;
  showNotice: (text: Bi) => void;
  clearNotice: () => void;
  setLanding: (p: CameraPreset | null) => void;
  reset: () => void;
}

export const useThreeUi = create<ThreeUiState>()((set, get) => ({
  displayScope: "city",
  transitioning: false,
  floodVisible: false,
  buildingStats: null,
  notice: null,
  landing: null,
  setDisplayScope: (displayScope) => {
    if (get().displayScope !== displayScope) set({ displayScope });
  },
  setTransitioning: (transitioning) => {
    if (get().transitioning !== transitioning) set({ transitioning });
  },
  setFloodVisible: (floodVisible) => {
    if (get().floodVisible !== floodVisible) set({ floodVisible });
  },
  setBuildingStats: (buildingStats) => set({ buildingStats }),
  showNotice: (text) => set({ notice: { text, nonce: (get().notice?.nonce ?? 0) + 1 } }),
  clearNotice: () => set({ notice: null }),
  setLanding: (landing) => set({ landing }),
  reset: () => set({ displayScope: "city", transitioning: false, floodVisible: false, buildingStats: null, notice: null, landing: null }),
}));
