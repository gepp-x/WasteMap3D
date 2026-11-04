"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useDashboard } from "@/store/dashboard-store";
import { useLang, useTr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AreaRecord } from "@/lib/types";
import { AREA_KIND } from "@/lib/map/labels";
import type { MapEngine } from "./use-map-engine";
import type { MapModel } from "./use-map-model";

/**
 * HTML name tag for one area, anchored at the dataset's point-on-surface. Rendered with the UI
 * font so Thai script shapes correctly (the vector-tile glyph server is used only for Latin labels).
 */
function NameTag({ engine, area, variant }: { engine: MapEngine; area: AreaRecord; variant: "selected" | "hover" }) {
  const t = useTr();
  const lang = useLang();
  const [el] = useState(() => {
    const d = document.createElement("div");
    d.style.pointerEvents = "none";
    return d;
  });
  const [lon, lat] = area.anchor;

  useEffect(() => {
    const marker = new engine.ml.Marker({ element: el, anchor: "bottom", offset: [0, -6], subpixelPositioning: true }).setLngLat([lon, lat]).addTo(engine.map);
    return () => {
      marker.remove();
    };
  }, [engine.ml, engine.map, el, lon, lat]);

  const primary = lang === "th" ? area.nameTh : area.nameEn;
  const secondary = lang === "th" ? area.nameEn : area.nameTh;
  return createPortal(
    <div className="flex flex-col items-center animate-in fade-in-0 zoom-in-95 duration-200" aria-hidden>
      <div
        className={cn(
          "flex flex-col items-center rounded-md border px-2 py-1 text-center shadow-[0_10px_24px_-12px_rgba(0,0,0,0.8)]",
          variant === "selected" ? "border-ui-cyan/60 bg-[rgba(6,17,30,0.92)]" : "border-ui-border-strong bg-[rgba(9,22,37,0.88)]",
        )}
      >
        <span className="text-[9.5px] tracking-[0.12em] text-ui-text-3 uppercase">{t(AREA_KIND[area.kind])}</span>
        <span className={cn("text-[13px] leading-tight font-semibold whitespace-nowrap", variant === "selected" ? "text-ui-cyan" : "text-ui-text")}>{primary}</span>
        <span className="text-[10px] leading-tight whitespace-nowrap text-ui-text-2">{secondary}</span>
      </div>
      <span className={cn("h-2 w-px", variant === "selected" ? "bg-ui-cyan/70" : "bg-ui-border-strong")} />
      <span className={cn("size-1.5 rounded-full", variant === "selected" ? "bg-ui-cyan" : "bg-ui-text-2")} />
    </div>,
    el,
  );
}

/** Thai/English name tags for the selected area and (when different) the hovered one. */
export function AreaNameMarkers({ engine, model }: { engine: MapEngine; model: MapModel }) {
  const selectedAreaId = useDashboard((s) => s.selectedAreaId);
  const hoveredAreaId = useDashboard((s) => s.hoveredAreaId);
  const byId = model.base?.areas.byId;
  const sel = selectedAreaId ? byId?.get(selectedAreaId) : undefined;
  const hov = hoveredAreaId && hoveredAreaId !== selectedAreaId ? byId?.get(hoveredAreaId) : undefined;
  return (
    <>
      {sel && <NameTag key={`sel-${sel.id}`} engine={engine} area={sel} variant="selected" />}
      {hov && <NameTag key={`hov-${hov.id}`} engine={engine} area={hov} variant="hover" />}
    </>
  );
}
