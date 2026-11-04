"use client";

import { useEffect, useId, useRef } from "react";
import { useDashboard } from "@/store/dashboard-store";
import { useLang, useTr, type Bi } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CITIES } from "@/lib/data/cities";
import { AREA_KIND } from "@/lib/map/labels";
import { useMapEngine } from "./use-map-engine";
import { useMapModel } from "./use-map-model";
import { useMapCamera, type ClickSelection } from "./use-map-camera";
import { City3DMode } from "./City3DMode";
import { MapLayers } from "./MapLayers";
import { MapInteractions } from "./MapInteractions";
import { AreaNameMarkers } from "./AreaNameMarker";
import { MapLegend } from "./MapLegend";
import { MapControls } from "./MapControls";
import { BasemapBadge, EngineFailureCard, MapErrorCard, MapLoadingVeil } from "./MapStatus";

const S = {
  canvas: { th: "แผนที่เชิงโต้ตอบ", en: "Interactive map" },
  help: {
    th: "ใช้ปุ่มลูกศรเพื่อเลื่อนแผนที่ ปุ่ม + และ − เพื่อซูม Shift ร่วมกับลูกศรเพื่อหมุนหรือเอียง กด Enter เพื่อเลือกพื้นที่ที่อยู่กลางแผนที่ และ Escape เพื่อยกเลิกการเลือก",
    en: "Arrow keys pan, + and − zoom, Shift + arrows rotate or tilt. Press Enter to select the area under the centre marker and Escape to clear the selection.",
  },
  selected: { th: "เลือกแล้ว", en: "Selected" },
} satisfies Record<string, Bi>;

/**
 * Interactive 2D geospatial map (MapLibre) — fills its parent.
 *
 * Composition: engine (map lifecycle + basemap health) → model (data × scenario) → renderless
 * layer sync + camera + pointer/keyboard interaction, with HTML overlays (tooltip, name tags,
 * legend, controls, loading/error/offline states) layered above the canvas.
 */
export function CityMap({ className }: { className?: string }) {
  const t = useTr();
  const lang = useLang();
  const helpId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clickRef = useRef<ClickSelection | null>(null);

  const { engine, failure } = useMapEngine(containerRef);
  const model = useMapModel();
  const camera = useMapCamera(engine, model, clickRef);

  const selectedAreaId = useDashboard((s) => s.selectedAreaId);
  const selectedArea = selectedAreaId ? model.base?.areas.byId.get(selectedAreaId) : undefined;

  // Localised accessible name + keyboard help on the focusable canvas.
  useEffect(() => {
    if (!engine) return;
    const canvas = engine.map.getCanvas();
    const city = CITIES[model.cityId];
    canvas.setAttribute("aria-label", `${t(S.canvas)} — ${t({ th: city.nameTh, en: city.nameEn })}`);
    canvas.setAttribute("aria-describedby", helpId);
  }, [engine, t, helpId, model.cityId]);

  const loading = model.status === "loading" || (model.status === "ready" && !model.base);
  const announce = selectedArea
    ? `${t(S.selected)}: ${t(AREA_KIND[selectedArea.kind])} ${lang === "th" ? selectedArea.nameTh : selectedArea.nameEn}`
    : "";

  return (
    <div ref={rootRef} className={cn("group/map relative isolate h-full w-full overflow-hidden bg-[#071423] [container-type:size]", className)}>
      {/* Map canvas container (the grid shows until the first frame paints). Positioned inline because
          maplibre-gl.css sets `.maplibregl-map { position: relative }` unlayered, which beats utilities. */}
      <div ref={containerRef} className="ui-grid-bg" style={{ position: "absolute", inset: 0 }} />

      {/* Keyboard reticle — visible only while the canvas has keyboard focus. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 z-10 size-7 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-has-[canvas:focus-visible]/map:opacity-100"
      >
        <span className="absolute inset-0 rounded-full border border-ui-cyan/80" />
        <span className="absolute top-1/2 left-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ui-cyan" />
        <span className="absolute -top-1.5 left-1/2 h-2 w-px -translate-x-1/2 bg-ui-cyan/80" />
        <span className="absolute -bottom-1.5 left-1/2 h-2 w-px -translate-x-1/2 bg-ui-cyan/80" />
        <span className="absolute top-1/2 -left-1.5 h-px w-2 -translate-y-1/2 bg-ui-cyan/80" />
        <span className="absolute top-1/2 -right-1.5 h-px w-2 -translate-y-1/2 bg-ui-cyan/80" />
      </div>

      {engine && (
        <>
          <MapLayers engine={engine} model={model} />
          <MapInteractions engine={engine} model={model} rootRef={rootRef} clickRef={clickRef} />
          <AreaNameMarkers engine={engine} model={model} />
          <City3DMode engine={engine} model={model} />
        </>
      )}

      <MapLoadingVeil cityId={model.cityId} show={!failure && loading} />
      {!failure && model.status === "error" && <MapErrorCard cityId={model.cityId} error={model.error} />}
      {failure && <EngineFailureCard failure={failure} />}

      {/* Bottom overlays: legend stack (left) and camera controls (right, clear of the attribution). */}
      {!failure && (
        <div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 z-20 flex items-end justify-between gap-3 sm:inset-x-3 sm:bottom-3">
          <div className="pointer-events-auto flex min-w-0 flex-col items-start gap-2">
            {engine && <BasemapBadge mode={engine.basemap} onRetry={engine.retryBasemap} />}
            {engine && <MapLegend model={model} />}
          </div>
          <div className="pointer-events-auto mb-7 shrink-0">
            <MapControls engine={engine} camera={camera} />
          </div>
        </div>
      )}

      <p id={helpId} className="sr-only">
        {t(S.help)}
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </p>
    </div>
  );
}
