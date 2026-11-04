import { getConsoleFunction, setConsoleFunction } from "three";

/**
 * Library-internal three.js warnings the app cannot act on. @react-three/fiber 9 still creates a
 * `THREE.Clock` for every root, which three r183+ reports as deprecated each time a canvas is created.
 */
const SILENCED_WARNINGS = ["THREE.Clock: This module has been deprecated"];

let installed = false;

/**
 * Drops the known library-internal deprecation warnings above and forwards every other three.js
 * message unchanged (to a previously installed handler when there is one). Idempotent.
 */
export function silenceKnownThreeWarnings() {
  if (installed) return;
  installed = true;
  // `getConsoleFunction()` returns null when no handler is installed (the typings omit the null).
  const previous = getConsoleFunction() as ReturnType<typeof getConsoleFunction> | null;
  setConsoleFunction((type, message, ...params) => {
    if (type === "warn" && SILENCED_WARNINGS.some((s) => message.startsWith(s))) return;
    if (previous) previous(type, message, ...params);
    else console[type](message, ...params);
  });
}
