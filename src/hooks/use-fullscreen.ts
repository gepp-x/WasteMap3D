"use client";

import { useCallback, useSyncExternalStore } from "react";

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

function subscribe(onChange: () => void) {
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange);
  return () => {
    document.removeEventListener("fullscreenchange", onChange);
    document.removeEventListener("webkitfullscreenchange", onChange);
  };
}

const noopSubscribe = () => () => {};

function isActive() {
  const d = document as FsDocument;
  return Boolean(d.fullscreenElement ?? d.webkitFullscreenElement);
}

function isSupported() {
  const d = document as FsDocument;
  return Boolean(d.fullscreenEnabled ?? d.webkitFullscreenEnabled);
}

/** Enter fullscreen on the whole document (must run inside a user gesture). Failures are silent by design. */
export async function enterFullscreen() {
  const el = document.documentElement as FsElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
    else await el.webkitRequestFullscreen?.();
  } catch {
    /* rejected by the browser (no gesture / policy) — the button state simply stays unchanged */
  }
}

export async function exitFullscreen() {
  const d = document as FsDocument;
  try {
    if (d.exitFullscreen) await d.exitFullscreen();
    else await d.webkitExitFullscreen?.();
  } catch {
    /* already exited */
  }
}

/** Non-hook toggle for keyboard handlers. */
export function toggleFullscreen() {
  if (!isSupported()) return;
  void (isActive() ? exitFullscreen() : enterFullscreen());
}

/** Fullscreen API state, SSR-safe (false on the server). */
export function useFullscreen() {
  const isFullscreen = useSyncExternalStore(subscribe, isActive, () => false);
  const supported = useSyncExternalStore(noopSubscribe, isSupported, () => false);
  const toggle = useCallback(() => toggleFullscreen(), []);
  return { isFullscreen, supported, toggle, enter: enterFullscreen, exit: exitFullscreen };
}
