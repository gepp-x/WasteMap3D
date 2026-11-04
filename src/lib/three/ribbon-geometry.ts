import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { cleanRing, type P2 } from "./simplify";

/**
 * Flat ribbons for linear features (waterways, roads) and flat polygons (water areas).
 *
 * Ribbons are built in scene XZ with mitred joins. `uv.x` carries the cumulative length along the
 * line in scene units (drives the flow shader, so streaks travel in the digitised direction — OSM
 * waterways are drawn downstream), `uv.y` runs 0 → 1 across the ribbon (soft edges in the shader).
 * All lines are merged into ONE indexed BufferGeometry → one draw call per feature class.
 */

export interface RibbonLine {
  /** Scene-space points [x, z]. */
  pts: P2[];
  /** Full width in scene units. */
  width: number;
  /** Optional linear-RGB colour (vertex colour). */
  color?: THREE.Color;
}

const MITER_LIMIT = 2.5;

export function buildRibbons(lines: RibbonLine[], y: number): THREE.BufferGeometry | null {
  const prepared: { pts: P2[]; width: number; color?: THREE.Color }[] = [];
  let vCount = 0;
  let iCount = 0;
  let withColor = false;
  for (const l of lines) {
    const pts: P2[] = [];
    for (const p of l.pts) {
      const prev = pts[pts.length - 1];
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      if (prev && Math.abs(prev[0] - p[0]) < 1e-5 && Math.abs(prev[1] - p[1]) < 1e-5) continue;
      pts.push(p);
    }
    if (pts.length < 2 || !(l.width > 0)) continue;
    prepared.push({ pts, width: l.width, color: l.color });
    if (l.color) withColor = true;
    vCount += pts.length * 2;
    iCount += (pts.length - 1) * 6;
  }
  if (!vCount) return null;

  const pos = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const col = withColor ? new Float32Array(vCount * 3) : null;
  const index = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let v = 0;
  let ii = 0;

  for (const { pts, width, color } of prepared) {
    const half = width / 2;
    const base = v;
    let dist = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // segment normals (left-hand perpendicular in XZ)
      let nx = 0;
      let nz = 0;
      let scale = 1;
      const prev = pts[i - 1];
      const next = pts[i + 1];
      let n1x = 0,
        n1z = 0,
        n2x = 0,
        n2z = 0;
      if (prev) {
        const dx = p[0] - prev[0];
        const dz = p[1] - prev[1];
        const len = Math.hypot(dx, dz) || 1;
        n1x = -dz / len;
        n1z = dx / len;
        dist += len;
      }
      if (next) {
        const dx = next[0] - p[0];
        const dz = next[1] - p[1];
        const len = Math.hypot(dx, dz) || 1;
        n2x = -dz / len;
        n2z = dx / len;
      }
      if (prev && next) {
        nx = n1x + n2x;
        nz = n1z + n2z;
        const l = Math.hypot(nx, nz);
        if (l < 1e-6) {
          nx = n2x;
          nz = n2z;
        } else {
          nx /= l;
          nz /= l;
          const d = nx * n2x + nz * n2z;
          scale = Math.min(MITER_LIMIT, 1 / Math.max(d, 1e-3));
        }
      } else if (prev) {
        nx = n1x;
        nz = n1z;
      } else {
        nx = n2x;
        nz = n2z;
      }
      const ox = nx * half * scale;
      const oz = nz * half * scale;
      // left (v = 0) then right (v = 1)
      pos[v * 3] = p[0] + ox;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = p[1] + oz;
      uv[v * 2] = dist;
      uv[v * 2 + 1] = 0;
      pos[(v + 1) * 3] = p[0] - ox;
      pos[(v + 1) * 3 + 1] = y;
      pos[(v + 1) * 3 + 2] = p[1] - oz;
      uv[(v + 1) * 2] = dist;
      uv[(v + 1) * 2 + 1] = 1;
      if (col) {
        const c = color ?? WHITE;
        col.set([c.r, c.g, c.b, c.r, c.g, c.b], v * 3);
      }
      v += 2;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      // upward-facing winding (see docs/THREE_D_ARCHITECTURE.md)
      index[ii++] = a;
      index[ii++] = c;
      index[ii++] = b;
      index[ii++] = b;
      index[ii++] = c;
      index[ii++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (col) geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}

const WHITE = new THREE.Color(1, 1, 1);

/** Flat polygons (planar east/north rings → y-up ShapeGeometry), merged. */
export function buildFlatPolygons(polys: { outer: P2[]; holes?: P2[][] }[], y: number): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const p of polys) {
    const outer = cleanRing(p.outer);
    if (outer.length < 3) continue;
    const shape = new THREE.Shape(outer.map(([x, n]) => new THREE.Vector2(x, n)));
    for (const h of p.holes ?? []) {
      const hr = cleanRing(h);
      if (hr.length >= 3) shape.holes.push(new THREE.Path(hr.map(([x, n]) => new THREE.Vector2(x, n))));
    }
    const g = new THREE.ShapeGeometry(shape, 1);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    geos.push(g);
  }
  if (!geos.length) return null;
  const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
  if (geos.length > 1) for (const g of geos) g.dispose();
  if (!merged) return null;
  merged.computeBoundingSphere();
  return merged;
}
