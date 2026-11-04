"use client";

import { useEffect, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Geometry } from "geojson";
import type { OrbitControls } from "three-stdlib";
import type { SceneFrame } from "@/lib/three/frame";
import { buildOutlineFromGeometries } from "@/lib/three/area-geometry";
import { GroundField } from "@/lib/three/runtime/ground";

/**
 * Technical-grid ground plane (fades around the orbit target), shadow catcher on the high tier and
 * a dashed boundary: Hat Yai municipality (city scope) or the selected area (neighbourhood scope).
 */
export function Ground({
  frame,
  shadows,
  boundary,
  boundaryColor = "#25d9f2",
  boundaryOpacity = 0.55,
}: {
  frame: SceneFrame;
  shadows: boolean;
  boundary: Geometry[] | null;
  boundaryColor?: string;
  boundaryOpacity?: number;
}) {
  const [ground] = useState(() => new GroundField());
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => () => ground.dispose(), [ground]);

  useEffect(() => {
    ground.configure(frame, shadows);
    invalidate();
  }, [ground, frame, shadows, invalidate]);

  useEffect(() => {
    const y = frame.kind === "neighborhood" ? 0.08 : 0.05;
    ground.setBoundary(boundary && boundary.length ? buildOutlineFromGeometries(boundary, frame, y) : null, boundaryColor, boundaryOpacity);
    invalidate();
  }, [ground, boundary, frame, boundaryColor, boundaryOpacity, invalidate]);

  useFrame((state) => {
    const controls = state.controls as unknown as OrbitControls | null;
    if (controls?.target) ground.follow(controls.target);
  });

  return <primitive object={ground.group} />;
}
