"use client";

import { useEffect, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { WaterInputs } from "@/lib/three/waterways";
import type { Atmosphere } from "@/lib/three/runtime/atmosphere";
import { WaterField } from "@/lib/three/runtime/water";

/**
 * Waterways as flat ribbons just above the ground with a UV-scrolling flow shader (direction =
 * digitised direction of the line) plus flat water polygons. Flow speed and brightness rise with
 * rain. Static under reduced motion / effects off. Visibility + opacity follow the shared
 * `waterways` map layer so 2D and 3D stay in sync.
 */
export function Waterways3D({
  inputs,
  y = 0.06,
  spacing,
  shimmerScale,
  atmosphere,
  flowing,
  visible,
  opacity,
}: {
  inputs: WaterInputs | null;
  y?: number;
  spacing: number;
  shimmerScale: number;
  atmosphere: Atmosphere;
  flowing: boolean;
  visible: boolean;
  opacity: number;
}) {
  const [water] = useState(() => new WaterField());
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => () => water.dispose(), [water]);

  useEffect(() => {
    water.setData(inputs ?? { lines: [], areas: [] }, y, spacing, shimmerScale);
    invalidate();
  }, [water, inputs, y, spacing, shimmerScale, invalidate]);

  useEffect(() => {
    water.setStyle(visible, opacity);
    invalidate();
  }, [water, visible, opacity, invalidate]);

  useFrame((_, dt) => {
    water.tick(Math.min(dt, 0.1), atmosphere.rain, flowing && visible);
  });

  return <primitive object={water.group} />;
}
