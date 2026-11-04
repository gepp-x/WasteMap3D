/**
 * Imperative animation helpers for the map. These run outside React (no setState per frame):
 *  - tweenFeatureColors: smooth choropleth recolouring via feature-state (MapLibre does not
 *    transition feature-state driven paint, so the interpolation is done here, ≤30 fps).
 *  - createTicker: a throttled rAF loop for decorative motion (flow, pulse) with pause support.
 */
import type { Map as MLMap } from "maplibre-gl";

function hexToRgb(h: string): [number, number, number] | null {
  const s = h.trim().replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
const toHex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

export interface ColorTweenState {
  /** Colour currently applied per feature id (null = no data). */
  applied: Map<number, string | null>;
  cancel: (() => void) | null;
}

export function createColorTweenState(): ColorTweenState {
  return { applied: new Map(), cancel: null };
}

/**
 * Animates each feature's `color` feature-state from what is currently applied to `target`.
 * Features switching to/from "no data" change immediately (absence is not a gradient).
 */
export function tweenFeatureColors(
  map: MLMap,
  source: string,
  target: Map<number, string | null>,
  state: ColorTweenState,
  durationMs: number,
  /** Guard for frames that land during a basemap swap (style not loaded → feature-state unavailable). */
  alive: () => boolean = () => true,
) {
  state.cancel?.();
  state.cancel = null;

  const lerp: { id: number; from: [number, number, number]; to: [number, number, number]; toHex: string }[] = [];
  for (const [id, to] of target) {
    const from = state.applied.get(id);
    if (to === null) {
      map.setFeatureState({ source, id }, { hasValue: false });
      state.applied.set(id, null);
      continue;
    }
    const a = from ? hexToRgb(from) : null;
    const b = hexToRgb(to);
    if (!a || !b || durationMs <= 0 || from === to) {
      map.setFeatureState({ source, id }, { color: to, hasValue: true });
      state.applied.set(id, to);
      continue;
    }
    map.setFeatureState({ source, id }, { hasValue: true });
    lerp.push({ id, from: a, to: b, toHex: to });
  }
  if (!lerp.length) return;

  let raf = 0;
  let last = 0;
  const t0 = performance.now();
  const frame = (now: number) => {
    if (!alive()) {
      state.cancel = null;
      return;
    }
    const t = Math.min(1, (now - t0) / durationMs);
    if (t < 1 && now - last < 32) {
      raf = requestAnimationFrame(frame);
      return;
    }
    last = now;
    const k = easeOutExpo(t);
    for (const x of lerp) {
      const c = t >= 1 ? x.toHex : toHex(x.from.map((v, i) => v + (x.to[i] - v) * k));
      map.setFeatureState({ source, id: x.id }, { color: c });
      state.applied.set(x.id, c);
    }
    if (t < 1) raf = requestAnimationFrame(frame);
    else state.cancel = null;
  };
  raf = requestAnimationFrame(frame);
  state.cancel = () => cancelAnimationFrame(raf);
}

/** Throttled rAF loop (fps cap) that skips work while the tab is hidden. Returns a stop function. */
export function createTicker(fps: number, tick: (now: number, dt: number) => void): () => void {
  let raf = 0;
  let last = 0;
  const interval = 1000 / fps;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (now - last < interval) return;
    const dt = last ? now - last : interval;
    last = now;
    if (typeof document !== "undefined" && document.hidden) return;
    tick(now, dt);
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}
