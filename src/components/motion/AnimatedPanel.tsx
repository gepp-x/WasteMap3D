"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform, type MotionStyle } from "motion/react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DURATION, EASE, motionDuration, useReducedMotionPref } from "@/lib/animation/tokens";
import { Button } from "@/components/ui/button";

/* ------------------------------------------------------------------ */
/*  Resizable, collapsible shell column                                */
/* ------------------------------------------------------------------ */

/**
 * Desktop shell column (left sidebar ↔ icon rail, right panel ↔ rail) with a drag handle on its
 * inner edge.
 *
 * - Width is the one layout property we deliberately animate: the stage must reflow so the map /
 *   3D canvas stay un-occluded (both resize through their own ResizeObservers).
 * - Two motion values: `expanded` (the user's width, drag-driven) and `col` (what the column
 *   occupies, tweened between the rail and `expanded`). Children size themselves with
 *   `var(--col-w)` = `expanded`, so collapsing only changes the clip (no text reflow) while a drag
 *   reflows them live.
 * - Dragging writes motion values only (no React render per frame); the width is committed to the
 *   store on release. Keyboard: ←/→ ±16 px (Shift ±64), Home / End = min / max, Enter or
 *   double-click = default.
 */
export function ResizableColumn({
  open,
  side,
  width,
  min,
  max,
  defaultWidth,
  collapsedWidth,
  onCommit,
  maxAvailable,
  label,
  handleLabel,
  id,
  className,
  children,
}: {
  open: boolean;
  /** Which shell edge the column sits on (the handle is on the opposite, inner edge). */
  side: "left" | "right";
  /** Committed width (px) from the store. */
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  collapsedWidth: number;
  onCommit: (px: number) => void;
  /** Largest width that still leaves the stage usable at the current window size. */
  maxAvailable?: () => number;
  label: string;
  handleLabel: string;
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotionPref();
  const expanded = useMotionValue(width);
  const col = useMotionValue(open ? width : collapsedWidth);
  const colVar = useTransform(expanded, (v) => `${v}px`);
  const drag = useRef<{ id: number; x: number; w: number; hi: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const mounted = useRef(false);

  // open / close tween and external width changes (keyboard, persistence, auto-fit)
  useEffect(() => {
    if (drag.current) return;
    expanded.set(width);
    const target = open ? width : collapsedWidth;
    if (!mounted.current) {
      mounted.current = true;
      col.set(target);
      return;
    }
    const c = animate(col, target, { duration: motionDuration(DURATION.panel, reduced), ease: EASE.outExpo });
    return () => c.stop();
  }, [open, width, collapsedWidth, reduced, col, expanded]);

  const upper = () => Math.max(min, Math.min(max, maxAvailable ? maxAvailable() : max));
  const clampW = (v: number, hi = upper()) => Math.round(Math.min(hi, Math.max(min, v)));
  const commit = (v: number) => {
    const c = clampW(v);
    expanded.set(c);
    col.set(c);
    onCommit(c);
  };
  const sign = side === "left" ? 1 : -1;

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.documentElement.style.removeProperty("cursor");
    setDragging(false);
    onCommit(clampW(expanded.get(), d.hi));
  };

  return (
    <div className="relative flex min-h-0 shrink-0">
      <motion.aside
        id={id}
        aria-label={label}
        className={cn("relative min-h-0 shrink-0 overflow-hidden", className)}
        style={{ width: col, contain: "layout paint", ["--col-w" as string]: colVar } as MotionStyle}
      >
        {children}
      </motion.aside>
      {open && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={handleLabel}
          aria-controls={id}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { id: e.pointerId, x: e.clientX, w: expanded.get(), hi: upper() };
            document.documentElement.style.cursor = "col-resize";
            setDragging(true);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            const v = clampW(d.w + sign * (e.clientX - d.x), d.hi);
            expanded.set(v);
            col.set(v);
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => commit(defaultWidth)}
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            const step = e.shiftKey ? 64 : 16;
            if (e.key === "ArrowRight") commit(width + sign * step);
            else if (e.key === "ArrowLeft") commit(width - sign * step);
            else if (e.key === "Home") commit(min);
            else if (e.key === "End") commit(upper());
            else if (e.key === "Enter") commit(defaultWidth);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
          className={cn(
            "group absolute inset-y-2 z-20 flex w-3 cursor-col-resize touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60",
            side === "left" ? "-right-2.5" : "-left-2.5",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "h-10 w-[3px] rounded-full transition-colors duration-150",
              dragging ? "bg-ui-cyan" : "bg-transparent group-hover:bg-ui-border-strong group-focus-visible:bg-ui-cyan",
            )}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Exit-safe modal surfaces (dialog + side sheet)                     */
/* ------------------------------------------------------------------ */

/**
 * Base UI keeps a closing dialog mounted until its exit transition ends (100–200 ms). The stock
 * shadcn backdrop / popup stay hit-testable during that window, so a click that lands right after
 * Esc (e.g. on the header "Data sources" button, which sits under the right-hand drawers) hits the
 * dying surface and is swallowed. These wrappers make closing surfaces transparent to input
 * (`data-closed:pointer-events-none`) and never return focus behind a modal that opened meanwhile.
 */
const EXIT_SAFE = "data-closed:pointer-events-none data-ending-style:pointer-events-none";

/** Focus returns to the opener only when no other modal surface took over in the meantime. */
const returnFocusUnlessCovered = () => document.querySelector('[data-slot="shell-modal"][data-open]') === null;

export function ShellSheetContent({
  side = "right",
  className,
  children,
  showCloseButton = true,
  closeLabel,
  ...props
}: DialogPrimitive.Popup.Props & { side?: "left" | "right"; showCloseButton?: boolean; closeLabel: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className={cn(
          "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
          EXIT_SAFE,
        )}
      />
      <DialogPrimitive.Popup
        data-slot="shell-modal"
        data-side={side}
        finalFocus={returnFocusUnlessCovered}
        className={cn(
          "fixed inset-y-0 z-50 flex h-full w-3/4 flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out outline-none data-ending-style:opacity-0 data-starting-style:opacity-0 sm:max-w-sm",
          side === "right"
            ? "right-0 border-l data-ending-style:translate-x-[2.5rem] data-starting-style:translate-x-[2.5rem]"
            : "left-0 border-r data-ending-style:translate-x-[-2.5rem] data-starting-style:translate-x-[-2.5rem]",
          EXIT_SAFE,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close render={<Button variant="ghost" className="absolute top-3 right-3" size="icon-sm" />}>
            <XIcon aria-hidden />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export function ShellDialogContent({
  className,
  children,
  showCloseButton = true,
  closeLabel,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean; closeLabel: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className={cn(
          "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          EXIT_SAFE,
        )}
      />
      <DialogPrimitive.Popup
        data-slot="shell-modal"
        finalFocus={returnFocusUnlessCovered}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          EXIT_SAFE,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}>
            <XIcon aria-hidden />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

/**
 * True cross-fade between two views without absolute positioning: both the leaving and the entering
 * view occupy the same grid cell while they overlap (AnimatePresence mode="sync").
 */
export function CrossFade({
  id,
  children,
  className,
  direction = 1,
}: {
  /** Changing the id swaps the view. */
  id: string;
  children: ReactNode;
  className?: string;
  /** +1 slides the new view in from the right, −1 from the left. */
  direction?: 1 | -1;
}) {
  const reduced = useReducedMotionPref();
  const d = motionDuration(DURATION.ui, reduced);
  const offset = reduced ? 0 : 10 * direction;
  return (
    <div className={cn("grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] [&>*]:[grid-area:1/1]", className)}>
      <AnimatePresence initial={false} mode="sync">
        <motion.div
          key={id}
          className="flex min-h-0 min-w-0 flex-col"
          initial={{ opacity: 0, x: offset }}
          animate={{ opacity: 1, x: 0, transition: { duration: d, ease: EASE.outExpo, delay: reduced ? 0 : 0.04 } }}
          exit={{ opacity: 0, x: -offset, transition: { duration: d * 0.7, ease: EASE.standard } }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** Slide-over panel (tablet details drawer). Mount/unmount handled with exit animation. */
export function SlideOver({
  open,
  side = "right",
  label,
  className,
  children,
}: {
  open: boolean;
  side?: "left" | "right";
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotionPref();
  const d = motionDuration(DURATION.panel, reduced);
  const x = reduced ? 0 : side === "right" ? 24 : -24;
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          key="slide-over"
          aria-label={label}
          className={className}
          initial={{ opacity: 0, x }}
          animate={{ opacity: 1, x: 0, transition: { duration: d, ease: EASE.outExpo } }}
          exit={{ opacity: 0, x, transition: { duration: d * 0.7, ease: EASE.standard } }}
        >
          {children}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/** Small vertical swap used for status chips (e.g. Historical ↔ Simulation). */
export function SwapText({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const reduced = useReducedMotionPref();
  const d = motionDuration(DURATION.ui, reduced);
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={id}
        className={cn("inline-flex items-center", className)}
        initial={{ opacity: 0, y: reduced ? 0 : 8 }}
        animate={{ opacity: 1, y: 0, transition: { duration: d, ease: EASE.outExpo } }}
        exit={{ opacity: 0, y: reduced ? 0 : -8, transition: { duration: d * 0.6, ease: EASE.standard } }}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}
