"use client";

import { useEffect, useMemo, type RefObject } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useDashboard } from "@/store/dashboard-store";
import type { AreaRecord } from "@/lib/types";
import type { AreaGeomSet } from "@/lib/three/area-geometry";
import type { AreaVisualSet } from "@/lib/three/area-visuals";
import type { PrismField } from "@/lib/three/runtime/prisms";
import { RiskMarkers } from "@/lib/three/runtime/markers";

const projected = new THREE.Vector3();

/** Imperative label placement (called from useFrame; never re-renders React). */
function placeLabel(el: HTMLDivElement | null | undefined, show: boolean, x = 0, y = 0) {
  if (!el) return;
  const v = show ? "true" : "false";
  if (el.dataset.show !== v) el.dataset.show = v;
  if (show) el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
}

/**
 * Risk overlay + selection marker for the city overview.
 * - High / Very High areas (live model) get a ground outline in their class colour while a scenario
 *   or historical replay is active (hidden when the height metric is already risk).
 * - The selected area gets a cyan roof ring (3 calm ripples, then static). Its pinned DOM label
 *   (SelectedAreaLabel, rendered beside the canvas) is projected here each rendered frame by direct
 *   style writes — name, value, unit and data status (glyph + text — never colour alone).
 */
export function RiskOverlay3D({
  set,
  field,
  visuals,
  areasById,
  showRisk,
  reduced,
  effects,
  active,
  labelRef,
}: {
  set: AreaGeomSet;
  field: PrismField;
  visuals: AreaVisualSet | null;
  areasById: Map<string, AreaRecord>;
  showRisk: boolean;
  reduced: boolean;
  effects: boolean;
  /** False while the neighbourhood scope is rendered (the DOM label ignores parent visibility). */
  active: boolean;
  /** DOM label positioned over the selected prism (owned by DigitalTwinCanvas). */
  labelRef?: RefObject<HTMLDivElement | null>;
}) {
  const invalidate = useThree((s) => s.invalidate);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const markers = useMemo(() => new RiskMarkers(set), [set]);

  useEffect(() => () => markers.dispose(), [markers]);

  useEffect(() => {
    markers.setRisk(visuals, showRisk && !!visuals && !visuals.isRisk);
    invalidate();
  }, [markers, visuals, showRisk, invalidate]);

  useEffect(() => {
    markers.setSelection(selectedId);
    invalidate();
  }, [markers, selectedId, invalidate]);

  const geom = selectedId ? set.byId.get(selectedId) : undefined;
  const hasLabel = active && !!geom && !!selectedId && areasById.has(selectedId);

  // label shown / hidden → draw one frame so useFrame re-projects it
  useEffect(() => {
    invalidate();
  }, [hasLabel, invalidate]);

  // hide the label when this overlay leaves the scene (city change, canvas re-creation)
  useEffect(() => {
    const el = labelRef?.current;
    return () => placeLabel(el, false);
  }, [labelRef]);

  useFrame((state, dt) => {
    const h = selectedId ? field.heightOf(selectedId) : 0;
    if (markers.tick(Math.min(dt, 0.1), h, effects && !reduced)) state.invalidate();
    const el = labelRef?.current;
    if (!el) return;
    if (!hasLabel || !geom) return placeLabel(el, false);
    projected.set(geom.anchor[0], h + 1.5, geom.anchor[1]).project(state.camera);
    const onScreen = projected.z < 1 && Math.abs(projected.x) <= 1.1 && Math.abs(projected.y) <= 1.1;
    placeLabel(el, onScreen, (projected.x * 0.5 + 0.5) * state.size.width, (-projected.y * 0.5 + 0.5) * state.size.height);
  });

  return <primitive object={markers.group} />;
}
