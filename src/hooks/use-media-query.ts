"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Layout breakpoints (px). Mobile < 768 ≤ tablet < 1280 ≤ desktop. */
export const BREAKPOINTS = { tablet: 768, desktop: 1280 } as const;

export type Breakpoint = "mobile" | "tablet" | "desktop";

const noopSubscribe = () => () => {};

/**
 * SSR-safe media query.
 *
 * Returns `null` on the server and during hydration (the server snapshot), then the real
 * match on the client. Callers render a neutral skeleton while the value is `null`, so the
 * server HTML and the first client render are identical and there is no hydration mismatch.
 */
export function useMediaQuery(query: string): boolean | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore<boolean | null>(subscribe, getSnapshot, () => null);
}

/** Current layout tier, or `null` until mounted on the client. */
export function useBreakpoint(): Breakpoint | null {
  const desktop = useMediaQuery(`(min-width: ${BREAKPOINTS.desktop}px)`);
  const tablet = useMediaQuery(`(min-width: ${BREAKPOINTS.tablet}px)`);
  if (desktop === null || tablet === null) return null;
  return desktop ? "desktop" : tablet ? "tablet" : "mobile";
}

/** `false` on the server and during hydration, `true` afterwards. */
export function useIsMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
