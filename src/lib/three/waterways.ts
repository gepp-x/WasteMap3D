import type { FeatureCollection, Geometry, Position } from "geojson";
import type { BuildingWindow } from "@/lib/types";
import type { SceneFrame } from "./frame";
import type { RibbonLine } from "./ribbon-geometry";
import { simplifyLine, type P2 } from "./simplify";

/**
 * Waterway inputs for the 3D scene. City scope reads `bundle.waterways` (lon/lat GeoJSON),
 * neighbourhood scope reads `BuildingWindow.water` (local metres). Ribbon widths use the tagged
 * width when present, otherwise a class default, and are clamped to a minimum on-screen width at
 * city scale (canals are exaggerated for legibility — documented in THREE_D_ARCHITECTURE.md).
 */

export type WaterClass = "river" | "canal" | "stream" | "drain";

const DEFAULT_WIDTH_M: Record<WaterClass, number> = { river: 160, canal: 25, stream: 10, drain: 5 };
/** Minimum visual width in scene units at city scope. */
const MIN_VISUAL_CITY: Record<WaterClass, number> = { river: 2.2, canal: 0.75, stream: 0.5, drain: 0.4 };
/** Minimum visual width in metres in the 1 km neighbourhood window. */
const MIN_VISUAL_NBHD: Record<WaterClass, number> = { river: 30, canal: 8, stream: 4, drain: 2.5 };

export function classifyWater(raw: unknown): WaterClass {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("river") || s.includes("แม่น้ำ")) return "river";
  if (s.includes("stream") || s.includes("brook")) return "stream";
  if (s.includes("drain") || s.includes("ditch") || s.includes("culvert")) return "drain";
  return "canal";
}

function propClass(props: Record<string, unknown> | null | undefined): WaterClass {
  if (!props) return "canal";
  return classifyWater(props.waterway ?? props.kind ?? props.type ?? props.class ?? props.fclass ?? props.t ?? "");
}

function propWidth(props: Record<string, unknown> | null | undefined): number | null {
  const w = props?.width;
  const n = typeof w === "number" ? w : typeof w === "string" ? parseFloat(w) : NaN;
  return Number.isFinite(n) && n > 0 && n < 2000 ? n : null;
}

export interface WaterInputs {
  lines: RibbonLine[];
  /** Planar (east, north) rings in scene units. */
  areas: { outer: P2[]; holes?: P2[][] }[];
}

function linesOf(g: Geometry): Position[][] {
  if (g.type === "LineString") return [g.coordinates];
  if (g.type === "MultiLineString") return g.coordinates;
  if (g.type === "GeometryCollection") return g.geometries.flatMap(linesOf);
  return [];
}

function polysOf(g: Geometry): Position[][][] {
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  if (g.type === "GeometryCollection") return g.geometries.flatMap(polysOf);
  return [];
}

export function waterFromGeoJSON(fc: FeatureCollection | null | undefined, frame: SceneFrame): WaterInputs {
  const out: WaterInputs = { lines: [], areas: [] };
  if (!fc?.features) return out;
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const props = f.properties as Record<string, unknown> | null;
    const cls = propClass(props);
    const widthM = propWidth(props) ?? DEFAULT_WIDTH_M[cls];
    const width = Math.max(widthM * frame.scale, MIN_VISUAL_CITY[cls]);
    for (const line of linesOf(f.geometry)) {
      const pts: P2[] = [];
      for (const c of line) if (c.length >= 2) pts.push(frame.toScene(c[0], c[1]));
      const simp = simplifyLine(pts, 0.05);
      if (simp.length >= 2) out.lines.push({ pts: simp, width });
    }
    for (const poly of polysOf(f.geometry)) {
      const rings = poly.map((r) => r.filter((c) => c.length >= 2).map((c) => frame.toPlanar(c[0], c[1])));
      if (rings[0] && rings[0].length >= 3) out.areas.push({ outer: rings[0], holes: rings.slice(1) });
    }
  }
  return out;
}

export function waterFromWindow(win: BuildingWindow): WaterInputs {
  const out: WaterInputs = { lines: [], areas: [] };
  for (const w of win.water ?? []) {
    if (!w.pts || w.pts.length < 2) continue;
    if (w.kind === "area") {
      if (w.pts.length >= 3) out.areas.push({ outer: w.pts.map(([e, n]) => [e, n] as P2) });
    } else {
      const cls = classifyWater(w.t);
      out.lines.push({
        pts: w.pts.map(([e, n]) => [e, -n] as P2),
        width: Math.max(DEFAULT_WIDTH_M[cls] * 0.6, MIN_VISUAL_NBHD[cls]),
      });
    }
  }
  return out;
}
