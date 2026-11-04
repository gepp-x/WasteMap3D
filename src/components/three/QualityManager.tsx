"use client";

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { useDashboard } from "@/store/dashboard-store";
import { stepTier, type QualityTier } from "@/lib/three/quality";

/**
 * Quality tier management.
 *  - explicit mode (high / balanced / low) → tier set directly
 *  - auto → starts at the probed tier; drei PerformanceMonitor steps it down/up (never above the
 *    probed ceiling) — mounted only while the canvas renders continuously, because on-demand
 *    frames are sparse by design and would read as "low fps".
 * Also adapts DPR to R3F's performance regression (OrbitControls `regress`) relative to the
 * CURRENT tier's DPR range (drei's AdaptiveDpr restores the creation-time DPR, which would undo
 * tier changes).
 */
export function QualityManager({ continuous, dpr, ceiling }: { continuous: boolean; dpr: [number, number]; ceiling: QualityTier }) {
  const quality = useDashboard((s) => s.quality);

  useEffect(() => {
    const s = useDashboard.getState();
    s.setQualityTier(quality === "auto" ? ceiling : quality);
  }, [quality, ceiling]);

  return (
    <>
      <TierAdaptiveDpr min={dpr[0]} max={dpr[1]} />
      {quality === "auto" && continuous && (
        <PerformanceMonitor
          ms={400}
          iterations={8}
          threshold={0.75}
          flipflops={4}
          bounds={(refresh) => (refresh > 90 ? [50, 85] : [38, 55])}
          onDecline={() => {
            const s = useDashboard.getState();
            s.setQualityTier(stepTier(s.qualityTier, -1));
          }}
          onIncline={() => {
            const s = useDashboard.getState();
            s.setQualityTier(stepTier(s.qualityTier, 1, ceiling));
          }}
          onFallback={() => useDashboard.getState().setQualityTier("low")}
        />
      )}
    </>
  );
}

function TierAdaptiveDpr({ min, max }: { min: number; max: number }) {
  const current = useThree((s) => s.performance.current);
  const setDpr = useThree((s) => s.setDpr);
  useEffect(() => {
    const device = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const base = Math.min(Math.max(device, min), max);
    setDpr(Math.max(0.5, base * current));
  }, [current, min, max, setDpr]);
  return null;
}
