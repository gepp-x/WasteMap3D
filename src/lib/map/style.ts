/**
 * "Midnight command center" basemap, built in code.
 *
 *  - Online: OpenFreeMap vector tiles (OpenMapTiles schema), deep-navy land, slate-blue road
 *    hierarchy with zoom-interpolated widths and casing, dashed rail, faint buildings from z14
 *    (extruded when the camera is tilted), barely-tinted parks and muted place labels.
 *  - Offline: background + generated graticule only. Used when the basemap cannot be reached;
 *    the bundled data overlay (areas, water, drainage, rain) renders identically on both.
 *
 * Both styles expose the same three invisible "anchor" layers (see ids.ts) so the data overlay
 * is inserted at the same z-order whichever basemap is active.
 */
import type { FeatureCollection } from "geojson";
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";
import { ANCHOR, BASEMAP_BUILDINGS_3D, BASEMAP_BUILDINGS_FLAT, BASEMAP_SOURCE, GRID_SOURCE } from "./ids";

export const OPENFREEMAP_TILEJSON = "https://tiles.openfreemap.org/planet";
export const GLYPHS_URL = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
export const FONT_REGULAR = ["Noto Sans Regular"];
export const FONT_BOLD = ["Noto Sans Bold"];

export const BASEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">© OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';

/** Basemap palette — deep navy land, restrained slate-blue network, cyan only as a hairline accent. */
export const MAP_COLORS = {
  land: "#071423",
  wood: "#0a1b25",
  grass: "#09192a",
  residential: "#09182a",
  industrial: "#0b1a2c",
  park: "#0a1d27",
  water: "#0a2236",
  shore: "#123a5c",
  waterLine: "#0f3354",
  runway: "#0e2033",
  building: "#0d2135",
  buildingLine: "#122b44",
  building3d: "#11283f",
  casing: "#040b14",
  motorway: "#2f5677",
  trunk: "#2a4d6c",
  primary: "#24425f",
  secondary: "#1f3953",
  tertiary: "#1b324b",
  minor: "#162b41",
  service: "#13263a",
  rail: "#2b4864",
  boundary: "#2d455c",
  labelCity: "#7a93a8",
  labelTown: "#6c869c",
  labelMinor: "#5a748a",
  labelWater: "#4a7ea4",
  labelRoad: "#5a7388",
  halo: "#071423",
  gridMajor: "rgba(37, 217, 242, 0.075)",
  grid: "rgba(37, 217, 242, 0.045)",
  gridFine: "rgba(37, 217, 242, 0.032)",
} as const;

const e = (v: unknown) => v as ExpressionSpecification;

/** Exponential zoom interpolation helper: stops = [[zoom, value], ...]. */
function zexp(stops: [number, number][], base = 1.5): ExpressionSpecification {
  return e(["interpolate", ["exponential", base], ["zoom"], ...stops.flat()]);
}
function zlin(stops: [number, number][]): ExpressionSpecification {
  return e(["interpolate", ["linear"], ["zoom"], ...stops.flat()]);
}
const classIn = (...classes: string[]) => e(["in", ["get", "class"], ["literal", classes]]);
const notTunnel = e(["!=", ["get", "brunnel"], "tunnel"]);

const placeName = e(["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]]);

/* -------------------------------------------------------------------------------------------- */
/*  Graticule — a fine technical grid generated in code (no network, works offline)              */
/* -------------------------------------------------------------------------------------------- */

interface GridProps {
  /** 0 = 1°, 1 = 0.1°, 2 = 0.02° */
  level: 0 | 1 | 2;
}

/** Fine-grid windows around the two cities (generous padding so the edge is never in view at z ≥ 12). */
const FINE_WINDOWS: [number, number, number, number][] = [
  [99.9, 13.1, 101.35, 14.35], // Bangkok
  [100.15, 6.75, 100.8, 7.3], // Hat Yai
];
const COARSE_WINDOW: [number, number, number, number] = [96, 4, 106, 16];

let gridCache: FeatureCollection | null = null;

export function graticule(): FeatureCollection {
  if (gridCache) return gridCache;
  const features: FeatureCollection["features"] = [];
  const push = (coords: [number, number][], level: GridProps["level"]) =>
    features.push({ type: "Feature", properties: { level }, geometry: { type: "LineString", coordinates: coords } });

  // Coarse 0.1° grid (integer tenths avoid float drift), 1° lines flagged as level 0.
  const [cw, cs, ce, cn] = COARSE_WINDOW;
  for (let i = Math.round(cw * 10); i <= Math.round(ce * 10); i++) push([[i / 10, cs], [i / 10, cn]], i % 10 === 0 ? 0 : 1);
  for (let j = Math.round(cs * 10); j <= Math.round(cn * 10); j++) push([[cw, j / 10], [ce, j / 10]], j % 10 === 0 ? 0 : 1);

  // Fine 0.02° grid inside the city windows (skipping lines already drawn by the coarse grid).
  for (const [w, s, east, n] of FINE_WINDOWS) {
    for (let i = Math.ceil(w * 50); i <= Math.floor(east * 50); i++) if (i % 5 !== 0) push([[i / 50, s], [i / 50, n]], 2);
    for (let j = Math.ceil(s * 50); j <= Math.floor(n * 50); j++) if (j % 5 !== 0) push([[w, j / 50], [east, j / 50]], 2);
  }
  gridCache = { type: "FeatureCollection", features };
  return gridCache;
}

function gridLayers(strength: 1 | 2): LayerSpecification[] {
  const k = strength === 2 ? 2.6 : 1.15;
  const alpha = (rgba: string) => rgba.replace(/[\d.]+\)$/, (m) => `${Math.min(0.3, parseFloat(m) * k).toFixed(3)})`);
  return [
    {
      id: "grid-fine",
      type: "line",
      source: GRID_SOURCE,
      minzoom: 11.5,
      filter: ["==", ["get", "level"], 2],
      paint: { "line-color": alpha(MAP_COLORS.gridFine), "line-width": 0.5, "line-opacity": zlin([[11.5, 0], [12.5, 1]]) },
    },
    {
      id: "grid",
      type: "line",
      source: GRID_SOURCE,
      minzoom: 7,
      filter: ["==", ["get", "level"], 1],
      paint: { "line-color": alpha(MAP_COLORS.grid), "line-width": 0.6, "line-opacity": zlin([[7, 0], [8.5, 1]]) },
    },
    {
      id: "grid-major",
      type: "line",
      source: GRID_SOURCE,
      filter: ["==", ["get", "level"], 0],
      paint: { "line-color": alpha(MAP_COLORS.gridMajor), "line-width": 0.8 },
    },
  ];
}

const anchorLayer = (id: string): LayerSpecification => ({
  id,
  type: "background",
  layout: { visibility: "none" },
  paint: { "background-color": "rgba(0,0,0,0)" },
});

/* -------------------------------------------------------------------------------------------- */
/*  Online style                                                                                 */
/* -------------------------------------------------------------------------------------------- */

function roadPair(
  id: string,
  classes: string[],
  color: string,
  width: [number, number][],
  opts: { minzoom?: number; casingFrom?: number } = {},
): LayerSpecification[] {
  const casingWidth = width.map(([z, w]) => [z, z >= (opts.casingFrom ?? 11) ? w + Math.min(2.2, 0.6 + w * 0.18) : w] as [number, number]);
  const filter = e(["all", classIn(...classes), notTunnel]);
  return [
    {
      id: `${id}-casing`,
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "transportation",
      minzoom: opts.minzoom,
      filter,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": MAP_COLORS.casing, "line-width": zexp(casingWidth), "line-opacity": zlin([[(opts.casingFrom ?? 11) - 0.5, 0], [opts.casingFrom ?? 11, 0.9]]) },
    },
    {
      id,
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "transportation",
      minzoom: opts.minzoom,
      filter,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": zexp(width) },
    },
  ];
}

export function buildBasemapStyle(): StyleSpecification {
  const C = MAP_COLORS;
  const layers: LayerSpecification[] = [
    { id: "background", type: "background", paint: { "background-color": C.land } },
    {
      id: "landcover-wood",
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "landcover",
      filter: classIn("wood", "forest"),
      paint: { "fill-color": C.wood, "fill-opacity": 0.7 },
    },
    {
      id: "landcover-grass",
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "landcover",
      filter: classIn("grass", "farmland", "wetland"),
      paint: { "fill-color": C.grass, "fill-opacity": 0.55 },
    },
    {
      id: "landuse-residential",
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "landuse",
      filter: classIn("residential", "suburb", "neighbourhood"),
      paint: { "fill-color": C.residential, "fill-opacity": zlin([[9, 0], [12, 0.8]]) },
    },
    {
      id: "landuse-industrial",
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "landuse",
      filter: classIn("industrial", "commercial", "retail", "railway"),
      paint: { "fill-color": C.industrial, "fill-opacity": zlin([[10, 0], [13, 0.7]]) },
    },
    { id: "park", type: "fill", source: BASEMAP_SOURCE, "source-layer": "park", paint: { "fill-color": C.park, "fill-opacity": 0.6 } },
    {
      id: "water",
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "water",
      filter: notTunnel,
      paint: { "fill-color": C.water, "fill-antialias": true },
    },
    {
      id: "water-shore",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "water",
      filter: notTunnel,
      paint: { "line-color": C.shore, "line-width": zlin([[5, 0.3], [12, 0.8], [16, 1.2]]), "line-opacity": 0.85 },
    },
    {
      id: "waterway",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "waterway",
      filter: notTunnel,
      layout: { "line-cap": "round" },
      paint: {
        "line-color": C.waterLine,
        "line-width": e([
          "interpolate",
          ["exponential", 1.4],
          ["zoom"],
          8,
          ["match", ["get", "class"], "river", 0.6, 0.2],
          13,
          ["match", ["get", "class"], "river", 2.2, "canal", 1.4, 0.6],
          17,
          ["match", ["get", "class"], "river", 7, "canal", 4, 1.6],
        ]),
      },
    },
    {
      id: "aeroway-runway",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "aeroway",
      filter: classIn("runway", "taxiway"),
      paint: { "line-color": C.runway, "line-width": zexp([[10, 1], [15, 16]], 1.6) },
    },
    ...gridLayers(1),
    anchorLayer(ANCHOR.fill),
    {
      id: BASEMAP_BUILDINGS_FLAT,
      type: "fill",
      source: BASEMAP_SOURCE,
      "source-layer": "building",
      minzoom: 13.5,
      paint: {
        "fill-color": C.building,
        "fill-outline-color": C.buildingLine,
        "fill-opacity": zlin([[13.5, 0], [15, 0.6]]),
      },
    },
    // Road network — graded slate-blue by class (minor → major so majors draw on top).
    ...roadPair("road-service", ["service", "track"], C.service, [[13, 0.3], [15, 1.1], [18, 5]], { minzoom: 13, casingFrom: 14 }),
    ...roadPair("road-minor", ["minor"], C.minor, [[12, 0.3], [14, 1.1], [16, 3.2], [18, 8]], { minzoom: 11.5, casingFrom: 13 }),
    ...roadPair("road-secondary", ["secondary", "tertiary"], C.secondary, [[9, 0.3], [12, 0.9], [14, 2.3], [16, 5], [18, 11]], { minzoom: 8.5, casingFrom: 12 }),
    ...roadPair("road-primary", ["primary"], C.primary, [[7, 0.35], [10, 0.9], [12, 1.5], [14, 3.2], [16, 6.5], [18, 14]], { minzoom: 6.5, casingFrom: 11 }),
    ...roadPair("road-trunk", ["trunk"], C.trunk, [[5, 0.4], [9, 0.9], [12, 1.8], [14, 3.8], [16, 7.5], [18, 16]], { minzoom: 5, casingFrom: 10 }),
    ...roadPair("road-motorway", ["motorway"], C.motorway, [[5, 0.5], [9, 1.1], [12, 2.1], [14, 4.2], [16, 8], [18, 17]], { minzoom: 5, casingFrom: 10 }),
    {
      id: "rail",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "transportation",
      minzoom: 9,
      filter: e(["all", classIn("rail", "transit"), notTunnel]),
      paint: {
        "line-color": C.rail,
        "line-width": zexp([[9, 0.6], [14, 1.4], [18, 2.6]]),
        "line-dasharray": [2.5, 2],
        "line-opacity": zlin([[9, 0.4], [12, 0.9]]),
      },
    },
    {
      id: "boundary-province",
      type: "line",
      source: BASEMAP_SOURCE,
      "source-layer": "boundary",
      filter: e(["all", ["<=", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]]),
      paint: { "line-color": C.boundary, "line-width": zlin([[5, 0.6], [12, 1.2]]), "line-dasharray": [4, 2, 1, 2], "line-opacity": 0.8 },
    },
    // Extrusions above the road network so streets do not draw through buildings when tilted.
    {
      id: BASEMAP_BUILDINGS_3D,
      type: "fill-extrusion",
      source: BASEMAP_SOURCE,
      "source-layer": "building",
      minzoom: 13.5,
      layout: { visibility: "none" },
      paint: {
        "fill-extrusion-color": C.building3d,
        "fill-extrusion-height": e(["coalesce", ["get", "render_height"], 6]),
        "fill-extrusion-base": e(["coalesce", ["get", "render_min_height"], 0]),
        "fill-extrusion-opacity": zlin([[13.5, 0], [15, 0.78]]),
        "fill-extrusion-vertical-gradient": true,
      },
    },
    anchorLayer(ANCHOR.overlay),
    {
      id: "label-road",
      type: "symbol",
      source: BASEMAP_SOURCE,
      "source-layer": "transportation_name",
      minzoom: 14,
      filter: classIn("motorway", "trunk", "primary", "secondary", "tertiary"),
      layout: {
        "symbol-placement": "line",
        "text-field": placeName,
        "text-font": FONT_REGULAR,
        "text-size": zlin([[14, 9.5], [18, 12]]),
        "text-letter-spacing": 0.04,
        "text-max-angle": 30,
      },
      paint: { "text-color": C.labelRoad, "text-halo-color": C.halo, "text-halo-width": 1.2 },
    },
    {
      id: "label-water",
      type: "symbol",
      source: BASEMAP_SOURCE,
      "source-layer": "water_name",
      minzoom: 6,
      layout: {
        "text-field": placeName,
        "text-font": FONT_REGULAR,
        "text-size": zlin([[6, 10], [14, 12]]),
        "text-letter-spacing": 0.12,
        "text-max-width": 8,
      },
      paint: { "text-color": C.labelWater, "text-halo-color": C.halo, "text-halo-width": 1 },
    },
    {
      id: "label-place-minor",
      type: "symbol",
      source: BASEMAP_SOURCE,
      "source-layer": "place",
      minzoom: 12.5,
      filter: classIn("suburb", "quarter", "neighbourhood", "village", "hamlet"),
      layout: {
        "text-field": placeName,
        "text-font": FONT_REGULAR,
        "text-size": zlin([[12.5, 9.5], [16, 11.5]]),
        "text-max-width": 7,
        "text-padding": 6,
      },
      paint: { "text-color": C.labelMinor, "text-halo-color": C.halo, "text-halo-width": 1.1, "text-opacity": zlin([[12.5, 0], [13.2, 0.9]]) },
    },
    {
      id: "label-place-town",
      type: "symbol",
      source: BASEMAP_SOURCE,
      "source-layer": "place",
      minzoom: 7,
      maxzoom: 14,
      filter: classIn("town"),
      layout: { "text-field": placeName, "text-font": FONT_REGULAR, "text-size": zlin([[7, 10], [12, 12.5]]), "text-max-width": 8 },
      paint: { "text-color": C.labelTown, "text-halo-color": C.halo, "text-halo-width": 1.2 },
    },
    {
      id: "label-place-city",
      type: "symbol",
      source: BASEMAP_SOURCE,
      "source-layer": "place",
      minzoom: 4,
      maxzoom: 11.2,
      filter: classIn("city"),
      layout: {
        "text-field": placeName,
        "text-font": FONT_BOLD,
        "text-size": zlin([[4, 10], [10, 12.5]]),
        "text-transform": "uppercase",
        "text-letter-spacing": 0.18,
        "text-max-width": 9,
      },
      // Fades out as district labels take over (data labels start at z10.6).
      paint: { "text-color": C.labelCity, "text-halo-color": C.halo, "text-halo-width": 1.4, "text-opacity": zlin([[9.8, 0.85], [11, 0]]) },
    },
    anchorLayer(ANCHOR.top),
  ];

  return {
    version: 8,
    name: "Urban Intelligence — Midnight",
    glyphs: GLYPHS_URL,
    sources: {
      [BASEMAP_SOURCE]: { type: "vector", url: OPENFREEMAP_TILEJSON, attribution: BASEMAP_ATTRIBUTION },
      [GRID_SOURCE]: { type: "geojson", data: graticule(), maxzoom: 12, tolerance: 0 },
    },
    light: { anchor: "viewport", color: "#a9c7e0", intensity: 0.28, position: [1.15, 210, 30] },
    transition: { duration: 300, delay: 0 },
    layers,
  };
}

/* -------------------------------------------------------------------------------------------- */
/*  Offline style                                                                                */
/* -------------------------------------------------------------------------------------------- */

export function buildOfflineStyle(): StyleSpecification {
  return {
    version: 8,
    name: "Urban Intelligence — Offline",
    // Glyphs stay declared so label layers validate; requests fail quietly while offline and the
    // HTML area-name marker still renders Thai/English names.
    glyphs: GLYPHS_URL,
    sources: {
      [GRID_SOURCE]: { type: "geojson", data: graticule(), maxzoom: 12, tolerance: 0 },
    },
    transition: { duration: 300, delay: 0 },
    layers: [
      { id: "background", type: "background", paint: { "background-color": MAP_COLORS.land } },
      ...gridLayers(2),
      anchorLayer(ANCHOR.fill),
      anchorLayer(ANCHOR.overlay),
      anchorLayer(ANCHOR.top),
    ],
  };
}
