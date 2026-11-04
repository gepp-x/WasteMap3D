/**
 * Ring / polyline helpers in planar scene space (pure, allocation-light).
 */

export type P2 = [number, number];

function sqSegDist(p: P2, a: P2, b: P2) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/** Iterative Ramer–Douglas–Peucker simplification (keeps endpoints). */
export function simplifyLine(points: P2[], tolerance: number): P2[] {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxSq = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i], points[first], points[last]);
      if (d > maxSq) {
        maxSq = d;
        index = i;
      }
    }
    if (index !== -1 && maxSq > sqTol) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out: P2[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Removes consecutive duplicates and the closing vertex of a ring. */
export function cleanRing(ring: P2[], eps = 1e-6): P2[] {
  const out: P2[] = [];
  for (const p of ring) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < eps && Math.abs(prev[1] - p[1]) < eps) continue;
    out.push(p);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps) out.pop();
  }
  return out;
}

/** Signed area (shoelace); positive = counter-clockwise in a y-up plane. */
export function signedArea(ring: P2[]) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Simplifies a closed ring, guaranteeing at least 3 vertices when possible. */
export function simplifyRing(ring: P2[], tolerance: number): P2[] {
  const clean = cleanRing(ring);
  if (clean.length < 4 || tolerance <= 0) return clean;
  const closed = [...clean, clean[0]];
  const s = cleanRing(simplifyLine(closed, tolerance));
  return s.length >= 3 ? s : clean;
}
