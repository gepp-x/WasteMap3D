import type { PaddingOptions } from "maplibre-gl";
import type { CityId } from "@/lib/types";
import type { BBox } from "./features";

/** Closest zoom when framing a single area (districts are larger than Hat Yai community zones). */
export const FOCUS_MAX_ZOOM: Record<CityId, number> = { bangkok: 13.2, hatyai: 15 };

/** Tilted camera pitch for the 2D/tilt toggle. */
export const TILT_PITCH = 50;

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Padding that keeps framed content clear of the map's own overlays (legend bottom-left,
 * controls bottom-right) plus extra room on the right when the details panel is open.
 * Scaled down on small containers so fitBounds never receives impossible padding.
 */
export function framePadding(width: number, height: number, opts: { rightOpen?: boolean; tight?: boolean } = {}): PaddingOptions {
  const base = Math.max(16, Math.min(64, Math.min(width, height) * 0.07));
  let pad = {
    top: base + (opts.tight ? 8 : 20),
    bottom: base + (opts.tight ? 24 : 44),
    left: base + (width > 720 ? 24 : 0),
    right: base + (width > 720 ? 52 : 36) + (opts.rightOpen && width > 900 ? Math.min(96, width * 0.07) : 0),
  };
  const sx = (pad.left + pad.right) / Math.max(1, width * 0.6);
  const sy = (pad.top + pad.bottom) / Math.max(1, height * 0.6);
  const s = Math.max(1, sx, sy);
  if (s > 1) pad = { top: pad.top / s, bottom: pad.bottom / s, left: pad.left / s, right: pad.right / s };
  return pad;
}

/** Share (0–1) of `inner` that lies inside `outer`, and how large it is relative to `outer`. */
export function bboxCoverage(inner: BBox, outer: BBox) {
  const iw = Math.max(0, Math.min(inner[2], outer[2]) - Math.max(inner[0], outer[0]));
  const ih = Math.max(0, Math.min(inner[3], outer[3]) - Math.max(inner[1], outer[1]));
  const ia = Math.max(1e-12, (inner[2] - inner[0]) * (inner[3] - inner[1]));
  const oa = Math.max(1e-12, (outer[2] - outer[0]) * (outer[3] - outer[1]));
  return { visible: (iw * ih) / ia, relativeSize: ia / oa };
}
