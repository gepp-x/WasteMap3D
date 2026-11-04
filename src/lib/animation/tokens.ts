"use client";

import { useEffect, useState } from "react";
import { useDashboard } from "@/store/dashboard-store";

/** Motion tokens (seconds) — mirrored as CSS vars in globals.css. */
export const DURATION = {
  fast: 0.15, // feedback: hover, press, toggle
  ui: 0.24, // tabs, tooltips, small layout changes
  panel: 0.32, // drawers, sheets, panel collapse
  scenario: 0.7, // synchronized scenario update (KPI, colours, charts)
  camera: 1.6, // geographic camera moves (context dependent)
  cityFlight: 2.4,
} as const;

/** Cubic-bezier easings for Motion (arrays) and matching GSAP names. */
export const EASE = {
  outExpo: [0.16, 1, 0.3, 1] as [number, number, number, number],
  standard: [0.2, 0, 0, 1] as [number, number, number, number],
  inOut: [0.65, 0, 0.35, 1] as [number, number, number, number],
} as const;

export const GSAP_EASE = {
  camera: "power3.inOut",
  out: "expo.out",
  standard: "power2.out",
} as const;

export const SPRING = {
  snappy: { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.8 },
  gentle: { type: "spring" as const, stiffness: 220, damping: 28 },
};

/** Stagger for entrance choreography (s). */
export const STAGGER = 0.05;

/** True when the OS asks for reduced motion OR the user disabled motion in Settings. */
export function useReducedMotionPref() {
  const userPref = useDashboard((s) => s.reducedMotion);
  const [os, setOs] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setOs(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return userPref || os;
}

/** Scale a duration to ~0 when reduced motion is requested. */
export const motionDuration = (d: number, reduced: boolean) => (reduced ? 0.001 : d);
