import * as THREE from "three";
import { buildFlatPolygons, buildRibbons } from "../ribbon-geometry";
import type { WaterInputs } from "../waterways";
import { createFlowMaterial, createWaterAreaMaterial } from "../shaders/water";

/**
 * Waterways: merged flow ribbons (one draw call) + merged water polygons (one draw call).
 * Flow time only advances while `flowing` (effects on, reduced motion off); rain speeds it up.
 */
export class WaterField {
  readonly group = new THREE.Group();
  private readonly ribbons: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly areas: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private time = 0;
  count = 0;

  constructor() {
    this.group.name = "waterways";
    this.ribbons = new THREE.Mesh(new THREE.BufferGeometry(), createFlowMaterial());
    this.areas = new THREE.Mesh(new THREE.BufferGeometry(), createWaterAreaMaterial());
    this.ribbons.renderOrder = 1;
    this.areas.renderOrder = 0;
    this.ribbons.raycast = () => {};
    this.areas.raycast = () => {};
    this.ribbons.visible = false;
    this.areas.visible = false;
    this.group.add(this.areas, this.ribbons);
  }

  /** Rebuilds geometry. `spacing` = streak spacing in scene units, `shimmerScale` = water pattern size. */
  setData(input: WaterInputs, y: number, spacing: number, shimmerScale: number) {
    this.ribbons.geometry.dispose();
    this.areas.geometry.dispose();
    const r = buildRibbons(input.lines, y + 0.02);
    const a = buildFlatPolygons(input.areas, y);
    this.ribbons.geometry = r ?? new THREE.BufferGeometry();
    this.areas.geometry = a ?? new THREE.BufferGeometry();
    this.ribbons.visible = !!r;
    this.areas.visible = !!a;
    this.ribbons.material.uniforms.uSpacing.value = spacing;
    this.areas.material.uniforms.uScale.value = shimmerScale;
    this.count = input.lines.length + input.areas.length;
  }

  setStyle(visible: boolean, opacity: number) {
    this.group.visible = visible;
    this.ribbons.material.uniforms.uOpacity.value = Math.min(1, opacity);
    this.areas.material.uniforms.uOpacity.value = Math.min(1, opacity) * 0.92;
  }

  tick(dt: number, rain: number, flowing: boolean) {
    if (flowing) {
      this.time = (this.time + dt * (1 + rain * 1.2)) % 3600;
      this.ribbons.material.uniforms.uTime.value = this.time;
      this.areas.material.uniforms.uTime.value = this.time;
    }
    this.ribbons.material.uniforms.uIntensity.value = rain;
    this.areas.material.uniforms.uIntensity.value = rain;
  }

  dispose() {
    this.ribbons.geometry.dispose();
    this.ribbons.material.dispose();
    this.areas.geometry.dispose();
    this.areas.material.dispose();
  }
}
