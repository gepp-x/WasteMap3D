/**
 * Stable source / layer / image ids shared by the style builders, the data-layer installer,
 * the React sync components and the legend. Everything prefixed `ui-` belongs to the data
 * overlay and is re-installed after every basemap swap (online ⇄ offline).
 */

/** OpenFreeMap vector source id inside the online basemap style. */
export const BASEMAP_SOURCE = "omt";
/** Graticule (fine technical grid) source, present in both basemap styles. */
export const GRID_SOURCE = "grid";

/**
 * Insertion anchors. Both basemap styles contain these as invisible background layers so the
 * data overlay lands at the same z-order regardless of which basemap is active.
 */
export const ANCHOR = {
  /** Above land/water/landuse, below buildings and roads — choropleth fills, heatmap. */
  fill: "anchor-data-fill",
  /** Above roads/rail/boundaries, below basemap labels — lines, outlines, points. */
  overlay: "anchor-data-overlay",
  /** Above everything — data labels. */
  top: "anchor-data-top",
} as const;
export type AnchorId = (typeof ANCHOR)[keyof typeof ANCHOR];

export const SRC = {
  areas: "ui-areas",
  anchors: "ui-area-anchors",
  hotspots: "ui-hotspots",
  waterways: "ui-waterways",
  drainage: "ui-drainage",
  stations: "ui-stations",
  rainGrid: "ui-rain-grid",
  municipality: "ui-municipality",
  communities: "ui-communities",
  waterLevels: "ui-water-levels",
} as const;

export const LYR = {
  // fills
  areasFill: "ui-areas-fill",
  areasNoData: "ui-areas-nodata",
  areasDim: "ui-areas-dim",
  areasHoverFill: "ui-areas-hover-fill",
  rainHeat: "ui-rain-heat",
  areasHit: "ui-areas-hit",
  // water & drainage
  waterAreas: "ui-water-areas",
  waterAreasLine: "ui-water-areas-line",
  waterLines: "ui-water-lines",
  waterFlow: "ui-water-flow",
  drainageAreas: "ui-drainage-areas",
  drainageLines: "ui-drainage-lines",
  drainageHalo: "ui-drainage-halo",
  drainageIcons: "ui-drainage-icons",
  // outlines
  areasShadow: "ui-areas-hover-shadow",
  areasOutline: "ui-areas-outline",
  areasOutlineApprox: "ui-areas-outline-approx",
  municipalityGlow: "ui-municipality-glow",
  municipalityLine: "ui-municipality-line",
  communitiesLine: "ui-communities-line",
  /** Community points matched to an authoritative / OSM feature (solid). */
  communitiesVerified: "ui-communities-verified",
  /** Deterministic demonstration placements inside the community's zone (dashed ring) — never real locations. */
  communitiesIllustrative: "ui-communities-illustrative",
  selectedGlow: "ui-areas-selected-glow",
  selectedLine: "ui-areas-selected-line",
  // points
  stations: "ui-stations",
  hotspotRing: "ui-hotspot-ring",
  hotspotCore: "ui-hotspot-core",
  waterLevelHalo: "ui-water-level-halo",
  waterLevelIcons: "ui-water-level-icons",
  waterLevelLabels: "ui-water-level-labels",
  // labels
  areaLabels: "ui-area-labels",
} as const;

export const IMG = {
  hatch: "ui-hatch",
  flow: "ui-flow",
  pump: "ui-ico-pump",
  gate: "ui-ico-gate",
  monitoring: "ui-ico-monitoring",
  retention: "ui-ico-retention",
  other: "ui-ico-other",
  /** Pump station from the official BMA DDS register (double ring) — distinct from OSM-mapped pumps. */
  pumpOfficial: "ui-ico-pump-official",
  communityVerified: "ui-ico-community-verified",
  communityIllustrative: "ui-ico-community-illustrative",
  /** Water-level gauge glyphs, one per situation class (see water-levels.ts). */
  gaugePrefix: "ui-ico-gauge-",
} as const;

/** Basemap layers that toggle between flat and extruded buildings when the camera is tilted. */
export const BASEMAP_BUILDINGS_FLAT = "building";
export const BASEMAP_BUILDINGS_3D = "building-3d";
