"use client";

/**
 * Scenario transition choreography — one coordinated "environmental update".
 *
 * Every scenario change (preset, slider, reset, activate/deactivate) bumps `store.scenarioNonce`.
 * Sliders can bump it every animation frame while dragging, so modules must NOT animate on the raw
 * nonce. Instead they subscribe to the debounced *scenario pulse* exported here:
 *
 *   - leading edge: fires immediately when the scenario changes after ≥ 700 ms of calm
 *     (a preset click pulses in the same frame its numbers start tweening);
 *   - trailing edge: during a burst (slider drag) one more pulse fires 220 ms after the last change.
 *
 * All subscribers share one module-level subscription, so the map, 3D scene, KPI tiles, charts and
 * the stage sweep (SimulationBanner) pulse on exactly the same tick. No provider is needed.
 *
 * Usage for other modules:
 *
 *   const pulse = useScenarioPulse();          // number, increments per debounced scenario change
 *   useOnScenarioPulse(() => flashLegend());   // imperative callback (not on mount)
 *   <ScenarioPulse>{kpiTile}</ScenarioPulse>   // brief hairline highlight around children
 *
 * Reduced motion and `store.effectsEnabled === false` suppress the visual highlight (values still update).
 * Timing tokens: DURATION.scenario (0.7 s) for value tweens; the highlight itself is 0.7 s.
 */

import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { motion } from "motion/react";
import { useDashboard } from "@/store/dashboard-store";
import { DURATION, EASE, useReducedMotionPref } from "@/lib/animation/tokens";
import { cn } from "@/lib/utils";

export const SCENARIO_PULSE_TIMING = {
  /** Calm period after which the next change pulses immediately (ms). */
  leadingGapMs: 700,
  /** Quiet period after the last change of a burst before the trailing pulse (ms). */
  trailingMs: 220,
} as const;

type Listener = () => void;

let pulseValue = 0;
let lastFireAt = Number.NEGATIVE_INFINITY;
let trailingTimer: number | null = null;
let unsubscribeStore: (() => void) | null = null;
const listeners = new Set<Listener>();

function firePulse() {
  trailingTimer = null;
  lastFireAt = performance.now();
  pulseValue += 1;
  for (const l of listeners) l();
}

function onScenarioNonce() {
  const now = performance.now();
  if (trailingTimer === null && now - lastFireAt >= SCENARIO_PULSE_TIMING.leadingGapMs) {
    firePulse();
    return;
  }
  if (trailingTimer !== null) window.clearTimeout(trailingTimer);
  trailingTimer = window.setTimeout(firePulse, SCENARIO_PULSE_TIMING.trailingMs);
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  if (!unsubscribeStore) {
    let lastNonce = useDashboard.getState().scenarioNonce;
    unsubscribeStore = useDashboard.subscribe((s) => {
      if (s.scenarioNonce === lastNonce) return;
      lastNonce = s.scenarioNonce;
      onScenarioNonce();
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unsubscribeStore) {
      unsubscribeStore();
      unsubscribeStore = null;
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
      trailingTimer = null;
    }
  };
}

const getSnapshot = () => pulseValue;
const getServerSnapshot = () => 0;

/** Debounced scenario pulse counter (increments once per coordinated scenario update). */
export function useScenarioPulse(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Run `callback` on every scenario pulse after mount (never on the initial render). */
export function useOnScenarioPulse(callback: (pulse: number) => void) {
  const pulse = useScenarioPulse();
  const mountedAt = useRef(pulse);
  const run = useEffectEvent(callback);
  useEffect(() => {
    if (pulse === mountedAt.current) return;
    run(pulse);
  }, [pulse]);
}

/** True when decorative scenario motion should play (motion allowed and effects enabled). */
export function useScenarioEffectsEnabled() {
  const reduced = useReducedMotionPref();
  const effects = useDashboard((s) => s.effectsEnabled);
  return effects && !reduced;
}

/**
 * Wraps children and briefly outlines them (cyan → violet hairline + faint wash) on each scenario pulse,
 * so a KPI or chart visibly participates in the same update as the map and 3D scene.
 */
export function ScenarioPulse({ children, className, rounded = "rounded-[10px]", inset = 0 }: { children: ReactNode; className?: string; rounded?: string; inset?: number }) {
  const pulse = useScenarioPulse();
  // Pulse value at mount: the highlight only plays for pulses that happen while mounted.
  const [mountPulse] = useState(pulse);
  const enabled = useScenarioEffectsEnabled();
  const show = enabled && pulse !== mountPulse;
  return (
    <div className={cn("relative", className)}>
      {children}
      {show && (
        <motion.span
          key={pulse}
          aria-hidden
          className={cn("pointer-events-none absolute", rounded)}
          style={{
            inset,
            boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--ui-cyan) 70%, transparent), 0 0 0 1px color-mix(in srgb, var(--ui-violet) 25%, transparent)",
            background: "linear-gradient(90deg, color-mix(in srgb, var(--ui-cyan) 7%, transparent), color-mix(in srgb, var(--ui-violet) 6%, transparent))",
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={{ duration: DURATION.scenario, ease: EASE.standard, times: [0, 0.25, 1] }}
        />
      )}
    </div>
  );
}
