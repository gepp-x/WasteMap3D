"use client";

import { useEffect, useState, type ReactNode } from "react";
import { motion, type Variants } from "motion/react";
import { EASE, STAGGER } from "@/lib/animation/tokens";
import { useDashboard } from "@/store/dashboard-store";

/**
 * Entrance choreography (first load only, ≤ 1.2 s total, never blocks interaction):
 *
 *   t=0.00  header fades + slides down 10 px            (0.50 s)
 *   t=0.05  left column slides in from −12 px            (0.50 s)
 *   t=0.10  stage resolves from a 14 px blur + 1.2 % scale (0.90 s → done at ~1.0 s)
 *   t=0.15  right column slides in from +12 px
 *   t=0.20  timeline / dock rise 12 px
 *   KPI cards stagger on their own group (0.05 s apart, 0.45 s each, done ≤ 1.1 s).
 *
 * Only opacity / transform / filter are animated (compositor-friendly). Skipped entirely when the
 * OS or the user asks for reduced motion, and on any re-mount after the first play (e.g. a
 * breakpoint change) — the shell then appears instantly.
 */

let entrancePlayed = false;

export type EntranceKind = "header" | "left" | "stage" | "right" | "dock" | "card" | "fade";

const ROOT: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: STAGGER, delayChildren: 0.02 } },
};

const ITEM: Record<EntranceKind, Variants> = {
  header: {
    hidden: { opacity: 0, y: -10 },
    show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE.outExpo } },
  },
  left: {
    hidden: { opacity: 0, x: -12 },
    show: { opacity: 1, x: 0, transition: { duration: 0.5, ease: EASE.outExpo } },
  },
  right: {
    hidden: { opacity: 0, x: 12 },
    show: { opacity: 1, x: 0, transition: { duration: 0.5, ease: EASE.outExpo } },
  },
  stage: {
    hidden: { opacity: 0, scale: 1.012, filter: "blur(14px)" },
    show: { opacity: 1, scale: 1, filter: "blur(0px)", transition: { duration: 0.9, ease: EASE.outExpo }, transitionEnd: { filter: "none" } },
  },
  dock: {
    hidden: { opacity: 0, y: 12 },
    show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE.outExpo } },
  },
  card: {
    hidden: { opacity: 0, y: 8 },
    show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE.outExpo } },
  },
  fade: {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { duration: 0.4, ease: EASE.standard } },
  },
};

/** Reads both the user setting and the OS preference synchronously (no first-frame flash). */
function useSkipEntrance() {
  const userReduced = useDashboard((s) => s.reducedMotion);
  const [skip] = useState(
    () => entrancePlayed || (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches),
  );
  return skip || userReduced;
}

/** Root of the choreography: children using <EntranceItem> inherit the stagger. */
export function EntranceRoot({ children, className }: { children: ReactNode; className?: string }) {
  const skip = useSkipEntrance();
  useEffect(() => {
    entrancePlayed = true;
  }, []);
  return (
    <motion.div className={className} variants={ROOT} initial={skip ? false : "hidden"} animate="show">
      {children}
    </motion.div>
  );
}

/** A choreographed element. Must be rendered inside an EntranceRoot or EntranceGroup. */
export function EntranceItem({
  kind = "fade",
  children,
  className,
  id,
  as = "div",
}: {
  kind?: EntranceKind;
  children: ReactNode;
  className?: string;
  id?: string;
  as?: "div" | "section" | "main" | "header" | "aside";
}) {
  const Comp = motion[as];
  return (
    <Comp id={id} className={className} variants={ITEM[kind]}>
      {children}
    </Comp>
  );
}

/**
 * Independent stagger group (KPI cards). `replayKey` re-runs the stagger when content swaps from
 * skeleton to data; the first-load rule and reduced motion still apply.
 */
export function EntranceGroup({
  children,
  className,
  stagger = STAGGER,
  delay = 0.12,
  replayKey,
  role,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
  delay?: number;
  replayKey?: string;
  role?: string;
  ariaLabel?: string;
}) {
  const skip = useSkipEntrance();
  return (
    <motion.div
      key={replayKey}
      role={role}
      aria-label={ariaLabel}
      className={className}
      variants={{ hidden: {}, show: { transition: { staggerChildren: stagger, delayChildren: delay } } }}
      initial={skip ? false : "hidden"}
      animate="show"
    >
      {children}
    </motion.div>
  );
}
