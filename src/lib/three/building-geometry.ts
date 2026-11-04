import * as THREE from "three";
import type { BuildingWindow } from "@/lib/types";
import type { RibbonLine } from "./ribbon-geometry";
import { cleanRing, signedArea, type P2 } from "./simplify";

/**
 * Neighbourhood buildings: ONE merged, indexed BufferGeometry for every footprint.
 *
 * Custom fast extrusion (no ExtrudeGeometry per building):
 *   walls — 4 vertices per edge, outward normals, darker at the base (cheap baked "AO")
 *   roof  — ring triangulated with THREE.ShapeUtils.triangulateShape, normal +y
 *
 * Vertex colours encode a slate-blue palette varied by height; buildings whose height is a
 * deterministic estimate are desaturated so tagged vs estimated heights read differently.
 * `aDist` (0 centre → 1 window corner) drives the outward rise-in animation in the shader.
 * Footprints are local metres [east, north]; scene uses x = east, z = −north, 1 unit = 1 m.
 */

export interface BuildingBuild {
  geometry: THREE.BufferGeometry;
  /** Buildings in the file. */
  total: number;
  /** Buildings drawn (after the tier cap). */
  shown: number;
  /** Count by height source (over all buildings in the file). */
  tagged: number;
  levels: number;
  estimated: number;
  maxHeight: number;
}

const PAL_LOW = new THREE.Color("#2a3e57");
const PAL_MID = new THREE.Color("#3d5d84");
const PAL_HIGH = new THREE.Color("#86a6cf");
const GREY = new THREE.Color("#4a5563");

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

function paletteFor(h: number, estimated: boolean, out: THREE.Color) {
  const t = Math.min(1, Math.max(0, Math.log(Math.max(h, 3) / 3) / Math.log(80 / 3)));
  if (t < 0.5) out.copy(PAL_LOW).lerp(PAL_MID, t * 2);
  else out.copy(PAL_MID).lerp(PAL_HIGH, (t - 0.5) * 2);
  if (estimated) {
    const l = out.r * 0.2126 + out.g * 0.7152 + out.b * 0.0722;
    tmpA.setRGB(l, l, l).lerp(GREY, 0.5);
    out.lerp(tmpA, 0.4).multiplyScalar(0.92);
  }
  return out;
}

interface Prepared {
  ring: P2[];
  h: number;
  hs: "height" | "levels" | "estimated";
  area: number;
  cx: number;
  cy: number;
  tris: number[][];
}

export function buildBuildings(win: BuildingWindow, cap: number): BuildingBuild | null {
  const items: Prepared[] = [];
  let tagged = 0;
  let levels = 0;
  let estimated = 0;
  for (const b of win.buildings ?? []) {
    if (b.hs === "height") tagged++;
    else if (b.hs === "levels") levels++;
    else estimated++;
    let ring = cleanRing((b.fp ?? []) as P2[], 1e-3);
    if (ring.length < 3) continue;
    let area = signedArea(ring);
    if (Math.abs(area) < 4) continue; // < 4 m² → noise
    if (area < 0) {
      ring = ring.slice().reverse();
      area = -area;
    }
    let cx = 0;
    let cy = 0;
    for (const p of ring) {
      cx += p[0];
      cy += p[1];
    }
    cx /= ring.length;
    cy /= ring.length;
    const h = Number.isFinite(b.h) && b.h > 0 ? Math.min(b.h, 400) : 6;
    items.push({ ring, h: Math.max(2.5, h), hs: b.hs, area, cx, cy, tris: [] });
  }
  if (!items.length) return null;

  let chosen = items;
  if (items.length > cap) chosen = items.slice().sort((a, b) => b.area - a.area).slice(0, cap);

  let vCount = 0;
  let iCount = 0;
  for (const it of chosen) {
    const contour = it.ring.map(([x, y]) => new THREE.Vector2(x, y));
    it.tris = THREE.ShapeUtils.triangulateShape(contour, []);
    vCount += it.ring.length * 4 + it.ring.length;
    iCount += it.ring.length * 6 + it.tris.length * 3;
  }

  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const dist = new Float32Array(vCount);
  const index = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  const maxD = Math.max(1, win.halfSizeM * Math.SQRT2);
  let v = 0;
  let ii = 0;
  let maxHeight = 0;
  const base = new THREE.Color();

  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, d: number) => {
    pos[v * 3] = x;
    pos[v * 3 + 1] = y;
    pos[v * 3 + 2] = z;
    nor[v * 3] = nx;
    nor[v * 3 + 1] = ny;
    nor[v * 3 + 2] = nz;
    col[v * 3] = c.r;
    col[v * 3 + 1] = c.g;
    col[v * 3 + 2] = c.b;
    dist[v] = d;
    return v++;
  };

  for (const it of chosen) {
    const { ring, h } = it;
    maxHeight = Math.max(maxHeight, h);
    const d = Math.min(1, Math.hypot(it.cx, it.cy) / maxD);
    paletteFor(h, it.hs === "estimated", base);
    const wallTop = tmpA.copy(base).multiplyScalar(0.95);
    const wallBottom = tmpB.copy(base).multiplyScalar(0.5);
    const n = ring.length;
    // walls
    for (let i = 0; i < n; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % n];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      // outward normal of a CCW ring in (east, north) is (dy, −dx); scene (x, z = −north) → (dy, 0, dx)
      const nx = dy / len;
      const nz = dx / len;
      const a = put(p[0], 0, -p[1], nx, 0, nz, wallBottom, d);
      const b = put(q[0], 0, -q[1], nx, 0, nz, wallBottom, d);
      const c = put(q[0], h, -q[1], nx, 0, nz, wallTop, d);
      const e = put(p[0], h, -p[1], nx, 0, nz, wallTop, d);
      index[ii++] = a;
      index[ii++] = b;
      index[ii++] = c;
      index[ii++] = a;
      index[ii++] = c;
      index[ii++] = e;
    }
    // roof
    const roof = tmpA.copy(base).multiplyScalar(1.18);
    const r0 = v;
    for (let i = 0; i < n; i++) put(ring[i][0], h, -ring[i][1], 0, 1, 0, roof, d);
    for (const t of it.tris) {
      const [i0, i1, i2] = t;
      const p0 = ring[i0];
      const p1 = ring[i1];
      const p2 = ring[i2];
      const s = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
      // CCW in (east, north) ⇒ +y facing in scene space
      if (s >= 0) {
        index[ii++] = r0 + i0;
        index[ii++] = r0 + i1;
        index[ii++] = r0 + i2;
      } else {
        index[ii++] = r0 + i0;
        index[ii++] = r0 + i2;
        index[ii++] = r0 + i1;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geometry.setAttribute("aDist", new THREE.BufferAttribute(dist, 1));
  geometry.setIndex(new THREE.BufferAttribute(index.subarray(0, ii), 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  return { geometry, total: win.buildings?.length ?? 0, shown: chosen.length, tagged, levels, estimated, maxHeight };
}

/** Road classes → ribbon width (m) and tone. */
const ROAD_STYLE: { match: RegExp; width: number; color: string }[] = [
  { match: /motorway|trunk/, width: 16, color: "#2c4560" },
  { match: /primary/, width: 12, color: "#28405a" },
  { match: /secondary/, width: 10, color: "#243a52" },
  { match: /tertiary/, width: 8, color: "#21354b" },
  { match: /residential|unclassified|living/, width: 5.5, color: "#1d3044" },
  { match: /service/, width: 3.5, color: "#1a2b3e" },
  { match: /foot|path|pedestrian|cycle|steps|track/, width: 2, color: "#182838" },
];

export function roadLines(win: BuildingWindow): RibbonLine[] {
  const out: RibbonLine[] = [];
  for (const r of win.roads ?? []) {
    if (!r.pts || r.pts.length < 2) continue;
    const t = String(r.t ?? "").toLowerCase();
    const style = ROAD_STYLE.find((s) => s.match.test(t)) ?? { width: 5, color: "#1d3044" };
    out.push({ pts: r.pts.map(([e, n]) => [e, -n] as P2), width: style.width, color: new THREE.Color(style.color) });
  }
  return out;
}

/** Height-source shares (percent, rounded) for the attribution line. */
export function heightShares(b: Pick<BuildingBuild, "tagged" | "levels" | "estimated">) {
  const total = b.tagged + b.levels + b.estimated;
  if (!total) return { taggedPct: null as number | null, estimatedPct: null as number | null };
  const taggedPct = Math.round(((b.tagged + b.levels) / total) * 100);
  return { taggedPct, estimatedPct: 100 - taggedPct };
}
