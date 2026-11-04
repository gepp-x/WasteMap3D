/**
 * Canvas-generated map images (no sprite sheet, no network): drainage-asset glyphs with distinct
 * shapes (shape — not colour — carries the asset type), the hatched "no data" fill pattern, and
 * the animated water-flow line pattern.
 */
import type { StyleImageInterface } from "maplibre-gl";
import { IMG } from "./ids";

const PR = 2; // device pixel ratio the images are drawn at

function canvas(wCss: number, hCss: number) {
  const c = document.createElement("canvas");
  c.width = Math.round(wCss * PR);
  c.height = Math.round(hCss * PR);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.scale(PR, PR);
  return { c, ctx };
}

const STROKE = "#9feffc";
const FILL = "#08192a";

type Draw = (ctx: CanvasRenderingContext2D, s: number) => void;

/** Drainage glyphs, drawn on an 18 × 18 css-px tile. */
const GLYPHS: Record<"pump" | "gate" | "monitoring" | "retention" | "other", Draw> = {
  // Pump station: circle with a three-blade impeller.
  pump: (ctx, s) => {
    const c = s / 2;
    ctx.beginPath();
    ctx.arc(c, c, c - 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.translate(c, c);
    ctx.fillStyle = STROKE;
    for (let i = 0; i < 3; i++) {
      ctx.rotate((Math.PI * 2) / 3);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(c * 0.55, -c * 0.15, c * 0.48, -c * 0.52);
      ctx.quadraticCurveTo(c * 0.18, -c * 0.4, 0, 0);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 1.3, 0, Math.PI * 2);
    ctx.fillStyle = FILL;
    ctx.fill();
    ctx.restore();
  },
  // Floodgate / sluice: square frame with a lowered gate leaf.
  gate: (ctx, s) => {
    const p = 2;
    ctx.beginPath();
    ctx.rect(p, p, s - 2 * p, s - 2 * p);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p + 3.5, p + 2.5);
    ctx.lineTo(p + 3.5, s - p - 2.5);
    ctx.moveTo(s - p - 3.5, p + 2.5);
    ctx.lineTo(s - p - 3.5, s - p - 2.5);
    ctx.stroke();
    ctx.fillStyle = STROKE;
    ctx.fillRect(p + 4.5, s / 2 - 0.5, s - 2 * p - 9, 3.5);
  },
  // Monitoring point: diamond with a centre reading dot.
  monitoring: (ctx, s) => {
    const c = s / 2;
    ctx.beginPath();
    ctx.moveTo(c, 1.5);
    ctx.lineTo(s - 1.5, c);
    ctx.lineTo(c, s - 1.5);
    ctx.lineTo(1.5, c);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = STROKE;
    ctx.fill();
  },
  // Retention / monkey-cheek basin: rounded basin with two water lines.
  retention: (ctx, s) => {
    const p = 1.8;
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(p + r, p);
    ctx.lineTo(s - p - r, p);
    ctx.quadraticCurveTo(s - p, p, s - p, p + r);
    ctx.lineTo(s - p, s - p - r);
    ctx.quadraticCurveTo(s - p, s - p, s - p - r, s - p);
    ctx.lineTo(p + r, s - p);
    ctx.quadraticCurveTo(p, s - p, p, s - p - r);
    ctx.lineTo(p, p + r);
    ctx.quadraticCurveTo(p, p, p + r, p);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    for (const y of [s * 0.42, s * 0.64]) {
      ctx.beginPath();
      ctx.moveTo(p + 3, y);
      ctx.bezierCurveTo(s * 0.35, y - 2.2, s * 0.5, y + 2.2, s * 0.65, y);
      ctx.bezierCurveTo(s * 0.72, y - 1.2, s * 0.8, y - 1.2, s - p - 3, y);
      ctx.stroke();
    }
  },
  // Other drainage asset: small ring.
  other: (ctx, s) => {
    const c = s / 2;
    ctx.beginPath();
    ctx.arc(c, c, c - 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  },
};

export function drawDrainageGlyph(kind: keyof typeof GLYPHS, sizeCss = 18): ImageData {
  const { c, ctx } = canvas(sizeCss, sizeCss);
  ctx.fillStyle = FILL;
  ctx.strokeStyle = STROKE;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  GLYPHS[kind](ctx, sizeCss);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** Official (BMA DDS register) pump station: the impeller glyph inside a second, solid ring. */
export function drawOfficialPumpGlyph(sizeCss = 22): ImageData {
  const { c, ctx } = canvas(sizeCss, sizeCss);
  const m = sizeCss / 2;
  ctx.beginPath();
  ctx.arc(m, m, m - 1, 0, Math.PI * 2);
  ctx.fillStyle = STROKE;
  ctx.fill();
  ctx.save();
  ctx.translate((sizeCss - 18) / 2, (sizeCss - 18) / 2);
  ctx.fillStyle = FILL;
  ctx.strokeStyle = STROKE;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  GLYPHS.pump(ctx, 18);
  ctx.restore();
  return ctx.getImageData(0, 0, c.width, c.height);
}

/**
 * Water-level gauge: a staff-gauge "tag" (rounded rectangle with a pointer foot) carrying the
 * surveyor's water-surface mark ▽ over two ripple lines. The fill colour carries the situation class;
 * the shape alone already distinguishes it from rain gauges (circles) and drainage assets.
 * `hollow` draws the no-data variant (outline only).
 */
export function drawGaugeGlyph(color: string, hollow = false, sizeCss = 20): ImageData {
  const w = sizeCss;
  const h = Math.round(sizeCss * 1.2);
  const { c, ctx } = canvas(w, h);
  const p = 1.6;
  const r = 4;
  const bodyH = h - 5;
  ctx.beginPath();
  ctx.moveTo(p + r, p);
  ctx.lineTo(w - p - r, p);
  ctx.quadraticCurveTo(w - p, p, w - p, p + r);
  ctx.lineTo(w - p, bodyH - r);
  ctx.quadraticCurveTo(w - p, bodyH, w - p - r, bodyH);
  ctx.lineTo(w / 2 + 3, bodyH);
  ctx.lineTo(w / 2, h - 1);
  ctx.lineTo(w / 2 - 3, bodyH);
  ctx.lineTo(p + r, bodyH);
  ctx.quadraticCurveTo(p, bodyH, p, bodyH - r);
  ctx.lineTo(p, p + r);
  ctx.quadraticCurveTo(p, p, p + r, p);
  ctx.closePath();
  ctx.fillStyle = hollow ? FILL : color;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.strokeStyle = hollow ? color : "#06111e";
  ctx.stroke();
  const ink = hollow ? color : "#06111e";
  // ▽ water-surface mark
  const cx = w / 2;
  const ty = p + 3.2;
  ctx.beginPath();
  ctx.moveTo(cx - 4, ty);
  ctx.lineTo(cx + 4, ty);
  ctx.lineTo(cx, ty + 4.6);
  ctx.closePath();
  ctx.fillStyle = ink;
  ctx.fill();
  // ripple lines under the mark
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.3;
  ctx.lineCap = "round";
  for (const [y, half] of [
    [ty + 7, 5.4],
    [ty + 9.8, 3.6],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(cx - half, y);
    ctx.lineTo(cx + half, y);
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** Community markers: verified = solid dot; illustrative = dashed ring with a hollow centre. */
export function drawCommunityGlyph(kind: "verified" | "illustrative", sizeCss = 14): ImageData {
  const { c, ctx } = canvas(sizeCss, sizeCss);
  const m = sizeCss / 2;
  if (kind === "verified") {
    ctx.beginPath();
    ctx.arc(m, m, m - 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#c7b8ff";
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "#06111e";
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(m, m, m - 2.2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(6, 17, 30, 0.55)";
    ctx.fill();
    ctx.setLineDash([2.2, 1.8]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#b9a9f5";
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** Diagonal hatch for "no data" areas — reads as absence, never as a low value. */
export function drawHatch(): ImageData {
  const s = 10;
  const { c, ctx } = canvas(s, s);
  ctx.fillStyle = "rgba(11, 27, 44, 0.55)";
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = "rgba(124, 150, 172, 0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = -s; k <= s; k += 5) {
    ctx.moveTo(k, s);
    ctx.lineTo(k + s, 0);
  }
  ctx.stroke();
  return ctx.getImageData(0, 0, c.width, c.height);
}

/**
 * Animated line pattern for water flow. `phase` is advanced by an external ≤15 fps ticker;
 * `render()` re-draws only when the phase changed, so idle frames cost nothing and MapLibre only
 * re-uploads this tiny texture (no tile re-layout, unlike animating `line-dasharray`).
 */
export class FlowPattern implements StyleImageInterface {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  private readonly period: number;
  private phase = 0;
  private drawn = -1;

  constructor(periodPx = 48, heightPx = 8) {
    this.period = periodPx;
    this.width = periodPx;
    this.height = heightPx;
    this.data = new Uint8ClampedArray(periodPx * heightPx * 4);
    this.paint();
  }

  /** Advance by `px` pixels (wraps). Returns the new phase. */
  advance(px: number) {
    this.phase = (this.phase + px) % this.period;
    return this.phase;
  }

  reset() {
    this.phase = 0;
  }

  private paint() {
    const { width: w, height: h, data } = this;
    const dash = Math.round(w * 0.42);
    const head = Math.floor(this.phase);
    for (let x = 0; x < w; x++) {
      // distance behind the moving head, wrapped to [0, w)
      const d = (head - x + w * 2) % w;
      const a = d < dash ? Math.pow(1 - d / dash, 1.6) : 0; // bright head, soft tail
      for (let y = 0; y < h; y++) {
        const cy = Math.abs(y + 0.5 - h / 2) / (h / 2); // 0 centre → 1 edge
        const alpha = a * Math.max(0, 1 - cy * cy) * 0.95;
        const i = (y * w + x) * 4;
        data[i] = 150;
        data[i + 1] = 240;
        data[i + 2] = 255;
        data[i + 3] = Math.round(alpha * 255);
      }
    }
    this.drawn = this.phase;
  }

  render() {
    if (this.drawn === this.phase) return false;
    this.paint();
    return true;
  }
}

export const DRAIN_ICON_IDS = {
  pump: IMG.pump,
  gate: IMG.gate,
  monitoring: IMG.monitoring,
  retention: IMG.retention,
  other: IMG.other,
} as const;

export { PR as IMAGE_PIXEL_RATIO };
