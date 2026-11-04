"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Map as MLMap, MapMouseEvent, PointLike } from "maplibre-gl";
import { useDashboard } from "@/store/dashboard-store";
import { LYR } from "@/lib/map/ids";
import { useCommunityFocus } from "@/lib/map/communities";
import type { MapEngine } from "./use-map-engine";
import type { MapModel } from "./use-map-model";
import type { ClickSelection } from "./use-map-camera";
import { MapTooltip, type HoverTarget } from "./MapTooltip";

interface Pt {
  x: number;
  y: number;
}

const visible = (map: MLMap, ids: string[]) => ids.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");

const box = (p: Pt, r: number): [PointLike, PointLike] => [
  [p.x - r, p.y - r],
  [p.x + r, p.y + r],
];

/** Hit-test priority: point assets → linear water/drainage → water bodies → the area underneath. */
function resolveTarget(map: MLMap, p: Pt, model: MapModel): { target: HoverTarget | null; areaId: string | null } {
  const base = model.base;
  if (!base || !map.getLayer(LYR.areasHit)) return { target: null, areaId: null };
  const af = map.queryRenderedFeatures([p.x, p.y], { layers: [LYR.areasHit] })[0];
  const rawFid = af?.id ?? af?.properties?.fid;
  const area = rawFid !== undefined && rawFid !== null ? base.areas.byFid.get(Number(rawFid)) : undefined;
  const areaId = area?.id ?? null;

  // Gauges first: their tag-shaped icon sits above its anchor point, so hit-test the icon box itself.
  const gaugeLayers = visible(map, [LYR.waterLevelIcons]);
  if (gaugeLayers.length) {
    const f = map.queryRenderedFeatures(box(p, 4), { layers: gaugeLayers })[0];
    const index = Number(f?.properties?._i);
    if (f && Number.isFinite(index)) return { target: { kind: "gauge", index, areaId }, areaId };
  }
  const pointLayers = visible(map, [LYR.stations, LYR.drainageIcons, LYR.drainageHalo, LYR.communitiesVerified, LYR.communitiesIllustrative]);
  if (pointLayers.length) {
    const f = map.queryRenderedFeatures(box(p, 6), { layers: pointLayers })[0];
    if (f) {
      const index = Number(f.properties?._i);
      if (Number.isFinite(index)) {
        if (f.layer.id === LYR.stations) return { target: { kind: "station", index, areaId }, areaId };
        if (f.layer.id === LYR.communitiesVerified || f.layer.id === LYR.communitiesIllustrative) {
          // A community belongs to its published zone, whatever polygon its (possibly illustrative) point falls in.
          const zone = model.base?.communities?.items[index]?.zoneId;
          const zoneId = zone && base.areas.byId.has(zone) ? zone : areaId;
          return { target: { kind: "community", index, areaId: zoneId }, areaId: zoneId };
        }
        return { target: { kind: "drainage", index, areaId }, areaId };
      }
    }
  }
  const lineLayers = visible(map, [LYR.drainageLines, LYR.waterLines]);
  if (lineLayers.length) {
    const f = map.queryRenderedFeatures(box(p, 3), { layers: lineLayers })[0];
    const index = Number(f?.properties?._i);
    if (f && Number.isFinite(index)) {
      if (f.layer.id === LYR.drainageLines) return { target: { kind: "drainage", index, areaId }, areaId };
      const it = base.waterways?.items[index];
      if (it && (it.nameTh || it.nameEn)) return { target: { kind: "water", index, areaId }, areaId };
    }
  }
  const polyLayers = visible(map, [LYR.drainageAreas, LYR.communitiesLine]);
  if (polyLayers.length) {
    const f = map.queryRenderedFeatures([p.x, p.y], { layers: polyLayers })[0];
    const index = Number(f?.properties?._i);
    if (f && Number.isFinite(index)) {
      if (f.layer.id === LYR.drainageAreas) return { target: { kind: "drainage", index, areaId }, areaId };
      return { target: { kind: "community", index, areaId }, areaId };
    }
  }
  return { target: area ? { kind: "area", areaId: area.id } : null, areaId };
}

const keyOf = (t: HoverTarget | null) => (t ? `${t.kind}:${"index" in t ? t.index : t.areaId}` : "");

function placeTooltip(tip: HTMLDivElement, p: Pt, w: number, h: number) {
  const tw = tip.offsetWidth || 248;
  const th = tip.offsetHeight || 140;
  const off = 16;
  let left = p.x + off;
  let top = p.y + off;
  if (left + tw > w - 8) left = p.x - off - tw;
  if (top + th > h - 8) top = p.y - off - th;
  left = Math.max(8, Math.min(left, w - tw - 8));
  top = Math.max(8, Math.min(top, h - th - 8));
  tip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

/**
 * Pointer + keyboard interaction. Mouse moves are coalesced to one hit-test per animation frame;
 * the tooltip is positioned imperatively and React only re-renders when the hovered target changes.
 *
 *  hover  → store.hoverArea + tooltip card   click → store.selectArea (empty space clears)
 *  Enter/Space on the focused canvas → select the area under the centre reticle
 *  Escape → clear selection
 */
export function MapInteractions({
  engine,
  model,
  rootRef,
  clickRef,
}: {
  engine: MapEngine;
  model: MapModel;
  rootRef: RefObject<HTMLDivElement | null>;
  clickRef: RefObject<ClickSelection | null>;
}) {
  const { map, isReady } = engine;
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    const canvas = map.getCanvas();
    const container = map.getContainer();
    let raf = 0;
    let pending: Pt | null = null;
    let last: Pt | null = null;
    let lastKey = "";
    let mapHover: string | null = null;

    const setHover = (areaId: string | null) => {
      const st = useDashboard.getState();
      if (mapHover === areaId && st.hoveredAreaId === areaId) return;
      mapHover = areaId;
      st.hoverArea(areaId);
    };

    const process = () => {
      raf = 0;
      const p = pending;
      pending = null;
      if (!p || !isReady()) return;
      last = p;
      const { target: hit, areaId } = resolveTarget(map, p, modelRef.current);
      const tip = tipRef.current;
      if (tip) placeTooltip(tip, p, container.clientWidth, container.clientHeight);
      canvas.style.cursor = hit ? "pointer" : "";
      const k = keyOf(hit);
      if (k !== lastKey) {
        lastKey = k;
        setTarget(hit);
      }
      setHover(areaId);
    };

    const onMove = (ev: MapMouseEvent) => {
      pending = { x: ev.point.x, y: ev.point.y };
      if (!raf) raf = requestAnimationFrame(process);
    };
    const onOut = () => {
      pending = null;
      last = null;
      cancelAnimationFrame(raf);
      raf = 0;
      lastKey = "";
      canvas.style.cursor = "";
      setTarget(null);
      if (mapHover !== null && useDashboard.getState().hoveredAreaId === mapHover) useDashboard.getState().hoverArea(null);
      mapHover = null;
    };
    const onMoveEnd = () => {
      if (last && !pending) {
        pending = last;
        if (!raf) raf = requestAnimationFrame(process);
      }
    };
    const onClick = (ev: MapMouseEvent) => {
      if (!isReady()) return;
      // Clicks without a preceding move (touch, synthetic input) still refresh the hover card.
      // (Skipped for touch taps: there is no pointer-leave to dismiss the card afterwards.)
      if ((ev.originalEvent as PointerEvent | undefined)?.pointerType !== "touch") {
        pending = { x: ev.point.x, y: ev.point.y };
        if (!raf) raf = requestAnimationFrame(process);
      }
      const { target: hit, areaId } = resolveTarget(map, ev.point, modelRef.current);
      const st = useDashboard.getState();
      if (hit?.kind === "community") {
        // Clicking a community selects its zone and points the details panel at the community's row.
        const it = modelRef.current.base?.communities?.items[hit.index];
        useCommunityFocus.getState().focus(it?.id ?? null);
        if (areaId) {
          st.setDetailTab("overview");
          if (areaId !== st.selectedAreaId) {
            clickRef.current = { areaId };
            st.selectArea(areaId);
          }
        }
        return;
      }
      if (areaId) {
        if (areaId !== st.selectedAreaId) {
          clickRef.current = { areaId };
          st.selectArea(areaId);
        }
      } else if (st.selectedAreaId) {
        st.selectArea(null, { focus: false });
      }
    };

    const subs = [map.on("mousemove", onMove), map.on("mouseout", onOut), map.on("moveend", onMoveEnd), map.on("click", onClick)];

    // Re-place the card when its content (and therefore size) changes.
    const tip = tipRef.current;
    const ro = new ResizeObserver(() => {
      if (tip && last) placeTooltip(tip, last, container.clientWidth, container.clientHeight);
    });
    if (tip) ro.observe(tip);

    return () => {
      subs.forEach((s) => s.unsubscribe());
      ro.disconnect();
      cancelAnimationFrame(raf);
      canvas.style.cursor = "";
      if (mapHover !== null && useDashboard.getState().hoveredAreaId === mapHover) useDashboard.getState().hoverArea(null);
    };
  }, [map, isReady, clickRef]);

  /* Keyboard: Enter/Space selects the area under the reticle; Escape clears selection. */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const canvas = map.getCanvas();
    const clear = () => {
      const st = useDashboard.getState();
      if (!st.selectedAreaId) return false;
      st.selectArea(null, { focus: false });
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (clear()) e.preventDefault();
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && e.target === canvas && isReady()) {
        e.preventDefault();
        const { areaId } = resolveTarget(map, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, modelRef.current);
        if (areaId) useDashboard.getState().selectArea(areaId);
      }
    };
    // Escape anywhere when nothing in particular has focus (does not steal it from dialogs/inputs).
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const a = document.activeElement;
      if (!a || a === document.body) clear();
    };
    root.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onWindowKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onWindowKey);
    };
  }, [map, isReady, rootRef]);

  return <MapTooltip ref={tipRef} target={target} model={model} />;
}
