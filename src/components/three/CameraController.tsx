"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useThree } from "@react-three/fiber";
import type { OrbitControls } from "three-stdlib";
import { useDashboard } from "@/store/dashboard-store";
import { DURATION } from "@/lib/animation/tokens";
import type { SceneFrame } from "@/lib/three/frame";
import type { AreaGeomSet } from "@/lib/three/area-geometry";
import type { PrismField } from "@/lib/three/runtime/prisms";
import { presetPose, type CameraRig, type FocusInfo } from "@/lib/three/runtime/camera-rig";
import { useThreeUi } from "@/lib/three/ui-store";

interface Ctx {
  cityFrame: SceneFrame;
  nbFrame: SceneFrame | null;
  set: AreaGeomSet | null;
  field: PrismField | null;
  reduced: boolean;
  selectedId: string | null;
  displayScope: "city" | "neighborhood";
}

function focusInfoOf(c: Ctx, id: string | null): FocusInfo | null {
  if (!id || !c.set) return null;
  const a = c.set.byId.get(id);
  if (!a) return null;
  return { anchor: a.anchor, radius: a.radius, height: c.field ? c.field.targetHeightOf(id) : 0 };
}

/**
 * Drives the camera from shared state:
 *   cameraPreset + cameraNonce  → preset tweens (overview / isometric / top-down / focus)
 *   focusNonce / selection      → focus the selected area (city) or reframe the window (neighbourhood)
 *   threeScope                  → two-phase dolly between city and neighbourhood frames
 * plus an establishing shot on first mount and keyboard navigation on the stage element.
 * All tweens: GSAP power3, DURATION tokens, controls disabled meanwhile, instant under reduced motion.
 */
export function CameraController({
  rig,
  cityFrame,
  nbFrame,
  set,
  field,
  stageRef,
  reduced,
  playIntro,
  onIntroStarted,
}: {
  rig: CameraRig;
  cityFrame: SceneFrame;
  nbFrame: SceneFrame | null;
  set: AreaGeomSet | null;
  field: PrismField | null;
  stageRef: RefObject<HTMLDivElement | null>;
  reduced: boolean;
  /** False when the canvas was re-created (quality AA switch / context retry) — land directly. */
  playIntro: boolean;
  onIntroStarted: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as OrbitControls | null;
  const invalidate = useThree((s) => s.invalidate);

  const cameraNonce = useDashboard((s) => s.cameraNonce);
  const focusNonce = useDashboard((s) => s.focusNonce);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const requestedScope = useDashboard((s) => s.threeScope);
  const displayScope = useThreeUi((s) => s.displayScope);

  // latest values for imperative callbacks
  const ctx = useRef<Ctx>({ cityFrame, nbFrame, set, field, reduced, selectedId, displayScope });
  useEffect(() => {
    ctx.current = { cityFrame, nbFrame, set, field, reduced, selectedId, displayScope };
  });

  // bind camera + controls
  useEffect(() => {
    rig.bind(camera, controls, invalidate);
  }, [rig, camera, controls, invalidate]);

  useEffect(() => () => rig.dispose(), [rig]);

  // establishing shot (once per mount, after controls exist)
  const introRef = useRef({ playIntro, onIntroStarted });
  useEffect(() => {
    introRef.current = { playIntro, onIntroStarted };
  });
  useEffect(() => {
    if (!controls) return;
    const c = ctx.current;
    const f = c.displayScope === "neighborhood" && c.nbFrame ? c.nbFrame : c.cityFrame;
    const { playIntro: play, onIntroStarted: started } = introRef.current;
    const overview = presetPose("overview", f);
    rig.intro(play ? presetPose("approach", f) : overview, overview, DURATION.cityFlight, c.reduced || !play);
    if (play) started();
  }, [rig, controls]);

  // preset requests
  const lastCameraNonce = useRef(cameraNonce);
  useEffect(() => {
    if (lastCameraNonce.current === cameraNonce) return;
    lastCameraNonce.current = cameraNonce;
    const c = ctx.current;
    const dash = useDashboard.getState();
    const preset = dash.cameraPreset;
    // resolve against the requested scope so a preset issued mid-transition lands in the right frame
    const frame = dash.threeScope === "neighborhood" && c.nbFrame ? c.nbFrame : c.cityFrame;
    const focus = preset === "focus" && frame.kind === "city" ? focusInfoOf(c, c.selectedId) : null;
    rig.goTo(presetPose(preset === "focus" && frame.kind === "city" && !focus ? "overview" : preset, frame, focus), { reduced: c.reduced });
  }, [cameraNonce, rig]);

  // focus requests (ranking row / map click / 3D click)
  const lastFocusNonce = useRef(focusNonce);
  useEffect(() => {
    if (lastFocusNonce.current === focusNonce) return;
    lastFocusNonce.current = focusNonce;
    const c = ctx.current;
    // a focus request overrides an ordinary tween (e.g. the intro) but never a scope transition
    if (!c.selectedId || useThreeUi.getState().transitioning) return;
    if (c.displayScope === "city") {
      const focus = focusInfoOf(c, c.selectedId);
      if (focus) rig.goTo(presetPose("focus", c.cityFrame, focus), { reduced: c.reduced });
    }
  }, [focusNonce, rig]);

  // neighbourhood: a new selection loads a new window → reframe once its frame is known
  const nbKey = nbFrame?.key ?? null;
  const lastNbKey = useRef(nbKey);
  useEffect(() => {
    const prev = lastNbKey.current;
    lastNbKey.current = nbKey;
    const c = ctx.current;
    if (!nbKey || !prev || prev === nbKey || c.displayScope !== "neighborhood" || !c.nbFrame || useThreeUi.getState().transitioning) return;
    // only reframe when the area itself changed (not when the default frame is refined by the loaded window)
    if (prev.split(":")[1] === nbKey.split(":")[1]) return;
    rig.goTo(presetPose("overview", c.nbFrame), { reduced: c.reduced });
  }, [nbKey, rig]);

  // scope transitions (city ⇄ neighbourhood)
  useEffect(() => {
    const ui = useThreeUi.getState();
    const c = ctx.current;
    if (requestedScope === ui.displayScope) {
      // request reverted before the swap (e.g. missing building window) → abort and settle in place
      if (rig.cancelTransition()) {
        ui.setTransitioning(false);
        if (requestedScope === "neighborhood" && c.nbFrame) rig.goTo(presetPose("overview", c.nbFrame), { reduced: c.reduced });
        else {
          const focus = focusInfoOf(c, c.selectedId);
          rig.goTo(focus ? presetPose("focus", c.cityFrame, focus) : presetPose("overview", c.cityFrame), { reduced: c.reduced });
        }
      }
      return;
    }
    if (requestedScope === "neighborhood" && !c.nbFrame) {
      useDashboard.getState().setThreeScope("city");
      return;
    }
    ui.setTransitioning(true);
    const swap = () => {
      useThreeUi.getState().setDisplayScope(useDashboard.getState().threeScope);
      useThreeUi.getState().setTransitioning(false);
    };
    if (requestedScope === "neighborhood") {
      const nb = c.nbFrame!;
      const focus = focusInfoOf(c, c.selectedId);
      const via = focus ? presetPose("focus", c.cityFrame, { ...focus, radius: focus.radius * 0.35 }) : null;
      rig.transition(via, swap, presetPose("approach", nb), presetPose("overview", nb), c.reduced);
    } else {
      const from = c.nbFrame;
      const via = from ? { position: [0, from.half * 2.6, from.half * 1.4] as [number, number, number], target: [0, 0, 0] as [number, number, number] } : null;
      const landing = ui.landing;
      ui.setLanding(null);
      const focus = landing === "overview" ? null : focusInfoOf(c, c.selectedId);
      const to = focus ? presetPose("focus", c.cityFrame, focus) : presetPose("overview", c.cityFrame);
      const approach = focus
        ? { position: [focus.anchor[0], focus.height + c.cityFrame.half * 0.06, focus.anchor[1] + c.cityFrame.half * 0.05] as [number, number, number], target: [focus.anchor[0], 0, focus.anchor[1]] as [number, number, number] }
        : presetPose("approach", c.cityFrame);
      rig.transition(via, swap, approach, to, c.reduced);
    }
  }, [requestedScope, rig]);

  // keyboard navigation on the stage (focusable region)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== el || e.altKey || e.metaKey || e.ctrlKey) return;
      const shift = e.shiftKey;
      const map: Record<string, Parameters<CameraRig["nudge"]>[0]> = {
        ArrowLeft: shift ? "panLeft" : "left",
        ArrowRight: shift ? "panRight" : "right",
        ArrowUp: shift ? "panUp" : "up",
        ArrowDown: shift ? "panDown" : "down",
        "+": "in",
        "=": "in",
        "-": "out",
        _: "out",
      };
      const action = map[e.key];
      if (action) {
        e.preventDefault();
        rig.nudge(action);
        return;
      }
      if (e.key === "Escape" && useDashboard.getState().selectedAreaId) {
        e.preventDefault();
        useDashboard.getState().selectArea(null, { focus: false });
      } else if (e.key === "0" || e.key === "Home") {
        e.preventDefault();
        useDashboard.getState().setCameraPreset("overview");
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [stageRef, rig]);

  return null;
}
