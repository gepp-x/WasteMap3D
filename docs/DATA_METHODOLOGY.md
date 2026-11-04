# Data methodology

How the published datasets in `public/data/` are derived from the staged research outputs, which values
are observed versus derived, estimated or simulated, and what the known gaps are. Sources are listed
in `docs/DATA_SOURCES.md`; the risk/accumulation model is documented in `docs/SIMULATION_MODEL.md`.

## 1. Pipeline

```
scripts/data/fetch-bangkok.ts                     ─┐
scripts/data/fetch-hatyai.ts                       │  raw downloads  → data/raw/<source>/   (+ .meta.json)
scripts/data/fetch-hatyai-community-locations.ts   │  staged values   → data/staged/*.json, *-notes.md
scripts/data/fetch-waste-gaps.ts                   ├─ public layers   → public/data/<city>/{districts|zones|municipality|communities,
scripts/data/fetch-rainfall.ts                     │                     waterways,drainage,stations,rain-grid,water-levels,
scripts/data/fetch-osm-infra.ts                    │                     rain-hourly}.*, public/data/buildings/
scripts/data/fetch-hydrology.ts                    │
scripts/data/fetch-buildings.ts                   ─┘  (npm run data:fetch [-- --offline], in this order)
scripts/data/build-datasets.ts     → public/data/<city>/{areas.json, areas.geojson, rain-areas.json, flood-events.json},
                                     public/data/sources.json, public/data/manifest.json,
                                     data/staged/osm-waterway-density.json, data/staged/build-datasets-report.json
                                       (npm run data:build)
scripts/data/validate-data.ts      → exit 1 on any integrity error   (npm run data:validate)
```

The build is **deterministic**: no network, no randomness, no wall-clock values. `generatedAt` in
`areas.json` and `manifest.json` is the newest input snapshot time (the latest `retrievedAt` among the
merged sources and the building windows present), or `SOURCE_DATE_EPOCH` when set. Two consecutive runs
on unchanged inputs write nothing (`outputs unchanged`). Because building windows are fetched by a
separate, slower process, re-run `npx tsx scripts/data/build-datasets.ts && npx tsx scripts/data/validate-data.ts`
after `fetch-buildings.ts` finishes: anchors, rainfall IDW points, spatial factors and the manifest then update.

**Order dependencies.** `fetch-hatyai-community-locations.ts` reads the community list and zones written by
`fetch-hatyai.ts` and is the only writer of `hatyai/communities.geojson` (`fetch-hatyai.ts` now stages its first-round
OSM name matches in `data/staged/hatyai-community-osm-candidates.geojson`). `fetch-waste-gaps.ts` reads the BMA tables
staged by `fetch-bangkok.ts`. `fetch-hydrology.ts` merges the official BMA drainage inventory into the OSM layer
written by `fetch-osm-infra.ts` (re-running `fetch-osm-infra.ts` alone resets `drainage.geojson` to OSM only; re-run
`fetch-hydrology.ts --sections=drainage` afterwards) and converts the hourly event rain staged by `fetch-rainfall.ts`.
`scripts/fetch-public-data.ts` runs them in a valid order.

## 2. Conventions

- **Calendar:** Gregorian year = Buddhist Era year − 543. A Thai fiscal year runs 1 Oct – 30 Sep; it is
  labelled with the Gregorian year in which it ends (FY BE 2569 = 2025-10-01 … 2026-09-30 → `referenceYear` 2026).
  `observedFrom`/`observedTo` always give the exact period.
- **Units:** persons; km²; persons/km²; t/day; kg/person/day; t/day/km²; t (stock); mm/year; mm; % ; index 0–1; score 0–100.
- **Rounding (published):** population integer; area 0.001 km²; population density 0.1; waste 0.01 t/day; per-capita 0.001;
  waste density 0.001; rainfall 0.1 mm; E and W 0.001; model outputs as returned by the model (0.1).
  Derived values are computed from the *published (rounded) components* so that anyone can recompute them exactly.
- **Status taxonomy** (`DataProvenance.status`):
  | status | meaning here |
  |---|---|
  | `observed` | value as published by the source (a pure unit conversion such as t/year → t/day keeps `observed`; the conversion is written in `methodology`) |
  | `derived` | arithmetic on sourced values only (sums, ratios, geometric areas, category aggregation) |
  | `estimated` | relies on stated assumptions or modelled data (allocations, proxy indices, reanalysis rainfall, anything derived from an estimate) |
  | `simulated` | output of the illustrative model (`src/lib/simulation/model.ts`) |
  | `unavailable` | no defensible value — `value: null`, rendered as “ยังไม่มีข้อมูล”, **never 0** |
- A `null` value always has status `unavailable`, and `unavailable` always has a `null` value (enforced by the zod schemas).
- Collected, generated, utilised and disposed waste are different quantities and are never mixed in one metric or series.

## 3. Areas, geometry and anchors

| City | Areas | Geometry | `geometryStatus` |
|---|---|---|---|
| Bangkok | 50 districts (เขต), ids `bkk-<DOPA code>` (1001–1050) | BMA GIS official polygons (simplified with mapshaper 20 % weighted, 5 decimals; median error 0.4 m) | `official` |
| Hat Yai | 4 community zones (เขต 1–4), ids `hy-z1`…`hy-z4` | Approximate demonstration partition of the OSM municipality polygon along the railway, ถนนเพชรเกษม, ถนนศรีภูวนารถ and ถนนกาญจนวณิชย์ (method in `zones.geojson`) | `approximate` |

- `fid` = 1-based index in id order (Bangkok sorted by code), used for MapLibre feature-state.
- `areas.geojson` copies the polygons unchanged and carries `{ fid, id, nameTh, nameEn, geometryStatus }`.
- `areaKm2` = geodesic `turf.area` of the published polygon (status `derived`). Bangkok's polygons sum to
  1,589.213 km² vs the official 1,568.737 km² (+1.3 %); some districts differ from BMA's area table
  (stated in each district's notes). Hat Yai zones tile the OSM municipality polygon (20.883 km²; official 21 km²).
- **Anchor** (label point, 3D focus, rainfall IDW point). Candidates are tried in order and the first one
  that lies *strictly inside* the polygon is used; the choice is written to `notesEn/notesTh` and
  `data/staged/build-datasets-report.json`:
  1. `data/staged/<city>-anchors.json` (building-window origin chosen by `fetch-buildings.ts`, e.g. the OSM district office);
  2. `origin` of `public/data/buildings/<areaId>.json`;
  3. the interior label point stored with the polygon (`zones.geojson` `anchor`, Hat Yai);
  4. a computed interior label point: the centroid if inside and ≥ 150 m from the edge, otherwise the
     point of a 60 × 60 lattice over the bbox farthest from the edge.
  `turf.pointOnFeature` is not used directly because it returns a boundary vertex for concave polygons
  (this happened for Hat Yai zone 1, whose building-window origin is such a vertex; the 3D window keeps
  its own origin and the validator reports it as a warning).

## 4. Population

- **Bangkok districts:** DOPA registered population at **31 Dec 2025** (BE 2568) from the NSO table
  OS_0405_01_0005_01; all 50 districts and the total equal the DOPA `stat_a68` file. Status `observed`.
  City total 5,422,568 = published total = sum of districts.
- **Hat Yai municipality (city total):** DOPA registration office 9098 at 31 Dec 2025: **138,582** (`observed`).
- **Hat Yai zones:** sums of the per-community populations printed in the 2022–2023 community-boundary
  announcements (`derived`; zone 1: 27/28 communities, zone 3: 24/25; reference date not stated by the source).
  Zones total 138,046, which differs from DOPA (different source, date and definition) — the city total uses DOPA.
- Registered (de jure) population excludes unregistered residents, migrant workers, students and commuters.

## 5. Waste quantities

### Bangkok (collected)
- District value = annual collected tonnage of the district office in FY BE 2569 ÷ the number of days stated in
  the BMA table header (365) → t/day; this reproduces the publisher's own average column (`observed`).
- City total = the published city total **9,491.78 t/day** (3,464,498.49 t), which includes an **'Others' row
  (215.09 t/day)** delivered by sources other than the 50 district offices. The districts therefore sum to
  less (**9,276.68 t/day**); this is stated in the totals' limitations and the dataset limitations.
- `wasteHistory` per district: FY BE 2562–2569 from the annual PDFs, plus legacy BE 2553–2561 from data.go.th
  (`garbage1`; annual t ÷ 365; whether those are fiscal or calendar years is not stated). Unusable legacy cells
  (misaligned BE 2554/2555 columns, 5 outliers) are `null`/`unavailable`. City history: published fiscal-year
  averages FY BE 2554–2569 (2011–2026).
- **Waste generated (separate measure).** The Pollution Control Department publishes a Bangkok total of waste
  *generated* (thaimsw.pcd.go.th, province table): **13,254 t/day for PCD year BE 2568 (2025)**, `observed`, copied as
  published. PCD does not say whether its year is calendar or fiscal, so `observedFrom/To` are left unset and only
  `referenceYear` (2025) is given. PCD's generated equals utilised + correctly disposed (an accounting identity in its
  table), not an independent measurement at source. Two PCD disposal-site reports (BE 2564: 12,214; BE 2566: 12,748
  t/day) match the web system exactly. City `wasteGeneratedHistory` = PCD BE 2556–2568 (2013–2025, `observed`); BE 2569
  shows an all-zero row (not yet reported) and is `unavailable`, never 0.
- **District generated (estimated allocation).** For PCD year BE Y:
  `generated_d = G_PCD(Y) × C_d(FY Y) ÷ Σ_{50 districts} C(FY Y)`, where C is the BMA annual collected tonnage of the
  district office in the BMA fiscal year with the same BE number (a 9-of-12-month overlap if PCD's year is a calendar
  year). The BMA 'Others' row (FY2568: 136,664.82 t = 3.92 % of collected tonnage) is left out of the denominator, so
  its share is spread pro rata. Values are rounded to 0.01 t/day by largest remainder (ties in DOPA code order), so the
  50 districts sum **exactly** to the PCD total (checked every year BE 2562–2568). Assumption: a district's share of
  generation equals its share of collection — districts with more recycling at source or lower collection coverage are
  under-estimated. District `wasteGeneratedHistory` covers 2019–2025 (`estimated`).
- **Never mixed.** Generated (PCD BE 2568) and collected (BMA FY BE 2569) differ in source, definition and year; the
  UI shows them side by side and never subtracts one from the other. `wasteHistory` stays the collected series and
  `wasteGeneratedHistory` is a separate optional series (drawn dashed in the trend chart).

### Hat Yai (collected and generated)
- Municipality values from the DLA LAO solid-waste survey (Songkhla data catalog): FY BE 2565
  (2021-10-01 … 2022-09-30) **collected 67,193.63 t/yr ÷ 365 = 184.09 t/day**, **generated 101,002.212 t/yr ÷ 365
  = 276.72 t/day** (`observed`, unit conversion only). FY BE 2564 collected = 186.80 t/day. FY BE 2566–2567 cells
  are empty (`unavailable`). This is the most recent year with values.
- **Zone allocation (estimated):** zone value_i = T × p_i / Σp, where T is the municipality total and p_i the zone
  population (announcement sums). Values are rounded with the **largest-remainder method in 0.01 t/day units**
  (floor every share, then give the remaining units to the largest fractional remainders, ties by zone order),
  so Σ zones = T exactly. (0.01 rather than 0.1 is used because the municipality total itself has two decimals.)
  Each historical collected year is allocated with the same weights.
- PMC12247160's 237.75 t/day of household waste is a secondary citation with no stated period or method; it is
  recorded but not used as a metric.

## 6. Derived per-area and city indicators

| Metric | Formula | Status |
|---|---|---|
| `populationDensity` | population ÷ areaKm2 | `derived` |
| `wastePerCapita` | wasteCollected (t/day) × 1000 ÷ population → kg/person/day | `derived` (Bangkok, city totals); `estimated` (Hat Yai zones, because zone waste is an allocation) |
| `wasteDensity` | wasteCollected ÷ areaKm2 → t/day/km² | as above |

Both indicators use **collected** waste in both cities, so they are comparable across areas and consistent with the
obstruction index W (which also uses collected waste density). Every per-capita and density methodology starts with
"Measure: COLLECTED waste (not generated)", the UI labels read "ขยะที่จัดเก็บได้ต่อคนต่อวัน / Collected waste per
capita" and "ความหนาแน่นขยะที่จัดเก็บได้ / Collected waste density", and where a generated figure exists a limitation
states it (Bangkok city: generated per capita would be 2.444 kg/person/day against 1.750 collected). The validator
fails if a per-capita or density methodology does not name the measure.

**Cross-period limitations** (written into `wastePerCapita.provenance.limitations` whenever the population and
waste reference years differ):
- Bangkok: waste FY BE 2569 (Oct 2025 – Sep 2026) ÷ registered population at 31 Dec 2025 (inside the fiscal year).
  District values exclude the unallocated 'Others' row; the city value includes it (1.750 kg/person/day).
- Hat Yai city: waste FY BE 2565 ÷ DOPA population at 31 Dec 2025 (1.328 kg/person/day). With the DOPA population
  closest to the waste period (146,528 at 31 Dec 2022) it would be 1.256 kg/person/day — both are stated.
- Hat Yai zones: per-capita is identical across zones *by construction* (waste allocated by the same populations).
- Registered population understates the people actually served, which inflates per-capita values (notably
  Bangkok's central districts).

## 7. Waste composition

- **Bangkok (city level):** BMA FY BE 2565 physical composition (% by weight, 14 categories, text-layer PDF)
  aggregated into the app's 6 categories — organic = food + wood/leaves; plastic = recyclable + non-recyclable
  plastic + foam; paper = recyclable + non-recyclable paper; glassMetal = glass + metal; other = leather/rubber,
  textiles, stone/ceramics, bones/shells, diapers — then largest-remainder rounding to 0.1 so the shares sum to
  exactly 100.0 (status `derived`). **hazardous = 0.0 means “not a category in the source table”, not a measured
  zero** (limitation attached).
- **Bangkok (per district, `estimated`):** BMA publishes no composition by district or district group (กลุ่มเขต); it
  publishes composition by disposal centre (On Nut, Nong Khaem, Sai Mai) for FY2563–FY2564 only, with no official
  district → centre assignment. Each district therefore carries the FY BE 2565 citywide shares as an **estimate**
  ("city composition applied; district surveys unavailable"). The UI labels it "Estimated for this area (citywide
  shares applied)" with a note that district differences are not shown; the validator requires any area composition
  identical to the city's to be labelled `estimated`. The per-centre tables are transcribed (each column sums to
  100.00) in `data/staged/bangkok-district-composition.json` for reference only.
- **Hat Yai (`derived`):** Prince of Songkla University research report ENV6405051S (TSRI-funded), "ณ เดือน สิงหาคม
  2564" (Aug 2021): food 22 / paper 12 / plastic 49 / glass 3 / metal 1 / rubber-leather 1 / textiles 4 / others 8 %.
  Mapping: organic = food; paper; plastic; glassMetal = glass + metal; other = rubber-leather + textiles + others;
  hazardous = 0.0 (no such source category). Result **22.0 / 49.0 / 12.0 / 4.0 / 0.0 / 13.0**. The report states no
  sampling design or weight/volume basis, and the plastic share is far above Bangkok's 21.0 %, so it is labelled
  indicative. Municipality-wide only; zones carry no composition. If the staged file is missing the build falls back to
  `unavailable` (null shares) — Bangkok or national shares are never substituted.

## 8. Rainfall

- **Reanalysis lattice** (`rain-grid.json`, written by the rainfall fetcher): Open-Meteo `models=era5` daily
  precipitation, 2024-01-01 … 2026-10-28, Bangkok 42 points (0.1°) carrying **11 distinct ERA5 cells**, Hat Yai 25
  points (0.05°) carrying **2 cells**. Daily totals are local days (≈ 23:00–23:00), not TMD's 07:00–07:00.
- **Area series** (`rain-areas.json`, kind `area`, dates identical to `rain-grid.json`): for each area anchor, the
  4 nearest lattice points by distance in local metres (x = Δlon·cos φ₀·111 320, y = Δlat·110 574); weights
  wᵢ = 1/dᵢ² (a point within 1 m is used alone); daily value = Σ wᵢvᵢ / Σ wᵢ over non-null vᵢ, rounded to 0.1 mm.
  IDW is over the lattice points (whose values Open-Meteo assigned from the ERA5 cell serving each location), not
  over nominal cell centres, because Open-Meteo's cell assignment is not a simple nearest-centre rule.
- `rainfallAnnual` = mean of the area series' annual totals over **complete calendar years** (2024 and 2025);
  `rainfall24h` = the area series value on the **last date** (2026-10-28) — the latest complete ERA5 day at
  retrieval, not a real-time reading (real-time gauge snapshots are in `stations.json`). Both `estimated`.
- City totals: area-weighted means of the area values (`estimated`).
- **Every rainfall metric carries the limitation** that ERA5 cells are 0.25° (≈ 27–28 km), so rainfall differences
  between neighbouring areas are mostly not resolved; IDW only smooths between cell values.
- Scale check against TMD 1991–2020 normals (stated in the limitations): Bangkok's ERA5 city mean is ≈ 73 % of the
  station normal at 48455 (1,702.2 mm/yr); Hat Yai's (≈ 2,234 mm/yr) is ≈ 127 % of the Hat Yai Airport normal
  (1,756 mm/yr). Use the reanalysis for timing and relative comparison, not as absolute local depths.

## 9. Flood exposure index E (0–1, `estimated`)

Waterway proximity is measured on a regular sample lattice (Bangkok 100 m, Hat Yai 20 m spacing, aligned on the
city's south-west corner): for every lattice point inside the area, it counts whether it lies within **300 m** of
a mapped OSM waterway (river, canal, stream and drain lines, plus water-area polygon edges and interiors).

- **Bangkok:** `E = 0.7 × minmax(flood-risk points per km²) + 0.3 × minmax(share of area within 300 m of a waterway)`,
  min–max over the 50 districts. Flood-risk points = the BMA DDS designated list for BE 2568 (2025), 216 points,
  counted by the district stated by the agency. Relative within Bangkok.
- **Hat Yai:** `E = 0.5 × share within 300 m of Khlong U-Taphao + 0.5 × share within 300 m of any mapped waterway`.
  Khlong U-Taphao = OSM ways named คลองอู่ตะเภา / คลองอุ่ตะเภา (the OSM spelling variant). Shares are absolute
  (not min–max scaled) because with 4 zones min–max would force one zone to 0 and one to 1. No spatial extent of the
  November 2025 flood was available, so historical inundation is not included.
- The weights are demonstration assumptions; E is a proxy, not a hydraulic hazard map, and not comparable between
  cities. Per-area inputs are in `data/staged/osm-waterway-density.json` and `build-datasets-report.json`.

## 10. Obstruction susceptibility W (0–1, `estimated`)

Waterway **line** length inside each area is measured by splitting every segment into ≤ 20 m pieces and assigning
each piece to the area containing its midpoint (water-area polygons are excluded from length).

- **Bangkok:** `W = 0.5 × minmax(collected waste density t/day/km²) + 0.5 × minmax(waterway length density km/km²)`.
- **Hat Yai:** `W = 0.5 × (waste density ÷ max) + 0.5 × (length density ÷ max)` (ratio-to-max scaling, 4 zones).
  Zone waste density is itself an allocation, so this term mirrors population density.
- W expresses co-location of waste pressure and open channels; it does not measure blockage, and waste is a
  possible contributing factor, not a proven cause of flooding.

## 11. Model outputs (`simulated`)

Imported from `src/lib/simulation/model.ts` (no formula is re-implemented):
- `drainageStress` (= `drainageStressPct`) and `modeledFloodRisk` (= `score`) come from
  `computeAreaRisk({ floodExposure: E, obstructionSusceptibility: W, rainSpatialFactor }, BASELINE_SCENARIO, DEFAULT_ASSUMPTIONS)`
  with `rainSpatialFactor = rainfallAnnual(area) ÷ mean(rainfallAnnual over the city's areas)` — the same rule the
  dashboard applies, so the stored baseline equals what the UI recomputes. The validator re-runs the model and
  requires exact equality.
- `wasteAccumulated` = final stock of `simulateAccumulation(inflow, η = 0.95 (baseline), 30 daily steps, A₀ = 0)`;
  inflow = `wasteGenerated` where available (now both cities: Hat Yai zone allocations and Bangkok district
  allocations of the PCD total) else `wasteCollected` as a proxy. The dashboard's accumulation chart applies the same
  rule, and the validator checks that every area with a generated value uses it as inflow. Illustrative, not a
  measured quantity.
- City totals: population-weighted means of the areas' drainage stress and risk score (as in the dashboard summary);
  `wasteAccumulated` simulated on the city inflow.

## 12. City totals

| Metric | Bangkok | Hat Yai |
|---|---|---|
| population | published DOPA total = sum of districts (`observed`) | DOPA municipality total (`observed`); zone sums differ (stated) |
| areaKm2 | sum of district polygons (`derived`) | sum of zone polygons = municipality polygon (`derived`) |
| wasteCollected | published city total incl. 'Others' (`observed`) | municipality total (`observed`) = Σ zones exactly |
| wasteGenerated | PCD Bangkok total BE 2568 (`observed`) = Σ districts exactly | municipality total (`observed`) = Σ zones exactly |
| density, per-capita, waste density | from the totals above (`derived`) | from the totals above (`derived`) |
| rainfallAnnual, rainfall24h | area-weighted mean (`estimated`) | area-weighted mean (`estimated`) |
| floodExposure, obstructionSusceptibility | area-weighted mean (`estimated`) | area-weighted mean (`estimated`) |
| drainageStress, modeledFloodRisk | population-weighted mean (`simulated`) | population-weighted mean (`simulated`) |
| wasteAccumulated | model on city inflow (`simulated`) | model on city inflow (`simulated`) |

## 13. What is observed vs derived vs estimated vs simulated

| Metric | Bangkok districts | Hat Yai zones |
|---|---|---|
| population | observed (DOPA 2025-12-31) | derived (announcement sums) |
| areaKm2, populationDensity | derived | derived (approximate polygons) |
| wasteCollected | observed (FY BE 2569) | estimated (allocation of FY BE 2565) |
| wasteGenerated | estimated (allocation of PCD BE 2568) | estimated (allocation of FY BE 2565) |
| wastePerCapita, wasteDensity | derived | estimated |
| rainfallAnnual, rainfall24h | estimated (ERA5) | estimated (ERA5) |
| floodExposure, obstructionSusceptibility | estimated (proxy indices) | estimated (proxy indices) |
| drainageStress, modeledFloodRisk, wasteAccumulated | simulated | simulated |
| composition | estimated (citywide FY BE 2565 shares applied); city level derived | none per zone; city level derived (PSU/TSRI, Aug 2021) |
| community points | — | 1 verified (OSM match), 102 illustrative demonstration positions |
| water levels | observed snapshot; capacity % derived | observed snapshot; capacity % derived |

## 14. Other outputs

- `flood-events.json`: Hat Yai — the November 2025 flood (19–28 Nov 2025, two waves) from ThaiWater/HII, with the
  peak daily rainfall 370.2 mm (TMD station หาดใหญ่ at ต.ทุ่งลาน, outside the municipality) as an observed
  `peakRainMm`. Bangkok — three documented events copied from `data/staged/bangkok-flood-events.json`: the 2011 great
  flood (Oct–Nov 2011; HII record + World Bank), the 17–18 May 2022 heavy-rain flood (peak 136.0 mm/day) and the
  25–27 Sep 2026 flood (peak 210.0 mm in 24 h; disaster declaration for all 50 districts). Beyond the `FloodEvent`
  contract each event carries `sourceIds`, `peakValues` (value, unit, place, period, status, Thai quote) and
  `eventWindowNote`; every quoted number was matched word for word against the cached source. Event windows follow
  the reporting windows, not hydrological onset/recession. Peak values are single-gauge maxima, not areal averages.
- `water-levels.json` (`WaterLevelStation[]`): a one-time snapshot of the public ThaiWater API (2026-11-04 ≈ 09:00 ICT;
  not live). Readings older than 48 h before retrieval are dropped (as on the ThaiWater web map; 55 old BMA canal
  gauges); gauge KRP901 is excluded because it reads 29.82 m "MSL" in Bangkok (clearly a local datum). Water and bank
  levels are `observed` in m MSL. `capacityPct` (`derived`) = (water level − ground level) ÷ (bank level − ground
  level) × 100, only where both ground and bank level are published (37 gauges; it matches ThaiWater's own
  storage_percent within 0.21 percentage points). BMA canal gauges publish no ground level, so they have no capacity %
  and are classed from their published watch/critical levels. Situation text is the agency's own wording; the UI
  classes it (e.g. "ต่ำกว่าระดับเฝ้าระวัง" = below the watch level → normal) and shows an English rendering.
- `rain-hourly.json` (`HourlyRainEvent[]`): ERA5 hourly precipitation via Open-Meteo for the Hat Yai Nov 2025 event
  (18–27 Nov 2025, 240 h) and the Bangkok Sep 2026 event (25–27 Sep 2026, 72 h), status `estimated`; times are local
  (+07:00) and each value is the rain in the preceding hour; hourly values sum to the event total. ERA5 depths are far
  below the gauges (Hat Yai peak day 240 vs 370.2 mm; Bangkok 88 vs 210 mm), which each file states: use for timing
  and shape, not depth.
- `drainage.geojson` (Bangkok): 173 OSM features plus 734 official BMA Drainage and Sewerage Department points
  (`source: "bma-dds"`: pump stations and floodgates from the 2023 inventory, pump sumps from the 2022 release) with
  agency coordinates. An official point that matches an OSM point (same kind, normalised name, ≤ 150 m) is not added
  twice; the OSM feature carries `officialMatch` (7 cases). Capacity (`capacityM3s`) is the nominal installed pumping
  capacity in m³/s from column `gp_gate` (meaning inferred: it equals the per-pump breakdown in 269 of 272 rows;
  withheld for the 3 rows that disagree). The 12 drainage tunnels have no coordinates and stay in staging.
- `communities.geojson` (Hat Yai, `CommunityProps`): all **103** official communities with their zone, households and
  population as printed in the 2022–2023 boundary announcements (null where not printed).
  - **Verified (1):** ชุมชนไทยโฮเต็ล matches OSM node/4367170491, a community health post whose name contains the full
    official name (rule N3, confidence medium), inside the municipality and its zone. It is a facility named after the
    community, not a surveyed centroid. Matching rules: Thai normalisation (NFC, Thai digits, common abbreviations,
    punctuation removed); a match needs the exact official name, a place/residential feature named without "ชุมชน", or
    the full official name inside a longer name ending at a word break; location must be inside the municipality and
    within 150 m of the zone; ways/relations ≤ 800 m across; candidates > 300 m apart are rejected as ambiguous. 27
    partial-name candidates (temples, schools, villages) were rejected and logged.
  - **Illustrative (102):** demonstration positions, **not locations**. A 25 m hexagonal candidate lattice inside both
    the zone and the municipality, ≥ 60 m from either edge and ≥ 120 m from the verified point; farthest-point
    selection (zone edge weighted as half a spacing) and 12 relaxation rounds; communities assigned to positions in
    SHA-256(name) order (deliberately unrelated to geography) with a small seeded offset (≤ 12 % of spacing) kept only
    if all limits still hold. Results: typical spacing 420–479 m per zone, min point-to-point 259.8 m, min edge distance
    87.6 m; zone counts 28/29/25/21 as published. Each carries `labelTh` "ตำแหน่งสาธิต ไม่ใช่พิกัดจริง" / `labelEn`
    "Illustrative position — not a real location"; only zone membership is real. The map draws them as hollow, dashed
    markers. Hat Yai publishes no community coordinates (its community map is a scanned PDF, deliberately not
    georeferenced).
- `sources.json`: union of the staged registries, de-duplicated by id (first occurrence wins), plus entries for the
  Overpass building windows, the basemap (OpenFreeMap / OpenMapTiles) and the two project-internal ids.
- `manifest.json`: every file under `public/data/` with byte size and sha256.
- Waterways: if any feature lacked `kind`, the build would add it from the OSM `waterway` tag (geometry untouched);
  the current files already carry `kind` and `widthClass`.

## 15. Validation (`scripts/data/validate-data.ts`)

Errors (exit 1): zod schema conformance of every file (`src/lib/validation/schemas.ts`); 50 Bangkok districts with
unique codes 1001–1050; 4 Hat Yai zones; null ⇔ `unavailable`; every non-unavailable value has a `sourceId` and every
non-observed value a methodology; every referenced `sourceId` exists in `sources.json`; composition sums to 100 ± 0.05;
Hat Yai zone waste sums to the municipality total ± 0.05; Bangkok population total = Σ districts; city waste ≥ Σ
districts with the 'Others' explanation; recomputation of density, per-capita and waste density; areaKm2 vs polygon;
geometry validity and bbox; Bangkok union area within 3 % of 1,568.737 km²; Hat Yai zones tile the municipality;
anchors strictly inside their polygon; `rain-areas.json` dates identical to `rain-grid.json` and series ids = area
ids; rainfallAnnual / rainfall24h recomputed from the area series; the ERA5 resolution limitation on every rainfall
metric; cross-period limitation on per-capita when years differ; baseline model outputs equal to a fresh model run;
waterway features carry a valid `kind`; manifest hashes for non-building files.

Second-round checks: Bangkok district `wasteGenerated` sums to the PCD city total ± 0.05 and every allocated value is
`estimated`; per-year additivity of `wasteGeneratedHistory` (areas → city) and of Hat Yai `wasteHistory`; accumulation
inflow uses generated waste where it exists; per-capita and density methodologies name the collected measure; an area
composition equal to the citywide shares must be `estimated`; `water-levels.json` schema (units m MSL, `capacityPct`
`derived` and only with both levels), unique ids, plausible levels, a Chao Phraya gauge in Bangkok and a Khlong
U-Taphao gauge in Hat Yai; `rain-hourly.json` schema (consecutive hours, values ≥ 0, never `observed`); flood-event
`sourceIds`/`peakValues` sources exist; `communities.geojson` conforms to `CommunityProps`, unique ids, zoneId ↔
zoneNo, illustrative points inside their zone and labelled as demonstration positions, zone counts equal the official
list, metadata counts equal the features; official drainage points have a source, a unique (sourceId, ddsId), kind
pump-station/gate and a positive or null capacity, and `officialMatch` distances ≤ 150 m.

Warnings (do not fail): missing or empty building windows, building windows larger than 1.5 MB, a building-window
origin on the polygon edge, stale manifest entries for building windows, files above 3 MB, annual rainfall outside
1,000–3,500 mm, implausible per-capita values.

## 16. Known gaps

- Hat Yai zone boundaries are approximate; no official machine-readable zone polygons exist.
- Hat Yai waste is available only to FY BE 2565 and only at municipality level; Hat Yai composition is a single
  Aug 2021 statement without a stated sampling method.
- Bangkok district generated waste is an allocation (collection share = generation share); PCD's year basis is not
  stated; no district or district-group composition survey exists.
- ERA5 rainfall does not resolve differences between neighbouring areas and is biased low in Bangkok / high in Hat Yai
  relative to the station normals; station data are single real-time snapshots.
- E and W are proxy indices with assumed weights; OSM waterway and drainage mapping is incomplete (OSM drainage points
  are display-only).
- No spatial flood extent for Hat Yai November 2025 or for any Bangkok event; the 2011 per-district list of flooded
  areas is not published in the sources used (only the count, 32 districts).
- Water levels are a one-time snapshot (2026-11-04), not live; BMA canal gauges have no capacity %.
- Only 1 of 103 Hat Yai communities has a verified location; the other 102 are labelled demonstration positions.
- Building windows are fetched separately and may be missing for some areas at build time (validator warning).
