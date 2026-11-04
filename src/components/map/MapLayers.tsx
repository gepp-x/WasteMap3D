"use client";

import { useEffect, useRef } from "react";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { useDashboard } from "@/store/dashboard-store";
import { DURATION, useReducedMotionPref } from "@/lib/animation/tokens";
import { LYR, SRC } from "@/lib/map/ids";
import { EMPTY_FC } from "@/lib/map/features";
import { COMMUNITY_LAYERS, WATERWAY_LAYERS, WATER_LEVEL_LAYERS, applyLayerOpacity, communityOpacity, setLayerVisible } from "@/lib/map/data-layers";
import { createColorTweenState, createTicker, tweenFeatureColors } from "@/lib/map/animation";
import type { MapEngine } from "./use-map-engine";
import type { MapModel } from "./use-map-model";

function setSourceData(map: MLMap, id: string, data: FeatureCollection) {
  const src = map.getSource(id) as GeoJSONSource | undefined;
  // setData resolves once the worker has re-tiled; a style swap mid-update simply aborts it.
  if (src) src.setData(data).catch(() => undefined);
}

/** Animation pacing for decorative motion (flow + hotspot pulse). */
const FX_FPS = 15;
const PULSE_PERIOD_MS = 2600;

/**
 * Renderless synchroniser: store + model → MapLibre sources, feature-state and paint.
 * Every effect re-runs on `styleEpoch`, so a basemap swap (which rebuilds the style) restores the
 * full overlay state. Nothing here calls React setState; per-frame work stays in MapLibre.
 */
export function MapLayers({ engine, model }: { engine: MapEngine; model: MapModel }) {
  const { map, styleEpoch, isReady, images } = engine;
  const layers = useDashboard((s) => s.layers);
  const activeChoropleth = useDashboard((s) => s.activeChoropleth);
  const selectedAreaId = useDashboard((s) => s.selectedAreaId);
  const hoveredAreaId = useDashboard((s) => s.hoveredAreaId);
  const effectsEnabled = useDashboard((s) => s.effectsEnabled);
  const reduced = useReducedMotionPref();

  const tweenRef = useRef(createColorTweenState());
  const emphRef = useRef<{ sel: number | null; hov: number | null }>({ sel: null, hov: null });
  const stressRef = useRef(new Map<string, number>());
  const speedRef = useRef(24);

  const { bundle, base, choropleth, rainGrid, stressByArea, cityId, scenario } = model;

  /* 1 ─ bundle sources (city data). Fresh geometry ⇒ reset feature-state & tween memory. */
  useEffect(() => {
    if (!isReady()) return;
    setSourceData(map, SRC.areas, bundle?.areasGeo ?? EMPTY_FC);
    setSourceData(map, SRC.anchors, base?.anchors ?? EMPTY_FC);
    setSourceData(map, SRC.waterways, base?.waterways?.fc ?? EMPTY_FC);
    setSourceData(map, SRC.drainage, base?.drainage?.fc ?? EMPTY_FC);
    setSourceData(map, SRC.communities, base?.communities?.fc ?? EMPTY_FC);
    setSourceData(map, SRC.municipality, bundle?.municipality ?? EMPTY_FC);
    setSourceData(map, SRC.stations, base?.stations ?? EMPTY_FC);
    setSourceData(map, SRC.hotspots, base?.hotspots?.fc ?? EMPTY_FC);
    setSourceData(map, SRC.waterLevels, base?.waterLevels?.fc ?? EMPTY_FC);
    for (const s of [SRC.areas, SRC.anchors, SRC.drainage, SRC.hotspots]) map.removeFeatureState({ source: s });
    const tween = tweenRef.current;
    tween.cancel?.();
    tween.cancel = null;
    tween.applied.clear();
    emphRef.current = { sel: null, hov: null };
    stressRef.current.clear();
  }, [map, styleEpoch, isReady, bundle, base]);

  /* 2 ─ reanalysis grid for the selected day (or mean annual). */
  useEffect(() => {
    if (!isReady()) return;
    setSourceData(map, SRC.rainGrid, rainGrid?.fc ?? EMPTY_FC);
  }, [map, styleEpoch, isReady, rainGrid]);

  /* 3 ─ choropleth colours via feature-state, tweened so scenario/timeline updates glide. */
  useEffect(() => {
    if (!isReady()) return;
    setLayerVisible(map, LYR.areasFill, !!choropleth);
    setLayerVisible(map, LYR.areasNoData, !!choropleth);
    if (!choropleth) return;
    const tween = tweenRef.current;
    const fresh = tween.applied.size === 0;
    tweenFeatureColors(map, SRC.areas, choropleth.colorByFid, tween, fresh || reduced ? 0 : DURATION.scenario * 1000, isReady);
  }, [map, styleEpoch, isReady, choropleth, reduced, base]);

  useEffect(() => {
    const tween = tweenRef.current;
    return () => tween.cancel?.();
  }, []);

  /* 4 ─ layer visibility + opacity from the layer control. */
  useEffect(() => {
    if (!isReady()) return;
    applyLayerOpacity(map, LYR.areasFill, activeChoropleth ? layers[activeChoropleth].opacity : 0.78);
    setLayerVisible(map, LYR.rainHeat, layers.rainEstimated.visible && !!rainGrid?.points);
    applyLayerOpacity(map, LYR.rainHeat, Math.min(1, layers.rainEstimated.opacity + 0.15));
    setLayerVisible(map, LYR.stations, layers.rainObserved.visible);
    applyLayerOpacity(map, LYR.stations, layers.rainObserved.opacity);
    for (const id of WATERWAY_LAYERS) {
      setLayerVisible(map, id, layers.waterways.visible);
      applyLayerOpacity(map, id, layers.waterways.opacity);
    }
    setLayerVisible(map, LYR.hotspotCore, layers.hotspots.visible);
    setLayerVisible(map, LYR.hotspotRing, layers.hotspots.visible);
    applyLayerOpacity(map, LYR.hotspotCore, layers.hotspots.opacity);
    const gauges = layers.waterLevel.visible && !!base?.waterLevels?.total;
    for (const id of WATER_LEVEL_LAYERS) {
      setLayerVisible(map, id, gauges);
      applyLayerOpacity(map, id, layers.waterLevel.opacity);
    }
    for (const id of COMMUNITY_LAYERS) setLayerVisible(map, id, layers.communities.visible && !!base?.communities);
  }, [map, styleEpoch, isReady, layers, activeChoropleth, rainGrid, base]);

  /* 4b ─ community markers: layer opacity + recede communities outside the selected zone. */
  const communityOp = layers.communities.opacity;
  useEffect(() => {
    if (!isReady() || !base?.communities) return;
    const zone = selectedAreaId && base.communities.byZone.has(selectedAreaId) ? selectedAreaId : null;
    const paint = communityOpacity(communityOp, zone);
    for (const id of [LYR.communitiesVerified, LYR.communitiesIllustrative]) if (map.getLayer(id)) map.setPaintProperty(id, "icon-opacity", paint);
    if (map.getLayer(LYR.communitiesLine)) map.setPaintProperty(LYR.communitiesLine, "line-opacity", 0.8 * communityOp);
  }, [map, styleEpoch, isReady, base, selectedAreaId, communityOp]);

  /* 5 ─ selection + hover (store-driven, so ranking hover highlights here too). */
  useEffect(() => {
    if (!isReady()) return;
    const byId = base?.areas.byId;
    const sel = selectedAreaId ? (byId?.get(selectedAreaId)?.fid ?? null) : null;
    const hov = hoveredAreaId ? (byId?.get(hoveredAreaId)?.fid ?? null) : null;
    const prev = emphRef.current;
    const touched = new Set([prev.sel, prev.hov, sel, hov].filter((x): x is number => x !== null));
    for (const fid of touched) {
      map.setFeatureState({ source: SRC.areas, id: fid }, { selected: fid === sel, hover: fid === hov });
      map.setFeatureState({ source: SRC.anchors, id: fid }, { emph: fid === sel || fid === hov });
    }
    emphRef.current = { sel, hov };
    if (map.getLayer(LYR.areasDim)) map.setPaintProperty(LYR.areasDim, "fill-opacity", sel !== null ? 0.3 : 0);
  }, [map, styleEpoch, isReady, selectedAreaId, hoveredAreaId, base]);

  /* 6 ─ drainage assets inherit their area's modelled drainage stress (live with the scenario). */
  useEffect(() => {
    if (!isReady() || !base?.drainage) return;
    const applied = stressRef.current;
    for (const [areaId, idxs] of base.drainage.byArea) {
      const cls = areaId ? (stressByArea.get(areaId) ?? -1) : -1;
      if (applied.get(areaId) === cls) continue;
      applied.set(areaId, cls);
      for (const i of idxs) if (base.drainage.items[i].geom === "point") map.setFeatureState({ source: SRC.drainage, id: i }, { s: cls });
    }
  }, [map, styleEpoch, isReady, base, stressByArea]);

  /* 7 ─ district labels appear at a city-appropriate zoom. */
  useEffect(() => {
    if (!isReady() || !map.getLayer(LYR.areaLabels)) return;
    map.setLayerZoomRange(LYR.areaLabels, cityId === "hatyai" ? 12.3 : 10.6, 24);
  }, [map, styleEpoch, isReady, cityId]);

  /* 8 ─ decorative motion: water flow + hotspot pulse at ≤15 fps; static under reduced motion / effects off. */
  useEffect(() => {
    speedRef.current = 22 + Math.min(46, scenario.visualIntensityMmH * 0.9);
  }, [scenario.visualIntensityMmH]);

  const flowOn = layers.waterways.visible && effectsEnabled && !reduced && !!base?.waterways?.lineCount;
  const pulseOn = layers.hotspots.visible && effectsEnabled && !reduced && !!base?.hotspots?.pulsing.length;
  const hotOpacity = layers.hotspots.opacity;

  useEffect(() => {
    if (!isReady()) return;
    const hot = base?.hotspots;
    const flow = images()?.flow;
    for (const fid of hot?.pulsing ?? []) map.setFeatureState({ source: SRC.hotspots, id: fid }, { k: 1.35, o: 0.55 * hotOpacity });
    if (!flowOn && !pulseOn) {
      flow?.reset();
      map.triggerRepaint();
      return;
    }
    const canvas = map.getCanvas();
    const stop = createTicker(FX_FPS, (now, dt) => {
      if (!isReady() || canvas.clientWidth === 0) return;
      if (flowOn && flow) flow.advance(((speedRef.current * dt) / 1000) * 2);
      if (pulseOn && hot) {
        const phase = (now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
        const state = { k: 1 + phase * 1.15, o: (1 - phase) * 0.95 * hotOpacity };
        for (const fid of hot.pulsing) map.setFeatureState({ source: SRC.hotspots, id: fid }, state);
      }
      map.triggerRepaint();
    });
    return stop;
  }, [map, styleEpoch, isReady, images, base, flowOn, pulseOn, hotOpacity]);

  return null;
}
