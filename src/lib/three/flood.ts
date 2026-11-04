import type { ScenarioState } from "@/lib/simulation/use-scenario";
import type { ThreeScope } from "@/store/dashboard-store";

/**
 * Illustrative 3D flood policy (visual metaphor only — never a depth prediction).
 *
 * Water is shown ONLY when a scenario or a historical replay is active AND the modelled risk class
 * of the relevant area(s) is High or Very High:
 *   city scope          → the highest-risk High/Very High areas (capped), water band at prism bases
 *   neighbourhood scope → the selected area, translucent sheet across the building window
 *
 * The visual level is a monotonic mapping of the 0–100 risk score (50 → low band, 100 → tallest
 * band); no numeric depth is ever derived or displayed.
 */

export interface FloodTarget {
  id: string;
  score: number;
  /** 0 (score 50) → 1 (score 100). */
  level01: number;
}

export const FLOOD_MIN_SCORE = 50;
export const MAX_CITY_FLOOD_AREAS = 12;

const level01 = (score: number) => Math.min(1, Math.max(0, (score - FLOOD_MIN_SCORE) / (100 - FLOOD_MIN_SCORE)));

export function floodTargets(s: ScenarioState, scope: ThreeScope, selectedId: string | null): FloodTarget[] {
  if (!s.ready || s.source === "baseline") return [];
  if (scope === "neighborhood") {
    if (!selectedId) return [];
    const a = s.byId.get(selectedId);
    const score = a?.current.score ?? null;
    if (score === null || score < FLOOD_MIN_SCORE) return [];
    return [{ id: selectedId, score, level01: level01(score) }];
  }
  return s.list
    .filter((a) => a.current.score !== null && a.current.score >= FLOOD_MIN_SCORE)
    .sort((a, b) => (b.current.score ?? 0) - (a.current.score ?? 0))
    .slice(0, MAX_CITY_FLOOD_AREAS)
    .map((a) => ({ id: a.area.id, score: a.current.score!, level01: level01(a.current.score!) }));
}

/** Visual water level (scene units) for a target in the given scope. */
export function visualLevel(t: FloodTarget, scope: ThreeScope) {
  return scope === "neighborhood" ? 0.5 + t.level01 * 1.6 : 0.9 + t.level01 * 3.6;
}
