"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import dynamic from "next/dynamic";
import { motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { Box, Map as MapIcon, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTr } from "@/lib/i18n";
import { useDashboard } from "@/store/dashboard-store";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/dashboard/BrandMark";
import { ViewModeSwitch } from "@/components/dashboard/ViewModeSwitch";
import { SimulationBanner } from "@/components/dashboard/SimulationBanner";
import { SceneLayer } from "@/components/motion/SceneTransition";
import { StoryOverlay } from "@/components/dashboard/StoryOverlay";

/* ------------------------------------------------------------------ */
/*  Lazy engines                                                       */
/* ------------------------------------------------------------------ */

function StageSkeleton({ kind }: { kind: "map" | "3d" }) {
  const t = useTr();
  return (
    <div role="status" aria-live="polite" className="ui-grid-bg absolute inset-0 flex items-center justify-center bg-ui-bg-deep">
      <div className="flex flex-col items-center gap-3">
        <BrandMark size={40} className="animate-pulse opacity-80" />
        <div className="h-px w-40 overflow-hidden rounded-full bg-ui-border">
          <div className="h-full w-1/3 animate-[stage-scan_1.6s_var(--ease-standard)_infinite] rounded-full bg-ui-cyan/70" />
        </div>
        <p className="text-[12px] text-ui-text-3">
          {kind === "map" ? t({ th: "กำลังเตรียมแผนที่…", en: "Preparing the map…" }) : t({ th: "กำลังเตรียมแบบจำลองเมือง 3 มิติ…", en: "Preparing the 3D city twin…" })}
        </p>
      </div>
      <style>{`@keyframes stage-scan{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
    </div>
  );
}

const CityMap = dynamic<{ className?: string }>(() => import("@/components/map/CityMap").then((m) => m.CityMap), {
  ssr: false,
  loading: () => <StageSkeleton kind="map" />,
});

const DigitalTwinCanvas = dynamic<{ className?: string; active?: boolean }>(
  () => import("@/components/three/DigitalTwinCanvas").then((m) => m.DigitalTwinCanvas),
  { ssr: false, loading: () => <StageSkeleton kind="3d" /> },
);

/* ------------------------------------------------------------------ */
/*  WebGL support probe (released immediately)                         */
/* ------------------------------------------------------------------ */

/** WebGL 2 only: both engines need it (MapLibre GL 6 and the three.js twin), so the answer matches DigitalTwinCanvas's own probe. */
function probeWebgl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Split divider                                                      */
/* ------------------------------------------------------------------ */

const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;
const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

function SplitDivider({
  ratio,
  containerRef,
}: {
  ratio: MotionValue<number>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useTr();
  const left = useTransform(ratio, (r) => `${r * 100}%`);
  // aria value is committed on release / key press only (never at pointer-move rate)
  const [ariaValue, setAriaValue] = useState(() => Math.round(ratio.get() * 100));
  const drag = useRef<{ id: number } | null>(null);

  const setFromClientX = (x: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    ratio.set(clampRatio((x - rect.left) / rect.width));
  };
  const commit = (r: number) => {
    ratio.set(clampRatio(r));
    setAriaValue(Math.round(clampRatio(r) * 100));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) setFromClientX(e.clientX);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setAriaValue(Math.round(ratio.get() * 100));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const r = ratio.get();
    if (e.key === "ArrowLeft") commit(r - 0.05);
    else if (e.key === "ArrowRight") commit(r + 0.05);
    else if (e.key === "Home") commit(MIN_RATIO);
    else if (e.key === "End") commit(MAX_RATIO);
    else if (e.key === "Enter") commit(0.5);
    else return;
    e.preventDefault();
  };

  return (
    <motion.div
      role="separator"
      aria-orientation="vertical"
      aria-label={t({ th: "ปรับสัดส่วนแผนที่และมุมมอง 3 มิติ", en: "Resize map and 3D panes" })}
      aria-valuemin={MIN_RATIO * 100}
      aria-valuemax={MAX_RATIO * 100}
      aria-valuenow={ariaValue}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => commit(0.5)}
      onKeyDown={onKeyDown}
      style={{ left }}
      className="group absolute top-0 bottom-0 z-20 flex w-4 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center outline-none"
    >
      <span aria-hidden className="h-full w-px bg-ui-border-strong transition-colors group-hover:bg-ui-cyan/60 group-focus-visible:bg-ui-cyan" />
      <span
        aria-hidden
        className="absolute top-1/2 flex h-10 w-2.5 -translate-y-1/2 flex-col items-center justify-center gap-1 rounded-full border border-ui-border-strong bg-ui-surface transition-colors group-hover:border-ui-cyan/60 group-focus-visible:border-ui-cyan"
      >
        <span className="size-0.5 rounded-full bg-ui-text-2" />
        <span className="size-0.5 rounded-full bg-ui-text-2" />
        <span className="size-0.5 rounded-full bg-ui-text-2" />
      </span>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stage                                                              */
/* ------------------------------------------------------------------ */

function PaneLabel({ icon: Icon, children }: { icon: typeof MapIcon; children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute top-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-ui-border bg-ui-bg/80 px-2.5 py-1 text-[11px] text-ui-text-2">
      <Icon aria-hidden className="size-3 text-ui-cyan" />
      {children}
    </span>
  );
}

function WebglNotice() {
  const t = useTr();
  const setViewMode = useDashboard((s) => s.setViewMode);
  return (
    <div className="ui-grid-bg absolute inset-0 flex items-center justify-center bg-ui-bg-deep p-6">
      <div role="alert" className="ui-panel flex max-w-sm flex-col items-start gap-3 p-5">
        <span className="flex items-center gap-2 text-[13px] font-medium text-ui-text">
          <TriangleAlert aria-hidden className="size-4 text-ui-orange" />
          {t({ th: "อุปกรณ์นี้ไม่รองรับ WebGL", en: "WebGL is unavailable on this device" })}
        </span>
        <p className="text-[12.5px] leading-relaxed text-ui-text-2">
          {t({
            th: "มุมมองเมือง 3 มิติต้องใช้ WebGL ลองเปิดการเร่งกราฟิกด้วยฮาร์ดแวร์ในเบราว์เซอร์ หรือใช้แผนที่ 2 มิติซึ่งแสดงข้อมูลชุดเดียวกัน",
            en: "The 3D city view needs WebGL. Enable hardware acceleration in your browser, or use the 2D map, which shows the same data.",
          })}
        </p>
        <Button variant="outline" size="sm" onClick={() => setViewMode("2d")}>
          <MapIcon aria-hidden />
          {t({ th: "กลับไปใช้แผนที่ 2 มิติ", en: "Back to the 2D map" })}
        </Button>
      </div>
    </div>
  );
}

/**
 * The stage: 2D map, 3D twin, or both side by side.
 * - CityMap is always mounted (hidden when not visible) so its camera and sources persist.
 * - DigitalTwinCanvas mounts lazily on first 3D/split use, then stays mounted with active={visible}
 *   so the render loop stops while it is hidden.
 * - Mode changes cross-fade (SceneLayer); pane geometry snaps instead of animating width so the
 *   WebGL canvases resize once, not on every frame.
 */
export function Stage({ className, compact = false }: { className?: string; compact?: boolean }) {
  const t = useTr();
  const viewMode = useDashboard((s) => s.viewMode);
  const webgl = useDashboard((s) => s.webglSupported);
  const containerRef = useRef<HTMLDivElement>(null);
  const ratio = useMotionValue(0.5);
  const mapWidth = useTransform(ratio, (r) => `${r * 100}%`);
  const threeWidth = useTransform(ratio, (r) => `${(1 - r) * 100}%`);

  const [threeMounted, setThreeMounted] = useState(viewMode !== "2d");
  if (viewMode !== "2d" && !threeMounted) setThreeMounted(true);

  useEffect(() => {
    const s = useDashboard.getState();
    if (s.webglSupported === null) s.setWebglSupported(probeWebgl());
  }, []);

  const split = viewMode === "split";
  const mapVisible = viewMode === "2d" || split;
  const threeVisible = viewMode === "3d" || split;

  return (
    <div
      ref={containerRef}
      id="stage"
      role="region"
      tabIndex={-1}
      aria-label={t({ th: "พื้นที่แสดงผลแผนที่และแบบจำลอง", en: "Map and model stage" })}
      className={cn("ui-grid-bg relative h-full w-full overflow-hidden bg-ui-bg-deep outline-none", !compact && "rounded-xl border border-ui-border", className)}
    >
      <SceneLayer visible={mapVisible} label={t({ th: "แผนที่ 2 มิติ", en: "2D map" })} className="left-0" style={{ width: split ? mapWidth : "100%" }}>
        <CityMap className="h-full w-full" />
        {split && <PaneLabel icon={MapIcon}>{t({ th: "แผนที่ 2 มิติ", en: "2D map" })}</PaneLabel>}
      </SceneLayer>

      <SceneLayer visible={threeVisible} label={t({ th: "แบบจำลองเมือง 3 มิติ", en: "3D city twin" })} className="right-0" style={{ width: split ? threeWidth : "100%" }}>
        {webgl === false ? <WebglNotice /> : threeMounted ? <DigitalTwinCanvas className="h-full w-full" active={threeVisible} /> : null}
        {split && <PaneLabel icon={Box}>{t({ th: "แบบจำลอง 3 มิติ", en: "3D twin" })}</PaneLabel>}
      </SceneLayer>

      {split && <SplitDivider ratio={ratio} containerRef={containerRef} />}

      <div className={cn("absolute z-30", compact ? "top-2 left-2" : "top-3 left-3")}>
        <ViewModeSwitch variant="overlay" />
      </div>

      <SimulationBanner />
      <StoryOverlay compact={compact} />
    </div>
  );
}
