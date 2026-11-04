import * as THREE from "three";
import { createRainGeometry, createRainMaterial } from "../shaders/rain";

/**
 * GPU rain. CPU work per frame = a handful of uniform writes, independent of drop count.
 * The rain volume is a box centred on the orbit target and sized from the camera distance, so the
 * same tuning reads correctly at city scale and in the 1 km neighbourhood window.
 */
export class RainSystem {
  readonly lines: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private count = 0;
  private time = 0;
  /** Smoothed 0–1 visual intensity. */
  level = 0;

  constructor() {
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), createRainMaterial());
    this.lines.frustumCulled = false;
    this.lines.raycast = () => {};
    this.lines.renderOrder = 10;
    this.lines.visible = false;
    this.lines.name = "rain";
  }

  setCount(n: number) {
    if (n === this.count) return;
    this.lines.geometry.dispose();
    this.lines.geometry = n > 0 ? createRainGeometry(n) : new THREE.BufferGeometry();
    this.count = n;
  }

  /**
   * @param target   0–1 intensity target (already includes effects/quality gating)
   * @param center   orbit target (box follows it)
   * @param distance camera → target distance (sizes the box)
   * @param animate  false under reduced motion → streaks hold still but density still shows intensity
   * @returns true while visible or fading
   */
  tick(dt: number, target: number, center: THREE.Vector3, distance: number, animate: boolean) {
    const k = 1 - Math.exp(-dt * 1.6);
    this.level += (target - this.level) * (animate ? k : 1);
    if (Math.abs(target - this.level) < 0.002) this.level = target;
    const t = this.level;
    const visible = t > 0.004 && this.count > 0;
    this.lines.visible = visible;
    if (!visible) return Math.abs(target - this.level) > 0;
    const u = this.lines.material.uniforms;
    const boxY = Math.min(900, Math.max(60, distance * 0.6));
    (u.uBox.value as THREE.Vector3).set(boxY * 1.6, boxY, boxY * 1.6);
    (u.uCenter.value as THREE.Vector3).copy(center);
    u.uDensity.value = 0.1 + 0.9 * Math.pow(t, 0.85);
    u.uSpeed.value = boxY * (0.75 + 0.85 * t);
    u.uLength.value = boxY * (0.018 + 0.03 * t);
    u.uOpacity.value = 0.22 + 0.5 * t;
    (u.uWind.value as THREE.Vector2).set(0.12 + 0.22 * t, 0.05 + 0.08 * t);
    if (animate) {
      this.time = (this.time + dt) % 600;
      u.uTime.value = this.time;
    }
    return true;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
  }
}
