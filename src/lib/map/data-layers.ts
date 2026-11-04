/**
 * Data overlay: sources + layers for areas, water/drainage, rain and hotspots.
 *
 * Specs are pure data (`dataOverlaySpec`) so they can be validated outside the browser, and
 * `installDataOverlay(map)` adds them on every `style.load` (first load and every basemap swap).
 * Dynamic values (choropleth colours, hover/selection, drainage stress) are driven through
 * feature-state, so updates never re-tile a source.
 */
import type { ExpressionSpecification, LayerSpecification, Map as MLMap, SourceSpecification } from "maplibre-gl";
import { ANCHOR, IMG, LYR, SRC, type AnchorId } from "./ids";
import { FONT_REGULAR } from "./style";
import { EMPTY_FC } from "./features";
import { STRESS_CLASSES } from "./choropleth";
import { DRAIN_ICON_IDS, FlowPattern, IMAGE_PIXEL_RATIO, drawCommunityGlyph, drawDrainageGlyph, drawGaugeGlyph, drawHatch, drawOfficialPumpGlyph } from "./icons";
import { GAUGE_CLASSES, gaugeIconId } from "./water-levels";

const e = (v: unknown) => v as ExpressionSpecification;
const fs = (key: string, fallback: boolean | number = false) =>
  typeof fallback === "boolean" ? e(["boolean", ["feature-state", key], fallback]) : e(["number", ["feature-state", key], fallback]);

export const COLORS = {
  outline: "rgba(145, 168, 186, 0.38)",
  outlineHover: "#d6eef8",
  approx: "rgba(167, 196, 216, 0.55)",
  cyan: "#25d9f2",
  municipality: "#7fc4e6",
  community: "#5f7c92",
  water: "#0e2c46",
  waterEdge: "#1d5378",
  river: "#2a86b5",
  canal: "#2273a0",
  stream: "#1b5a80",
  drain: "#174a68",
  drainageLine: "#3aa6c8",
  stationStroke: "#d9f4ff",
  hotspot: "#f6a34b",
  hotspotCore: "#f5d65a",
  label: "#9db5c8",
  labelHalo: "#06111e",
} as const;

/** Colours for water kinds (legend reuses these). */
export const WATER_KIND_COLOR: Record<string, string> = {
  river: COLORS.river,
  canal: COLORS.canal,
  stream: COLORS.stream,
  drain: COLORS.drain,
  other: COLORS.stream,
};

/** Rain-gauge colour by TMD class thresholds (mm/24 h). */
export const STATION_STEPS: [number, string][] = [
  [0.1, "#1767a1"],
  [10, "#1f95d0"],
  [35, "#25d9f2"],
  [90, "#c9f6ff"],
];
export const STATION_NONE_COLOR = "#2a4a63";

/** Heatmap colour ramp (density → colour), matches the legend gradient. */
export const HEAT_RAMP: [number, string][] = [
  [0, "rgba(13, 34, 56, 0)"],
  [0.15, "rgba(18, 62, 102, 0.55)"],
  [0.35, "rgba(23, 103, 161, 0.75)"],
  [0.6, "rgba(31, 149, 208, 0.85)"],
  [0.82, "rgba(37, 217, 242, 0.9)"],
  [1, "rgba(191, 244, 255, 0.95)"],
];

/** Community markers appear once the map is close enough to separate ~100 points in four zones. */
export const COMMUNITY_MINZOOM = 11.5;

/**
 * Community icon opacity: fades in from COMMUNITY_MINZOOM; when a zone is selected, communities of
 * other zones recede so the selected zone's list on the map matches the details panel.
 */
export function communityOpacity(op: number, zoneId: string | null): ExpressionSpecification {
  const inZone = zoneId ? ["case", ["==", ["get", "_z"], zoneId], op, op * 0.28] : op;
  return e(["interpolate", ["linear"], ["zoom"], COMMUNITY_MINZOOM, 0, COMMUNITY_MINZOOM + 0.7, inZone]);
}

export interface OverlaySpec {
  sources: Record<string, SourceSpecification>;
  layers: { before: AnchorId; spec: LayerSpecification }[];
}

const fc = () => ({ type: "geojson" as const, data: EMPTY_FC });

export function dataOverlaySpec(): OverlaySpec {
  const sources: Record<string, SourceSpecification> = {
    [SRC.areas]: { ...fc(), promoteId: "fid" },
    [SRC.anchors]: { ...fc(), promoteId: "fid" },
    [SRC.hotspots]: { ...fc(), promoteId: "fid" },
    [SRC.waterways]: { ...fc(), attribution: "© OpenStreetMap contributors" },
    [SRC.drainage]: { ...fc(), promoteId: "_i" },
    [SRC.stations]: { ...fc() },
    [SRC.rainGrid]: { ...fc() },
    [SRC.municipality]: { ...fc() },
    [SRC.communities]: { ...fc() },
    [SRC.waterLevels]: { ...fc() },
  };

  const stressColor = e([
    "match",
    fs("s", -1),
    ...STRESS_CLASSES.flatMap((c, i) => [i, c.color]),
    "rgba(127, 227, 245, 0.55)",
  ]);

  const layers: OverlaySpec["layers"] = [
    /* ---------------- fills (under buildings & roads) ---------------- */
    {
      before: ANCHOR.fill,
      spec: {
        id: LYR.areasFill,
        type: "fill",
        source: SRC.areas,
        layout: { visibility: "none" },
        paint: {
          // Static expression; only feature-state changes → no re-tiling. Opacity stays a constant
          // so the layer-opacity slider is a cheap paint update.
          "fill-color": e(["case", fs("hasValue"), ["to-color", ["coalesce", ["feature-state", "color"], "#13304a"]], "rgba(0,0,0,0)"]),
          "fill-opacity": 0.78,
          "fill-antialias": false,
        },
      },
    },
    {
      before: ANCHOR.fill,
      spec: {
        id: LYR.areasNoData,
        type: "fill",
        source: SRC.areas,
        layout: { visibility: "none" },
        paint: {
          "fill-pattern": IMG.hatch,
          "fill-opacity": e(["case", fs("hasValue", true), 0, 0.85]),
        },
      },
    },
    {
      // Dims every area except the selected one (opacity constant toggled when a selection exists).
      before: ANCHOR.fill,
      spec: {
        id: LYR.areasDim,
        type: "fill",
        source: SRC.areas,
        paint: {
          "fill-color": e(["case", fs("selected"), "rgba(0,0,0,0)", "#050d18"]),
          "fill-opacity": 0,
        },
      },
    },
    {
      before: ANCHOR.fill,
      spec: {
        id: LYR.areasHoverFill,
        type: "fill",
        source: SRC.areas,
        paint: {
          "fill-color": "#cfe9f5",
          "fill-opacity": e(["case", fs("hover"), 0.08, fs("selected"), 0.04, 0]),
        },
      },
    },
    {
      before: ANCHOR.fill,
      spec: {
        id: LYR.rainHeat,
        type: "heatmap",
        source: SRC.rainGrid,
        layout: { visibility: "none" },
        paint: {
          "heatmap-weight": e(["coalesce", ["get", "w"], 0]),
          "heatmap-intensity": 1.15,
          // ≈ 0.18° footprint per reanalysis cell at every zoom (exponential base 2 tracks map scale)
          "heatmap-radius": e(["interpolate", ["exponential", 2], ["zoom"], 5, 4.2, 14, 2150]),
          "heatmap-color": e(["interpolate", ["linear"], ["heatmap-density"], ...HEAT_RAMP.flat()]),
          "heatmap-opacity": 0.55,
        },
      },
    },
    {
      before: ANCHOR.fill,
      spec: {
        id: LYR.areasHit,
        type: "fill",
        source: SRC.areas,
        paint: { "fill-color": "#000000", "fill-opacity": 0 },
      },
    },

    /* ---------------- water & drainage (above roads) ---------------- */
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.waterAreas,
        type: "fill",
        source: SRC.waterways,
        filter: e(["==", ["get", "_a"], 1]),
        paint: { "fill-color": COLORS.water, "fill-opacity": 0.9 },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.waterAreasLine,
        type: "line",
        source: SRC.waterways,
        filter: e(["==", ["get", "_a"], 1]),
        paint: { "line-color": COLORS.waterEdge, "line-width": 0.7, "line-opacity": 0.9 },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.waterLines,
        type: "line",
        source: SRC.waterways,
        // Field drains / ditches only appear once the map is close enough to read them.
        filter: e(["all", ["==", ["get", "_a"], 0], ["any", [">=", ["get", "_w"], 1], [">=", ["zoom"], 11]]]),
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": e(["match", ["get", "_k"], "river", COLORS.river, "canal", COLORS.canal, "drain", COLORS.drain, COLORS.stream]),
          "line-width": e([
            "interpolate",
            ["exponential", 1.6],
            ["zoom"],
            9,
            ["*", 0.35, ["+", 0.6, ["get", "_w"]]],
            12,
            ["*", 0.8, ["+", 0.6, ["get", "_w"]]],
            16,
            ["*", 2.6, ["+", 0.6, ["get", "_w"]]],
          ]),
          "line-opacity": e(["interpolate", ["linear"], ["zoom"], 9, 0.7, 12, 0.9]),
        },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.waterFlow,
        type: "line",
        source: SRC.waterways,
        minzoom: 10.5,
        filter: e(["all", ["==", ["get", "_a"], 0], [">=", ["get", "_w"], 1], ["in", ["get", "_k"], ["literal", ["river", "canal"]]]]),
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-pattern": IMG.flow,
          "line-width": e(["interpolate", ["exponential", 1.6], ["zoom"], 10.5, ["*", 0.9, ["+", 0.6, ["get", "_w"]]], 16, ["*", 2.6, ["+", 0.6, ["get", "_w"]]]]),
          "line-opacity": e(["interpolate", ["linear"], ["zoom"], 10.5, 0, 11.5, 0.75]),
        },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.drainageAreas,
        type: "fill",
        source: SRC.drainage,
        filter: e(["==", ["get", "_g"], "area"]),
        paint: { "fill-color": "#12c9b0", "fill-opacity": 0.14, "fill-outline-color": "rgba(18, 201, 176, 0.6)" },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.drainageLines,
        type: "line",
        source: SRC.drainage,
        filter: e(["==", ["get", "_g"], "line"]),
        layout: { "line-cap": "round" },
        paint: {
          "line-color": COLORS.drainageLine,
          "line-width": e(["interpolate", ["linear"], ["zoom"], 10, 0.6, 15, 2]),
          "line-dasharray": [1.5, 1.5],
          "line-opacity": 0.75,
        },
      },
    },

    /* ---------------- area outlines & selection ---------------- */
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.areasShadow,
        type: "line",
        source: SRC.areas,
        layout: { "line-join": "round" },
        paint: {
          "line-color": "#000000",
          "line-width": 5,
          "line-blur": 4,
          "line-translate": [1.5, 3],
          "line-opacity": e(["case", fs("hover"), 0.55, 0]),
        },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.areasOutline,
        type: "line",
        source: SRC.areas,
        filter: e(["!=", ["get", "geometryStatus"], "approximate"]),
        layout: { "line-join": "round" },
        paint: {
          "line-color": e(["case", fs("hover"), COLORS.outlineHover, COLORS.outline]),
          "line-width": e(["interpolate", ["linear"], ["zoom"], 9, ["case", fs("hover"), 1.4, 0.5], 14, ["case", fs("hover"), 2, 1]]),
        },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.areasOutlineApprox,
        type: "line",
        source: SRC.areas,
        filter: e(["==", ["get", "geometryStatus"], "approximate"]),
        layout: { "line-join": "round" },
        paint: {
          "line-color": e(["case", fs("hover"), COLORS.outlineHover, COLORS.approx]),
          "line-width": e(["case", fs("hover"), 1.8, 1.1]),
          "line-dasharray": [3, 2],
        },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.municipalityGlow,
        type: "line",
        source: SRC.municipality,
        layout: { "line-join": "round" },
        paint: { "line-color": COLORS.municipality, "line-width": 7, "line-blur": 6, "line-opacity": 0.18 },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.municipalityLine,
        type: "line",
        source: SRC.municipality,
        layout: { "line-join": "round" },
        paint: { "line-color": COLORS.municipality, "line-width": 1.6, "line-opacity": 0.9 },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.communitiesLine,
        type: "line",
        source: SRC.communities,
        minzoom: 12.5,
        filter: e(["==", ["get", "_g"], "area"]),
        paint: { "line-color": COLORS.community, "line-width": 0.7, "line-dasharray": [1, 2], "line-opacity": 0.8 },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.selectedGlow,
        type: "line",
        source: SRC.areas,
        layout: { "line-join": "round" },
        paint: { "line-color": COLORS.cyan, "line-width": 11, "line-blur": 9, "line-opacity": e(["case", fs("selected"), 0.32, 0]) },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.selectedLine,
        type: "line",
        source: SRC.areas,
        layout: { "line-join": "round" },
        paint: { "line-color": COLORS.cyan, "line-width": 2.5, "line-opacity": e(["case", fs("selected"), 1, 0]) },
      },
    },

    /* ---------------- point overlays ---------------- */
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.drainageHalo,
        type: "circle",
        source: SRC.drainage,
        minzoom: 10,
        filter: e(["==", ["get", "_g"], "point"]),
        paint: {
          "circle-radius": e(["interpolate", ["linear"], ["zoom"], 10, 5, 15, 13]),
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": stressColor,
          "circle-stroke-width": e(["interpolate", ["linear"], ["zoom"], 10, 1.2, 15, 2.2]),
          "circle-stroke-opacity": e(["interpolate", ["linear"], ["zoom"], 10, 0, 10.6, 0.85]),
        },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.drainageIcons,
        type: "symbol",
        source: SRC.drainage,
        minzoom: 10,
        filter: e(["==", ["get", "_g"], "point"]),
        layout: {
          "icon-image": e([
            "match",
            ["get", "_k"],
            "pump",
            ["case", ["==", ["get", "_o"], "official"], IMG.pumpOfficial, DRAIN_ICON_IDS.pump],
            "gate",
            DRAIN_ICON_IDS.gate,
            "monitoring",
            DRAIN_ICON_IDS.monitoring,
            "retention",
            DRAIN_ICON_IDS.retention,
            DRAIN_ICON_IDS.other,
          ]),
          "icon-size": e(["interpolate", ["linear"], ["zoom"], 10, 0.55, 13, 0.8, 16, 1]),
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": e(["interpolate", ["linear"], ["zoom"], 10, 0, 10.6, 1]) },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.stations,
        type: "circle",
        source: SRC.stations,
        layout: { visibility: "none" },
        paint: {
          "circle-radius": e([
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            ["case", ["has", "v"], ["interpolate", ["linear"], ["get", "v"], 0, 3, 10, 4.5, 35, 6.5, 90, 9, 150, 11], 3],
            14,
            ["case", ["has", "v"], ["interpolate", ["linear"], ["get", "v"], 0, 5, 10, 7, 35, 10, 90, 14, 150, 17], 5],
          ]),
          "circle-color": e(["case", ["has", "v"], ["step", ["get", "v"], STATION_NONE_COLOR, ...STATION_STEPS.flat()], "rgba(0,0,0,0)"]),
          "circle-stroke-color": e(["case", ["has", "v"], COLORS.stationStroke, "#62798c"]),
          "circle-stroke-width": e(["case", ["has", "v"], 1, 1.4]),
          "circle-opacity": 0.92,
          "circle-stroke-opacity": 0.92,
        },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.hotspotRing,
        type: "circle",
        source: SRC.hotspots,
        layout: { visibility: "none" },
        filter: e(["==", ["get", "p"], 1]),
        paint: {
          "circle-radius": e([
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            ["*", ["get", "r"], 0.65, fs("k", 1.35)],
            15,
            ["*", ["get", "r"], 1.7, fs("k", 1.35)],
          ]),
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": COLORS.hotspot,
          "circle-stroke-width": 1.4,
          "circle-stroke-opacity": e(["*", 0.85, fs("o", 0.5)]),
        },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.hotspotCore,
        type: "circle",
        source: SRC.hotspots,
        layout: { visibility: "none" },
        paint: {
          "circle-radius": e(["interpolate", ["linear"], ["zoom"], 9, ["*", ["get", "r"], 0.65], 15, ["*", ["get", "r"], 1.7]]),
          "circle-color": e(["case", ["==", ["get", "p"], 1], "rgba(246, 163, 75, 0.28)", "rgba(245, 214, 90, 0.16)"]),
          "circle-stroke-color": e(["case", ["==", ["get", "p"], 1], COLORS.hotspot, COLORS.hotspotCore]),
          "circle-stroke-width": 1,
          "circle-stroke-opacity": 0.8,
          "circle-blur": 0.15,
        },
      },
    },

    /* ---------------- communities (Hat Yai) ---------------- */
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.communitiesIllustrative,
        type: "symbol",
        source: SRC.communities,
        minzoom: COMMUNITY_MINZOOM,
        filter: e(["all", ["==", ["get", "_g"], "point"], ["==", ["get", "_v"], 0]]),
        layout: {
          "icon-image": IMG.communityIllustrative,
          "icon-size": e(["interpolate", ["linear"], ["zoom"], COMMUNITY_MINZOOM, 0.7, 15, 1, 17, 1.2]),
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": communityOpacity(1, null) },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.communitiesVerified,
        type: "symbol",
        source: SRC.communities,
        minzoom: COMMUNITY_MINZOOM,
        filter: e(["all", ["==", ["get", "_g"], "point"], ["==", ["get", "_v"], 1]]),
        layout: {
          "icon-image": IMG.communityVerified,
          "icon-size": e(["interpolate", ["linear"], ["zoom"], COMMUNITY_MINZOOM, 0.7, 15, 1, 17, 1.2]),
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": communityOpacity(1, null) },
      },
    },

    /* ---------------- water-level gauges (snapshot) ---------------- */
    {
      before: ANCHOR.overlay,
      spec: {
        // Soft halo so a gauge reads on any choropleth colour; also widens the hover target.
        id: LYR.waterLevelHalo,
        type: "circle",
        source: SRC.waterLevels,
        layout: { visibility: "none" },
        paint: {
          "circle-radius": e(["interpolate", ["linear"], ["zoom"], 8, 7, 13, 12, 16, 15]),
          "circle-color": "rgba(6, 17, 30, 0.55)",
          "circle-blur": 0.6,
          // centred on the tag body (the icon is anchored at its pointer foot)
          "circle-translate": [0, -9],
        },
      },
    },
    {
      before: ANCHOR.overlay,
      spec: {
        id: LYR.waterLevelIcons,
        type: "symbol",
        source: SRC.waterLevels,
        layout: {
          visibility: "none",
          "icon-image": e(["concat", IMG.gaugePrefix, ["get", "_c"]]),
          "icon-anchor": "bottom",
          "icon-size": e(["interpolate", ["linear"], ["zoom"], 8, 0.62, 12, 0.85, 16, 1.05]),
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          // most severe gauges draw on top
          "symbol-sort-key": e(["match", ["get", "_c"], "overflow", 5, "high", 4, "normal", 3, "low", 2, "criticalLow", 2, 1]),
        },
        paint: { "icon-opacity": 1 },
      },
    },
    {
      before: ANCHOR.top,
      spec: {
        id: LYR.waterLevelLabels,
        type: "symbol",
        source: SRC.waterLevels,
        minzoom: 11.5,
        filter: e(["!=", ["get", "_t"], ""]),
        layout: {
          visibility: "none",
          "text-field": e(["get", "_t"]),
          "text-font": FONT_REGULAR,
          "text-size": 10.5,
          "text-anchor": "left",
          "text-offset": [0.95, -1.05],
          "text-optional": true,
          "text-padding": 2,
        },
        paint: {
          "text-color": "#d9f4ff",
          "text-halo-color": COLORS.labelHalo,
          "text-halo-width": 1.4,
          "text-opacity": e(["interpolate", ["linear"], ["zoom"], 11.5, 0, 12, 0.95]),
        },
      },
    },

    /* ---------------- labels ---------------- */
    {
      before: ANCHOR.top,
      spec: {
        id: LYR.areaLabels,
        type: "symbol",
        source: SRC.anchors,
        minzoom: 10.6,
        layout: {
          "text-field": e(["get", "nameEn"]),
          "text-font": FONT_REGULAR,
          "text-size": e(["interpolate", ["linear"], ["zoom"], 10.5, 9.5, 14, 12]),
          "text-transform": "uppercase",
          "text-letter-spacing": 0.08,
          "text-max-width": 7,
          "text-padding": 4,
          "text-optional": true,
        },
        paint: {
          "text-color": COLORS.label,
          "text-halo-color": COLORS.labelHalo,
          "text-halo-width": 1.4,
          "text-opacity": e(["interpolate", ["linear"], ["zoom"], 10.6, 0, 11.2, ["case", fs("emph"), 0, 0.92]]),
        },
      },
    },
  ];
  return { sources, layers };
}

/** Layers that share one opacity with the waterways overlay. */
export const WATERWAY_LAYERS = [
  LYR.waterAreas,
  LYR.waterAreasLine,
  LYR.waterLines,
  LYR.waterFlow,
  LYR.drainageAreas,
  LYR.drainageLines,
  LYR.drainageHalo,
  LYR.drainageIcons,
] as const;

const zlin = (z0: number, v0: number, z1: number, v1: number) => e(["interpolate", ["linear"], ["zoom"], z0, v0, z1, v1]);

/**
 * Opacity per layer as a function of the layer-control opacity (0–1). Every value is a constant
 * or a zoom-only expression, so slider drags never trigger a source re-layout.
 */
type PaintName = Parameters<MLMap["setPaintProperty"]>[1];
type PaintValue = Parameters<MLMap["setPaintProperty"]>[2];

const OPACITY: Partial<Record<string, (op: number) => [PaintName, PaintValue][]>> = {
  // Recedes at street level so roads and buildings read through the colour.
  [LYR.areasFill]: (op) => [["fill-opacity", zlin(12, op, 15.5, op * 0.45)]],
  [LYR.rainHeat]: (op) => [["heatmap-opacity", op]],
  [LYR.waterAreas]: (op) => [["fill-opacity", 0.9 * op]],
  [LYR.waterAreasLine]: (op) => [["line-opacity", 0.9 * op]],
  [LYR.waterLines]: (op) => [["line-opacity", zlin(9, 0.7 * op, 12, 0.9 * op)]],
  [LYR.waterFlow]: (op) => [["line-opacity", zlin(10.5, 0, 11.5, 0.75 * op)]],
  [LYR.drainageAreas]: (op) => [["fill-opacity", 0.14 * op]],
  [LYR.drainageLines]: (op) => [["line-opacity", 0.75 * op]],
  [LYR.drainageHalo]: (op) => [["circle-stroke-opacity", zlin(10, 0, 10.6, 0.85 * op)]],
  [LYR.drainageIcons]: (op) => [["icon-opacity", zlin(10, 0, 10.6, op)]],
  [LYR.stations]: (op) => [
    ["circle-opacity", 0.92 * op],
    ["circle-stroke-opacity", 0.92 * op],
  ],
  [LYR.hotspotCore]: (op) => [
    ["circle-opacity", op],
    ["circle-stroke-opacity", 0.8 * op],
  ],
  [LYR.waterLevelIcons]: (op) => [["icon-opacity", op]],
  [LYR.waterLevelHalo]: (op) => [["circle-opacity", op]],
  [LYR.waterLevelLabels]: (op) => [["text-opacity", zlin(11.5, 0, 12, 0.95 * op)]],
};

/** Every layer of the water-level overlay (shares one visibility / opacity). */
export const WATER_LEVEL_LAYERS = [LYR.waterLevelHalo, LYR.waterLevelIcons, LYR.waterLevelLabels] as const;
/** Community layers (share one visibility; opacity also carries the selected-zone emphasis). */
export const COMMUNITY_LAYERS = [LYR.communitiesLine, LYR.communitiesIllustrative, LYR.communitiesVerified] as const;

/** Paint values for a layer at a given layer-control opacity (empty when the layer has no setter). */
export function opacityPaint(layerId: string, op: number): [PaintName, PaintValue][] {
  const f = OPACITY[layerId];
  return f ? f(Math.max(0, Math.min(1, op))) : [];
}

export function applyLayerOpacity(map: MLMap, layerId: string, op: number) {
  if (!map.getLayer(layerId)) return;
  for (const [prop, value] of opacityPaint(layerId, op)) map.setPaintProperty(layerId, prop, value);
}

export function setLayerVisible(map: MLMap, layerId: string, visible: boolean) {
  if (!map.getLayer(layerId)) return;
  const v = visible ? "visible" : "none";
  if (map.getLayoutProperty(layerId, "visibility") !== v) map.setLayoutProperty(layerId, "visibility", v);
}

/** Per-instance image state (the flow pattern is animated by the map animation hook). */
export interface OverlayImages {
  flow: FlowPattern;
}

function addImages(map: MLMap): OverlayImages {
  const flow = new FlowPattern();
  const add = (id: string, img: ImageData | FlowPattern) => {
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, img, { pixelRatio: IMAGE_PIXEL_RATIO });
  };
  add(IMG.hatch, drawHatch());
  add(IMG.flow, flow);
  (Object.keys(DRAIN_ICON_IDS) as (keyof typeof DRAIN_ICON_IDS)[]).forEach((k) => add(DRAIN_ICON_IDS[k], drawDrainageGlyph(k)));
  add(IMG.pumpOfficial, drawOfficialPumpGlyph());
  add(IMG.communityVerified, drawCommunityGlyph("verified"));
  add(IMG.communityIllustrative, drawCommunityGlyph("illustrative"));
  for (const c of GAUGE_CLASSES) add(gaugeIconId(c.id), drawGaugeGlyph(c.color, c.id === "unknown"));
  return { flow };
}

/** Installs (or re-installs after a style swap) every overlay source, image and layer. */
export function installDataOverlay(map: MLMap): OverlayImages {
  const images = addImages(map);
  const { sources, layers } = dataOverlaySpec();
  for (const [id, src] of Object.entries(sources)) if (!map.getSource(id)) map.addSource(id, src);
  for (const { before, spec } of layers) {
    if (map.getLayer(spec.id)) continue;
    map.addLayer(spec, map.getLayer(before) ? before : undefined);
  }
  return images;
}
