# GEPP Urban Intelligence — Waste & Flood Observatory
**หอสังเกตการณ์ขยะและน้ำท่วม · Understand the City. See the Connections.**

An interactive geospatial dashboard and Three.js digital twin for **Bangkok** (50 districts) and **Hat Yai Municipality** (4 community-management zones). It connects municipal waste, population, rainfall, drainage and flood exposure. The interface is Thai by default, with an English switch.

> **SIMULATION — NOT AN OFFICIAL FLOOD FORECAST.** Risk scores, drainage stress, accumulation and the 3D flood surface come from an illustrative, deterministic model. Waste is treated as a *possible contributing factor*, never a proven cause.

## Run

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. A production build:

```bash
npm run build && npm start
```

All data is bundled in `public/data/`, so the app works offline except for basemap tiles. If the tiles are unreachable, the map switches to an offline grid basemap.

### Checks

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm test
```

```bash
npm run build && npm run test:e2e
```

```bash
npm run data:validate
```

- `npm test` runs 104 unit tests (model, scenario logic, store, guided story, water-level classification).
- `npm run test:e2e` runs the Playwright desktop and mobile smoke tests.
- `npm run data:validate` performs about 12,000 data-integrity checks.

### Rebuild the data

```bash
npm run data:fetch
```

```bash
npm run data:build && npm run data:validate
```

`data:fetch` re-downloads public sources (polite; reuses caches under `data/raw/`; pass `-- --offline` to rebuild from cache only).

## Features
- **2D map (MapLibre + OpenFreeMap vector tiles)** with a custom midnight style:
  - choropleths for waste volume, waste per capita, population density, modelled flood risk and estimated rainfall;
  - observed rain-gauge stations, an ERA5 rainfall heatmap, OSM waterways with flow animation, drainage infrastructure, and area-level waste hotspots;
  - hover, select, fly-to, legend, search and an offline fallback.
- **3D digital twin (Three.js / React Three Fiber)** with 2D, 3D and split views:
  - city scope: real district or zone polygons extruded by the active metric;
  - neighbourhood scope: about 28,500 real OpenStreetMap building footprints in 0.9 km windows around each area;
  - GPU rain, animated water, and an illustrative flood surface that always carries its disclaimer;
  - GSAP camera presets, quality tiers (Auto / High / Balanced / Low) and a WebGL fallback.
- **3D City mode** (`เมือง 3D`, key `4`):
  - continuous Apple-Maps-style 3D city: real OSM building massing from vector tiles across the whole city, with glowing wire-frame edges drawn by a Three.js custom layer in the map camera;
  - real roads and canals;
  - scenario rain on the GPU, and an illustrative flood sheet that always carries its disclaimer.
- **Scenario Lab:**
  - 5 presets and 6 sliders;
  - the explainable risk model `Risk = 0.45R + 0.25D + 0.20E + 0.10W` with a per-factor breakdown;
  - before/after comparison against the baseline;
  - one coordinated update across the map, 3D view, KPIs, charts and rankings.
- **Timeline:**
  - historical replay over ERA5 daily rainfall (2024-01-01 → 2026-10-28), with Hat Yai's November 2025 flood marked;
  - a deterministic simulated-storm timeline.
- **Analytics:**
  - area details (Overview / Waste / Rain & Drainage / Flood Factors / Data);
  - rankings, two-area comparison, the Insight Explorer, and a data-source drawer;
  - full provenance on every value: observed / derived / estimated / simulated / unavailable.
- **Responsive:** desktop command center; tablet drawers; mobile map-first layout with a bottom sheet. Reduced-motion and effects toggles are available.

## Data at a glance

| | Bangkok | Hat Yai |
|---|---|---|
| Geometry | Official BMA district polygons (50) | OSM municipality boundary. The 4 zones are **approximate demonstration partitions**, labelled as such. |
| Population | DOPA registered population, 31 Dec 2025: **5,422,568** | DOPA, 31 Dec 2025: **138,582** |
| Waste | BMA **collected** waste, FY 2026: **9,491.78 t/day** (history FY 2011–2026). Separately, PCD **generated** waste 2025: **13,254 t/day** (history 2013–2025); district generated values are allocations (estimated). | Songkhla LAO survey, FY 2022: 184.09 t/day collected / 276.72 t/day generated. Zone values are allocated by population (estimated). |
| Composition | BMA FY 2022 survey (city); districts carry it as an estimate (no district survey exists) | PSU/TSRI research report, Aug 2021 (derived; indicative) |
| Rainfall | Observed gauge snapshot (BMA, HII, TMD, RID, DWR) + ERA5 reanalysis daily grid + TMD 1991–2020 normals | Same sources |
| Flood context | BMA DDS flood-risk points (exposure index); documented events 2011, May 2022, Sep 2026 | Thaiwater summary of the Nov 2025 flood |
| Water & drainage | ThaiWater water-level snapshot (255 gauges incl. Chao Phraya); 734 official BMA pump stations, gates and sumps + OSM | ThaiWater snapshot (9 gauges incl. Khlong U-Taphao); OSM |
| Hourly rain | ERA5 hourly, 25–27 Sep 2026 (estimated) | ERA5 hourly, 18–27 Nov 2025 (estimated) |
| Communities | — | 103 official communities: 1 verified OSM location, 102 labelled demonstration positions inside their zone |

Details are in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) and [docs/DATA_METHODOLOGY.md](docs/DATA_METHODOLOGY.md).

## Documentation
- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) — every source: URL, licence, period, retrieval status
- [docs/DATA_METHODOLOGY.md](docs/DATA_METHODOLOGY.md) — derivations, unit and BE→CE conversions, allocations, limitations
- [docs/SIMULATION_MODEL.md](docs/SIMULATION_MODEL.md) — risk, drainage, accumulation and hyetograph models; assumptions
- [docs/THREE_D_ARCHITECTURE.md](docs/THREE_D_ARCHITECTURE.md) — coordinates, level of detail, shaders, quality tiers
- [docs/MOTION_SYSTEM.md](docs/MOTION_SYSTEM.md) — motion tokens, which engine owns which effect, reduced motion
- [docs/SKILLS_USED.md](docs/SKILLS_USED.md) — design skills installed and applied

## Project layout
```
src/app                 Next.js App Router entry, global design tokens
src/components/map      MapLibre map, layers, legend, controls
src/components/three    R3F digital twin (scenes, rain, water, flood, camera)
src/components/dashboard Shell, KPIs, panels, Scenario Lab, timeline
src/components/charts   ECharts wrapper + charts
src/lib                 types (data contract), simulation model, metrics, geo, formatters
src/store               Zustand dashboard state
scripts/data            fetch / build / validate pipeline
public/data             bundled, validated datasets
tests/unit, tests/e2e   Vitest + Playwright
```

## Known limitations
- **Bangkok district totals:** the published city total includes about 215 t/day not allocated to any district, so the districts sum to 9,276.68 t/day.
- **Hat Yai:** zone polygons are approximate; zone waste is allocated by population; data years differ (waste FY 2022, population 2025), and this is disclosed.
- **Rainfall resolution:** ERA5 cells are 0.25° (about 27 km), so differences in rainfall between neighbouring areas are not resolved. The gauge readings are a one-off snapshot taken when the data was fetched, not live.
- **Building heights:** about 90 % are deterministic estimates (OSM has few height tags). Two outer Bangkok districts have no mapped buildings in their window.
- **Drainage capacity:** the 60 mm/h figure relies on official statements reported in the media (BMA), not engineering data. Hat Yai has no verifiable figure, so it is an assumption there.
- **Waste generated vs collected (Bangkok):** PCD's generated total (2025) and BMA's collected total (FY 2026) are different measures and years; district generated values are allocations by collection share, and composition per district is the citywide survey applied as an estimate.
- **Hat Yai communities:** only 1 of 103 has a verified location; 102 are deterministic demonstration positions inside their zone, labelled "ตำแหน่งสาธิต ไม่ใช่พิกัดจริง".
- **Water levels:** a one-time ThaiWater snapshot (4 Nov 2026), not live.
- **Licensing:** most BMA datasets publish no licence; attribution to the publishers is shown.
