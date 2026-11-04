# Bangkok data notes: boundaries, population, waste, composition, flood points

Retrieved 2026-11-04 (raw files fetched 2026-11-03T18:31Z–18:35Z UTC). Re-run with
`npx tsx scripts/data/fetch-bangkok.ts`, or add `--offline` to rebuild from the cached raw files only.
Every HTTP request returned 200. The script sends the User-Agent
`UrbanIntelligenceDemo/0.1 (research prototype)`, waits at least 1.1 s between requests to the same host,
and retries 429/5xx responses with exponential backoff. The per-file manifest (URL, time, HTTP status, bytes,
sha256) is `data/raw/_manifests/fetch-bangkok.json`. `data/staged/bangkok-ingest-report.json` holds the
validation results and the fetch log for the latest run.

All Buddhist Era (BE) years are converted with Gregorian = BE − 543. A Thai fiscal year (FY) runs from
1 October to 30 September. FY BE 2569 is 2025-10-01 to 2026-09-30, and it is labelled 2026 in the outputs
(the Gregorian year in which the FY ends).

## Outputs

| File | Content |
|---|---|
| `public/data/bangkok/districts.geojson` | 50 district polygons, WGS84, 334,209 bytes |
| `data/staged/bangkok-population.json` | DOPA registered population by district, 2021–2025, with the city total and cross-checks |
| `data/staged/bangkok-waste.json` | Collected waste by district for FY2010–FY2026 (FY2011/2012 unusable), citywide collected FY2011–FY2026, disposed FY2017–FY2022 |
| `data/staged/bangkok-composition.json` | Citywide physical composition, FY2022 primary (FY2020 and FY2021 as history), mapped to 6 categories |
| `data/staged/bangkok-flood-points.json` | 6 BMA flood-point series: counts per district code, plus points where the agency published coordinates |
| `data/staged/bangkok-sources.json` | 31 `SourceRef` objects |
| `data/staged/bangkok-ingest-report.json` | Validation results, fuzzy name matches and the fetch log (supporting file) |

## 1. District boundaries: `geometryStatus: "official"`

- **Source:** data.go.th dataset `50`, "พื้นที่เขตปกครอง 50 เขตของกรุงเทพมหานคร". It is published by
  BMA (กองสารสนเทศภูมิศาสตร์ / BMA GIS) and harvested from data.bangkok.go.th.
  - The resource used is `district-2.zip`: a shapefile in EPSG:32647 (UTM 47N), DBF encoding cp874.
    It was exported on 2020-08-11 from the BMA GeoServer WFS layer `BMAWMS:district`, and the resource is
    dated 2021-03-09.
  - The area table `50district.csv` comes from the same dataset.
  - **License:** "License not specified" on both CKAN portals.
- **Processing:** `unzip`, then mapshaper `-simplify 20% weighted keep-shapes`, run in UTM metres. After
  that, `-proj wgs84` and output with `precision=0.00001` (5 decimals). Features are sorted by code.
- **Properties:**
  - `code`: the DOPA code, "1001"–"1050".
  - `nameTh`: the source name with the "เขต" prefix removed.
  - `nameEn`: RTGS romanisation.
  - `nameEnSource`: the BMA spelling. Some of these are non-standard, for example "Parthum Wan",
    "Yan na wa", "Vadhana", "Bang Khun thain" and "Chatu Chak".
  - `geometryStatus: "official"` and `sourceId: "bma-gis-district-boundaries"`.
  - `areaKm2Official` and `areaKm2Geodesic` (extras, described below).
- **Spelling fix:** the source DBF spells 1024 as "ราษฏร์บูรณะ" (with ฏ). It was corrected to
  "ราษฎร์บูรณะ", the DOPA/NSO spelling.
- **Validation (all checks pass):**
  - There are 50 features with 50 unique codes covering 1001–1050.
  - `turf.booleanValid` reports 0 invalid features and `turf.kinks` finds 0 self-intersections. All
    50 features are Polygon geometries.
  - The union area is 1,589.211 km², which is **+1.305 %** against the official 1,568.737 km². The
    requirement is within 3 %.
  - The sum of the simplified areas equals the union (1,589.211 km²), so there are no overlaps. The
    full-resolution sum is 1,589.213 km².
  - The file is 334 KB, under the 1.2 MB limit.
  - Vertices go from 81,451 to 15,367.
  - **Simplification error:** distances were measured from every 5th original vertex (16,309 points) to
    the simplified outline. The median is 0.4 m, p95 1.6 m, p99 3.7 m and max 21.1 m. One pixel at
    zoom 13 (512-px tiles) is about 9.3 m, so the error is well under one pixel except for the extreme
    maximum (~2 px).
- **Area caveat:**
  - The BMA area table (`area_dis`) sums exactly to 1,568.737 km².
  - Per-district table areas differ from the polygon areas for some districts, for example Bang Rak
    5.536 vs 4.028 km² and Rat Burana 15.782 vs 12.381 km². The table appears to be the administrative
    statistic rather than a measurement of these polygons.
  - Both values are kept: `areaKm2Official` (the table) and `areaKm2Geodesic` (turf area of the
    full-resolution polygon).
  - The DBF also carries `num_male`/`num_female` with no reference year. These were **not used**.
- **OSM fallback:** not needed and not queried, so no Overpass load was generated. The script would stop
  with an error if both the official download and its cache were missing.

## 2. Population: `bangkok-population.json`

- **Primary source:** NSO official statistics table `OS_0405_01_0005_01`, "จำนวนประชากรตามพื้นที่จากการทะเบียน"
  (data.go.th `0405_01_0005`, license **Creative Commons Attributions**).
  - The data source is DOPA (กรมการปกครอง).
  - Years covered are BE 2564–2568, i.e. 2021–2025.
  - **Latest complete year:** 2025 (BE 2568). The reference date is **2025-12-31**, following DOPA's
    31-December annual announcements.
- **Definition:** persons recorded in district house registers (Thai and non-Thai). This is not the de
  facto resident population.
- **City total for 2025:** 5,422,568. The sum of the 50 districts equals the published total for every
  year 2021–2025.
- **Cross-checks (all exact matches):**
  1. **DOPA's own files.** The `stat_a64…stat_a68.txt` download files from
     `https://stat.bora.dopa.go.th/new_stat/file/YY/` have periods 6412…6812. All 50 districts match by
     DOPA code, and the total matches, in each of the 5 years. This file also gives the registered houses
     (`housesLatest`).
  2. **DOPA Central Registration Office announcement.** It was published in the Royal Gazette on
     2023-01-23 (`https://www.dopa.go.th/news/preview/10616`) for 31 Dec 2022. Bangkok = 5,494,932
     (Thai 5,394,910 + non-Thai 100,022), which equals the NSO value for 2022.
  3. **BMA open data `bkkpopulationdistric`.** The CSV is windows-874 and states no year. All 50
     districts and the total of 5,471,588 equal NSO/DOPA **2023**, so that file is the 2023 data, not
     2023–2025 as its CKAN year fields suggest.
- **Not used:**
  - The newer DOPA SPA portal `stat.bora.dopa.go.th/stat/statnew/statyear/` returns only a JavaScript
    shell (HTTP 200).
  - A prachachat.net news page about the end-2025 figure returned HTTP 403. It is recorded as
    `manual-reference` only.

## 3. Waste quantity: `bangkok-waste.json`

**Primary series: collected waste by district office, FY2019–FY2026 (BE 2562–2569).**

- **Source:** the BMA Environment Department (สำนักสิ่งแวดล้อม) annual PDFs "สถิติปริมาณมูลฝอย ประจำปีงบประมาณ",
  using the September edition (full year) of each.
  - The PDFs are linked from `https://webportal.bangkok.go.th/environmentbma/page/sub/28229`.
  - Each table is titled "ข้อมูลปริมาณมูลฝอยที่จัดเก็บได้", with 12 monthly tonnages, the annual total in tonnes
    and the average in t/day.
  - **License:** not stated.
- **Definition: collected (มูลฝอยที่จัดเก็บได้).** This is general municipal solid waste collected by each of
  the 50 district offices and delivered to BMA facilities. It is not generation: waste recycled at source,
  hazardous waste and infectious waste are excluded.
- **"อื่นๆ" (Others) row:** waste not delivered by a district office. In env0004 this column is called
  `envidepart_ton`. It cannot be allocated to a district and is kept in `others`.
- **Unit published:** t per fiscal year.
  - `tonnesPerDay` = annual ÷ **days stated in the table header**: 365, or 366 for FY2020 and FY2024.
    These equal the calendar days of 1 Oct–30 Sep.
  - This reproduces the publisher's own average column (`tonnesPerDayPublished`).
- **Parsing method:**
  - PDF text was extracted with macOS PDFKit via `osascript`/JXA. The text is cached in
    `data/raw/bma-environment/waste-stats/text/*.txt`, keyed by the PDF's sha256.
  - Rows are found as 12 numbers plus a 13th that equals their sum (±0.07 t).
  - Rows are assigned by the BMA table order, which is Thai alphabetical. This order was verified against
    the printed row numbers: 51/51 in most years, 14/14 in FY2021 and 50/50 in FY2025.
  - The 51 rows sum exactly to the printed grand total in every year.
  - Spot checks covered rows whose labels the PDF text layer displaced (FY2020 and FY2026 Din Daeng, among
    others).
  - The independent BMA open-data CSV `env0004` (FY2023, Oct–Jul) matches **510/510** cells.
  - No district changes by more than ×1.5 or less than ×0.67 year on year.
- **Latest: FY2026 (BE 2569, 2025-10-01 → 2026-09-30).**
  - City total 3,464,498.49 t, i.e. **9,491.78 t/day**.
  - The 50 districts total 3,385,991.79 t (9,276.68 t/day). Others are 78,506.70 t (215.09 t/day).
  - The largest district is Chatuchak at 365.44 t/day and the smallest is Samphanthawong at 45.49 t/day.

**Citywide collected t/day, FY2011–FY2026 (BE 2554–2569):** taken from the 10-year summary tables in
the PDFs, preferring the most recent report. The overlapping reports agree exactly.

| FY (Gregorian) | 2011 | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 |
|---|---|---|---|---|---|---|---|---|
| t/day | 8,943.10 | 9,747.74 | 9,963.27 | 9,939.80 | 10,166.84 | 10,130.22 | 10,526.92 | 10,705.82 |

| FY (Gregorian) | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|
| t/day | 10,564.48 | 9,519.81 | 8,674.73 | 8,979.37 | 8,775.12 | 9,238.29 | 9,560.56 | 9,491.78 |

**Disposed (env0011, BMA open data):** t/day by technology for BE 2560–2565 (2017–2022), covering
landfill, compost, incinerator, MBT and the new system. The totals equal the collected averages except
FY2019 (10,570.47 vs 10,564.48) and FY2022 (8,979.36 vs 8,979.37).

**Legacy per-district series, BE 2553–2561 (2010–2018).**

- **Source:** data.go.th `garbage1` (License not specified) and its byte-identical duplicate `garbage`
  (Creative Commons Attributions), from BMA GIS.
  - The data dictionary is `garbage.docx` (updated 4 Jun 2020). Units are t/year and t/day, and
    dcode 1000 means "อื่นๆ".
  - The title says only "ปริมาณขยะมูลฝอย", and whether the year is fiscal or calendar is not stated.
  - It is treated as **collected**: column totals match the BMA collected averages within 0.6 % for
    BE 2556–2561.
  - t/day = annual ÷ 365, the divisor the publisher used in its own per-day columns.
- **Quality problems:** these are flagged and the affected values set to `null`/`unavailable`. The raw
  values are kept in `rawPublished`.
  - The BE 2554 and 2555 columns are misaligned with the district codes (they look sorted). Their
    Spearman ρ against the FY2019 PDF is −0.07 and −0.09, so all 100 values are unavailable. BE 2555
    also contains `116.37` for 1002.
  - Five cells deviate from their district median by more than ×1.5 or less than ×0.67 (the
    1007/1008/1004 swaps in BE 2557 and 2559) and are set to unavailable.
  - The BE 2559 per-day column is inconsistent with annual/365 for most districts, and the BE 2560 per-day
    column is all zeros. Neither is used, because t/day is derived from the annual values.
- **Gap:** there is no district-level FY2018/FY2019 overlap check, because the FY2017/FY2018 PDFs use a
  column layout that was not parsed.

**Cross-checks:**

- `garbage50` (BMA open data, no year stated) equals the **FY2022 (BE 2565)** PDF table in 49 of 51 rows.
  The two differences are Din Daeng 78,465.9 vs 78,465.29 and Watthana 87,478.5 vs 87,781.5.
- Chom Thong carries the wrong dcode in `garbage50` (1036 instead of 1035), so it was matched by name.
- `garbage50` is not used as a separate series.

**Not retrieved:** Pollution Control Department "generated" waste estimates for Bangkok. No generation
figures are given anywhere in these outputs.

## 4. Composition: `bangkok-composition.json`

- **Primary: FY2022 (BE 2565, 2021-10-01 → 2022-09-30).**
  - Source table: "องค์ประกอบมูลฝอยของกรุงเทพมหานคร ปีงบประมาณ พ.ศ. 2565" by กลุ่มงานวิจัยและพัฒนา,
    สำนักงานจัดการมูลฝอยและสิ่งปฏิกูล, สำนักสิ่งแวดล้อม.
  - The PDF text layer was parsed. It has 14 categories that sum to 100.00.
  - **Scope:** Bangkok city-level municipal solid waste (not national). The FY2022 table does not state
    sampling sites or sample counts. The FY2020 and FY2021 tables report the average of BMA's three
    disposal centres (On Nut, Nong Khaem and Sai Mai), with the unit "% by weight". In FY2021, COVID-19
    restricted sampling to On Nut in Jul–Aug 2021.
  - The same file under `/WasteData/2569/` returned HTTP 200 with an empty body. The `/2565/` path works.
- **Mapping to the six app categories:**
  - **organic** = food waste 49.04 + wood/leaves 5.02 = 54.06
  - **plastic** = recyclable 1.76 + non-recyclable 17.70 + foam 1.51 = 20.97
  - **paper** = recyclable 2.30 + non-recyclable 9.30 = 11.60
  - **glassMetal** = glass 1.52 + metal 1.60 = 3.12
  - **hazardous** = **0.0**. The source has no hazardous category, so this means "not reported as a
    category", not a measured zero.
  - **other** = leather/rubber 1.57 + textiles 5.08 + stone/ceramics 1.09 + bones/shells 1.68 +
    diapers 0.83 = 10.25
- **Rounding:** largest remainder in 0.1 units with integer arithmetic. The result is
  **organic 54.1, plastic 21.0, paper 11.6, glassMetal 3.1, hazardous 0.0, other 10.2 = 100.0**.
  Provenance status is `derived`.
- **History:**
  - FY2020 and FY2021 are scanned PDFs with no text layer. Their values were transcribed by hand into the
    script, and each column sums to 100.00.
  - FY2020 → 51.2 / 22.6 / 14.0 / 3.7 / 0.0 / 8.5.
  - FY2021 → 52.6 / 22.9 / 12.0 / 3.1 / 0.0 / 9.4.
- **Conflict:**
  - The BMA open-data CSV `garbage_element.csv` (license "Open Data Common") is labelled 2565, but all
    14 of its values differ from the FY2022 PDF (food 49.83 vs 49.04, for example). It also sums to
    100.00.
  - The PDF was preferred because its title states the fiscal year and its author unit is named. The CSV is
    kept in `alternateOpenDataCsv`, whose 6-category shares are 54.6 / 21.3 / 11.3 / 2.8 / 0.0 / 10.0.

## 5. Flood-prone points: `bangkok-flood-points.json`

All of these are BMA CKAN datasets. Counts are keyed by DOPA code, and a district with no points has
count 0 for that list. Point coordinates are included only where the agency published them.

| Series id | What | Year | Total | Districts >0 | Coordinates | License |
|---|---|---|---|---|---|---|
| `bma-dds-flood-risk-2568` (**primary**) | จุดเสี่ยงน้ำท่วม 2568, DDS (สำนักการระบายน้ำ) | 2025 | 216 | 38 | yes | not specified |
| `bma-dds-flood-risk-register` | Risk-point register (rain via district/DDS, tidal), with fix status 1–5 | no year; CSV updated 2025-08-19 | 737 (472 not "fixed") | 49 | yes | not specified |
| `bma-igd-flood-risk-points-2566` | Counts of risk points per district office, Inspector-General report | FY2023 | 159 (6 DDS-level) | 37 | no | not specified |
| `bma-igd-flood-watch-points-2566` | Counts of จุดเฝ้าระวัง per district office | FY2023 | 242 (43 DDS-level) | 45 | no | not specified |
| `bma-dds-risk-watch-2566` | Risk/watch road sections, DDS | 2023 | 49 | 23 | no | CC-BY |
| `bma-gis-flood-weak-points` | จุดอ่อนน้ำท่วม, BMA GIS | not stated (exported 2020) | 20 | 17 | yes (from UTM) | not specified |

Caveats:

- **flood_risk26:** the columns are named `UTM_X`/`UTM_Y` but contain WGS84 lon/lat. The title and
  description say BE 2568, while the CKAN year fields say 2026. The BE year was used.
- **Point-in-polygon QA:**
  - 2568 list: 196/216 points lie inside the stated district. 7 of the other 20 are within 200 m of it;
    the farthest is 10.3 km away.
  - Register: 715/737 lie inside. 17 of the other 22 are within 200 m; the farthest is 2.9 km away.
  - Counts use the district stated by the agency. Coordinates are not modified.
- **IGD datasets:** "สำนักงานเขตคลองสมวา" was fuzzy-matched to 1046 คลองสามวา. The DDS-level rows (code A1)
  are kept in `nonDistrictRows`.
- **`risk-flood-bangkok-area`:** the meaning of `risk_type` codes 1/2 (6 vs 43 rows) is not documented.
  It is not interpreted.
- **Not used:** `frd_dds`, a CC-BY dataset of main-road flooding event statistics for 2021–2025, would
  suit a flood-events task.

## 6. Sources, licenses and failures

- `bangkok-sources.json` lists all 31 sources:
  - 28 `retrieved`, including the data.go.th CKAN API entry, which is metadata only.
  - 1 `partial`: legacy garbage, because of the quality problems above.
  - 0 `failed`.
  - 2 `manual-reference`: prachachat news (HTTP 403) and OSM Overpass (not queried).
- **Failures and non-uses:**
  - DOPA SPA portal: HTML shell only.
  - prachachat.net: HTTP 403.
  - `.../WasteData/2569/WasteComp 2565.pdf`: empty body.
  - The FY2017/FY2018 waste PDFs use a column-wise layout. They were not parsed and were deleted from raw.
- **Licenses:** most BMA datasets say "License not specified". `garbage` (data.go.th) and
  `risk-flood-bangkok-area` are CC-BY, and the composition CSV is "Open Data Common". The NSO table is
  CC-BY. The BMA Environment Department and DOPA files state no license. Attribute BMA, DOPA and NSO in the
  UI.
- **Platform requirements:**
  - PDF text extraction needs macOS (PDFKit). On other systems the script reuses the cached
    `text/*.txt`, which is checked against the PDF sha256.
  - Shell tools used: `unzip` (system) and `node_modules/.bin/mapshaper`. No package was installed.
