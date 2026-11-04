"use client";

import { useEffect, useEffectEvent } from "react";
import type { Bi } from "@/lib/i18n";
import { useDashboard } from "@/store/dashboard-store";
import { exitGuidedStory } from "@/hooks/use-story";

/** Shortcut catalogue — single source for the help dialog, the settings list and tooltips. */
export const SHORTCUTS: { id: string; keys: string[]; label: Bi }[] = [
  { id: "view2d", keys: ["1"], label: { th: "มุมมองแผนที่ 2 มิติ", en: "2D map view" } },
  { id: "view3d", keys: ["2"], label: { th: "มุมมองแบบจำลอง 3 มิติ", en: "3D digital-twin view" } },
  { id: "split", keys: ["3"], label: { th: "แยกจอ 2 มิติ / 3 มิติ", en: "Split 2D / 3D view" } },
  { id: "city3d", keys: ["4"], label: { th: "เมือง 3 มิติ (อาคาร ถนน คลองจริง)", en: "3D City (real buildings, roads, canals)" } },
  { id: "layers", keys: ["L"], label: { th: "เปิด/ปิดแผงชั้นข้อมูล", en: "Toggle the layers sidebar" } },
  { id: "lab", keys: ["S"], label: { th: "เปิดห้องทดลองสถานการณ์", en: "Open the Scenario Lab" } },
  { id: "fullscreen", keys: ["F"], label: { th: "เต็มจอ", en: "Toggle fullscreen" } },
  { id: "search", keys: ["/"], label: { th: "ค้นหาพื้นที่", en: "Search areas" } },
  { id: "escape", keys: ["Esc"], label: { th: "ล้างการเลือก / ปิดหน้าต่าง / ออกจากทัวร์", en: "Clear selection / close drawers / exit the tour" } },
  { id: "help", keys: ["?"], label: { th: "แสดงแป้นพิมพ์ลัด", en: "Show keyboard shortcuts" } },
];

/* ------------------------------------------------------------------ */
/*  Modal surfaces: one at a time                                      */
/* ------------------------------------------------------------------ */

/** Store-driven modal surfaces (dialogs / drawers). */
export type ModalPanel = "settingsOpen" | "sourcesOpen" | "insightsOpen";
export const MODAL_PANELS: ModalPanel[] = ["settingsOpen", "sourcesOpen", "insightsOpen"];

/** Modal surfaces whose open state lives outside the dashboard store (e.g. the shortcuts help). */
const externalModals = new Set<{ isOpen: () => boolean; close: () => void }>();
export function registerModal(m: { isOpen: () => boolean; close: () => void }) {
  externalModals.add(m);
  return () => {
    externalModals.delete(m);
  };
}

export function anyModalOpen() {
  const s = useDashboard.getState();
  return MODAL_PANELS.some((p) => s[p]) || [...externalModals].some((m) => m.isOpen());
}

export function closeAllModals() {
  const s = useDashboard.getState();
  for (const p of MODAL_PANELS) if (s[p]) s.setPanel(p, false);
  for (const m of externalModals) if (m.isOpen()) m.close();
}

/**
 * Open one modal surface, closing any other first, so two Base UI dialogs never compete for focus,
 * outside-press or Esc. Every opener in the shell goes through this.
 */
export function openModal(panel: ModalPanel) {
  const s = useDashboard.getState();
  for (const p of MODAL_PANELS) if (p !== panel && s[p]) s.setPanel(p, false);
  for (const m of externalModals) if (m.isOpen()) m.close();
  if (!s[panel]) s.setPanel(panel, true);
}

export function shortcutKey(id: string) {
  return SHORTCUTS.find((s) => s.id === id)?.keys[0];
}

/** True when the event target is a text-entry control (shortcuts must never steal typing). */
export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "range", "button", "submit", "reset", "color"].includes(type);
  }
  const role = target.getAttribute("role");
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

/**
 * Map a keydown to a shortcut id. Uses `e.key` first and falls back to the physical `e.code`, so the
 * shortcuts keep working with the Thai Kedmanee layout active (where "L" types "ส", "/" types "ฝ", …).
 */
function resolveKey(e: KeyboardEvent): string | null {
  const k = e.key;
  const c = e.code;
  if (k === "?" || (c === "Slash" && e.shiftKey)) return "help";
  if (e.shiftKey) return null;
  if (k === "/" || c === "Slash") return "search";
  if (k === "1" || c === "Digit1" || c === "Numpad1") return "view2d";
  if (k === "2" || c === "Digit2" || c === "Numpad2") return "view3d";
  if (k === "3" || c === "Digit3" || c === "Numpad3") return "split";
  if (k === "4" || c === "Digit4" || c === "Numpad4") return "city3d";
  if (k === "l" || k === "L" || c === "KeyL") return "layers";
  if (k === "s" || k === "S" || c === "KeyS") return "lab";
  if (k === "f" || k === "F" || c === "KeyF") return "fullscreen";
  return null;
}

export interface ShortcutHandlers {
  /** L — layout-specific (expand sidebar / open drawer / open mobile layers tab). */
  onToggleLayers: () => void;
  /** / — focus the area search. */
  onFocusSearch: () => void;
  /** S — open the Scenario Lab where this layout shows it. */
  onOpenLab: () => void;
  /** ? — open the shortcuts help. */
  onOpenHelp: () => void;
  /** F — fullscreen. */
  onFullscreen: () => void;
  /** Esc — return true when handled by the layout (e.g. closing an overlay). */
  onEscape?: () => boolean;
  /** True when a modal surface owned by the layout is open (blocks non-Esc shortcuts). */
  isModalOpen?: () => boolean;
}

/**
 * Global keyboard shortcuts. One listener for the whole app; handlers are read through an
 * effect event so the listener is attached once and never re-bound on re-render.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled = true) {
  const handle = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const s = useDashboard.getState();
    const dialogOpen = anyModalOpen() || Boolean(handlers.isModalOpen?.());

    if (e.key === "Escape") {
      // A Base UI dialog consumes its own Esc (defaultPrevented above); this only runs when focus sits
      // outside every modal surface. Modals first, then the guided story, then layout overlays.
      if (dialogOpen) {
        closeAllModals();
        return;
      }
      if (s.storyActive) {
        exitGuidedStory();
        return;
      }
      if (handlers.onEscape?.()) return;
      if (s.labOpen) {
        s.setPanel("labOpen", false);
        return;
      }
      if (s.selectedAreaId) s.selectArea(null);
      return;
    }
    if (dialogOpen || e.repeat) return;

    const action = resolveKey(e);
    if (!action) return;
    if (action === "view2d") {
      s.setCityMode3d(false);
      s.setViewMode("2d");
    } else if (action === "city3d") s.setCityMode3d(true);
    else if (action === "view3d") s.setViewMode("3d");
    else if (action === "split") s.setViewMode("split");
    else if (action === "layers") handlers.onToggleLayers();
    else if (action === "lab") handlers.onOpenLab();
    else if (action === "fullscreen") handlers.onFullscreen();
    else if (action === "search") handlers.onFocusSearch();
    else if (action === "help") handlers.onOpenHelp();
    e.preventDefault();
  });

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => handle(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
