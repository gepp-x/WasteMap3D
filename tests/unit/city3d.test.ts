import { describe, expect, it } from "vitest";
import { buildEdgeVertices } from "@/lib/map/city3d";
import { floodVisualHeight } from "@/components/map/City3DMode";

const square = (x: number, h: number) => ({
  geometry: { type: "Polygon" as const, coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] },
  properties: { render_height: h, render_min_height: 0 },
});
const project = (lng: number, lat: number): [number, number] => [lng * 10, lat * 10];

describe("3D City edges", () => {
  it("emits roof outline + vertical corners at the tagged height", () => {
    const v = buildEdgeVertices([square(0, 30)], project);
    const segs = v.length / 6;
    expect(segs).toBe(4 + 3); // 4 roof edges, 3 interior corners (closing vertex shared)
    const zs = new Set<number>();
    for (let i = 2; i < v.length; i += 3) zs.add(Math.round(v[i] * 100) / 100);
    expect([...zs].sort((a, b) => a - b)).toEqual([0, 30.25]);
  });
  it("de-duplicates footprints repeated across tiles and honours hide_3d and the cap", () => {
    expect(buildEdgeVertices([square(0, 10), square(0, 10)], project).length).toBe(buildEdgeVertices([square(0, 10)], project).length);
    expect(buildEdgeVertices([{ ...square(0, 10), properties: { hide_3d: true } }], project).length).toBe(0);
    expect(buildEdgeVertices([square(0, 10), square(5, 10), square(9, 10)], project, 12).length).toBeLessThanOrEqual(12 + 6 * 2);
  });
  it("flood sheet is a visual metaphor that only appears from High risk", () => {
    expect(floodVisualHeight(null)).toBe(0);
    expect(floodVisualHeight(49.9)).toBe(0);
    expect(floodVisualHeight(50)).toBe(0.4);
    expect(floodVisualHeight(100)).toBe(2.6);
  });
});
