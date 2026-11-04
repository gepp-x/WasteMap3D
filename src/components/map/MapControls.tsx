"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Box, Compass, Focus, Maximize2, Minus, Plus } from "lucide-react";
import { useDashboard } from "@/store/dashboard-store";
import { useTr, type Bi } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MapEngine } from "./use-map-engine";
import type { MapCameraApi } from "./use-map-camera";

const S = {
  group: { th: "ควบคุมแผนที่", en: "Map controls" },
  zoomIn: { th: "ขยายเข้า", en: "Zoom in" },
  zoomOut: { th: "ย่อออก", en: "Zoom out" },
  north: { th: "หันทิศเหนือขึ้นและปรับเป็นมุมตรง", en: "Reset north & pitch" },
  fitCity: { th: "แสดงทั้งเมือง", en: "Fit city" },
  focus: { th: "โฟกัสพื้นที่ที่เลือก", en: "Focus selection" },
  focusNone: { th: "เลือกพื้นที่ก่อนเพื่อโฟกัส", en: "Select an area to focus" },
  tiltOn: { th: "มุมมองเอียง (อาคาร 3 มิติ)", en: "Tilted view (3D buildings)" },
} satisfies Record<string, Bi>;

function ControlButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
  shortcut,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
  shortcut?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            aria-disabled={disabled || undefined}
            onClick={disabled ? undefined : onClick}
            className={cn(
              "relative grid size-9 place-items-center text-ui-text-2 transition-colors duration-150 outline-none",
              "hover:bg-ui-elevated-2/70 hover:text-ui-text focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ui-cyan focus-visible:ring-inset",
              "active:bg-ui-elevated-2 [&_svg]:size-[17px]",
              pressed && "bg-ui-cyan/12 text-ui-cyan hover:text-ui-cyan",
              disabled && "cursor-not-allowed text-ui-text-3/60 hover:bg-transparent hover:text-ui-text-3/60",
            )}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="left" sideOffset={8}>
        <span>{label}</span>
        {shortcut && <kbd className="ml-1 rounded border border-background/30 px-1 font-mono text-[10px] opacity-70">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/** Bottom-right camera controls. The compass needle follows the bearing via direct DOM writes (no re-render per frame). */
export function MapControls({ engine, camera }: { engine: MapEngine | null; camera: MapCameraApi }) {
  const t = useTr();
  const selectedAreaId = useDashboard((s) => s.selectedAreaId);
  const requestFocus = useDashboard((s) => s.requestFocus);
  const needleRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!engine) return;
    const map = engine.map;
    const update = () => {
      const n = needleRef.current;
      if (n) n.style.transform = `rotate(${-map.getBearing()}deg) rotateX(${map.getPitch() * 0.6}deg)`;
    };
    update();
    const subs = [map.on("rotate", update), map.on("pitch", update)];
    return () => subs.forEach((s) => s.unsubscribe());
  }, [engine]);

  const off = !engine;
  return (
    <div role="toolbar" aria-label={t(S.group)} aria-orientation="vertical" className="flex flex-col gap-2">
      <div className="ui-panel-float flex flex-col divide-y divide-ui-border overflow-hidden !rounded-lg">
        <ControlButton label={t(S.zoomIn)} shortcut="+" onClick={() => camera.zoomBy(1)} disabled={off}>
          <Plus aria-hidden />
        </ControlButton>
        <ControlButton label={t(S.zoomOut)} shortcut="−" onClick={() => camera.zoomBy(-1)} disabled={off}>
          <Minus aria-hidden />
        </ControlButton>
        <ControlButton label={t(S.north)} onClick={camera.resetNorth} disabled={off}>
          <span ref={needleRef} className="grid place-items-center transition-none [transform-style:preserve-3d]">
            <Compass aria-hidden />
          </span>
        </ControlButton>
      </div>
      <div className="ui-panel-float flex flex-col divide-y divide-ui-border overflow-hidden !rounded-lg">
        <ControlButton label={t(S.fitCity)} onClick={camera.fitCity} disabled={off}>
          <Maximize2 aria-hidden />
        </ControlButton>
        <ControlButton label={selectedAreaId ? t(S.focus) : t(S.focusNone)} onClick={requestFocus} disabled={off || !selectedAreaId}>
          <Focus aria-hidden />
        </ControlButton>
        <ControlButton label={t(S.tiltOn)} pressed={camera.tilted} onClick={() => camera.setTilt(!camera.tilted)} disabled={off}>
          <Box aria-hidden />
        </ControlButton>
      </div>
    </div>
  );
}
