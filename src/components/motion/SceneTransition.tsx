"use client";

import type { ReactNode } from "react";
import { motion, type MotionStyle } from "motion/react";
import { cn } from "@/lib/utils";
import { DURATION, EASE, motionDuration, useReducedMotionPref } from "@/lib/animation/tokens";

/**
 * A stage layer (2D map or 3D twin) that stays mounted and cross-fades in/out:
 * opacity + a 1.5 % scale settle + a soft blur, ~DURATION.panel.
 *
 * Hidden layers become `visibility: hidden` *after* the fade and `inert`, so they leave the tab
 * order and stop receiving pointer events, while their WebGL contexts and sizes are preserved
 * (no resize / re-initialisation when switching back).
 */
export function SceneLayer({
  visible,
  label,
  className,
  style,
  children,
}: {
  visible: boolean;
  label: string;
  className?: string;
  style?: MotionStyle;
  children: ReactNode;
}) {
  const reduced = useReducedMotionPref();
  const d = motionDuration(DURATION.panel, reduced);
  return (
    <motion.section
      aria-label={label}
      aria-hidden={!visible}
      inert={!visible}
      className={cn("absolute top-0 bottom-0 overflow-hidden", !visible && "pointer-events-none", className)}
      style={style}
      initial={false}
      animate={
        visible
          ? { opacity: 1, scale: 1, filter: "blur(0px)", visibility: "visible", transitionEnd: { filter: "none" } }
          : { opacity: 0, scale: reduced ? 1 : 0.985, filter: reduced ? "none" : "blur(6px)", transitionEnd: { visibility: "hidden" } }
      }
      transition={{ duration: d, ease: EASE.standard }}
    >
      {children}
    </motion.section>
  );
}
