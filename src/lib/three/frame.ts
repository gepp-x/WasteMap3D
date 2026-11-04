import type { City } from "@/lib/types";
import { makeProjector, type LocalProjector } from "@/lib/geo/local";

/**
 * Scene frames — how geographic coordinates become Three.js positions.
 *
 * Geographic lon/lat are never used as positions. Each scope picks an origin close to its content,
 * projects to local ENU metres with `makeProjector` and applies a uniform scale:
 *
 *   city scope          origin = CITIES[id].center, scale chosen so the city bbox spans ≈ ±280 units
 *                       (Bangkok ≈ 1 unit : 118 m, Hat Yai ≈ 1 unit : 16 m)
 *   neighborhood scope  origin = BuildingWindow.origin, 1 unit = 1 m (window ±500 m)
 *
 * Both keep vertex magnitudes < ~1 000 so float32 precision stays sub-centimetre at neighbourhood
 * scale and the same camera / fog / rain tuning works for both scopes.
 *
 * Three.js convention: x = east, y = up, z = −north.
 */

export const CITY_HALF_EXTENT = 280;
export const DEFAULT_WINDOW_HALF_M = 500;

export type FrameKind = "city" | "neighborhood";

export interface SceneFrame {
  /** Stable cache key (changes when the frame changes). */
  key: string;
  kind: FrameKind;
  origin: [number, number];
  /** Scene units per metre. */
  scale: number;
  /** Metres represented by one scene unit (display only). */
  metresPerUnit: number;
  /** Half extent of the content in scene units. */
  half: number;
  /** Scene-space centre of the content ([x, z]) — the camera's natural target. */
  center: [number, number];
  projector: LocalProjector;
  /** lon/lat → scene [x, z]. */
  toScene: (lon: number, lat: number) => [number, number];
  /** lon/lat → scaled planar [east, north] (shape space, before the −90° X rotation). */
  toPlanar: (lon: number, lat: number) => [number, number];
  /** Grid spacing in scene units (minor / major) and the minor spacing in metres for the legend. */
  grid: { minor: number; major: number; minorM: number };
}

const GRID_STEPS_M = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000];

function gridFor(half: number, scale: number) {
  const want = half * 0.035;
  const minorM = GRID_STEPS_M.find((m) => m * scale >= want) ?? GRID_STEPS_M[GRID_STEPS_M.length - 1];
  const minor = minorM * scale;
  return { minor, major: minor * 5, minorM };
}

function makeFrame(key: string, kind: FrameKind, origin: [number, number], scale: number, half: number, center: [number, number]): SceneFrame {
  const projector = makeProjector(origin);
  return {
    key,
    kind,
    origin,
    scale,
    metresPerUnit: 1 / scale,
    half,
    center,
    projector,
    toScene: (lon, lat) => projector.toScene(lon, lat, scale),
    toPlanar: (lon, lat) => {
      const [e, n] = projector.toLocal(lon, lat);
      return [e * scale, n * scale];
    },
    grid: gridFor(half, scale),
  };
}

/** City overview frame: origin at the city centre, scale fitted to the city bbox. */
export function cityFrame(city: City): SceneFrame {
  const [w, s, e, n] = city.bbox;
  const p = makeProjector(city.center);
  const [x0, y0] = p.toLocal(w, s);
  const [x1, y1] = p.toLocal(e, n);
  const halfM = Math.max(x1 - x0, y1 - y0) / 2;
  const scale = CITY_HALF_EXTENT / Math.max(halfM, 1);
  // bbox centre in scene space (x = east, z = −north)
  const center: [number, number] = [((x0 + x1) / 2) * scale, -((y0 + y1) / 2) * scale];
  return makeFrame(`city:${city.id}`, "city", city.center, scale, CITY_HALF_EXTENT, center);
}

/** Neighbourhood frame: origin at the building window origin, 1 unit = 1 m. */
export function neighborhoodFrame(areaId: string, origin: [number, number], halfSizeM: number): SceneFrame {
  const half = Math.max(100, halfSizeM);
  return makeFrame(`nbhd:${areaId}:${origin[0].toFixed(5)},${origin[1].toFixed(5)}:${half}`, "neighborhood", origin, 1, half, [0, 0]);
}

/** Formats a grid spacing in metres for the legend. */
export function gridLabel(minorM: number, lang: "th" | "en") {
  if (minorM >= 1000) {
    const km = minorM / 1000;
    return lang === "th" ? `${km} กม.` : `${km} km`;
  }
  return lang === "th" ? `${minorM} ม.` : `${minorM} m`;
}
