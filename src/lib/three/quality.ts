/**
 * Quality tiers for the 3D digital twin.
 *
 * `store.quality` = "auto" → a one-off WebGL probe (renderer string, texture limits, device hints)
 * picks a starting tier and a ceiling; drei's PerformanceMonitor then steps the tier down/up while
 * the scene renders continuously. Explicit modes map 1:1 to a tier.
 */

export type QualityTier = "high" | "balanced" | "low";

export interface TierSettings {
  dpr: [number, number];
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  rainCount: number;
  /** Max buildings drawn in the neighbourhood window (largest footprints first). */
  buildingCap: number;
}

export const TIER_SETTINGS: Record<QualityTier, TierSettings> = {
  high: { dpr: [1, 2], antialias: true, shadows: true, shadowMapSize: 2048, rainCount: 18000, buildingCap: 60000 },
  balanced: { dpr: [1, 1.5], antialias: true, shadows: false, shadowMapSize: 1024, rainCount: 8000, buildingCap: 15000 },
  low: { dpr: [0.75, 1], antialias: false, shadows: false, shadowMapSize: 1024, rainCount: 2500, buildingCap: 2000 },
};

const ORDER: QualityTier[] = ["low", "balanced", "high"];

export function stepTier(t: QualityTier, dir: 1 | -1, ceiling: QualityTier = "high"): QualityTier {
  const i = Math.min(ORDER.indexOf(ceiling), Math.max(0, ORDER.indexOf(t) + dir));
  return ORDER[i];
}

export interface WebGLProbe {
  supported: boolean;
  renderer: string;
  maxTextureSize: number;
}

/**
 * Creates a throw-away WebGL2 context (three r163+ requires WebGL2), reads capability hints and
 * releases it immediately so it never competes with the real canvas for a context slot.
 */
export function probeWebGL(): WebGLProbe {
  if (typeof document === "undefined") return { supported: false, renderer: "", maxTextureSize: 0 };
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null;
    if (!gl) return { supported: false, renderer: "", maxTextureSize: 0 };
    let renderer = "";
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    try {
      renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch {
      renderer = "";
    }
    const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { supported: true, renderer, maxTextureSize };
  } catch {
    return { supported: false, renderer: "", maxTextureSize: 0 };
  }
}

/** Device / GPU heuristics → starting tier (also used as the ceiling for auto step-ups). */
export function detectTier(probe: WebGLProbe): QualityTier {
  if (typeof window === "undefined") return "balanced";
  const r = probe.renderer.toLowerCase();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 8;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const small = Math.min(window.screen?.width ?? 1920, window.screen?.height ?? 1080) < 600;
  const mobile = coarse && small;

  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(r)) return "low";
  if (probe.maxTextureSize && probe.maxTextureSize < 4096) return "low";
  if (mobile) return cores <= 4 || memory <= 3 ? "low" : "balanced";
  if (memory <= 2 || cores <= 2) return "low";
  const discrete = /nvidia|geforce|rtx|quadro|radeon (rx|pro)|radeon\(tm\) rx|apple m\d|apple gpu/.test(r);
  const integrated = /intel|uhd|iris|mali|adreno|powervr|vega \d|radeon\(tm\) graphics/.test(r);
  if (discrete && cores >= 6 && memory >= 6) return "high";
  if (integrated) return "balanced";
  return cores >= 8 && memory >= 8 ? "high" : "balanced";
}
