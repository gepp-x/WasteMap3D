import * as THREE from "three";
import type { ThreeScope } from "@/store/dashboard-store";
import type { AreaGeomSet } from "../area-geometry";
import type { SceneFrame } from "../frame";
import { visualLevel, type FloodTarget } from "../flood";
import { createFloodMaterial } from "../shaders/flood";

/**
 * Illustrative flood visual (never a depth prediction).
 *   city          translucent water band hugging each flagged prism's base (the prism's own unit
 *                 extrusion, scaled 1.5 % outward around its anchor and to the visual level)
 *   neighbourhood one sheet across the building window with a soft radial edge
 * Levels ease in slowly (≈2.5 s) and recede before being hidden.
 */

interface Band {
  outer: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  level: number;
  target: number;
}

const XZ_INFLATE = 1.015;

export class FloodField {
  readonly group = new THREE.Group();
  private readonly material = createFloodMaterial();
  private readonly sheet: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly bands = new Map<string, Band>();
  private sheetLevel = 0;
  private sheetTarget = 0;
  private time = 0;
  private set: AreaGeomSet | null = null;

  constructor() {
    this.group.name = "flood";
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    this.sheet = new THREE.Mesh(plane, this.material);
    this.sheet.visible = false;
    this.sheet.renderOrder = 6;
    this.sheet.raycast = () => {};
    this.group.add(this.sheet);
  }

  setTargets(targets: FloodTarget[], scope: ThreeScope, set: AreaGeomSet | null, frame: SceneFrame | null) {
    const u = this.material.uniforms;
    if (scope === "neighborhood" && frame) {
      const h = frame.half;
      this.sheet.scale.set(h * 2.2, 1, h * 2.2);
      this.sheet.position.set(0, this.sheetLevel, 0);
      u.uEdgeRadius.value = h * 1.08;
      (u.uEdgeCenter.value as THREE.Vector2).set(0, 0);
      u.uScale.value = 9;
      this.sheetTarget = targets[0] ? visualLevel(targets[0], "neighborhood") : 0;
      for (const b of this.bands.values()) b.target = 0;
      return;
    }
    this.sheetTarget = 0;
    u.uEdgeRadius.value = 0;
    u.uScale.value = frame ? Math.max(2, frame.half * 0.02) : 6;
    if (set !== this.set) {
      // geometry set changed (city switch) → drop bands bound to old geometries
      for (const b of this.bands.values()) this.group.remove(b.outer);
      this.bands.clear();
      this.set = set;
    }
    const wanted = new Map(targets.map((t) => [t.id, visualLevel(t, "city")] as const));
    for (const [id, b] of this.bands) b.target = wanted.get(id) ?? 0;
    if (!set) return;
    for (const [id, level] of wanted) {
      if (this.bands.has(id)) continue;
      const a = set.byId.get(id);
      if (!a) continue;
      const outer = new THREE.Group();
      outer.position.set(a.anchor[0], 0, a.anchor[1]);
      outer.scale.set(XZ_INFLATE, 0.001, XZ_INFLATE);
      const mesh = new THREE.Mesh(a.prism, this.material);
      mesh.position.set(-a.anchor[0], 0, -a.anchor[1]);
      mesh.raycast = () => {};
      mesh.renderOrder = 6;
      outer.add(mesh);
      this.group.add(outer);
      this.bands.set(id, { outer, mesh, level: 0, target: level });
    }
  }

  /** Returns { moving, visible }. `shimmer` false freezes the surface (reduced motion / effects off). */
  tick(dt: number, reduced: boolean, shimmer: boolean) {
    const k = reduced ? 1 : 1 - Math.exp(-dt * 1.3);
    let moving = false;
    let visible = false;
    for (const [id, b] of this.bands) {
      b.level += (b.target - b.level) * k;
      if (Math.abs(b.target - b.level) < 0.003) b.level = b.target;
      else moving = true;
      if (b.level <= 0.0005 && b.target === 0) {
        this.group.remove(b.outer);
        this.bands.delete(id);
        continue;
      }
      b.outer.scale.y = Math.max(0.001, b.level);
      visible = true;
    }
    this.sheetLevel += (this.sheetTarget - this.sheetLevel) * k;
    if (Math.abs(this.sheetTarget - this.sheetLevel) < 0.003) this.sheetLevel = this.sheetTarget;
    else moving = true;
    this.sheet.visible = this.sheetLevel > 0.003;
    this.sheet.position.y = this.sheetLevel;
    // "visible" also covers water that is about to rise, so the label never flickers off for a frame
    if (this.sheet.visible || this.sheetTarget > 0) visible = true;
    if (visible && shimmer) {
      this.time = (this.time + dt) % 3600;
      this.material.uniforms.uTime.value = this.time;
    }
    return { moving, visible };
  }

  dispose() {
    this.sheet.geometry.dispose();
    this.material.dispose();
    this.bands.clear();
  }
}
