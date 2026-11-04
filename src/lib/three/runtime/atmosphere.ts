import * as THREE from "three";
import type { SceneFrame } from "../frame";

/**
 * Lights, fog and background — and their environmental response to rain.
 *
 * `rain` (0–1, smoothed here) darkens and cools the scene: background/fog shift toward a deeper
 * navy, visibility (fog near/far) shrinks, the key light dims and turns bluer. Colours are lerped
 * between preallocated endpoints — no allocations per frame.
 *
 * Light budget (tuned for toneMapped:false data materials so prism tops ≈ legend colours):
 *   top face ≈ (sun·sin(elev) + hemi + ambient) / π ≈ 0.94 × albedo in clear weather.
 */

const CLEAR = {
  bg: new THREE.Color("#06101c"),
  sky: new THREE.Color("#dbe7f5"),
  ground: new THREE.Color("#1d2c40"),
  sun: new THREE.Color("#f6f8ff"),
  hemi: 0.85,
  sunI: 2.4,
  ambient: 0.3,
};
const STORM = {
  bg: new THREE.Color("#03080f"),
  sky: new THREE.Color("#a8bdd6"),
  ground: new THREE.Color("#111c2b"),
  sun: new THREE.Color("#a9bcd8"),
  hemi: 0.72,
  sunI: 1.45,
  ambient: 0.24,
};

export class Atmosphere {
  readonly group = new THREE.Group();
  readonly background = new THREE.Color().copy(CLEAR.bg);
  readonly fog = new THREE.Fog(CLEAR.bg.getHex(), 480, 1500);
  private readonly hemi = new THREE.HemisphereLight(CLEAR.sky, CLEAR.ground, CLEAR.hemi);
  private readonly ambient = new THREE.AmbientLight(0xffffff, CLEAR.ambient);
  private readonly sun = new THREE.DirectionalLight(CLEAR.sun, CLEAR.sunI);
  private half = 280;
  private applied = -1;
  /** Smoothed rain intensity 0–1 (read by rain / water each frame). */
  rain = 0;

  constructor() {
    this.group.name = "atmosphere";
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.group.add(this.hemi, this.ambient, this.sun, this.sun.target);
  }

  attach(scene: THREE.Scene) {
    scene.background = this.background;
    scene.fog = this.fog;
  }

  detach(scene: THREE.Scene) {
    if (scene.background === this.background) scene.background = null;
    if (scene.fog === this.fog) scene.fog = null;
  }

  /** Positions the key light for the frame and fits a tight shadow frustum around the content. */
  configure(frame: SceneFrame, shadows: boolean, mapSize: number) {
    const [cx, cz] = frame.center;
    const h = frame.half;
    this.half = h;
    // sun from the south-east, ~55° elevation
    this.sun.position.set(cx + h * 0.75, h * 1.55, cz + h * 0.55);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.target.updateMatrixWorld();
    this.sun.castShadow = shadows;
    const cam = this.sun.shadow.camera;
    const extent = h * (frame.kind === "neighborhood" ? 1.05 : 1.25);
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = h * 5;
    cam.updateProjectionMatrix();
    if (this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.shadow.needsUpdate = true;
    this.applied = -1;
    this.apply();
  }

  /** Smooths `rain` toward the target; returns true while still converging. */
  tick(dt: number, target: number, reduced: boolean) {
    const k = reduced ? 1 : 1 - Math.exp(-dt * 1.4);
    this.rain += (target - this.rain) * k;
    const converging = Math.abs(target - this.rain) > 0.002;
    if (!converging) this.rain = target;
    if (Math.abs(this.rain - this.applied) > 0.0005) this.apply();
    return converging;
  }

  private apply() {
    const t = this.rain;
    this.applied = t;
    this.background.lerpColors(CLEAR.bg, STORM.bg, t);
    this.fog.color.copy(this.background);
    this.fog.near = this.half * (1.7 - 0.8 * t);
    this.fog.far = this.half * (5.6 - 2.2 * t);
    this.hemi.color.lerpColors(CLEAR.sky, STORM.sky, t);
    this.hemi.groundColor.lerpColors(CLEAR.ground, STORM.ground, t);
    this.hemi.intensity = CLEAR.hemi + (STORM.hemi - CLEAR.hemi) * t;
    this.ambient.intensity = CLEAR.ambient + (STORM.ambient - CLEAR.ambient) * t;
    this.sun.color.lerpColors(CLEAR.sun, STORM.sun, t);
    this.sun.intensity = CLEAR.sunI + (STORM.sunI - CLEAR.sunI) * t;
  }

  dispose() {
    this.sun.shadow.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.ambient.dispose();
  }
}

/** Visual rain intensity (mm/h) → 0–1 environment level (0 none, ~5 light, ~15 moderate, ~35 heavy, 60+ extreme). */
export function rainLevel(mmH: number) {
  if (!Number.isFinite(mmH) || mmH <= 0.1) return 0;
  return Math.min(1, Math.pow(mmH / 60, 0.7));
}
