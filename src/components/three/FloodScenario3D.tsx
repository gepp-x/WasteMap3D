"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeScope } from "@/store/dashboard-store";
import type { AreaGeomSet } from "@/lib/three/area-geometry";
import type { SceneFrame } from "@/lib/three/frame";
import type { FloodTarget } from "@/lib/three/flood";
import { FloodField } from "@/lib/three/runtime/flood";
import { useThreeUi } from "@/lib/three/ui-store";

/**
 * Illustrative 3D flood (visual metaphor). Shown only when a scenario / historical replay puts the
 * relevant area(s) at High or Very High modelled risk. The level maps from the risk score — no
 * numeric depth exists anywhere in this pipeline. While any water is visible the overlay shows
 * COMMON.illustrativeFlood (edge-triggered through the three UI store, never per frame).
 */
export function FloodScenario3D({
  targets,
  scope,
  set,
  frame,
  reduced,
  effects,
}: {
  targets: FloodTarget[];
  scope: ThreeScope;
  set: AreaGeomSet | null;
  frame: SceneFrame | null;
  reduced: boolean;
  effects: boolean;
}) {
  const flood = useMemo(() => new FloodField(), []);
  const invalidate = useThree((s) => s.invalidate);
  const setFloodVisible = useThreeUi((s) => s.setFloodVisible);
  const visibleRef = useRef(false);

  useEffect(
    () => () => {
      flood.dispose();
      useThreeUi.getState().setFloodVisible(false);
    },
    [flood],
  );

  useEffect(() => {
    flood.setTargets(targets, scope, set, frame);
    if (targets.length) {
      visibleRef.current = true;
      setFloodVisible(true);
    }
    invalidate();
  }, [flood, targets, scope, set, frame, setFloodVisible, invalidate]);

  useFrame((state, dt) => {
    const { moving, visible } = flood.tick(Math.min(dt, 0.1), reduced, effects && !reduced);
    if (moving) state.invalidate();
    if (visible !== visibleRef.current) {
      visibleRef.current = visible;
      setFloodVisible(visible);
    }
  });

  return <primitive object={flood.group} />;
}
