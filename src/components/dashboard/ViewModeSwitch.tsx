"use client";

import { Fragment, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { Box, Building2, Columns2, Map as MapIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SPRING } from "@/lib/animation/tokens";
import { useTr, type Bi } from "@/lib/i18n";
import { useDashboard, type ViewMode } from "@/store/dashboard-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shortcutKey } from "@/hooks/use-keyboard-shortcuts";

/* ------------------------------------------------------------------ */
/*  Segmented control (radiogroup + roving tabindex + Motion layoutId) */
/* ------------------------------------------------------------------ */

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when the label is not plain text or the control is icon-only. */
  ariaLabel?: string;
  icon?: LucideIcon;
  tooltip?: ReactNode;
  shortcut?: string;
}

const SIZE = {
  sm: "h-6 px-2 text-[11px]",
  md: "h-7 px-2.5 text-xs",
  lg: "h-8 px-3 text-[13px]",
} as const;
const ICON_SIZE = { sm: "size-6", md: "size-7", lg: "size-8" } as const;

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex min-w-4 items-center justify-center rounded border border-current/30 px-1 font-mono text-[10px] leading-4 opacity-80", className)}>
      {children}
    </kbd>
  );
}

/**
 * Segmented control used for city, view mode and language. Behaves as an ARIA radiogroup:
 * one tab stop, arrow keys / Home / End move the selection, the active pill glides between
 * options with a shared-layout spring (instant under reduced motion via MotionConfig).
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = "md",
  orientation = "horizontal",
  iconOnly = false,
  fullWidth = false,
  tooltipSide = "bottom",
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  ariaLabel: string;
  size?: keyof typeof SIZE;
  orientation?: "horizontal" | "vertical";
  iconOnly?: boolean;
  fullWidth?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const idx = options.findIndex((o) => o.value === value);

  const move = (next: number) => {
    const n = (next + options.length) % options.length;
    onChange(options[n].value);
    refs.current[n]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const fwd = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    const back = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    if (e.key === fwd) move(idx + 1);
    else if (e.key === back) move(idx - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(options.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      onKeyDown={onKeyDown}
      className={cn(
        "relative inline-flex gap-0.5 rounded-lg border border-ui-border bg-ui-bg-deep/70 p-0.5",
        orientation === "vertical" && "flex-col",
        fullWidth && "flex w-full",
        className,
      )}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        const Icon = o.icon;
        const button = (
          <button
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={iconOnly || o.ariaLabel ? (o.ariaLabel ?? (typeof o.label === "string" ? o.label : undefined)) : undefined}
            tabIndex={active || (idx === -1 && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative z-0 inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-ui-cyan/70",
              iconOnly ? ICON_SIZE[size] : SIZE[size],
              active ? "text-ui-text" : "text-ui-text-2 hover:text-ui-text",
              fullWidth && "flex-1",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                aria-hidden
                className="absolute inset-0 -z-10 rounded-md bg-ui-elevated-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ring-1 ring-ui-border-strong"
                transition={SPRING.snappy}
              />
            )}
            {Icon && <Icon aria-hidden className={cn("shrink-0", size === "lg" ? "size-4" : "size-3.5", active ? "text-ui-cyan" : undefined)} />}
            {!iconOnly && <span>{o.label}</span>}
          </button>
        );
        if (!o.tooltip && !o.shortcut) return <Fragment key={o.value}>{button}</Fragment>;
        return (
          <Tooltip key={o.value}>
            <TooltipTrigger render={button} />
            <TooltipContent side={tooltipSide}>
              <span>{o.tooltip ?? o.label}</span>
              {o.shortcut && <Kbd>{o.shortcut}</Kbd>}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  View mode switch                                                   */
/* ------------------------------------------------------------------ */

/** "city3d" is the 2D map stage tilted into the 3D City mode (store.cityMode3d). */
export type StageMode = ViewMode | "city3d";

export const VIEW_MODES: { value: StageMode; icon: LucideIcon; label: Bi; hint: Bi; shortcutId: string }[] = [
  { value: "2d", icon: MapIcon, label: { th: "2 มิติ", en: "2D" }, hint: { th: "แผนที่ 2 มิติ", en: "2D map" }, shortcutId: "view2d" },
  { value: "city3d", icon: Building2, label: { th: "เมือง 3D", en: "3D City" }, hint: { th: "เมืองสามมิติ: อาคาร ถนน คลองจริง", en: "3D city: real buildings, roads, canals" }, shortcutId: "city3d" },
  { value: "3d", icon: Box, label: { th: "3 มิติ", en: "3D" }, hint: { th: "แบบจำลองเมือง 3 มิติ", en: "3D digital twin" }, shortcutId: "view3d" },
  { value: "split", icon: Columns2, label: { th: "แยกจอ", en: "Split" }, hint: { th: "แผนที่และ 3 มิติเคียงกัน", en: "Map and 3D side by side" }, shortcutId: "split" },
];

/**
 * 2D | 3D | Split switch.
 *  - "overlay": floating chip on the stage
 *  - "sidebar": full-width control in the left sidebar
 *  - "rail":    vertical icon-only control in the collapsed sidebar rail
 */
export function ViewModeSwitch({ variant = "overlay", className }: { variant?: "overlay" | "sidebar" | "rail"; className?: string }) {
  const t = useTr();
  const rawMode = useDashboard((s) => s.viewMode);
  const cityMode3d = useDashboard((s) => s.cityMode3d);
  const viewMode: StageMode = cityMode3d && rawMode === "2d" ? "city3d" : rawMode;
  const setViewMode = (m: StageMode) => {
    const s = useDashboard.getState();
    if (m === "city3d") s.setCityMode3d(true);
    else {
      if (s.cityMode3d) s.setCityMode3d(false);
      s.setViewMode(m);
    }
  };
  const options: SegmentOption<StageMode>[] = VIEW_MODES.map((m) => ({
    value: m.value,
    label: t(m.label),
    ariaLabel: t(m.hint),
    icon: m.icon,
    tooltip: t(m.hint),
    shortcut: shortcutKey(m.shortcutId),
  }));
  const ariaLabel = t({ th: "รูปแบบการแสดงผล", en: "Display mode" });

  if (variant === "rail") {
    return (
      <SegmentedControl
        value={viewMode}
        onChange={setViewMode}
        options={options}
        ariaLabel={ariaLabel}
        orientation="vertical"
        iconOnly
        size="lg"
        tooltipSide="right"
        className={className}
      />
    );
  }
  if (variant === "sidebar") {
    return <SegmentedControl value={viewMode} onChange={setViewMode} options={options} ariaLabel={ariaLabel} size="lg" fullWidth className={className} />;
  }
  return (
    <div className={cn("ui-panel-float p-1", className)}>
      <SegmentedControl value={viewMode} onChange={setViewMode} options={options} ariaLabel={ariaLabel} size="md" className="border-transparent bg-transparent" />
    </div>
  );
}
