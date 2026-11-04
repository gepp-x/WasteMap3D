import * as THREE from "three";
import type { SceneFrame } from "../frame";
import { createGridMaterial } from "../shaders/grid";

/**
 * Ground: one large plane with the technical-grid shader (fades around the camera target), an
 * optional shadow-catcher plane (high tier only) and boundary outlines (Hat Yai municipality in
 * city scope; selected-area boundary + building-window frame in neighbourhood scope).
 */
export class GroundField {
  readonly group = new THREE.Group();
  private readonly grid: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly catcher: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  private readonly boundary: THREE.LineSegments<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  private readonly frameLine: THREE.LineLoop<THREE.BufferGeometry, THREE.LineDashedMaterial>;

  constructor() {
    this.group.name = "ground";
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    this.grid = new THREE.Mesh(plane, createGridMaterial());
    this.grid.renderOrder = -10;
    this.grid.frustumCulled = false;

    this.catcher = new THREE.Mesh(plane, new THREE.ShadowMaterial({ color: 0x01060d, opacity: 0.38, transparent: true, depthWrite: false }));
    this.catcher.position.y = 0.02;
    this.catcher.receiveShadow = true;
    this.catcher.visible = false;

    this.boundary = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: "#25d9f2", transparent: true, opacity: 0.55, dashSize: 3, gapSize: 2, depthWrite: false, toneMapped: false }),
    );
    this.boundary.visible = false;
    this.boundary.renderOrder = 2;

    this.frameLine = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: "#3b6a8a", transparent: true, opacity: 0.6, dashSize: 12, gapSize: 8, depthWrite: false, toneMapped: false }),
    );
    this.frameLine.visible = false;

    for (const o of [this.grid, this.catcher, this.boundary, this.frameLine]) o.raycast = () => {};
    this.group.add(this.grid, this.catcher, this.boundary, this.frameLine);
  }

  configure(frame: SceneFrame, shadows: boolean) {
    const size = frame.half * 16;
    const [cx, cz] = frame.center;
    this.grid.scale.set(size, 1, size);
    this.grid.position.set(cx, 0, cz);
    this.catcher.scale.set(frame.half * 3, 1, frame.half * 3);
    this.catcher.position.set(cx, 0.02, cz);
    this.catcher.visible = shadows;
    const u = this.grid.material.uniforms;
    u.uMinor.value = frame.grid.minor;
    u.uMajor.value = frame.grid.major;
    u.uRadius.value = frame.half * 2.4;
    const dash = frame.kind === "neighborhood" ? 6 : Math.max(0.8, frame.half * 0.012);
    this.boundary.material.dashSize = dash;
    this.boundary.material.gapSize = dash * 0.6;
    // building-window frame (neighbourhood only)
    if (frame.kind === "neighborhood") {
      const h = frame.half;
      this.frameLine.geometry.dispose();
      this.frameLine.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-h, 0.05, -h),
        new THREE.Vector3(h, 0.05, -h),
        new THREE.Vector3(h, 0.05, h),
        new THREE.Vector3(-h, 0.05, h),
      ]);
      this.frameLine.computeLineDistances();
      this.frameLine.visible = true;
    } else {
      this.frameLine.visible = false;
    }
  }

  /** Replaces the boundary outline (geometry ownership transfers to the ground). */
  setBoundary(geo: THREE.BufferGeometry | null, color = "#25d9f2", opacity = 0.55) {
    this.boundary.geometry.dispose();
    this.boundary.geometry = geo ?? new THREE.BufferGeometry();
    this.boundary.material.color.set(color);
    this.boundary.material.opacity = opacity;
    if (geo) this.boundary.computeLineDistances();
    this.boundary.visible = !!geo;
  }

  /** Grid fade follows the camera target. */
  follow(target: THREE.Vector3) {
    (this.grid.material.uniforms.uCenter.value as THREE.Vector3).copy(target);
  }

  dispose() {
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.catcher.material.dispose();
    this.boundary.geometry.dispose();
    this.boundary.material.dispose();
    this.frameLine.geometry.dispose();
    this.frameLine.material.dispose();
  }
}
