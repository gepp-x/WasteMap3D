"use client";

import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { SceneFrame } from "@/lib/three/frame";
import type { Atmosphere } from "@/lib/three/runtime/atmosphere";

/**
 * Hemisphere + ambient + one directional key light (shadow-casting on the high tier only, tight
 * frustum fitted to the frame), deep-navy background and fog. Rain drives a smooth darker/cooler
 * shift (Atmosphere.tick runs first each frame, priority −2, so rain/water read the same value).
 */
export function SceneLighting({
  atmosphere,
  frame,
  shadows,
  mapSize,
  rainTarget,
  reduced,
}: {
  atmosphere: Atmosphere;
  frame: SceneFrame;
  shadows: boolean;
  mapSize: number;
  rainTarget: number;
  reduced: boolean;
}) {
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    atmosphere.attach(scene);
    invalidate();
    return () => atmosphere.detach(scene);
  }, [atmosphere, scene, invalidate]);

  useEffect(() => {
    atmosphere.configure(frame, shadows, mapSize);
    invalidate();
  }, [atmosphere, frame, shadows, mapSize, invalidate]);

  useEffect(() => {
    invalidate();
  }, [rainTarget, invalidate]);

  useFrame((state, dt) => {
    if (atmosphere.tick(Math.min(dt, 0.1), rainTarget, reduced)) state.invalidate();
  }, -2);

  return <primitive object={atmosphere.group} />;
}
