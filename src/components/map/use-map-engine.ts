"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Map as MLMap, MapSourceDataEvent } from "maplibre-gl";
import { useDashboard } from "@/store/dashboard-store";
import { CITIES } from "@/lib/data/cities";
import { buildBasemapStyle, buildOfflineStyle } from "@/lib/map/style";
import { installDataOverlay, type OverlayImages } from "@/lib/map/data-layers";
import { BASEMAP_SOURCE } from "@/lib/map/ids";
import { framePadding } from "@/lib/map/camera";
import { maplibreWorkerUrl } from "@/lib/map/worker-url";

export type MaplibreModule = typeof import("maplibre-gl");

/** Point MapLibre at the bundler-emitted worker once per page, before the first map (see lib/map/worker-url.ts). */
function ensureWorkerUrl(ml: MaplibreModule) {
  if (!ml.getWorkerUrl()) ml.setWorkerUrl(maplibreWorkerUrl());
}

export type BasemapMode = "online" | "offline";
export type EngineFailure = "webgl" | "load";

export interface MapEngine {
  map: MLMap;
  ml: MaplibreModule;
  /** Increments after every (re)install of the data overlay — effects depend on it to re-apply state. */
  styleEpoch: number;
  basemap: BasemapMode;
  /** True while the overlay is installed on the current style (false during a basemap swap). */
  isReady: () => boolean;
  retryBasemap: () => void;
  images: () => OverlayImages | null;
}

/** No basemap tile within this window ⇒ switch to the offline basemap. */
const WATCHDOG_MS = 8000;
/** Tile failures (before any success) tolerated before switching. */
const MAX_TILE_ERRORS = 3;

/**
 * One maplibregl.Map per mount (StrictMode-safe: the library is imported lazily and a disposed
 * flag prevents a stale instance), removed on unmount. Watches basemap health and swaps to the
 * offline style when OpenFreeMap is unreachable; the data overlay is re-installed on every
 * `style.load`, so bundled layers render identically on both basemaps.
 */
export function useMapEngine(containerRef: RefObject<HTMLDivElement | null>) {
  const [instance, setInstance] = useState<{ map: MLMap; ml: MaplibreModule } | null>(null);
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [basemap, setBasemap] = useState<BasemapMode>("online");
  const [failure, setFailure] = useState<EngineFailure | null>(null);
  const readyRef = useRef(false);
  const imagesRef = useRef<OverlayImages | null>(null);
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let map: MLMap | null = null;
    let mode: BasemapMode = "online";
    let watchdog = 0;
    let tileOk = false;
    let tileErrors = 0;
    let resizeRaf = 0;
    let ro: ResizeObserver | null = null;

    const clearWatchdog = () => window.clearTimeout(watchdog);
    // Armed on style.load (rendering has started). A hidden tab pauses rAF and therefore tile
    // loading, so the window restarts instead of blaming the network.
    const arm = () => {
      clearWatchdog();
      const check = () => {
        if (disposed || tileOk || mode !== "online") return;
        if (document.hidden) {
          watchdog = window.setTimeout(check, WATCHDOG_MS);
          return;
        }
        swap("offline");
      };
      watchdog = window.setTimeout(check, WATCHDOG_MS);
    };
    const swap = (next: BasemapMode) => {
      if (!map || disposed) return;
      mode = next;
      readyRef.current = false;
      tileOk = false;
      tileErrors = 0;
      clearWatchdog();
      setBasemap(next);
      map.setStyle(next === "online" ? buildBasemapStyle() : buildOfflineStyle(), { diff: false });
    };
    const onOffline = () => {
      if (mode !== "offline") swap("offline");
    };
    const onOnline = () => {
      if (mode === "offline") swap("online");
    };

    import("maplibre-gl")
      .then((ml) => {
        if (disposed) return;
        ensureWorkerUrl(ml);
        mode = typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "online";
        const city = CITIES[useDashboard.getState().cityId];
        const rect = el.getBoundingClientRect();
        let m: MLMap;
        try {
          m = new ml.Map({
            container: el,
            style: mode === "online" ? buildBasemapStyle() : buildOfflineStyle(),
            bounds: city.bbox,
            fitBoundsOptions: { padding: framePadding(rect.width || 960, rect.height || 640) },
            attributionControl: { compact: true },
            minZoom: 4.5,
            maxZoom: 18,
            maxPitch: 70,
            fadeDuration: 180,
            dragRotate: true,
            touchPitch: true,
            cancelPendingTileRequestsWhileZooming: true,
            canvasContextAttributes: { antialias: true },
          });
        } catch {
          setFailure("webgl");
          return;
        }
        map = m;

        m.on("style.load", () => {
          if (disposed) return;
          imagesRef.current = installDataOverlay(m);
          readyRef.current = true;
          setStyleEpoch((n) => n + 1);
          if (mode === "online" && !tileOk) arm();
        });
        m.on("data", (ev) => {
          const d = ev as MapSourceDataEvent;
          if (d.dataType === "source" && d.sourceId === BASEMAP_SOURCE && d.tile) {
            tileOk = true;
            clearWatchdog();
          }
        });
        m.on("error", (ev) => {
          const extra = ev as unknown as { sourceId?: string; tile?: unknown };
          const err = ev.error as (Error & { url?: string }) | undefined;
          const url = err?.url ?? "";
          const basemapRelated = extra.sourceId === BASEMAP_SOURCE || url.includes("tiles.openfreemap.org");
          if (basemapRelated) {
            // Glyph failures only cost basemap labels; offline-mode failures are expected.
            if (mode === "offline" || url.includes("/fonts/")) return;
            if (extra.sourceId === BASEMAP_SOURCE && !extra.tile) {
              swap("offline"); // TileJSON itself failed
              return;
            }
            if (!tileOk && ++tileErrors >= MAX_TILE_ERRORS) swap("offline");
            return;
          }
          if (url) return; // other network failures surface through the data-loading UI
          if (process.env.NODE_ENV !== "production") console.warn("[CityMap]", err?.message ?? ev);
        });

        // Mounted at zero size (e.g. hidden behind the 3D view): frame the city once it gets real space.
        let needsFrame = rect.width === 0 || rect.height === 0;
        ro = new ResizeObserver(() => {
          cancelAnimationFrame(resizeRaf);
          resizeRaf = requestAnimationFrame(() => {
            if (disposed) return;
            m.resize();
            if (needsFrame && el.clientWidth > 0 && el.clientHeight > 0) {
              needsFrame = false;
              const cam = m.cameraForBounds(CITIES[useDashboard.getState().cityId].bbox, {
                padding: framePadding(el.clientWidth, el.clientHeight),
              });
              if (cam) m.jumpTo(cam);
            }
          });
        });
        ro.observe(el);
        window.addEventListener("offline", onOffline);
        window.addEventListener("online", onOnline);
        retryRef.current = () => swap("online");

        setBasemap(mode);
        setInstance({ map: m, ml });
      })
      .catch(() => {
        if (!disposed) setFailure("load");
      });

    return () => {
      disposed = true;
      clearWatchdog();
      cancelAnimationFrame(resizeRaf);
      ro?.disconnect();
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      readyRef.current = false;
      imagesRef.current = null;
      retryRef.current = () => {};
      map?.remove();
      map = null;
    };
  }, [containerRef]);

  const isReady = useCallback(() => readyRef.current, []);
  const retryBasemap = useCallback(() => retryRef.current(), []);
  const images = useCallback(() => imagesRef.current, []);

  const engine = useMemo<MapEngine | null>(
    () => (instance ? { map: instance.map, ml: instance.ml, styleEpoch, basemap, isReady, retryBasemap, images } : null),
    [instance, styleEpoch, basemap, isReady, retryBasemap, images],
  );

  return { engine, failure };
}
