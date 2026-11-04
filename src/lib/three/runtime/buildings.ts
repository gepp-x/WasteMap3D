import * as THREE from "three";
import type { BuildingWindow } from "@/lib/types";
import { buildBuildings, roadLines, type BuildingBuild } from "../building-geometry";
import { buildRibbons } from "../ribbon-geometry";
import { createBuildingMaterial, type BuildingUniforms } from "../shaders/building-rise";

/**
 * Neighbourhood buildings + roads. Buildings: one merged mesh (rise-in shader, risk tint uniform);
 * roads: one merged ribbon mesh with vertex colours. Shadows switch on only after the rise has
 * finished (the depth pass does not run the rise patch).
 */

const RISE_SECONDS = 1.2;

export class BuildingField {
  readonly group = new THREE.Group();
  private readonly buildings: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private readonly roads: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly u: BuildingUniforms;
  private rise = 1;
  private tintTarget = 0;
  private readonly tintColor = new THREE.Color();
  private shadows = false;

  constructor() {
    this.group.name = "buildings";
    const { material, uniforms } = createBuildingMaterial();
    this.u = uniforms;
    this.buildings = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.buildings.raycast = () => {};
    this.buildings.visible = false;
    this.roads = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false, transparent: true, opacity: 0.95 }),
    );
    this.roads.raycast = () => {};
    this.roads.renderOrder = 1;
    this.roads.visible = false;
    this.group.add(this.roads, this.buildings);
  }

  /** Builds the merged meshes for a window. Returns build stats (or null when no buildings). */
  setWindow(win: BuildingWindow | null, cap: number, reduced: boolean): BuildingBuild | null {
    this.buildings.geometry.dispose();
    this.roads.geometry.dispose();
    const build = win ? buildBuildings(win, cap) : null;
    const roads = win ? buildRibbons(roadLines(win), 0.04) : null;
    this.buildings.geometry = build?.geometry ?? new THREE.BufferGeometry();
    this.roads.geometry = roads ?? new THREE.BufferGeometry();
    this.buildings.visible = !!build;
    this.roads.visible = !!roads;
    this.rise = reduced ? 1 : 0;
    this.u.uRise.value = this.rise;
    this.buildings.castShadow = false;
    this.buildings.receiveShadow = this.shadows;
    return build;
  }

  setShadows(on: boolean) {
    this.shadows = on;
    this.buildings.receiveShadow = on;
    this.buildings.castShadow = on && this.rise >= 1;
  }

  /** Subtle tint toward the selected area's modelled risk-class colour (null → none). */
  setTint(color: string | null, amount: number) {
    if (color) this.tintColor.set(color);
    this.tintTarget = color ? amount : 0;
  }

  tick(dt: number, reduced: boolean) {
    let moving = false;
    if (this.rise < 1) {
      this.rise = reduced ? 1 : Math.min(1, this.rise + dt / RISE_SECONDS);
      this.u.uRise.value = this.rise;
      moving = this.rise < 1;
      if (!moving) this.buildings.castShadow = this.shadows;
    }
    const k = reduced ? 1 : 1 - Math.exp(-dt * 3);
    const cur = this.u.uTintAmount.value;
    const next = cur + (this.tintTarget - cur) * k;
    this.u.uTintAmount.value = Math.abs(this.tintTarget - next) < 0.001 ? this.tintTarget : next;
    if (this.u.uTintAmount.value !== this.tintTarget) moving = true;
    const tc = this.u.uTint.value.lerp(this.tintColor, k);
    if (Math.abs(tc.r - this.tintColor.r) + Math.abs(tc.g - this.tintColor.g) + Math.abs(tc.b - this.tintColor.b) < 0.002) tc.copy(this.tintColor);
    else moving = true;
    return moving;
  }

  dispose() {
    this.buildings.geometry.dispose();
    this.buildings.material.dispose();
    this.roads.geometry.dispose();
    this.roads.material.dispose();
  }
}
