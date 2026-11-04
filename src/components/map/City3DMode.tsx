"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Building2, CloudRain, Waves, ZoomIn } from "lucide-react";
import type { ExpressionSpecification } from "maplibre-gl";
import { useDashboard } from "@/store/dashboard-store";
import { useTr, COMMON } from "@/lib/i18n";
import { CITIES } from "@/lib/data/cities";
import { DURATION, useReducedMotionPref } from "@/lib/animation/tokens";
import { BASEMAP_BUILDINGS_3D, BASEMAP_BUILDINGS_FLAT, BASEMAP_SOURCE, SRC, ANCHOR } from "@/lib/map/ids";
import { setLayerVisible } from "@/lib/map/data-layers";
import { easeInOutCubic } from "@/lib/map/camera";
import { CITY3D_FLOOD_LAYER_ID, CITY3D_LAYER_ID, EDGE_MIN_ZOOM, createCity3DLayer, type City3DLayerHandle } from "@/lib/map/city3d";
import type { MapEngine } from "./use-map-engine";
import type { MapModel } from "./use-map-model";

export const CITY3D_PITCH = 62;
const CITY3D_BEARING = -24;
const CITY3D_ZOOM = 15.3;

/** Massing palette: low-rise slate → mid-rise steel blue → towers catch a cool cyan rim. */
const HEIGHT_COLOR: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["coalesce", ["get", "render_height"], 6],
  0, "#0f2236",
  12, "#14304b",
  40, "#1b4466",
  90, "#22618a",
  180, "#2b86ad",
];

/** Visual-only flood sheet height (m) from a modelled risk score — a metaphor, never a depth forecast. */
export function floodVisualHeight(score: number | null): number {
  if (score === null || score < 50) return 0;
  return Math.round((0.4 + ((Math.min(100, score) - 50) / 50) * 2.2) * 100) / 100;
}

const S = {
  title: { th: "เมือง 3 มิติ", en: "3D City" },
  credit: {
    th: "อาคาร ถนน คลอง: © OpenStreetMap contributors · OpenMapTiles · ความสูงจากแท็ก OSM หรือค่าประมาณ",
    en: "Buildings, roads, canals: © OpenStreetMap contributors · OpenMapTiles · heights OSM-tagged or estimated",
  },
  zoomIn: { th: "ซูมเข้า (ระดับ 14+) เพื่อดูเส้นโครงอาคาร", en: "Zoom in (level 14+) to see building outlines" },
  offline: {
    th: "โหมดเมือง 3 มิติต้องใช้แผนที่ฐานออนไลน์ — ใช้มุมมอง 3 มิติ (แบบจำลอง) แทนได้",
    en: "3D City needs the online basemap — use the 3D twin view instead",
  },
  rain: { th: "ฝนจำลองตามสถานการณ์", en: "Scenario rainfall" },
};

/**
 * Renderless controller + HUD for the 3D City mode. Owns: building massing style, the Three.js edge/rain
 * custom layer, the illustrative flood sheet (fill-extrusion of area polygons driven by feature-state) and
 * the enter/exit camera moves. Camera focus on selection inside the mode is handled by use-map-camera.
 */
export function City3DMode({ engine, model }: { engine: MapEngine; model: MapModel }) {
  const t = useTr();
  const active = useDashboard((s) => s.cityMode3d);
  const selectedAreaId = useDashboard((s) => s.selectedAreaId);
  const effectsEnabled = useDashboard((s) => s.effectsEnabled);
  const reduced = useReducedMotionPref();
  const handleRef = useRef<City3DLayerHandle | null>(null);
  const [zoomOk, setZoomOk] = useState(true);
  const online = engine.basemap === "online";
  const on = active && online;

  // Install / remove the layers (re-run after every basemap style swap via styleEpoch).
  useEffect(() => {
    const map = engine.map;
    if (!on || !engine.isReady()) return;
    const handle = createCity3DLayer(map, engine.ml);
    handleRef.current = handle;
    const before = map.getLayer(ANCHOR.overlay) ? ANCHOR.overlay : undefined;
    if (!map.getLayer(CITY3D_FLOOD_LAYER_ID) && map.getSource(SRC.areas)) {
      map.addLayer(
        {
          id: CITY3D_FLOOD_LAYER_ID,
          type: "fill-extrusion",
          source: SRC.areas,
          paint: {
            "fill-extrusion-color": "#25d9f2",
            "fill-extrusion-opacity": 0.26,
            "fill-extrusion-height": ["coalesce", ["feature-state", "flood"], 0],
            "fill-extrusion-base": 0,
          },
        },
        before,
      );
    }
    map.addLayer(handle.layer, before);

    // Massing style for the mode (restored on exit).
    const prev = {
      color: map.getPaintProperty(BASEMAP_BUILDINGS_3D, "fill-extrusion-color"),
      opacity: map.getPaintProperty(BASEMAP_BUILDINGS_3D, "fill-extrusion-opacity"),
    };
    map.setPaintProperty(BASEMAP_BUILDINGS_3D, "fill-extrusion-color", HEIGHT_COLOR);
    map.setPaintProperty(BASEMAP_BUILDINGS_3D, "fill-extrusion-opacity", 0.9);
    setLayerVisible(map, BASEMAP_BUILDINGS_3D, true);
    setLayerVisible(map, BASEMAP_BUILDINGS_FLAT, false);

    // Rebuild after camera moves and when new basemap tiles finish loading — never on "idle"
    // (a rebuild repaints, which would fire idle again and loop).
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setZoomOk(map.getZoom() >= EDGE_MIN_ZOOM);
        handle.rebuild();
      }, 250);
    };
    const onData = (e: { sourceId?: string; isSourceLoaded?: boolean }) => {
      if (e.sourceId === BASEMAP_SOURCE && e.isSourceLoaded) schedule();
    };
    map.on("moveend", schedule);
    map.on("sourcedata", onData);
    schedule();

    return () => {
      window.clearTimeout(timer);
      map.off("moveend", schedule);
      map.off("sourcedata", onData);
      if (map.getLayer(CITY3D_LAYER_ID)) map.removeLayer(CITY3D_LAYER_ID);
      if (map.getLayer(CITY3D_FLOOD_LAYER_ID)) map.removeLayer(CITY3D_FLOOD_LAYER_ID);
      if (map.getLayer(BASEMAP_BUILDINGS_3D)) {
        if (prev.color !== undefined) map.setPaintProperty(BASEMAP_BUILDINGS_3D, "fill-extrusion-color", prev.color);
        if (prev.opacity !== undefined) map.setPaintProperty(BASEMAP_BUILDINGS_3D, "fill-extrusion-opacity", prev.opacity);
        const tilted = map.getPitch() > 12;
        setLayerVisible(map, BASEMAP_BUILDINGS_3D, tilted);
        setLayerVisible(map, BASEMAP_BUILDINGS_FLAT, !tilted);
      }
      handle.dispose();
      handleRef.current = null;
    };
  }, [engine, engine.styleEpoch, on]);

  // Enter / exit camera moves.
  const entered = useRef(false);
  useEffect(() => {
    const map = engine.map;
    if (on && !entered.current) {
      entered.current = true;
      const area = selectedAreaId ? model.base?.areas.byId.get(selectedAreaId) : undefined;
      const center = area?.anchor ?? (map.getZoom() >= 13.5 ? map.getCenter().toArray() : CITIES[model.cityId].center);
      const cam = { center: center as [number, number], zoom: Math.max(CITY3D_ZOOM, map.getZoom()), pitch: CITY3D_PITCH, bearing: CITY3D_BEARING };
      map.stop();
      if (reduced) map.jumpTo(cam);
      else map.flyTo({ ...cam, duration: DURATION.cityFlight * 1000, curve: 1.3, easing: easeInOutCubic, essential: true });
    } else if (!active && entered.current) {
      entered.current = false;
      const cam = { pitch: 0, bearing: 0, zoom: Math.min(map.getZoom(), model.cityId === "bangkok" ? 12 : 13.6) };
      if (reduced) map.jumpTo(cam);
      else map.easeTo({ ...cam, duration: DURATION.camera * 1000, easing: easeInOutCubic, essential: true });
    }
  }, [engine, on, active, reduced, selectedAreaId, model.base, model.cityId]);

  // Rain follows the shared scenario / historical replay intensity.
  const intensity = model.scenario.visualIntensityMmH;
  useEffect(() => {
    handleRef.current?.setRain(effectsEnabled ? intensity : 0, !reduced);
  }, [intensity, effectsEnabled, reduced, on, engine.styleEpoch]);

  // Illustrative flood sheet per area from the live modelled risk (only for scenario / historical replay).
  const floodAny = on && model.scenario.source !== "baseline" && model.scenario.list.some((a) => floodVisualHeight(a.current.score) > 0);
  useEffect(() => {
    const map = engine.map;
    if (!on || !map.getSource(SRC.areas)) return;
    const live = model.scenario.source !== "baseline";
    for (const a of model.scenario.list) {
      map.setFeatureState({ source: SRC.areas, id: a.area.fid }, { flood: live ? floodVisualHeight(a.current.score) : 0 });
    }
  }, [engine, on, model.scenario, engine.styleEpoch]);

  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-20 flex justify-center px-3 sm:top-16">
      <AnimatePresence>
        <motion.div
          key="city3d-hud"
          initial={reduced ? false : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: DURATION.ui }}
          className="ui-panel-float pointer-events-auto flex max-w-[min(560px,100%)] flex-col gap-1.5 px-3 py-2 text-[11.5px] leading-snug text-ui-text-2"
          role="status"
        >
          <div className="flex items-center gap-2 text-ui-text">
            <Building2 className="size-3.5 text-ui-cyan" aria-hidden />
            <span className="font-semibold">{t(S.title)}</span>
            {intensity > 0.2 && effectsEnabled && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ui-text-2">
                <CloudRain className="size-3.5 text-ui-cyan" aria-hidden />
                {t(S.rain)} · {Math.round(intensity)} {t({ th: "มม./ชม.", en: "mm/h" })}
              </span>
            )}
          </div>
          {!online ? (
            <p className="text-ui-yellow">{t(S.offline)}</p>
          ) : (
            <>
              {!zoomOk && (
                <p className="inline-flex items-center gap-1.5 text-ui-text">
                  <ZoomIn className="size-3.5 text-ui-cyan" aria-hidden />
                  {t(S.zoomIn)}
                </p>
              )}
              <p>{t(S.credit)}</p>
              {floodAny && (
                <p className="ui-sim-stripes inline-flex items-start gap-1.5 rounded-md px-1.5 py-1 text-ui-text">
                  <Waves className="mt-0.5 size-3.5 shrink-0 text-ui-violet" aria-hidden />
                  {t(COMMON.illustrativeFlood)}
                </p>
              )}
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
