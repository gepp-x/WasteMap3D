"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useDashboard } from "@/store/dashboard-store";
import { CITIES } from "@/lib/data/cities";
import type { CityId } from "@/lib/types";
import { DURATION, useReducedMotionPref } from "@/lib/animation/tokens";
import { FOCUS_MAX_ZOOM, TILT_PITCH, bboxCoverage, easeInOutCubic, easeOutCubic, framePadding } from "@/lib/map/camera";
import { BASEMAP_BUILDINGS_3D, BASEMAP_BUILDINGS_FLAT } from "@/lib/map/ids";
import { setLayerVisible } from "@/lib/map/data-layers";
import type { MapEngine } from "./use-map-engine";
import type { MapModel } from "./use-map-model";

/**
 * A request can land in the same commit as a stage layout change (e.g. split → 2D on reset or
 * "locate"), before the engine's ResizeObserver has resized the canvas. Sync the size first so
 * the camera is computed for the container the user will actually see. Skipped while hidden.
 */
function syncMapSize(map: MapEngine["map"]) {
  const el = map.getContainer();
  if (el.clientWidth > 0 && el.clientHeight > 0) map.resize();
}

/** Set by the map click handler so a click-selection does not yank an already-visible area around. */
export interface ClickSelection {
  areaId: string;
}

export interface MapCameraApi {
  tilted: boolean;
  setTilt: (on: boolean) => void;
  fitCity: () => void;
  resetNorth: () => void;
  zoomBy: (delta: 1 | -1) => void;
}

/**
 * Camera choreography:
 *  - first paint frames the city bbox (set at construction), or the current selection once known;
 *  - city change → flyTo with a high curve (zooms out over the Gulf of Thailand, then in);
 *  - focusNonce with a selection → fitBounds(area bbox) with panel-aware padding and per-city maxZoom;
 *  - reduced motion → jumps instead of flights.
 */
export function useMapCamera(engine: MapEngine | null, model: MapModel, clickRef: RefObject<ClickSelection | null>): MapCameraApi {
  const cityId = model.cityId;
  const bboxes = model.base?.bboxes;
  const focusNonce = useDashboard((s) => s.focusNonce);
  const selectedAreaId = useDashboard((s) => s.selectedAreaId);
  const rightOpen = useDashboard((s) => s.rightOpen);
  const reduced = useReducedMotionPref();
  const [tilted, setTilted] = useState(false);

  // Latest values for imperative callbacks (kept out of effect deps on purpose).
  const live = useRef({ reduced, rightOpen, tilted, cityId });
  useEffect(() => {
    live.current = { reduced, rightOpen, tilted, cityId };
  }, [reduced, rightOpen, tilted, cityId]);

  const track = useRef<{ city: CityId | null; nonce: number }>({ city: null, nonce: Number.NaN });

  const padding = useCallback(
    (tight = false) => {
      const el = engine?.map.getContainer();
      return framePadding(el?.clientWidth ?? 960, el?.clientHeight ?? 640, { rightOpen: live.current.rightOpen, tight });
    },
    [engine],
  );

  /* City change → cinematic flight (or a jump under reduced motion). */
  useEffect(() => {
    if (!engine) return;
    const t = track.current;
    if (t.city === null) {
      t.city = cityId; // constructed with this city's bounds already
      return;
    }
    if (t.city === cityId) return;
    t.city = cityId;
    const map = engine.map;
    const cam = map.cameraForBounds(CITIES[cityId].bbox, { padding: padding() });
    if (!cam) return;
    const pitch = live.current.tilted ? TILT_PITCH : 0;
    map.stop();
    if (live.current.reduced) map.jumpTo({ ...cam, bearing: 0, pitch });
    else map.flyTo({ ...cam, bearing: 0, pitch, duration: DURATION.cityFlight * 1000, curve: 1.65, easing: easeInOutCubic, essential: true });
  }, [engine, cityId, padding]);

  /* Focus requests (ranking row click, map click, "focus selection" control). */
  useEffect(() => {
    if (!engine) return;
    const t = track.current;
    if (focusNonce === t.nonce) return;
    if (!selectedAreaId) {
      t.nonce = focusNonce;
      return;
    }
    const bbox = bboxes?.get(selectedAreaId);
    if (!bbox) return; // data not ready yet — re-runs when bboxes arrive
    t.nonce = focusNonce;
    const map = engine.map;
    syncMapSize(map);
    const click = clickRef.current;
    clickRef.current = null;
    if (click?.areaId === selectedAreaId) {
      const b = map.getBounds();
      const cov = bboxCoverage(bbox, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      if (cov.visible > 0.85 && cov.relativeSize > 0.015) return; // already comfortably in view
    }
    // 3D City: fly to the area's anchor at street level, keeping the oblique view
    if (useDashboard.getState().cityMode3d) {
      const anchor = model.base?.areas.byId.get(selectedAreaId)?.anchor;
      if (anchor) {
        const cam = { center: anchor, zoom: Math.max(15, map.getZoom()), pitch: Math.max(55, map.getPitch()), bearing: map.getBearing() };
        if (live.current.reduced) map.jumpTo(cam);
        else map.flyTo({ ...cam, duration: DURATION.camera * 1000, curve: 1.2, easing: easeInOutCubic, essential: true });
        return;
      }
    }
    map.fitBounds(bbox, {
      padding: padding(true),
      maxZoom: FOCUS_MAX_ZOOM[cityId],
      duration: live.current.reduced ? 0 : DURATION.camera * 1000,
      easing: easeInOutCubic,
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      essential: true,
    });
  }, [engine, focusNonce, selectedAreaId, bboxes, cityId, padding, clickRef, model.base]);

  /* Dashboard reset (Settings → Reset) → back to the flat, north-up city view. */
  const resetNonce = useDashboard((s) => s.resetNonce);
  const lastReset = useRef(resetNonce);
  useEffect(() => {
    if (!engine || lastReset.current === resetNonce) return;
    lastReset.current = resetNonce;
    const map = engine.map;
    syncMapSize(map);
    const cam = map.cameraForBounds(CITIES[live.current.cityId].bbox, { padding: padding() });
    if (!cam) return;
    map.stop();
    if (live.current.reduced) map.jumpTo({ ...cam, bearing: 0, pitch: 0 });
    else map.easeTo({ ...cam, bearing: 0, pitch: 0, duration: DURATION.camera * 1000, easing: easeInOutCubic, essential: true });
  }, [engine, resetNonce, padding]);

  /* Keep the tilt toggle honest when the user pitches with the mouse / touch. */
  useEffect(() => {
    if (!engine) return;
    const map = engine.map;
    const sub = map.on("pitchend", () => setTilted(map.getPitch() > 12));
    return () => sub.unsubscribe();
  }, [engine]);

  /* Flat footprints in 2D, extruded buildings when tilted (re-applied after basemap swaps). */
  useEffect(() => {
    if (!engine || !engine.isReady()) return;
    if (useDashboard.getState().cityMode3d) return; // City3DMode owns building visibility
    setLayerVisible(engine.map, BASEMAP_BUILDINGS_3D, tilted);
    setLayerVisible(engine.map, BASEMAP_BUILDINGS_FLAT, !tilted);
  }, [engine, tilted]);

  const setTilt = useCallback(
    (on: boolean) => {
      if (!engine) return;
      engine.map.easeTo({ pitch: on ? TILT_PITCH : 0, duration: live.current.reduced ? 0 : 900, easing: easeOutCubic, essential: true });
    },
    [engine],
  );

  const fitCity = useCallback(() => {
    if (!engine) return;
    engine.map.fitBounds(CITIES[live.current.cityId].bbox, {
      padding: padding(),
      duration: live.current.reduced ? 0 : DURATION.camera * 1000,
      easing: easeInOutCubic,
      pitch: engine.map.getPitch(),
      essential: true,
    });
  }, [engine, padding]);

  const resetNorth = useCallback(() => {
    engine?.map.resetNorthPitch({ duration: live.current.reduced ? 0 : 700, easing: easeOutCubic });
  }, [engine]);

  const zoomBy = useCallback(
    (delta: 1 | -1) => {
      if (!engine) return;
      const opts = { duration: live.current.reduced ? 0 : 280 };
      if (delta > 0) engine.map.zoomIn(opts);
      else engine.map.zoomOut(opts);
    },
    [engine],
  );

  return { tilted, setTilt, fitCity, resetNorth, zoomBy };
}
