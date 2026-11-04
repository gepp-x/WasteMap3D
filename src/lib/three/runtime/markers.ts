import * as THREE from "three";
import type { AreaGeomSet } from "../area-geometry";
import type { AreaVisualSet } from "../area-visuals";
import { RISK_COLORS } from "@/lib/data/status";
import { createOutlineMaterial, createPulseMaterial, type OutlineUniforms } from "../shaders/markers";

/**
 * Risk overlay for the city overview:
 *   • ground-level outlines in the risk-class colour for areas the live model puts at High /
 *     Very High (only while a scenario or historical replay is active and the height metric is not
 *     risk itself — the legend explains the colours, tooltips name the class in text)
 *   • the selection marker: a pulse ring resting on the selected prism's roof (three ripples, then
 *     settles to a static ring — calm, and lets the canvas return to on-demand rendering)
 */

const PULSE_SECONDS = 6;
const tmp = new THREE.Color();

export class RiskMarkers {
  readonly group = new THREE.Group();
  private readonly outline: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly outlineU: OutlineUniforms;
  private readonly ring: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private pulseT = 0;
  private selected: string | null = null;

  constructor(private readonly set: AreaGeomSet) {
    this.group.name = "risk-overlay";
    const { material, uniforms } = createOutlineMaterial(set.areas.length, 0.12);
    this.outline = new THREE.LineSegments(set.outlines, material);
    this.outline.raycast = () => {};
    this.outline.renderOrder = 2;
    this.outlineU = uniforms;

    const plane = new THREE.PlaneGeometry(2, 2);
    plane.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(plane, createPulseMaterial());
    this.ring.raycast = () => {};
    this.ring.visible = false;
    this.ring.renderOrder = 4;
    this.group.add(this.outline, this.ring);
  }

  setRisk(v: AreaVisualSet | null, show: boolean) {
    for (const a of this.set.areas) {
      const col = this.outlineU.uColors.value[a.index];
      const vis = v?.byId.get(a.id);
      const cls = vis?.riskClass;
      if (show && (cls === "high" || cls === "veryHigh")) {
        tmp.set(RISK_COLORS[cls]);
        col.set(tmp.r, tmp.g, tmp.b, 0.95);
      } else col.set(0, 0, 0, 0);
    }
  }

  setSelection(id: string | null) {
    if (id === this.selected) return;
    this.selected = id && this.set.byId.has(id) ? id : null;
    this.pulseT = 0;
    this.ring.visible = !!this.selected;
    if (this.selected) {
      const a = this.set.byId.get(this.selected)!;
      const r = Math.min(Math.max(a.radius * 0.32, 2.5), 22);
      this.ring.scale.set(r, 1, r);
      this.ring.position.set(a.anchor[0], 0, a.anchor[1]);
    }
  }

  /** `height` = current prism height of the selection. Returns true while the pulse animates. */
  tick(dt: number, height: number, animate: boolean) {
    if (!this.selected) return false;
    this.ring.position.y = height + 0.12;
    const u = this.ring.material.uniforms;
    if (!animate) {
      u.uActive.value = 0;
      return false;
    }
    this.pulseT += dt;
    const active = this.pulseT < PULSE_SECONDS;
    u.uActive.value = active ? 1 : 0;
    u.uTime.value = this.pulseT;
    return active;
  }

  dispose() {
    this.outline.material.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}
