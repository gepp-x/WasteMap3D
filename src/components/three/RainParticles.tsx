"use client";

import { useEffect, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls } from "three-stdlib";
import { RainSystem } from "@/lib/three/runtime/rain";

const ORIGIN = new THREE.Vector3();

/**
 * GPU rain streaks. Count by quality tier (high 18 000 / balanced 8 000 / low 2 500; 0 when effects
 * are off). Density, opacity, speed and slant follow the scenario's visual intensity
 * (useScenario().visualIntensityMmH → 0–1) with a smooth fade in/out. Under reduced motion the
 * streaks hold still but density still communicates intensity.
 */
export function RainParticles({ count, target, animate }: { count: number; target: number; animate: boolean }) {
  const [rain] = useState(() => new RainSystem());
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => () => rain.dispose(), [rain]);

  useEffect(() => {
    rain.setCount(count);
    invalidate();
  }, [rain, count, invalidate]);

  useEffect(() => {
    invalidate();
  }, [target, invalidate]);

  useFrame((state, dt) => {
    const controls = state.controls as unknown as OrbitControls | null;
    const center = controls?.target ?? ORIGIN;
    const distance = state.camera.position.distanceTo(center);
    if (rain.tick(Math.min(dt, 0.1), count > 0 ? target : 0, center, distance, animate)) state.invalidate();
  });

  return <primitive object={rain.lines} />;
}
