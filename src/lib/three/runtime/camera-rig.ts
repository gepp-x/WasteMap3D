import gsap from "gsap";
import * as THREE from "three";
import type { OrbitControls } from "three-stdlib";
import type { CameraPreset } from "@/store/dashboard-store";
import { DURATION, GSAP_EASE } from "@/lib/animation/tokens";
import type { SceneFrame } from "../frame";

/**
 * Camera choreography (GSAP timelines over camera.position + controls.target).
 *
 * • OrbitControls are disabled for the duration of a tween and their damping inertia is cleared
 *   first, so GSAP and damping never fight; they are re-enabled (and synced) on complete/kill.
 * • Every timeline is killed before a new one starts and on unmount (no orphan tweens).
 * • Reduced motion → poses are applied instantly.
 * • onUpdate → invalidate(), so tweens render even while the canvas is in on-demand mode.
 */

export type Vec3 = [number, number, number];
export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

export interface FocusInfo {
  anchor: [number, number];
  radius: number;
  height: number;
}

export function presetPose(preset: CameraPreset | "approach", frame: SceneFrame, focus?: FocusInfo | null): CameraPose {
  const R = frame.half;
  const [cx, cz] = frame.center;
  if (frame.kind === "neighborhood") {
    switch (preset) {
      case "isometric":
        return { position: [R * 0.85, R * 0.78, R * 0.85], target: [0, 0, 0] };
      case "topdown":
        return { position: [0, R * 2.1, 0.01], target: [0, 0, 0] };
      case "focus":
        return { position: [R * 0.26, R * 0.2, R * 0.38], target: [0, 6, 0] };
      case "approach":
        return { position: [0, R * 2.9, R * 1.7], target: [0, 0, 0] };
      default:
        return { position: [0, R * 0.95, R * 1.18], target: [0, 0, 0] };
    }
  }
  switch (preset) {
    case "isometric":
      return { position: [cx + R * 1.02, R * 0.95, cz + R * 1.02], target: [cx, 0, cz] };
    case "topdown":
      return { position: [cx, R * 2.25, cz + 0.01], target: [cx, 0, cz] };
    case "focus": {
      if (!focus) return presetPose("overview", frame);
      const [ax, az] = focus.anchor;
      const ty = focus.height * 0.45;
      const d = Math.min(R * 0.95, Math.max(R * 0.2, focus.radius * 2.6 + focus.height * 1.4));
      return { position: [ax + d * 0.32, ty + d * 0.74, az + d * 0.86], target: [ax, ty, az] };
    }
    case "approach":
      return { position: [cx, R * 3.2, cz + R * 2.3], target: [cx, 0, cz] };
    default:
      return { position: [cx, R * 1.3, cz + R * 1.5], target: [cx, 0, cz] };
  }
}

interface GoOptions {
  duration?: number;
  ease?: string;
  reduced?: boolean;
}

export class CameraRig {
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private invalidate: () => void = () => {};
  private tl: gsap.core.Timeline | null = null;
  private pendingSwap: (() => void) | null = null;
  private pendingPose: CameraPose | null = null;
  private introDone = false;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  bind(camera: THREE.Camera, controls: OrbitControls | null, invalidate: () => void) {
    this.camera = camera instanceof THREE.PerspectiveCamera ? camera : null;
    this.controls = controls;
    this.invalidate = invalidate;
    if (this.pendingPose && this.controls) {
      const p = this.pendingPose;
      this.pendingPose = null;
      this.apply(p);
    }
  }

  get ready() {
    return !!(this.camera && this.controls);
  }

  /** Instantly applies a pose. */
  apply(pose: CameraPose) {
    const cam = this.camera;
    const ctl = this.controls;
    if (!cam || !ctl) {
      this.pendingPose = pose;
      return;
    }
    this.clearInertia();
    cam.position.set(...pose.position);
    ctl.target.set(...pose.target);
    cam.lookAt(ctl.target);
    ctl.update();
    this.invalidate();
  }

  /** Establishing shot, once per rig: from `from` to `to` (instant under reduced motion). */
  intro(from: CameraPose, to: CameraPose, duration: number, reduced: boolean) {
    if (this.introDone || !this.ready) return;
    this.introDone = true;
    if (reduced) {
      this.apply(to);
      return;
    }
    this.apply(from);
    this.goTo(to, { duration });
  }

  /** Tweens to a pose (power3.inOut, DURATION.camera by default). */
  goTo(pose: CameraPose, opts: GoOptions = {}) {
    this.kill();
    const cam = this.camera;
    const ctl = this.controls;
    if (!cam || !ctl || opts.reduced) {
      this.apply(pose);
      return;
    }
    const duration = opts.duration ?? DURATION.camera;
    const ease = opts.ease ?? GSAP_EASE.camera;
    this.hold();
    const tl = gsap.timeline({ onUpdate: this.onUpdate, onComplete: this.release });
    tl.to(cam.position, { x: pose.position[0], y: pose.position[1], z: pose.position[2], duration, ease }, 0);
    tl.to(ctl.target, { x: pose.target[0], y: pose.target[1], z: pose.target[2], duration, ease }, 0);
    this.tl = tl;
  }

  /**
   * Two-phase transition between frames (city ⇄ neighbourhood):
   *   1. push toward `via` in the current frame (accelerating, power3.in)
   *   2. `swap()` the rendered scope, jump to `approach` in the new frame
   *   3. settle on `to` (decelerating, power3.out, DURATION.camera)
   */
  transition(via: CameraPose | null, swap: () => void, approach: CameraPose, to: CameraPose, reduced: boolean) {
    this.kill();
    const cam = this.camera;
    const ctl = this.controls;
    if (!cam || !ctl || reduced) {
      swap();
      this.apply(to);
      return;
    }
    this.hold();
    this.pendingSwap = swap;
    const tl = gsap.timeline({ onUpdate: this.onUpdate, onComplete: this.release });
    if (via) {
      tl.to(cam.position, { x: via.position[0], y: via.position[1], z: via.position[2], duration: 0.75, ease: "power3.in" }, 0);
      tl.to(ctl.target, { x: via.target[0], y: via.target[1], z: via.target[2], duration: 0.75, ease: "power3.in" }, 0);
    }
    tl.call(() => {
      this.runSwap();
      cam.position.set(...approach.position);
      ctl.target.set(...approach.target);
      cam.lookAt(ctl.target);
      this.invalidate();
    });
    tl.to(cam.position, { x: to.position[0], y: to.position[1], z: to.position[2], duration: DURATION.camera, ease: "power3.out" });
    tl.to(ctl.target, { x: to.target[0], y: to.target[1], z: to.target[2], duration: DURATION.camera, ease: "power3.out" }, "<");
    this.tl = tl;
  }

  /** Keyboard navigation (damped through OrbitControls). */
  nudge(action: "left" | "right" | "up" | "down" | "in" | "out" | "panLeft" | "panRight" | "panUp" | "panDown") {
    const ctl = this.controls;
    const cam = this.camera;
    if (!ctl || !cam || this.tl) return;
    switch (action) {
      case "left":
        ctl.setAzimuthalAngle(ctl.getAzimuthalAngle() - 0.18);
        break;
      case "right":
        ctl.setAzimuthalAngle(ctl.getAzimuthalAngle() + 0.18);
        break;
      case "up":
        ctl.setPolarAngle(Math.max(0.05, ctl.getPolarAngle() - 0.12));
        break;
      case "down":
        ctl.setPolarAngle(Math.min(ctl.maxPolarAngle, ctl.getPolarAngle() + 0.12));
        break;
      case "in":
        ctl.dollyIn(1.18);
        break;
      case "out":
        ctl.dollyOut(1.18);
        break;
      default: {
        const dist = cam.position.distanceTo(ctl.target);
        const right = this.tmpA.set(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
        const fwd = this.tmpB.set(0, 0, -1).applyQuaternion(cam.quaternion).setY(0).normalize();
        const step = dist * 0.08;
        const off = action === "panLeft" ? right.multiplyScalar(-step) : action === "panRight" ? right.multiplyScalar(step) : action === "panUp" ? fwd.multiplyScalar(step) : fwd.multiplyScalar(-step);
        cam.position.add(off);
        ctl.target.add(off);
        ctl.update();
      }
    }
    this.invalidate();
  }

  /** Keeps the orbit target near the content (called on controls change). */
  clampTarget(frame: SceneFrame) {
    const ctl = this.controls;
    const cam = this.camera;
    if (!ctl || !cam || this.tl) return;
    const lim = frame.half * 1.6;
    const [cx, cz] = frame.center;
    const t = ctl.target;
    const nx = Math.min(cx + lim, Math.max(cx - lim, t.x));
    const nz = Math.min(cz + lim, Math.max(cz - lim, t.z));
    const ny = Math.min(frame.half * 0.5, Math.max(0, t.y));
    if (nx !== t.x || nz !== t.z || ny !== t.y) {
      const off = this.tmpA.set(nx - t.x, ny - t.y, nz - t.z);
      t.add(off);
      cam.position.add(off);
    }
  }

  /** Cancels an in-flight scope transition WITHOUT swapping. Returns true when one was pending. */
  cancelTransition() {
    if (!this.pendingSwap) return false;
    this.pendingSwap = null;
    if (this.tl) {
      this.tl.kill();
      this.tl = null;
    }
    this.release();
    return true;
  }

  kill() {
    if (this.tl) {
      this.tl.kill();
      this.tl = null;
    }
    this.runSwap();
    this.release();
  }

  dispose() {
    this.kill();
    this.camera = null;
    this.controls = null;
  }

  private runSwap() {
    const s = this.pendingSwap;
    this.pendingSwap = null;
    s?.();
  }

  private clearInertia() {
    const ctl = this.controls;
    if (!ctl) return;
    const damping = ctl.enableDamping;
    ctl.enableDamping = false;
    ctl.update();
    ctl.enableDamping = damping;
  }

  private hold() {
    const ctl = this.controls;
    if (!ctl) return;
    this.clearInertia();
    ctl.enabled = false;
  }

  private readonly onUpdate = () => {
    const cam = this.camera;
    const ctl = this.controls;
    if (cam && ctl) cam.lookAt(ctl.target);
    this.invalidate();
  };

  private readonly release = () => {
    this.tl = null;
    const ctl = this.controls;
    if (!ctl) return;
    if (!ctl.enabled) {
      ctl.enabled = true;
      ctl.update();
    }
    this.invalidate();
  };
}
