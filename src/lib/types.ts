/**
 * Shared data contract for Urban Intelligence.
 *
 * Every number shown in the UI must travel inside a `MetricValue` so its
 * provenance (observed / derived / estimated / simulated / unavailable) is
 * carried with the value rather than bolted on in the view layer.
 *
 * Raw observations are immutable. Scenario outputs are computed separately
 * (see src/lib/simulation) and never written back into these structures.
 */

export type DataStatus =
  | "observed" // directly sourced from a public dataset
  | "derived" // calculated from sourced values
  | "estimated" // based on stated assumptions or modelled reanalysis
  | "simulated" // generated deterministically for demo behaviour
  | "unavailable"; // no defensible value — render as "ยังไม่มีข้อมูล", never 0

export interface DataProvenance {
  status: DataStatus;
  /** Key into the source registry (public/data/sources.json). */
  sourceId?: string;
  sourceName?: string;
  sourceUrl?: string;
  /** ISO dates (YYYY-MM-DD) bounding the observation period. */
  observedFrom?: string;
  observedTo?: string;
  /** Gregorian reference year (BE − 543). */
  referenceYear?: number;
  geographicScope?: string;
  methodology?: string;
  limitations?: string[];
}

export interface MetricValue {
  value: number | null;
  unit: string;
  provenance: DataProvenance;
}

export type CityId = "bangkok" | "hatyai";

export type AreaKind = "district" | "community-zone" | "municipality";

/** How trustworthy an area's polygon is. */
export type GeometryStatus =
  | "official" // from an official government GIS source
  | "osm" // OpenStreetMap administrative boundary (ODbL)
  | "approximate"; // illustrative demo partition — must be labelled in UI

export interface City {
  id: CityId;
  nameTh: string;
  nameEn: string;
  /** [lon, lat] */
  center: [number, number];
  zoom: number;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  areaKindTh: string;
  areaKindEn: string;
  /** Short description of the dataset period shown in the header. */
  periodLabelTh: string;
  periodLabelEn: string;
}

export interface AreaMetrics {
  population: MetricValue; // persons
  areaKm2: MetricValue; // km²
  populationDensity: MetricValue; // persons/km² (derived)
  wasteGenerated: MetricValue; // t/day
  wasteCollected: MetricValue; // t/day
  wasteAccumulated: MetricValue; // t (simulated stock, illustrative)
  wastePerCapita: MetricValue; // kg/person/day (derived)
  wasteDensity: MetricValue; // t/day/km² (derived)
  rainfallAnnual: MetricValue; // mm/year (station or reanalysis)
  rainfall24h: MetricValue; // mm (latest/selected day)
  drainageStress: MetricValue; // % modelled, 0–100
  floodExposure: MetricValue; // index 0–1 (E in the risk model)
  obstructionSusceptibility: MetricValue; // index 0–1 (W in the risk model)
  modeledFloodRisk: MetricValue; // score 0–100 (baseline scenario)
}

export type WasteCategory =
  | "organic"
  | "plastic"
  | "paper"
  | "glassMetal"
  | "hazardous"
  | "other";

export interface WasteComposition {
  /** Percent shares; must sum to 100 (±0.05 rounding). */
  shares: Record<WasteCategory, number>;
  provenance: DataProvenance;
}

export interface YearValue {
  year: number; // Gregorian
  value: number | null;
  unit: string;
  status: DataStatus;
}

export interface AreaRecord {
  id: string; // "bkk-1001", "hy-z1"
  /** Numeric id used for MapLibre feature-state (promoteId: "fid"). */
  fid: number;
  cityId: CityId;
  code?: string; // official code (e.g. DOPA district code)
  nameTh: string;
  nameEn: string;
  kind: AreaKind;
  /** [lon, lat] point-on-surface used for labels, 3D focus and building windows. */
  anchor: [number, number];
  geometryStatus: GeometryStatus;
  metrics: AreaMetrics;
  composition?: WasteComposition;
  /** History of the area's primary waste measure (Bangkok: collected; Hat Yai: collected). */
  wasteHistory: YearValue[];
  /** History of waste GENERATED, when a separate generation series exists (never mixed with wasteHistory). */
  wasteGeneratedHistory?: YearValue[];
  /** Free-text notes shown in the Data tab (Thai/English). */
  notesTh?: string[];
  notesEn?: string[];
}

export interface SourceRef {
  id: string;
  nameTh?: string;
  nameEn: string;
  url: string;
  publisher: string;
  license?: string;
  retrievedAt?: string; // ISO datetime
  accessStatus: "retrieved" | "partial" | "failed" | "manual-reference";
  notes?: string;
}

export interface CityDataset {
  city: City;
  areas: AreaRecord[];
  /** Citywide totals; values are sums/derivations of area values or sourced city totals. */
  totals: AreaMetrics;
  composition: WasteComposition;
  /** City history of the primary (collected) waste measure. */
  wasteHistory: YearValue[];
  /** City history of waste GENERATED (e.g. PCD for Bangkok), kept separate from wasteHistory. */
  wasteGeneratedHistory?: YearValue[];
  generatedAt: string;
  limitations: string[];
}

/** Daily rainfall time series (mm/day). */
export interface RainSeries {
  cityId: CityId;
  kind: "station" | "reanalysis-grid" | "area";
  dates: string[]; // ISO dates
  series: { id: string; nameEn: string; nameTh?: string; lon: number; lat: number; values: (number | null)[] }[];
  provenance: DataProvenance;
}

export interface RainStation {
  id: string;
  nameTh?: string;
  nameEn: string;
  lon: number;
  lat: number;
  agency: string;
  rain24h: MetricValue;
  /** Optional latest reading timestamp (ISO). */
  observedAt?: string;
}

export interface FloodEvent {
  id: string;
  cityId: CityId;
  titleTh: string;
  titleEn: string;
  from: string;
  to: string;
  summaryTh: string;
  summaryEn: string;
  peakRainMm?: MetricValue;
  sourceId: string;
}

/** Building window for the 3D neighbourhood view. Coordinates are local metres (ENU) relative to `origin`. */
export interface BuildingWindow {
  areaId: string;
  origin: [number, number]; // [lon, lat]
  halfSizeM: number;
  retrievedAt: string;
  sourceId: string;
  buildings: {
    id: number;
    /** height in metres */
    h: number;
    /** height source: tagged height / building:levels × 3.2 m / deterministic estimate */
    hs: "height" | "levels" | "estimated";
    /** outer ring, local metres [x(east), y(north)], not closed */
    fp: [number, number][];
  }[];
  roads: { t: string; pts: [number, number][] }[];
  water: { t: string; kind: "line" | "area"; pts: [number, number][] }[];
}

/** Water-level gauge snapshot (observed at retrieval time; not live). */
export interface WaterLevelStation {
  id: string;
  nameTh?: string;
  nameEn: string;
  lon: number;
  lat: number;
  agency: string;
  /** Waterway the gauge sits on, as published. */
  waterway?: string;
  /** Water level in metres above mean sea level (m MSL), status observed. */
  waterLevel: MetricValue;
  /** Bank / critical level in m MSL when published. */
  bankLevel?: MetricValue;
  /** Share of bank capacity used (%), derived when both levels exist. */
  capacityPct?: MetricValue;
  /** Agency situation text (e.g. normal / watch / critical) as published. */
  situation?: string;
  observedAt?: string;
}

/** Hourly rainfall for a documented event (reanalysis, status estimated). */
export interface HourlyRainEvent {
  id: string;
  cityId: CityId;
  titleTh: string;
  titleEn: string;
  lon: number;
  lat: number;
  /** ISO datetimes (local, +07:00), one per hour; value = rain in the preceding hour (mm). */
  times: string[];
  values: (number | null)[];
  provenance: DataProvenance;
}

/**
 * Community feature properties in public/data/hatyai/communities.geojson.
 * locationStatus "verified" = matched to an authoritative / OSM feature; "illustrative" = deterministic
 * demonstration placement inside its zone (never presented as a real location).
 */
export interface CommunityProps {
  id: string;
  nameTh: string;
  nameEn?: string | null;
  zoneId: string;
  zoneNo: number;
  locationStatus: "verified" | "illustrative";
  method: string;
  households?: number | null;
  population?: number | null;
  sourceId?: string;
}
