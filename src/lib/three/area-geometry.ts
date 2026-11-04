import * as THREE from "three";
import type { FeatureCollection, Geometry, Position } from "geojson";
import type { AreaFeatureProps } from "@/lib/data/loader";
import type { AreaRecord } from "@/lib/types";
import type { SceneFrame } from "./frame";
import { cleanRing, simplifyRing, type P2 } from "./simplify";

/**
 * City-scope area prisms.
 *
 * Each area polygon (Polygon / MultiPolygon, holes supported) becomes ONE unit-height
 * ExtrudeGeometry in scene space. Heights are applied with `mesh.scale.y`, so data changes
 * never rebuild geometry — they only move a scale toward a target. Top-edge outlines for all
 * areas are merged into a single LineSegments buffer with a per-vertex area index (`aArea`)
 * so one draw call renders every outline; the shader lifts each vertex to its area's height.
 */

export interface AreaGeom {
  id: string;
  /** Index into the set (uniform-array slot for merged outlines). */
  index: number;
  /** Unit-height prism, scene space (x = east, y = 0..1, z = −north). */
  prism: THREE.BufferGeometry;
  /** Flat footprint (y = 0) used by flood sheets. */
  footprint: THREE.BufferGeometry;
  /** Anchor in scene space ([x, z]) — dataset point-on-surface when available. */
  anchor: [number, number];
  /** Approximate footprint radius from the anchor (scene units). */
  radius: number;
  /** [minX, minZ, maxX, maxZ] */
  bounds: [number, number, number, number];
  geometryStatus: string;
}

export interface AreaGeomSet {
  key: string;
  areas: AreaGeom[];
  byId: Map<string, AreaGeom>;
  /** Merged outlines: position (y = 0) + aArea. */
  outlines: THREE.BufferGeometry;
  dispose: () => void;
}

function ringsOf(geom: Geometry): Position[][][] {
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  if (geom.type === "GeometryCollection") return geom.geometries.flatMap(ringsOf);
  return [];
}

function toPlanarRing(ring: Position[], frame: SceneFrame, tol: number): P2[] {
  const pts: P2[] = [];
  for (const c of ring) {
    if (c.length < 2) continue;
    pts.push(frame.toPlanar(c[0], c[1]));
  }
  return simplifyRing(pts, tol);
}

function shapeFrom(outer: P2[], holes: P2[][]) {
  const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  return shape;
}

/** Converts lon/lat polygons into planar shapes (east/north, scaled). Exported for reuse (flat water polygons). */
export function polygonsToShapes(geom: Geometry, frame: SceneFrame, tolerance: number): { shapes: THREE.Shape[]; rings: P2[][] } {
  const shapes: THREE.Shape[] = [];
  const rings: P2[][] = [];
  for (const poly of ringsOf(geom)) {
    if (!poly.length) continue;
    const outer = toPlanarRing(poly[0], frame, tolerance);
    if (outer.length < 3) continue;
    const holes = poly
      .slice(1)
      .map((r) => toPlanarRing(r, frame, tolerance))
      .filter((r) => r.length >= 3);
    shapes.push(shapeFrom(outer, holes));
    rings.push(outer, ...holes);
  }
  return { shapes, rings };
}

/** Builds prisms + merged outlines for every area feature. */
export function buildAreaGeometry(
  fc: FeatureCollection<Geometry, AreaFeatureProps>,
  areas: AreaRecord[],
  frame: SceneFrame,
): AreaGeomSet {
  // ~0.08 scene units ≈ 9 m in Bangkok / 1.3 m in Hat Yai — invisible at overview, removes OSM micro-noise.
  const tol = 0.08;
  const recordById = new Map(areas.map((a) => [a.id, a] as const));
  const list: AreaGeom[] = [];
  const outlinePos: number[] = [];
  const outlineArea: number[] = [];

  for (const f of fc.features) {
    const id = f.properties?.id;
    if (!id || !f.geometry) continue;
    if (list.some((a) => a.id === id)) continue;
    const { shapes, rings } = polygonsToShapes(f.geometry, frame, tol);
    if (!shapes.length) continue;

    const prism = new THREE.ExtrudeGeometry(shapes, { depth: 1, bevelEnabled: false, steps: 1, curveSegments: 1 });
    // shape (x = east, y = north), extrusion along +z → rotate so y = up and z = −north
    prism.rotateX(-Math.PI / 2);
    prism.computeBoundingSphere();
    prism.computeBoundingBox();

    const footprint = new THREE.ShapeGeometry(shapes, 1);
    footprint.rotateX(-Math.PI / 2);
    footprint.computeBoundingSphere();

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    const index = list.length;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        outlinePos.push(a[0], 0, -a[1], b[0], 0, -b[1]);
        outlineArea.push(index, index);
        minX = Math.min(minX, a[0]);
        maxX = Math.max(maxX, a[0]);
        minZ = Math.min(minZ, -a[1]);
        maxZ = Math.max(maxZ, -a[1]);
      }
    }

    const rec = recordById.get(id);
    const anchor: [number, number] = rec?.anchor ? frame.toScene(rec.anchor[0], rec.anchor[1]) : [(minX + maxX) / 2, (minZ + maxZ) / 2];
    let radius = 0;
    for (const ring of rings) {
      for (const p of ring) radius = Math.max(radius, Math.hypot(p[0] - anchor[0], -p[1] - anchor[1]));
    }

    list.push({
      id,
      index,
      prism,
      footprint,
      anchor,
      radius,
      bounds: [minX, minZ, maxX, maxZ],
      geometryStatus: rec?.geometryStatus ?? f.properties?.geometryStatus ?? "osm",
    });
  }

  const outlines = new THREE.BufferGeometry();
  outlines.setAttribute("position", new THREE.Float32BufferAttribute(outlinePos, 3));
  outlines.setAttribute("aArea", new THREE.Float32BufferAttribute(outlineArea, 1));
  outlines.computeBoundingSphere();
  if (outlines.boundingSphere) outlines.boundingSphere.radius += frame.half; // heights are applied in the shader

  return {
    key: frame.key,
    areas: list,
    byId: new Map(list.map((a) => [a.id, a] as const)),
    outlines,
    dispose: () => {
      for (const a of list) {
        a.prism.dispose();
        a.footprint.dispose();
      }
      outlines.dispose();
    },
  };
}

/** Builds a merged LineSegments buffer for arbitrary lon/lat polygons (e.g. municipality outline). */
export function buildOutlineFromGeometries(geoms: Geometry[], frame: SceneFrame, y = 0): THREE.BufferGeometry | null {
  const pos: number[] = [];
  for (const g of geoms) {
    const { rings } = polygonsToShapes(g, frame, 0.05);
    for (const ring of rings) {
      const r = cleanRing(ring);
      for (let i = 0; i < r.length; i++) {
        const a = r[i];
        const b = r[(i + 1) % r.length];
        pos.push(a[0], y, -a[1], b[0], y, -b[1]);
      }
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeBoundingSphere();
  return geo;
}
