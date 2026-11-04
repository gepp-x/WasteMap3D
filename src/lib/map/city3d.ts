/**
 * 3D City mode — a Three.js custom layer rendered inside MapLibre's own GL context and camera.
 *
 * MapLibre draws the solid building massing (fill-extrusion from the OpenFreeMap / OpenMapTiles
 * `building` layer, heights from `render_height`). This layer adds what MapLibre cannot draw:
 *   1. glowing building edges (roof outline + vertical corner lines) → the "wire-frame" city look;
 *   2. GPU rain streaks driven by the scenario's rainfall intensity.
 *
 * Precision: vertices are stored in METRES relative to a local origin (re-centred whenever the
 * edges are rebuilt) and placed with a float64 model matrix = translate(origin) · scale(m→mercator),
 * so float32 vertex data never holds large Mercator coordinates.
 */
import * as THREE from "three";
import type { Map as MLMap, CustomLayerInterface, CustomRenderMethodInput } from "maplibre-gl";
import type { MaplibreModule } from "@/components/map/use-map-engine";
import { BASEMAP_SOURCE } from "./ids";

export const CITY3D_LAYER_ID = "city3d-three";
export const CITY3D_FLOOD_LAYER_ID = "city3d-flood";

/** Below this zoom the tile building layer is absent/too dense to outline usefully. */
export const EDGE_MIN_ZOOM = 14;
/** Hard cap on edge vertices so a dense CBD never stalls the main thread. */
const MAX_EDGE_VERTICES = 240_000;
const DEFAULT_HEIGHT_M = 6;

const RAIN_DROPS = 9000;
const RAIN_BOX_M = { x: 2600, y: 2600, z: 520 };

interface Origin {
  lng: number;
  lat: number;
  merc: { x: number; y: number; z: number };
  /** Mercator units per metre at the origin latitude. */
  scale: number;
}

export interface City3DLayerHandle {
  layer: CustomLayerInterface;
  /** Re-read building geometry from loaded tiles around the current view. */
  rebuild: () => void;
  setRain: (intensityMmH: number, animate: boolean) => void;
  setEdgeOpacity: (o: number) => void;
  dispose: () => void;
}

/** Tile building features → line-segment vertices (metres around `origin`). Pure; exported for tests. */
export function buildEdgeVertices(features: { geometry: GeoJSON.Geometry; properties: Record<string, unknown> | null }[], project: (lng: number, lat: number) => [number, number], max = MAX_EDGE_VERTICES) {
  const out: number[] = [];
  const seen = new Set<string>();
  const pushRing = (ring: number[][], h: number, base: number) => {
    if (ring.length < 4) return;
    // de-duplicate the same footprint repeated across neighbouring tiles
    const key = `${ring[0][0].toFixed(6)},${ring[0][1].toFixed(6)},${ring.length},${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    const roof = h + 0.25; // lift the roof outline off the roof face (avoids z-fighting)
    let prev = project(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) {
      const cur = project(ring[i][0], ring[i][1]);
      out.push(prev[0], prev[1], roof, cur[0], cur[1], roof);
      // vertical edge at each corner (skip near-collinear vertices on curved outlines)
      if (i < ring.length - 1) {
        const next = project(ring[i + 1][0], ring[i + 1][1]);
        const ax = cur[0] - prev[0], ay = cur[1] - prev[1], bx = next[0] - cur[0], by = next[1] - cur[1];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        const cos = la && lb ? (ax * bx + ay * by) / (la * lb) : 1;
        if (cos < 0.94) out.push(cur[0], cur[1], base, cur[0], cur[1], roof);
      }
      prev = cur;
      if (out.length >= max) return;
    }
  };
  for (const f of features) {
    if (out.length >= max) break;
    const p = f.properties ?? {};
    if (p.hide_3d === true) continue;
    const h = typeof p.render_height === "number" ? p.render_height : DEFAULT_HEIGHT_M;
    const base = typeof p.render_min_height === "number" ? p.render_min_height : 0;
    const g = f.geometry;
    if (g.type === "Polygon") pushRing(g.coordinates[0] as number[][], h, base);
    else if (g.type === "MultiPolygon") for (const poly of g.coordinates) pushRing(poly[0] as number[][], h, base);
  }
  return new Float32Array(out);
}

const RAIN_VERT = /* glsl */ `
  attribute vec3 aSeed;     // x,y in [0,1], z = phase
  attribute float aEnd;     // 0 = drop head, 1 = tail
  uniform float uTime;
  uniform float uSpeed;
  uniform float uLength;
  uniform float uDensity;
  uniform vec3 uBox;
  uniform vec2 uCenter;     // metres, local frame
  varying float vAlpha;
  void main() {
    float visible = step(aSeed.z, uDensity);
    vec2 xy = uCenter + (aSeed.xy - 0.5) * uBox.xy;
    float fall = fract(aSeed.z * 7.13 - uTime * uSpeed / uBox.z);
    float z = fall * uBox.z;
    vec3 p = vec3(xy + vec2(-0.18, 0.05) * aEnd * uLength, z + aEnd * uLength);
    vAlpha = visible * (1.0 - aEnd) * smoothstep(0.0, 0.08, fall);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const RAIN_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying float vAlpha;
  void main() { gl_FragColor = vec4(0.72, 0.88, 1.0, vAlpha * uOpacity); }
`;

export function createCity3DLayer(map: MLMap, ml: MaplibreModule): City3DLayerHandle {
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  let origin: Origin | null = null;

  // No depth test on purpose: edges read through the translucent massing ("wire-frame city" look).
  // Roof outlines are bright, vertical corners softer (per-vertex colour) so dense blocks stay legible.
  const edgeMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, depthTest: false });
  const edges = new THREE.LineSegments(new THREE.BufferGeometry(), edgeMaterial);
  edges.frustumCulled = false;
  scene.add(edges);

  // Rain: one line segment (2 vertices) per drop, animated entirely in the vertex shader.
  const rainGeo = new THREE.BufferGeometry();
  const seeds = new Float32Array(RAIN_DROPS * 2 * 3);
  const ends = new Float32Array(RAIN_DROPS * 2);
  let s = 1337;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < RAIN_DROPS; i++) {
    const x = rnd(), y = rnd(), ph = rnd();
    for (let k = 0; k < 2; k++) {
      seeds.set([x, y, ph], (i * 2 + k) * 3);
      ends[i * 2 + k] = k;
    }
  }
  rainGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RAIN_DROPS * 2 * 3), 3));
  rainGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
  rainGeo.setAttribute("aEnd", new THREE.BufferAttribute(ends, 1));
  const rainMat = new THREE.ShaderMaterial({
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: 260 },
      uLength: { value: 14 },
      uDensity: { value: 0 },
      uOpacity: { value: 0 },
      uBox: { value: new THREE.Vector3(RAIN_BOX_M.x, RAIN_BOX_M.y, RAIN_BOX_M.z) },
      uCenter: { value: new THREE.Vector2(0, 0) },
    },
  });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  let rainTarget = 0;
  let rainLevel = 0;
  let animateRain = true;
  let last = performance.now();
  const modelMatrix = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();

  const setOrigin = (lng: number, lat: number) => {
    const m = ml.MercatorCoordinate.fromLngLat({ lng, lat }, 0);
    origin = { lng, lat, merc: { x: m.x, y: m.y, z: m.z }, scale: m.meterInMercatorCoordinateUnits() };
    // Mercator y grows southward → flip y so local +y is north; z is up in metres.
    modelMatrix.makeTranslation(m.x, m.y, m.z).multiply(tmp.makeScale(origin.scale, -origin.scale, origin.scale));
  };

  const project = (lng: number, lat: number): [number, number] => {
    const o = origin!;
    const m = ml.MercatorCoordinate.fromLngLat({ lng, lat }, 0);
    return [(m.x - o.merc.x) / o.scale, -(m.y - o.merc.y) / o.scale];
  };

  const rebuild = () => {
    if (map.getZoom() < EDGE_MIN_ZOOM || !map.getSource(BASEMAP_SOURCE)) {
      edges.visible = false;
      map.triggerRepaint();
      return;
    }
    const c = map.getCenter();
    setOrigin(c.lng, c.lat);
    let feats: ReturnType<MLMap["querySourceFeatures"]> = [];
    try {
      feats = map.querySourceFeatures(BASEMAP_SOURCE, { sourceLayer: "building" });
    } catch {
      feats = [];
    }
    // keep buildings near the view (tiles cover more than the viewport)
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.35;
    const padY = (b.getNorth() - b.getSouth()) * 0.35;
    const inView = feats.filter((f) => {
      const g = f.geometry;
      const pt = g.type === "Polygon" ? g.coordinates[0]?.[0] : g.type === "MultiPolygon" ? g.coordinates[0]?.[0]?.[0] : null;
      return !!pt && pt[0] > b.getWest() - padX && pt[0] < b.getEast() + padX && pt[1] > b.getSouth() - padY && pt[1] < b.getNorth() + padY;
    });
    const verts = buildEdgeVertices(inView, project);
    // observable state for tests / diagnostics (no globals)
    map.getContainer().dataset.city3dFeatures = String(feats.length);
    map.getContainer().dataset.city3dEdges = String(verts.length / 6);
    const colors = new Float32Array(verts.length);
    for (let i = 0; i < verts.length; i += 6) {
      const vertical = verts[i] === verts[i + 3] && verts[i + 1] === verts[i + 4];
      const k = vertical ? 0.42 : 1; // roof outline = full cyan, corners dimmer
      for (const o of [0, 3]) colors.set([0.31 * k, 0.89 * k, 0.97 * k], i + o);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    edges.geometry.dispose();
    edges.geometry = geo;
    edges.visible = verts.length > 0;
    map.triggerRepaint();
  };

  const layer: CustomLayerInterface = {
    id: CITY3D_LAYER_ID,
    type: "custom",
    renderingMode: "3d",
    onAdd(_map, gl) {
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
      renderer.autoClear = false;
    },
    render(_gl, args: CustomRenderMethodInput) {
      if (!renderer || !origin) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // ease rain in/out
      rainLevel += (rainTarget - rainLevel) * Math.min(1, dt * 2.5);
      const raining = rainLevel > 0.01;
      rain.visible = raining;
      if (raining) {
        const u = rainMat.uniforms;
        if (animateRain) u.uTime.value += dt;
        u.uDensity.value = Math.min(1, 0.08 + rainLevel * 0.92);
        u.uOpacity.value = 0.25 + 0.5 * rainLevel;
        u.uSpeed.value = 220 + 260 * rainLevel;
        u.uLength.value = 8 + 22 * rainLevel;
        const c = map.getCenter();
        const [cx, cy] = project(c.lng, c.lat);
        u.uCenter.value.set(cx, cy);
      }
      const mvp = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
      camera.projectionMatrix = mvp.multiply(modelMatrix);
      renderer.resetState();
      renderer.render(scene, camera);
      if ((raining && animateRain) || Math.abs(rainTarget - rainLevel) > 0.01) map.triggerRepaint();
    },
    onRemove() {
      renderer?.dispose();
      renderer = null;
    },
  };

  return {
    layer,
    rebuild,
    setRain: (mmH, animate) => {
      // 0 → none, ~5 light, ~15 moderate, ~35 heavy, 60+ extreme
      rainTarget = mmH <= 0.2 ? 0 : Math.min(1, Math.sqrt(mmH / 60));
      animateRain = animate;
      map.triggerRepaint();
    },
    setEdgeOpacity: (o) => {
      edgeMaterial.opacity = o;
      map.triggerRepaint();
    },
    dispose: () => {
      edges.geometry.dispose();
      edgeMaterial.dispose();
      rainGeo.dispose();
      rainMat.dispose();
    },
  };
}
