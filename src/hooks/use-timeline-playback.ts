"use client";

import { useEffect, useEffectEvent } from "react";
import { useDashboard, type TimelineMode } from "@/store/dashboard-store";
import { useReducedMotionPref } from "@/lib/animation/tokens";

/* ------------------------------------------------------------------ */
/*  Pure timeline / playback helpers (unit-tested, no React, no I/O)  */
/* ------------------------------------------------------------------ */

/**
 * Playback rates at 1× in timeline units per second.
 *  - historical: 8 days per second (0.5× ≈ 4, 2× ≈ 16, 4× ≈ 32 days/s)
 *  - scenario:   4 hyetograph steps (15 min each) per second = 1 simulated hour per second at 1×
 */
export const PLAYBACK_BASE_RATE: Record<TimelineMode, number> = { historical: 8, scenario: 4 };

/** Maximum frequency at which playback commits a new index to the store (~15 Hz). */
export const COMMIT_INTERVAL_MS = 1000 / 15;

/** Under reduced motion playback advances in discrete ticks instead of a continuous sweep. */
export const REDUCED_TICK_MS = 600;

/** Long frames (tab switch, GC pause) are clamped so playback never leaps ahead. */
export const MAX_FRAME_MS = 250;

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof SPEEDS)[number];

/** Next speed in the 0.5× → 1× → 2× → 4× → 0.5× cycle. */
export function nextSpeed(s: PlaybackSpeed): PlaybackSpeed {
  const i = SPEEDS.indexOf(s);
  return SPEEDS[(i + 1) % SPEEDS.length];
}

export function playbackRate(mode: TimelineMode, speed: number): number {
  return PLAYBACK_BASE_RATE[mode] * speed;
}

export const clampIndex = (i: number, min: number, max: number) => (i < min ? min : i > max ? max : i);

/** Advance a fractional playhead by one frame. Ends (and pins) at `lastIndex`. */
export function advancePosition(pos: number, dtMs: number, unitsPerSecond: number, lastIndex: number, maxDtMs = MAX_FRAME_MS): { pos: number; ended: boolean } {
  const dt = Math.max(0, Math.min(dtMs, maxDtMs));
  const next = pos + (dt / 1000) * unitsPerSecond;
  if (next >= lastIndex) return { pos: lastIndex, ended: true };
  return { pos: next, ended: false };
}

/** Whole-unit jump per reduced-motion tick (never less than one unit). */
export function reducedStepSize(unitsPerSecond: number, tickMs = REDUCED_TICK_MS): number {
  return Math.max(1, Math.round((unitsPerSecond * tickMs) / 1000));
}

/** Where playback starts: the current index, or `minIndex` when unset / before the start / already at the end. */
export function startPosition(index: number | null, minIndex: number, lastIndex: number): number {
  if (index === null || !Number.isFinite(index) || index < minIndex || index >= lastIndex) return minIndex;
  return index;
}

/** Keyboard stepping. From an unset position, forward starts at the beginning and backward at the end. */
export function stepIndex(current: number | null, delta: number, min: number, max: number): number {
  if (current === null) return delta >= 0 ? min : max;
  return clampIndex(current + delta, min, max);
}

/** Index for a pointer position along a track of `width` px. */
export function indexFromRatio(ratio: number, min: number, max: number): number {
  const r = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return clampIndex(Math.round(min + r * (max - min)), min, max);
}

/**
 * City-mean daily series: per date, the mean of the non-null area values.
 * Dates where every area is null stay null (rendered "Unavailable", never 0).
 */
export function cityMeanSeries(series: { values: (number | null)[] }[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    let n = 0;
    for (const s of series) {
      const v = s.values[i];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    out[i] = n ? Math.round((sum / n) * 10) / 10 : null;
  }
  return out;
}

/** First index ≥ `fromIso` and last index ≤ `toIso` in an ascending ISO date list (null when the range misses the list). */
export function dateIndexRange(dates: string[], fromIso: string, toIso: string): [number, number] | null {
  const from = fromIso.slice(0, 10);
  const to = toIso.slice(0, 10);
  let a = -1;
  let b = -1;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i].slice(0, 10);
    if (a === -1 && d >= from) a = i;
    if (d <= to) b = i;
  }
  if (a === -1 || b === -1 || b < a) return null;
  return [a, b];
}

/** Index of the largest non-null value in [from, to]; falls back to `from` when all values are null. */
export function peakIndexInRange(values: (number | null)[], from: number, to: number): number {
  let best = from;
  let bestV = -Infinity;
  for (let i = from; i <= to && i < values.length; i++) {
    const v = values[i];
    if (v !== null && v !== undefined && v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return best;
}

/** Hours since storm start → "hh:mm". */
export function formatElapsed(hours: number): string {
  const totalMin = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export interface PlaybackConfig {
  /** When false the loop never runs and any running playback is stopped. */
  enabled: boolean;
  /** Number of positions on the timeline. */
  length: number;
  /** First playable index (historical: 0, simulated event: 1 — step 0 is the full-storm summary). */
  minIndex: number;
  /** Timeline units per second at 1× (see PLAYBACK_BASE_RATE). */
  unitsPerSecond: number;
  /** Non-reactive read of the committed index (e.g. `useDashboard.getState().dateIndex`). */
  read: () => number | null;
  /** Commit an index to the store (called at most ~15 Hz). */
  write: (i: number) => void;
  /** Per-frame fractional playhead for direct DOM updates — never set React state here. */
  onFrame?: (pos: number) => void;
}

/**
 * requestAnimationFrame playback driven by `store.playing` / `store.playbackSpeed`.
 *
 * - All per-frame state lives in closure variables (no React state at frame rate).
 * - Store commits are throttled to ~15 Hz and only when the integer index changes.
 * - External scrubs during playback are adopted on the next frame.
 * - Stops at the end, pauses when the tab is hidden, and under reduced motion advances
 *   in discrete ticks (REDUCED_TICK_MS) instead of a continuous sweep.
 */
export function useTimelinePlayback(cfg: PlaybackConfig) {
  const playing = useDashboard((s) => s.playing);
  const speed = useDashboard((s) => s.playbackSpeed);
  const reduced = useReducedMotionPref();
  const { enabled, length, minIndex, unitsPerSecond } = cfg;

  const readIndex = useEffectEvent(() => cfg.read());
  const writeIndex = useEffectEvent((i: number) => cfg.write(i));
  const frame = useEffectEvent((pos: number) => cfg.onFrame?.(pos));

  useEffect(() => {
    if (playing && (!enabled || length < 2)) useDashboard.getState().setPlaying(false);
  }, [enabled, playing, length]);

  useEffect(() => {
    if (!enabled || !playing || length < 2) return;
    const last = length - 1;
    const rate = unitsPerSecond * speed;
    const stop = () => useDashboard.getState().setPlaying(false);

    let pos = startPosition(readIndex(), minIndex, last);
    let committed = Math.floor(pos);
    if (readIndex() !== committed) writeIndex(committed);
    frame(pos);

    let raf = 0;
    let timer = 0;
    let prevT = performance.now();
    let lastCommitT = prevT;

    /** Adopt a scrub made by the user while playing. */
    const adoptExternal = () => {
      const ext = readIndex();
      if (ext !== null && ext !== committed) {
        pos = ext;
        committed = ext;
      }
    };

    if (reduced) {
      const jump = reducedStepSize(rate);
      timer = window.setInterval(() => {
        adoptExternal();
        const next = Math.min(last, committed + jump);
        pos = next;
        committed = next;
        writeIndex(next);
        frame(next);
        if (next >= last) stop();
      }, REDUCED_TICK_MS);
    } else {
      const tick = (t: number) => {
        adoptExternal();
        const r = advancePosition(pos, t - prevT, rate, last);
        prevT = t;
        pos = r.pos;
        frame(pos);
        if (r.ended) {
          if (committed !== last) writeIndex(last);
          committed = last;
          stop();
          return;
        }
        const idx = Math.floor(pos);
        if (idx !== committed && t - lastCommitT >= COMMIT_INTERVAL_MS) {
          committed = idx;
          lastCommitT = t;
          writeIndex(idx);
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    const onVisibility = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, playing, length, minIndex, unitsPerSecond, speed, reduced]);

  return { playing, speed, reduced };
}
