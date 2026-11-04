"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree, type RootState } from "@react-three/fiber";
import { useCityBundle } from "@/lib/data/loader";
import { useScenario } from "@/lib/simulation/use-scenario";
import { useDashboard } from "@/store/dashboard-store";
import { useReducedMotionPref } from "@/lib/animation/tokens";
import { useTr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AreaRecord } from "@/lib/types";
import { computeAreaVisuals } from "@/lib/three/area-visuals";
import { floodTargets } from "@/lib/three/flood";
import { TIER_SETTINGS, detectTier, probeWebGL } from "@/lib/three/quality";
import { rainLevel } from "@/lib/three/runtime/atmosphere";
import { useThreeUi } from "@/lib/three/ui-store";
import { placeTooltip } from "@/lib/three/dom";
import { silenceKnownThreeWarnings } from "@/lib/three/console";
import { CityScene } from "./CityScene";
import { ThreeOverlay } from "./ThreeOverlay";
import { WebglFallback } from "./WebglFallback";
import { SelectedAreaLabel } from "./SelectedAreaLabel";

silenceKnownThreeWarnings();

const S = {
  region: { th: "ดิจิทัลทวิน 3 มิติของเมือง", en: "3D city digital twin" },
  roledesc: { th: "ฉาก 3 มิติแบบโต้ตอบ", en: "interactive 3D scene" },
  keys: {
    th: "ใช้ลูกศรเพื่อหมุนและเอียงกล้อง Shift + ลูกศรเพื่อเลื่อน ปุ่ม + และ − เพื่อซูม ปุ่ม 0 กลับสู่ภาพรวม และ Esc เพื่อยกเลิกการเลือกพื้นที่ เลือกพื้นที่ได้จากแผนที่หรือตารางอันดับ",
    en: "Arrow keys orbit and tilt, Shift + arrows pan, + and − zoom, 0 returns to the overview and Esc clears the selection. Areas can also be selected from the map or the ranking.",
  },
  starting: { th: "กำลังเตรียมฉาก 3 มิติ…", en: "Preparing the 3D scene…" },
};

/**
 * 3D digital twin entry point (loaded by the shell with next/dynamic, ssr: false).
 *
 * - WebGL 2 probe → store.webglSupported; unsupported / context lost → fallback card with
 *   "Back to 2D" (the rest of the dashboard keeps working).
 * - frameloop: "never" when inactive (stays mounted), "always" only while something animates
 *   continuously (rain, flowing water, flood shimmer), otherwise "demand" + invalidate().
 * - Quality tier → DPR range, antialias (canvas re-created when AA must change), shadows, counts.
 */
export function DigitalTwinCanvas({ className, active = true }: { className?: string; active?: boolean }) {
  const t = useTr();
  const descId = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  // ---- capability probe (once per mount; this component is client-only)
  const [probe] = useState(() => probeWebGL());
  const [detected] = useState(() => (probe.supported ? detectTier(probe) : "low"));
  const [lost, setLost] = useState(false);
  const [canvasKey, setCanvasKey] = useState(0);
  const [introPlayed, setIntroPlayed] = useState(false);
  const onIntroStarted = useCallback(() => setIntroPlayed(true), []);

  useEffect(() => {
    useDashboard.getState().setWebglSupported(probe.supported);
  }, [probe]);

  useEffect(
    () => () => {
      useThreeUi.getState().reset();
    },
    [],
  );

  // ---- shared state
  const quality = useDashboard((s) => s.quality);
  const tier = useDashboard((s) => s.qualityTier);
  const effects = useDashboard((s) => s.effectsEnabled);
  const waterVisible = useDashboard((s) => s.layers.waterways.visible);
  const activeChoropleth = useDashboard((s) => s.activeChoropleth);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const reduced = useReducedMotionPref();
  const displayScope = useThreeUi((s) => s.displayScope);
  const nbWater = useThreeUi((s) => s.buildingStats?.waterCount ?? 0);
  const { status, bundle, error } = useCityBundle();
  const scenario = useScenario();

  const visuals = useMemo(() => computeAreaVisuals(scenario, activeChoropleth), [scenario, activeChoropleth]);
  const flood = useMemo(() => floodTargets(scenario, displayScope, selectedId), [scenario, displayScope, selectedId]);
  const areasById = useMemo(() => new Map<string, AreaRecord>((bundle?.dataset.areas ?? []).map((a) => [a.id, a])), [bundle]);

  const settings = TIER_SETTINGS[tier];
  const aa = TIER_SETTINGS[quality === "auto" ? detected : quality].antialias;
  const cityWater = bundle?.waterways?.features?.length ?? 0;
  const hasWater = displayScope === "neighborhood" ? nbWater > 0 : cityWater > 0;
  const motionOk = effects && !reduced;
  const rainOn = motionOk && settings.rainCount > 0 && rainLevel(scenario.visualIntensityMmH) > 0;
  const waterOn = motionOk && waterVisible && hasWater;
  const floodOn = motionOk && flood.length > 0;
  const continuous = rainOn || waterOn || floodOn;
  const frameloop = !active ? "never" : continuous ? "always" : "demand";

  // ---- context loss
  const onLost = useCallback((e: Event) => {
    e.preventDefault();
    setLost(true);
  }, []);

  const onCreated = useCallback(
    (state: RootState) => {
      state.gl.toneMapping = THREE.ACESFilmicToneMapping;
      state.gl.toneMappingExposure = 1;
      state.gl.outputColorSpace = THREE.SRGBColorSpace;
      const el = state.gl.domElement;
      canvasElRef.current = el;
      el.addEventListener("webglcontextlost", onLost, false);
    },
    [onLost],
  );

  useEffect(
    () => () => {
      canvasElRef.current?.removeEventListener("webglcontextlost", onLost, false);
    },
    [onLost, canvasKey, aa],
  );

  const retry = () => {
    canvasElRef.current?.removeEventListener("webglcontextlost", onLost, false);
    canvasElRef.current = null;
    setLost(false);
    setCanvasKey((k) => k + 1);
  };

  const gl = useMemo(() => ({ antialias: aa, alpha: false, stencil: false, powerPreference: "high-performance" as const }), [aa]);

  const failed = !probe.supported || lost;
  // PCF (three r18x removed PCFSoftShadowMap; "soft" would only log a deprecation warning)
  const shadows = settings.shadows ? ("percentage" as const) : false;

  return (
    <div className={cn("relative isolate h-full w-full overflow-hidden bg-[#06101c]", className)}>
      <div
        ref={stageRef}
        tabIndex={failed ? -1 : 0}
        role="region"
        aria-roledescription={t(S.roledesc)}
        aria-label={t(S.region)}
        aria-describedby={descId}
        className="absolute inset-0 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ui-cyan)]"
        onPointerMove={(e) => {
          const tip = tooltipRef.current;
          if (!tip) return;
          if (tip.dataset.inside !== "true") tip.dataset.inside = "true";
          placeTooltip(tip, stageRef.current, e.clientX, e.clientY);
        }}
        onPointerLeave={() => {
          const tip = tooltipRef.current;
          if (tip) tip.dataset.inside = "false";
        }}
      >
        {failed ? (
          <WebglFallback reason={lost ? "lost" : "unsupported"} onRetry={lost ? retry : undefined} />
        ) : (
          <Canvas
            key={`${canvasKey}:${aa ? "aa" : "no-aa"}`}
            frameloop={frameloop}
            dpr={settings.dpr}
            shadows={shadows}
            gl={gl}
            camera={{ fov: 38, near: 1, far: 9000, position: [0, 900, 1100] }}
            performance={{ min: 0.6, max: 1, debounce: 300 }}
            onCreated={onCreated}
            fallback={<p className="p-4 text-sm text-ui-text-2">{t(S.starting)}</p>}
          >
            <ActiveInvalidator active={active} />
            <CityScene
              bundle={bundle}
              visuals={visuals}
              scenarioSource={scenario.source}
              visualIntensityMmH={scenario.visualIntensityMmH}
              flood={flood}
              tier={tier}
              autoCeiling={detected}
              reduced={reduced}
              effects={effects}
              continuous={continuous && active}
              stageRef={stageRef}
              labelRef={labelRef}
              playIntro={!introPlayed}
              onIntroStarted={onIntroStarted}
            />
          </Canvas>
        )}
        {!failed && <SelectedAreaLabel ref={labelRef} visuals={visuals} areasById={areasById} showRisk={scenario.source !== "baseline"} />}
      </div>
      <p id={descId} className="sr-only">
        {t(S.keys)}
      </p>
      <ThreeOverlay
        visuals={visuals}
        scenarioSource={scenario.source}
        bundleStatus={status}
        bundleError={error}
        areasById={areasById}
        tooltipRef={tooltipRef}
        showCanvasUi={!failed}
      />
    </div>
  );
}

/** Renders one frame whenever the canvas becomes active again (frameloop leaves "never"). */
function ActiveInvalidator({ active }: { active: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (active) invalidate();
  }, [active, invalidate]);
  return null;
}
