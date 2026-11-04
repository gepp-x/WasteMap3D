import * as THREE from "three";
import type { AreaGeomSet } from "../area-geometry";
import type { AreaVisualSet } from "../area-visuals";
import { UNAVAILABLE_COLOR } from "../area-visuals";
import { createOutlineMaterial, type OutlineUniforms } from "../shaders/markers";

/**
 * City-overview prisms: one mesh per area (shared program, per-area material for colour/emissive),
 * heights via `scale.y`, plus ONE merged top-outline draw call.
 *
 * Targets are set from React (on data / selection / hover change); `tick()` eases current values
 * toward them with frame-rate-independent exponential smoothing and reports whether anything is
 * still moving, so the canvas can stay in on-demand rendering when static.
 */

const H_MIN = 1.2;
const H_NULL = 0.5;
const SELECT_CYAN = new THREE.Color("#25d9f2");
const tmp = new THREE.Color();

export class PrismField {
  readonly group = new THREE.Group();
  readonly set: AreaGeomSet;
  private readonly meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
  private readonly outline: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly outlineU: OutlineUniforms;
  private readonly curH: Float32Array;
  private readonly tgtH: Float32Array;
  private readonly curE: Float32Array;
  private readonly tgtE: Float32Array;
  private readonly curC: THREE.Color[];
  private readonly tgtC: THREE.Color[];

  constructor(set: AreaGeomSet) {
    this.set = set;
    this.group.name = "area-prisms";
    const n = set.areas.length;
    this.curH = new Float32Array(n).fill(H_MIN);
    this.tgtH = new Float32Array(n).fill(H_MIN);
    this.curE = new Float32Array(n);
    this.tgtE = new Float32Array(n);
    this.curC = Array.from({ length: n }, () => new THREE.Color(UNAVAILABLE_COLOR));
    this.tgtC = Array.from({ length: n }, () => new THREE.Color(UNAVAILABLE_COLOR));
    for (const a of set.areas) {
      const mat = new THREE.MeshStandardMaterial({
        color: UNAVAILABLE_COLOR,
        roughness: 0.74,
        metalness: 0,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(a.prism, mat);
      mesh.userData.areaId = a.id;
      mesh.scale.y = H_MIN;
      mesh.name = `prism:${a.id}`;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    const { material, uniforms } = createOutlineMaterial(n, 0.06);
    this.outline = new THREE.LineSegments(set.outlines, material);
    this.outline.raycast = () => {};
    this.outline.renderOrder = 3;
    this.outlineU = uniforms;
    this.group.add(this.outline);
  }

  setShadows(on: boolean) {
    for (const m of this.meshes) {
      m.castShadow = on;
      m.receiveShadow = on;
    }
  }

  /** Updates targets from the visual encoding + interaction state. */
  setTargets(v: AreaVisualSet | null, selectedId: string | null, hoveredId: string | null, maxH: number) {
    const anySelected = !!selectedId && this.set.byId.has(selectedId);
    for (const a of this.set.areas) {
      const i = a.index;
      const vis = v?.byId.get(a.id);
      const t = vis?.t ?? null;
      this.tgtH[i] = t === null ? H_NULL : H_MIN + t * (maxH - H_MIN);
      const c = this.tgtC[i].set(vis?.color ?? UNAVAILABLE_COLOR);
      const isSel = a.id === selectedId;
      const isHover = a.id === hoveredId;
      if (anySelected && !isSel) {
        const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
        tmp.setRGB(l, l, l);
        c.lerp(tmp, 0.45).multiplyScalar(isHover ? 0.95 : 0.72);
      }
      this.tgtE[i] = isHover ? 0.3 : isSel ? 0.12 : 0;
      const col = this.outlineU.uColors.value[i];
      if (isSel) col.set(SELECT_CYAN.r, SELECT_CYAN.g, SELECT_CYAN.b, 1);
      else if (isHover) col.set(1, 1, 1, 0.75);
      else col.set(0.85, 0.93, 1, anySelected ? 0.1 : 0.22);
    }
  }

  /** Eases toward targets. Returns true while anything is still moving. */
  tick(dt: number, reduced: boolean) {
    // first frames ease up from the minimum height → the city "rises" during the establishing shot
    const k = reduced ? 1 : 1 - Math.exp(-dt * 5.5);
    let moving = false;
    const heights = this.outlineU.uHeights.value;
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      let h = this.curH[i] + (this.tgtH[i] - this.curH[i]) * k;
      if (Math.abs(this.tgtH[i] - h) < 0.01) h = this.tgtH[i];
      else moving = true;
      this.curH[i] = h;
      m.scale.y = Math.max(h, 0.001);
      heights[i] = h;

      const c = this.curC[i];
      const tc = this.tgtC[i];
      c.lerp(tc, k);
      if (Math.abs(c.r - tc.r) + Math.abs(c.g - tc.g) + Math.abs(c.b - tc.b) < 0.004) c.copy(tc);
      else moving = true;
      m.material.color.copy(c);
      m.material.emissive.copy(c);

      let e = this.curE[i] + (this.tgtE[i] - this.curE[i]) * k;
      if (Math.abs(this.tgtE[i] - e) < 0.002) e = this.tgtE[i];
      else moving = true;
      this.curE[i] = e;
      m.material.emissiveIntensity = e;
    }
    return moving;
  }

  heightOf(id: string) {
    const a = this.set.byId.get(id);
    return a ? this.curH[a.index] : 0;
  }

  /** Target (settled) height — used for camera framing so focus moves land correctly. */
  targetHeightOf(id: string) {
    const a = this.set.byId.get(id);
    return a ? this.tgtH[a.index] : 0;
  }

  dispose() {
    for (const m of this.meshes) m.material.dispose();
    this.outline.material.dispose();
    // geometries belong to the AreaGeomSet (disposed by its owner)
  }
}
