/**
 * Runtime (zod) schemas mirroring the shared data contract in src/lib/types.ts.
 *
 * Used by scripts/data/validate-data.ts and reusable by the app. The schemas add the integrity
 * rules the TypeScript types cannot express:
 *  - a MetricValue / YearValue with `value: null` must carry status "unavailable", and a value
 *    with status "unavailable" must be null (missing data is never rendered as 0);
 *  - composition shares sum to 100 (±0.05);
 *  - RainSeries value arrays have the same length as `dates`.
 *
 * One deliberate widening versus types.ts: `WasteComposition.shares` may hold `null` for every
 * category when `provenance.status === "unavailable"` (e.g. Hat Yai, where no sourced composition
 * table exists). Consumers already treat non-numeric shares as missing.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ primitives */

export const DATA_STATUSES = ["observed", "derived", "estimated", "simulated", "unavailable"] as const;
export const DataStatusSchema = z.enum(DATA_STATUSES);

/** ISO date (YYYY-MM-DD), optionally followed by a time part. */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "ISO date expected");
/** ISO date-time. */
export const IsoDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/, "ISO date-time expected");

const LonLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export const DataProvenanceSchema = z.object({
  status: DataStatusSchema,
  sourceId: z.string().min(1).optional(),
  sourceName: z.string().optional(),
  sourceUrl: z.string().optional(),
  observedFrom: IsoDateSchema.optional(),
  observedTo: IsoDateSchema.optional(),
  referenceYear: z.number().int().min(1900).max(2100).optional(),
  geographicScope: z.string().optional(),
  methodology: z.string().optional(),
  limitations: z.array(z.string()).optional(),
});

export const MetricValueSchema = z
  .object({
    value: z.number().nullable(),
    unit: z.string().min(1),
    provenance: DataProvenanceSchema,
  })
  .superRefine((m, ctx) => {
    if (m.value === null && m.provenance.status !== "unavailable") {
      ctx.addIssue({ code: "custom", message: `null value must have status "unavailable" (got "${m.provenance.status}")` });
    }
    if (m.value !== null && m.provenance.status === "unavailable") {
      ctx.addIssue({ code: "custom", message: `status "unavailable" must carry a null value (got ${m.value})` });
    }
    if (m.value !== null && !Number.isFinite(m.value)) {
      ctx.addIssue({ code: "custom", message: "value must be finite" });
    }
  });

export const CityIdSchema = z.enum(["bangkok", "hatyai"]);
export const AreaKindSchema = z.enum(["district", "community-zone", "municipality"]);
export const GeometryStatusSchema = z.enum(["official", "osm", "approximate"]);

export const CitySchema = z.object({
  id: CityIdSchema,
  nameTh: z.string().min(1),
  nameEn: z.string().min(1),
  center: LonLatSchema,
  zoom: z.number(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  areaKindTh: z.string().min(1),
  areaKindEn: z.string().min(1),
  periodLabelTh: z.string().min(1),
  periodLabelEn: z.string().min(1),
});

export const METRIC_KEYS = [
  "population",
  "areaKm2",
  "populationDensity",
  "wasteGenerated",
  "wasteCollected",
  "wasteAccumulated",
  "wastePerCapita",
  "wasteDensity",
  "rainfallAnnual",
  "rainfall24h",
  "drainageStress",
  "floodExposure",
  "obstructionSusceptibility",
  "modeledFloodRisk",
] as const;

export const AreaMetricsSchema = z.object({
  population: MetricValueSchema,
  areaKm2: MetricValueSchema,
  populationDensity: MetricValueSchema,
  wasteGenerated: MetricValueSchema,
  wasteCollected: MetricValueSchema,
  wasteAccumulated: MetricValueSchema,
  wastePerCapita: MetricValueSchema,
  wasteDensity: MetricValueSchema,
  rainfallAnnual: MetricValueSchema,
  rainfall24h: MetricValueSchema,
  drainageStress: MetricValueSchema,
  floodExposure: MetricValueSchema,
  obstructionSusceptibility: MetricValueSchema,
  modeledFloodRisk: MetricValueSchema,
});

export const WASTE_CATEGORIES = ["organic", "plastic", "paper", "glassMetal", "hazardous", "other"] as const;
export const WasteCategorySchema = z.enum(WASTE_CATEGORIES);

const shareSchema = z.number().min(0).max(100).nullable();

export const WasteCompositionSchema = z
  .object({
    shares: z.object({
      organic: shareSchema,
      plastic: shareSchema,
      paper: shareSchema,
      glassMetal: shareSchema,
      hazardous: shareSchema,
      other: shareSchema,
    }),
    provenance: DataProvenanceSchema,
  })
  .superRefine((c, ctx) => {
    const vals = WASTE_CATEGORIES.map((k) => c.shares[k]);
    if (c.provenance.status === "unavailable") {
      if (vals.some((v) => v !== null)) ctx.addIssue({ code: "custom", message: 'composition with status "unavailable" must have null shares' });
      return;
    }
    if (vals.some((v) => v === null)) {
      ctx.addIssue({ code: "custom", message: "composition shares must all be numbers unless status is unavailable" });
      return;
    }
    const sum = (vals as number[]).reduce((s, v) => s + v, 0);
    if (Math.abs(sum - 100) > 0.05 + 1e-9) ctx.addIssue({ code: "custom", message: `composition shares sum to ${sum.toFixed(3)}, expected 100 ±0.05` });
  });

export const YearValueSchema = z
  .object({
    year: z.number().int().min(1900).max(2100),
    value: z.number().nullable(),
    unit: z.string().min(1),
    status: DataStatusSchema,
  })
  .superRefine((y, ctx) => {
    if (y.value === null && y.status !== "unavailable") ctx.addIssue({ code: "custom", message: `year ${y.year}: null value must have status "unavailable"` });
    if (y.value !== null && y.status === "unavailable") ctx.addIssue({ code: "custom", message: `year ${y.year}: status "unavailable" must carry a null value` });
  });

export const AreaRecordSchema = z.object({
  id: z.string().min(1),
  fid: z.number().int().positive(),
  cityId: CityIdSchema,
  code: z.string().optional(),
  nameTh: z.string().min(1),
  nameEn: z.string().min(1),
  kind: AreaKindSchema,
  anchor: LonLatSchema,
  geometryStatus: GeometryStatusSchema,
  metrics: AreaMetricsSchema,
  composition: WasteCompositionSchema.optional(),
  wasteHistory: z.array(YearValueSchema),
  wasteGeneratedHistory: z.array(YearValueSchema).optional(),
  notesTh: z.array(z.string()).optional(),
  notesEn: z.array(z.string()).optional(),
});

export const SourceRefSchema = z.object({
  id: z.string().min(1),
  nameTh: z.string().optional(),
  nameEn: z.string().min(1),
  url: z.string().min(1),
  publisher: z.string().min(1),
  license: z.string().optional(),
  retrievedAt: IsoDateTimeSchema.optional(),
  accessStatus: z.enum(["retrieved", "partial", "failed", "manual-reference"]),
  notes: z.string().optional(),
});

export const CityDatasetSchema = z.object({
  city: CitySchema,
  areas: z.array(AreaRecordSchema).min(1),
  totals: AreaMetricsSchema,
  composition: WasteCompositionSchema,
  wasteHistory: z.array(YearValueSchema),
  wasteGeneratedHistory: z.array(YearValueSchema).optional(),
  generatedAt: IsoDateTimeSchema,
  limitations: z.array(z.string()),
});

export const RainSeriesSchema = z
  .object({
    cityId: CityIdSchema,
    kind: z.enum(["station", "reanalysis-grid", "area"]),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
    series: z
      .array(
        z.object({
          id: z.string().min(1),
          nameEn: z.string().min(1),
          nameTh: z.string().optional(),
          lon: z.number().min(-180).max(180),
          lat: z.number().min(-90).max(90),
          values: z.array(z.number().nullable()),
        }),
      )
      .min(1),
    provenance: DataProvenanceSchema,
  })
  .superRefine((r, ctx) => {
    for (const s of r.series) {
      if (s.values.length !== r.dates.length) ctx.addIssue({ code: "custom", message: `series ${s.id}: ${s.values.length} values for ${r.dates.length} dates` });
    }
    for (let i = 1; i < r.dates.length; i++) {
      if (r.dates[i] <= r.dates[i - 1]) {
        ctx.addIssue({ code: "custom", message: `dates not strictly increasing at index ${i} (${r.dates[i - 1]} → ${r.dates[i]})` });
        break;
      }
    }
  });

export const RainStationSchema = z.object({
  id: z.string().min(1),
  nameTh: z.string().optional(),
  nameEn: z.string().min(1),
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  agency: z.string().min(1),
  rain24h: MetricValueSchema,
  observedAt: z.string().optional(),
});

export const FloodEventSchema = z.object({
  id: z.string().min(1),
  cityId: CityIdSchema,
  titleTh: z.string().min(1),
  titleEn: z.string().min(1),
  from: IsoDateSchema,
  to: IsoDateSchema,
  summaryTh: z.string().min(1),
  summaryEn: z.string().min(1),
  peakRainMm: MetricValueSchema.optional(),
  sourceId: z.string().min(1),
});

/** Water-level gauge snapshot (public/data/<city>/water-levels.json). */
export const WaterLevelStationSchema = z
  .object({
    id: z.string().min(1),
    nameTh: z.string().optional(),
    nameEn: z.string().min(1),
    lon: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
    agency: z.string().min(1),
    waterway: z.string().optional(),
    waterLevel: MetricValueSchema,
    bankLevel: MetricValueSchema.optional(),
    capacityPct: MetricValueSchema.optional(),
    situation: z.string().optional(),
    observedAt: IsoDateTimeSchema.optional(),
  })
  .superRefine((s, ctx) => {
    if (s.waterLevel.unit !== "m MSL") ctx.addIssue({ code: "custom", message: `waterLevel unit must be "m MSL" (got "${s.waterLevel.unit}")` });
    if (s.bankLevel && s.bankLevel.unit !== "m MSL") ctx.addIssue({ code: "custom", message: `bankLevel unit must be "m MSL" (got "${s.bankLevel.unit}")` });
    if (s.capacityPct && s.capacityPct.value !== null && s.capacityPct.provenance.status !== "derived")
      ctx.addIssue({ code: "custom", message: `capacityPct must be "derived" (got "${s.capacityPct.provenance.status}")` });
  });

/** Hourly rainfall for a documented event (public/data/<city>/rain-hourly.json). */
export const HourlyRainEventSchema = z
  .object({
    id: z.string().min(1),
    cityId: CityIdSchema,
    titleTh: z.string().min(1),
    titleEn: z.string().min(1),
    lon: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
    times: z.array(IsoDateTimeSchema).min(1),
    values: z.array(z.number().min(0).nullable()),
    provenance: DataProvenanceSchema,
  })
  .superRefine((e, ctx) => {
    if (e.values.length !== e.times.length) ctx.addIssue({ code: "custom", message: `${e.values.length} values for ${e.times.length} times` });
    for (let i = 1; i < e.times.length; i++) {
      const dt = Date.parse(e.times[i]) - Date.parse(e.times[i - 1]);
      if (dt !== 3_600_000) {
        ctx.addIssue({ code: "custom", message: `times are not consecutive hours at index ${i} (${e.times[i - 1]} → ${e.times[i]})` });
        break;
      }
    }
    if (e.provenance.status === "observed") ctx.addIssue({ code: "custom", message: "reanalysis hourly rain must not be labelled observed" });
  });

/** Properties of public/data/hatyai/communities.geojson features (CommunityProps in types.ts). */
export const CommunityPropsSchema = z.object({
  id: z.string().min(1),
  nameTh: z.string().min(1),
  nameEn: z.string().nullable().optional(),
  zoneId: z.string().min(1),
  zoneNo: z.number().int().positive(),
  locationStatus: z.enum(["verified", "illustrative"]),
  method: z.string().min(1),
  households: z.number().int().nonnegative().nullable().optional(),
  population: z.number().int().nonnegative().nullable().optional(),
  sourceId: z.string().min(1).optional(),
});

export const CommunityFeatureCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z
    .array(
      z.object({
        type: z.literal("Feature"),
        properties: CommunityPropsSchema.loose(),
        geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]) }),
      }),
    )
    .min(1),
});

const LocalPointSchema = z.tuple([z.number(), z.number()]);

export const BuildingWindowSchema = z.object({
  areaId: z.string().min(1),
  origin: LonLatSchema,
  halfSizeM: z.number().positive(),
  retrievedAt: z.string().min(1),
  sourceId: z.string().min(1),
  buildings: z.array(
    z.object({
      id: z.number(),
      h: z.number().positive(),
      hs: z.enum(["height", "levels", "estimated"]),
      fp: z.array(LocalPointSchema).min(3),
    }),
  ),
  roads: z.array(z.object({ t: z.string(), pts: z.array(LocalPointSchema).min(2) })),
  water: z.array(z.object({ t: z.string(), kind: z.enum(["line", "area"]), pts: z.array(LocalPointSchema).min(2) })),
});

/* ------------------------------------------------------------------ GeoJSON outputs */

const PositionSchema = z.array(z.number()).min(2);
const RingSchema = z.array(PositionSchema).min(4);
export const PolygonalGeometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Polygon"), coordinates: z.array(RingSchema).min(1) }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(RingSchema).min(1)).min(1) }),
]);

/** Properties of public/data/<city>/areas.geojson features (numeric fid for MapLibre feature-state). */
export const AreaFeaturePropsSchema = z.object({
  fid: z.number().int().positive(),
  id: z.string().min(1),
  nameTh: z.string().min(1),
  nameEn: z.string().min(1),
  geometryStatus: GeometryStatusSchema,
});

export const AreaFeatureCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z
    .array(
      z.object({
        type: z.literal("Feature"),
        properties: AreaFeaturePropsSchema,
        geometry: PolygonalGeometrySchema,
      }),
    )
    .min(1),
});

export const GenericFeatureCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(
    z.object({
      type: z.literal("Feature"),
      properties: z.record(z.string(), z.unknown()).nullable(),
      geometry: z.object({ type: z.string(), coordinates: z.unknown() }).nullable(),
    }),
  ),
});

export const ManifestSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  files: z.array(z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});

export type CityDatasetParsed = z.infer<typeof CityDatasetSchema>;
