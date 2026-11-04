"use client";

import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { formatNumber } from "@/lib/formatters";
import { useLang } from "@/lib/i18n";
import { DURATION, EASE, useReducedMotionPref } from "@/lib/animation/tokens";

interface Props {
  value: number | null;
  decimals?: number;
  compact?: boolean;
  /** Seconds. Defaults to the scenario token so synced updates land together. */
  duration?: number;
  className?: string;
  /** Briefly highlight when the value changes (KPI feedback). */
  flash?: boolean;
  /** Text shown when value is null (defaults to localized "Unavailable"). */
  nullText?: string;
}

const finiteOrNull = (v: number | null) => (v !== null && Number.isFinite(v) ? v : null);

/**
 * Tweens from the previous value to the next (never random); null renders as "Unavailable", never 0.
 * Respects reduced motion by jumping straight to the final value.
 *
 * The tween writes a MotionValue that Motion renders as the span's text directly, so a running
 * tween never re-renders React (no setState at frame rate).
 */
export function AnimatedNumber({ value, decimals = 0, compact = false, duration = DURATION.scenario, className, flash = true, nullText }: Props) {
  const lang = useLang();
  const reduced = useReducedMotionPref();
  const target = finiteOrNull(value);
  const mv = useMotionValue(target ?? 0);
  // re-evaluated on every render, so language / format changes apply immediately
  const display = useTransform(mv, (v) => formatNumber(v, lang, decimals, compact));
  const prev = useRef<number | null>(target);

  // Flash feedback: adjust state while rendering when the value changes (React's "previous value" pattern).
  const [seen, setSeen] = useState<number | null>(target);
  const [pulse, setPulse] = useState(0);
  if (!Object.is(seen, target)) {
    setSeen(target);
    if (flash && !reduced && seen !== null && target !== null) setPulse((p) => p + 1);
  }

  useEffect(() => {
    if (target === null) {
      prev.current = null;
      return;
    }
    const from = prev.current;
    prev.current = target;
    if (from === null || reduced || from === target) {
      mv.set(target);
      return;
    }
    const controls = animate(mv, target, { duration, ease: EASE.outExpo });
    return () => controls.stop();
  }, [target, duration, reduced, mv]);

  return (
    <motion.span
      key={pulse}
      className={className}
      // CSS keyframes (not a Motion colour tween): "currentColor" is not animatable by Motion, and the
      // keyframe's implicit end state is whatever colour the element inherits.
      style={pulse && !reduced ? { animation: `ui-num-flash 1.1s cubic-bezier(${EASE.standard.join(",")})` } : undefined}
      aria-live="polite"
    >
      {target === null ? (nullText ?? formatNumber(null, lang, decimals, compact)) : display}
    </motion.span>
  );
}
