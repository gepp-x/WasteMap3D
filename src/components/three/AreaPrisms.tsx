"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useDashboard } from "@/store/dashboard-store";
import type { AreaVisualSet } from "@/lib/three/area-visuals";
import type { PrismField } from "@/lib/three/runtime/prisms";
import { setCursor } from "@/lib/three/dom";

/**
 * City overview: real area polygons extruded as prisms. Height = active choropleth metric
 * (fallback: primary waste metric), colour = same ramp/breaks as the 2D map, both from live
 * scenario values. Hover (pointer move) → store.hoverArea (map highlights too), click → store.selectArea.
 * Smooth transitions run in PrismField.tick (refs/uniforms only — no React state per frame).
 */
export function AreaPrisms({
  field,
  visuals,
  interactive,
  reduced,
  shadows,
  maxHeight,
}: {
  field: PrismField;
  visuals: AreaVisualSet | null;
  interactive: boolean;
  reduced: boolean;
  shadows: boolean;
  maxHeight: number;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const hoverArea = useDashboard((s) => s.hoverArea);
  const selectArea = useDashboard((s) => s.selectArea);
  const latest = useRef({ visuals, selectedId, maxHeight });

  useEffect(() => {
    latest.current = { visuals, selectedId, maxHeight };
    field.setTargets(visuals, selectedId, useDashboard.getState().hoveredAreaId, maxHeight);
    invalidate();
  }, [field, visuals, selectedId, maxHeight, invalidate]);

  // hover changes (from this scene OR the 2D map) update targets without re-rendering React
  useEffect(
    () =>
      useDashboard.subscribe((s, prev) => {
        if (s.hoveredAreaId === prev.hoveredAreaId) return;
        const l = latest.current;
        field.setTargets(l.visuals, l.selectedId, s.hoveredAreaId, l.maxHeight);
        invalidate();
      }),
    [field, invalidate],
  );

  useEffect(() => {
    field.setShadows(shadows);
    invalidate();
  }, [field, shadows, invalidate]);

  useEffect(() => () => setCursor(gl.domElement, ""), [gl]);

  useFrame((state, dt) => {
    if (field.tick(Math.min(dt, 0.1), reduced)) state.invalidate();
  });

  const areaOf = (e: ThreeEvent<PointerEvent | MouseEvent>) => (e.object.userData?.areaId as string | undefined) ?? null;

  return (
    <primitive
      object={field.group}
      // R3F keys over/out by the handler's object (this group), so moving between two prisms would
      // not re-fire "over" — hover is tracked on move (store.hoverArea is a no-op for the same id).
      onPointerMove={
        interactive
          ? (e: ThreeEvent<PointerEvent>) => {
              e.stopPropagation();
              const id = areaOf(e);
              if (!id) return;
              if (useDashboard.getState().hoveredAreaId !== id) hoverArea(id);
              setCursor(gl.domElement, "pointer");
            }
          : undefined
      }
      onPointerOut={
        interactive
          ? () => {
              const current = useDashboard.getState().hoveredAreaId;
              if (current && field.set.byId.has(current)) hoverArea(null);
              setCursor(gl.domElement, "");
            }
          : undefined
      }
      onClick={
        interactive
          ? (e: ThreeEvent<MouseEvent>) => {
              if (e.delta > 6) return; // ignore clicks that ended an orbit drag
              e.stopPropagation();
              const id = areaOf(e);
              if (id) selectArea(id);
            }
          : undefined
      }
    />
  );
}
