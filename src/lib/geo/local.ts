/**
 * Local tangent-plane (ENU) projection for the 3D scene.
 *
 * Geographic coordinates are never used directly as mesh positions: every 3D
 * scene picks an origin near the content (city centre or area anchor) and
 * converts lon/lat to metres east/north of it. This keeps vertex values small
 * (no float32 precision jitter) and keeps map ↔ 3D placement consistent.
 *
 * Accuracy: equirectangular approximation, error < 0.1 % within ~30 km of the origin —
 * adequate for Bangkok (~45 km across) at overview scale and exact enough for 1 km windows.
 *
 * Three.js convention used throughout: x = east, y = up, z = −north.
 */

export const M_PER_DEG_LAT = 110574;
export const M_PER_DEG_LON_EQ = 111320;

export interface LocalProjector {
  origin: [number, number];
  /** lon/lat → [east, north] metres */
  toLocal: (lon: number, lat: number) => [number, number];
  /** [east, north] metres → lon/lat */
  toLonLat: (x: number, y: number) => [number, number];
  /** lon/lat → Three.js [x, z] (z = −north) scaled by `scale` (scene units per metre). */
  toScene: (lon: number, lat: number, scale?: number) => [number, number];
}

export function makeProjector(origin: [number, number]): LocalProjector {
  const [lon0, lat0] = origin;
  const kx = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG_LON_EQ;
  const ky = M_PER_DEG_LAT;
  return {
    origin,
    toLocal: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: (x, y) => [lon0 + x / kx, lat0 + y / ky],
    toScene: (lon, lat, scale = 1) => [(lon - lon0) * kx * scale, -(lat - lat0) * ky * scale],
  };
}

/** Haversine distance in metres. */
export function distanceM(a: [number, number], b: [number, number]) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
