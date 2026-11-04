# Hat Yai data notes: municipality, zones, communities, population, waste, flood

Scope: เทศบาลนครหาดใหญ่ (Hat Yai City Municipality), Songkhla. Built by
`npx tsx scripts/data/fetch-hatyai.ts` (see "Reproducing" at the end). All Thai text is
UTF-8. Years are Gregorian (BE − 543); Thai fiscal year FY BE n = (n−544)-10-01 .. (n−543)-09-30.
Every figure keeps its definition: generated, collected and utilised waste are never mixed.

Final state: last full rebuild `npx tsx scripts/data/fetch-hatyai.ts --offline` on 2026-11-04 (local) from raw files retrieved 2026-11-03T18:08Z-23:06Z (UTC); the OSM community-candidate query, the Songkhla `dataset_sw_02` check and the PMC article HTML were re-fetched on 2026-11-03T23:06Z with `--offline --fetch=…`. Every output below exists, parses and was re-validated (zones tiling, anchors, contract properties).

## Outputs

| File | Content | Status |
| --- | --- | --- |
| `public/data/hatyai/municipality.geojson` | 1 polygon, OSM relation 19981578 (admin_level 7), 20.883 km² | `geometryStatus: "osm"` |
| `public/data/hatyai/zones.geojson` | 4 polygons `hy-z1`..`hy-z4` (เขต 1-4) tiling the municipality | `geometryStatus: "approximate"` (demo partition, not official) |
| `public/data/hatyai/communities.geojson` | 1 verified point (ชุมชนไทยโฮเต็ล, เขต 3) of 103 communities | `geometryStatus: "osm"` |
| `data/staged/hatyai-communities.json` | 103 communities, zone, verbatim Thai names, printed area/population/households per community | names observed; figures observed (as printed) |
| `data/staged/hatyai-population.json` | DOPA registered population 2021-2025, zone sums of printed community figures | observed / derived |
| `data/staged/hatyai-waste.json` | dataset_sw_02 scope check, Songkhla-catalog LAO waste (generated / collected / utilised), PCD province context, PMC12247160 claim | observed / derived / estimated |
| `data/staged/hatyai-flood.json` | Nov 2025 flood (ThaiWater/HII) as `FloodEvent` + details; 2000/2010 floods as references | observed / manual-reference |
| `data/staged/hatyai-sources.json` | `SourceRef[]` (12 entries) | — |
| `data/staged/hatyai-ingest-report.json` | checks (name verification, tiling, landmark validation), fetch log | — |
| `data/raw/_manifests/fetch-hatyai.json` | per-file retrieval log (URL, HTTP status, bytes, sha256, time) | — |

Manual inputs (both verifiable against the cached PDFs):
`data/manual/hatyai-communities-official-list.json` (103 names by zone) and
`data/manual/hatyai-boundary-notice-transcriptions.json` (figures from scanned announcement pages).

## 1. Municipality boundary — `municipality.geojson`

- Overpass search of `boundary=administrative|local_authority` relations in bbox (6.95,100.40,7.08,100.55)
  returned 4 relations: อำเภอบางกล่ำ, อำเภอหาดใหญ่, อำเภอนาหม่อม (admin_level 6 = district/amphoe) and
  **relation 19981578 `เทศบาลนครหาดใหญ่` / name:en "Hatyai city municipality", admin_level 7** — the
  municipality, not the amphoe (Hat Yai district is 660 km² per the municipality site) or a tambon.
- Geometry: 1 outer ring, 0 inner rings; geodesic area **20.883 km²** vs **21 km²** stated on
  https://www.hatyaicity.go.th/content/general ("มีขนาดพื้นที่ 21 ตารางกิโลเมตร"). OSM base timestamp
  2026-05-31T22:37:44Z, retrieved 2026-11-03T18:58:43Z.
- Caveat: the relation is tagged `fixme=approximate please verify` and
  `description=traceing from https://ratchakitcha.soc.go.th/documents/1658230.pdf` (Royal Gazette). Hence
  `geometryStatus: "osm"`, not "official". License ODbL-1.0.
- Properties: `id: "hy-muni"`, `nameTh`, `nameEn`, `geometryStatus`, `sourceId: "osm-hatyai-municipality"`,
  `areaKm2` plus OSM tags, official area and retrieval metadata.

## 2. Community-management structure — `hatyai-communities.json`

**Official naming.** The community list (cate/258) and map (cate/259) name the zones **"เขต 1" … "เขต 4"**.
The 2022-2023 boundary announcements number them "เขตที่ ๑ … ๔" and say the municipality consists of
"พื้นที่การเลือกตั้ง ๔ เขตเลือกตั้ง ๑๐๓ ชุมชน" (the zones are the 4 municipal electoral districts).
`nameTh` = "เขต N", `nameThOfficialAlt` = "เขตที่ ๑ (เขตเลือกตั้ง)" etc., `nameEn` = "Zone N" (our rendering).

**Count: 103 communities — verified three ways.**
- https://www.hatyaicity.go.th/content/cate/258 ("รายชื่อชุมชน") links 4 PDFs "ข้อมูลประธานกรรมการชุมชน เขต 1-4"
  (data as of **1 ตุลาคม 2569 = 2026-10-01**): 28 + 29 + 25 + 21 = **103** rows.
- https://www.hatyaicity.go.th/content/cate/259 links "แผนที่เขตเทศบาลนครหาดใหญ่ ผังรวม 103 ชุมชน.pdf"
  (map "แผนที่ชุมชนภายในเขตเทศบาลนครหาดใหญ่ จำนวน 103 ชุมชน", revised 14 พ.ย. 2565 = 2022-11-14).
- The 4 announcements "ประกาศเทศบาลนครหาดใหญ่ เรื่อง (การแบ่ง)แนวเขต(พื้นที่)ชุมชน เขต 1-4" state 28 / 29 / 25 / 21.
- https://www.hatyaicity.go.th/content/general has no community count (the page is marked
  "อยู่ระหว่างปรับปรุงข้อมูล").

**Names — verified exactly against the official PDFs.** Names are stored verbatim (Thai digits kept as the
PDF encodes them; `nameThNormalized` converts digits/spaces). The earlier ingest report listed 56 "mismatches"
between the manual names and the PDF text layer (e.g. manual ชุมชนหน้าสวนสาธารณะ vs text layer
ชุมชนหนาสวนสาธารณะ, ชุมชนป้อม 6 vs ชุมชนปอม 6). These were **extraction artefacts**: the PDFs' Thai font
places tone marks / mai han-akat / thanthakhat through Private-Use-Area glyph variants (U+F705, U+F706,
U+F70A-U+F70C, U+F70E, U+F710 occur in the 4 PDFs, e.g. `หนา` = หน้า), which the first extraction
dropped. With those code points mapped to standard Unicode (`puaToThai`), **all 103 manual names equal the
text layer exactly (0 mismatches)** — the manual names are the correct ones. No English names are
published (`nameEn: null`).

**Per-community figures (status "observed", as printed).** From the boundary announcements on cate/259
(zone 2 announced 8 Nov 2022; zones 1 and 3 on 18 Jan 2023; zone 4 on 22 May 2023 — the day numbers are
handwritten): "พื้นที่ (โดยประมาณ)" in m² and km², "ประชากร จำนวน N คน (ชาย / หญิง)", "จำนวนครัวเรือน",
and the N/S/E/W boundary description. Zone 2, zone 4 and the first zone-3 information page have a text
layer (51 communities parsed automatically); all 28 zone-1 pages and 23 zone-3 pages are scans, transcribed
manually (51 communities; spot-checked again on 2026-11-04 by re-rendering zone 1 p.4 and zone 3 p.6 — both
match the transcription exactly).
**102 of 103** communities have figures; ชุมชนรัตนวิบูลย์ (เขต 3) has a map page but no information page.
The announcements give **no reference date or counting method**; these are not DOPA counts.
Flagged printed anomalies (kept as printed, never silently corrected):
`hy-c1-05` and `hy-c1-06` households > population; `hy-c1-08` printed total "๑,๖๐๐๕" malformed (total left
null, male+female = 1,605); `hy-c2-12` total 1,178 ≠ male+female 1,198; `hy-c3-09` female "๗๓๐๖๙๖"
malformed (left null); `hy-c3-12` total 1,301 ≠ 1,311; `hy-c3-18` households 1,553 > population 1,119
(identical to ชุมชนทุ่งเสา, probable copy error).

Zone sums (derived; printed community figures):

| Zone | Communities | Population sum (communities) | Households sum | Printed area sum |
| --- | --- | --- | --- | --- |
| เขต 1 | 28 | 33,852 (27 of 28) | 15,921 (28) | 8.530 km² |
| เขต 2 | 29 | 33,896 (29) | 20,856 (29) | 5.920 km² |
| เขต 3 | 25 | 33,498 (24) | 17,142 (24) | 4.201 km² (24) |
| เขต 4 | 21 | 36,800 (21) | 14,516 (21) | 3.949 km² |

Total of printed community populations: 138,046 persons (101 communities) — compare DOPA 146,528
(2022-12-31) / 143,733 (2023-12-31). The printed areas sum to ~22.6 km² (> 21 km²): they are "approximate"
figures and must not be used as polygon areas.

Privacy: chairperson names and phone numbers in the source PDFs are deliberately not reproduced.

## 3. Community points — `communities.geojson`

Only OSM features whose name contains the full official community name (Thai marks ignored), or `place=*` nodes whose name equals it, inside the municipality polygon are accepted; nothing is geocoded by guesswork. Overpass query `community-candidates` (features with `name~ชุมชน`, any `place=*`, `amenity=community_centre` in the municipality bbox ± 0.005°; retrieved 2026-11-03T23:06:33Z from overpass-api.de after 2 timeouts and one HTTP 502 on the other endpoints; OSM base 2026-11-03T23:05:10Z) returned 18 elements.

- **Accepted (1):** `hy-c3-19` **ชุมชนไทยโฮเต็ล** (เขต 3) = OSM node/4367170491 "ศูนย์สาธารณสุขมูลฐานชุมชนชุมชนไทยโฮเต็ล" (amenity=doctors) at 100.4631368, 6.9969764 — a community primary-health-care post, *not* a surveyed community centroid (`locationKind` says so). It falls in approximate zone 3, consistent with the official list.
- **Rejected (2):** node/4367168697 "ศูนย์สุขภาพชุมชนวัดท่าเคียน" and node/4467282116 "บ้านท่าไทร" (village) only share a bare place name with ชุมชนท่าเคียน / ชุมชนท่าไทร and lie outside the municipality.
- The other 102 communities have `location.status: "unavailable"` in `hatyai-communities.json`. No authoritative published coordinates exist (the 103-community map is a PDF drawing without coordinates).
- Note: an older cached response (2 elements, 2026-11-03T18:12Z) did not match the current query (it lacked e.g. the `place=city` node 297328621); it was replaced by the re-fetch above. Result unchanged (1 point).

## 4. Zones — `zones.geojson` (APPROXIMATE demonstration partition)

No machine-readable official zone polygons were found (the municipality publishes the zones only as a
scanned/vector PDF map and textual boundary descriptions), so `geometryStatus: "approximate"`.

**Geographic basis.** The official 103-community map draws the เขต 1-4 limits along (a) the main southern
railway line, (b) ถนนเพชรเกษม and, in the south-east, (c) ถนนศรีภูวนารถ and (d) ถนนกาญจนวณิชย์; the
announcements' boundary descriptions confirm these lines (e.g. ชุมชนบ้านพักรถไฟ, เขต 2: N ถนนเพชรเกษม,
S ถนนศรีภูวนารถ, W แนวเขตรถไฟ; ชุมชนขนส่ง, เขต 3: E แนวถนนกาญจนวนิชย์).

**Deterministic method** (full text in `properties.method`): OSM ways (railway=rail without `service`;
highway named ถนนเพชรเกษม [secondary], ถนนศรีภูวนารถ, ถนนกาญจนวณิชย์; Overpass `zone-lines`, retrieved
2026-11-03T18:59:27Z) are chained by Dijkstra shortest path over shared node ids (end-node gaps ≤ 120 m
bridged). Each path is closed into a half-plane polygon with a frame; with M = municipality polygon,
N = north of ถนนเพชรเกษม, W = west of the railway, Q = south of ศรีภูวนารถ and west of กาญจนวณิชย์:
เขต 4 = M∩N∩W, เขต 1 = (M∩N)−W, เขต 3 = (M−N)∩(W∪Q), เขต 2 = (M−N)−(W∪Q). Parts < 20,000 m² that are not a
zone's largest part would be merged into the neighbour sharing the longest edge (none occurred).
Path sizes: railway 123 nodes, เพชรเกษม 271, ศรีภูวนารถ 61, กาญจนวณิชย์ 94 (ศรีภูวนารถ end snapped 16.8 m to
กาญจนวณิชย์).

| id | nameTh | communityCount | area (km²) | anchor [lon, lat] |
| --- | --- | --- | --- | --- |
| hy-z1 | เขต 1 | 28 | 4.954 | 100.481404, 7.023394 |
| hy-z2 | เขต 2 | 29 | 6.684 | 100.481827, 7.006547 |
| hy-z3 | เขต 3 | 25 | 4.976 | 100.462287, 6.997519 |
| hy-z4 | เขต 4 | 21 | 4.270 | 100.458887, 7.016194 |
| sum | | 103 | 20.883 | |

**Tiling check** (`checks.zones.tiling`, before rounding / `tilingWritten`, as published with 1e-7° ≈ 1 cm
coordinates): pairwise overlap 0 m²; each zone is a single polygon without self-intersections; before rounding the gap is 0.118 m² and the area outside the municipality 0.022 m²; on the published coordinates the gap is 1.967 m² and outside 0.582 m² (sum of zones 20,882,970.8 m² vs municipality 20,882,972.2 m²)
— i.e. the 4 zones tile the municipality up to coordinate-rounding slivers (< 1e-6 of the area).
An independent re-check with turf on the published files gives the same picture.

**Validation (not used to build zones):** 9 of 9 named OSM landmarks whose zone can be read from the
official map fall in the expected approximate zone (ตลาดกิมหยง → 2, โรงพยาบาลหาดใหญ่ ×2 → 1,
โรงเรียนหาดใหญ่วิทยาลัย → 1, วัดคลองเรียน → 2, วัดโคกสมานคุณ → 4, วัดหาดใหญ่ใน → 4, สนามกีฬาจิระนคร ×2 → 1).
`communityCount` (28/29/25/21) comes from the official list; zone polygons must still be labelled
"approximate" in the UI — the true limits follow small roads/sois that are not modelled.
`anchor` = interior label point (centroid if ≥ 150 m inside, else farthest-from-edge grid point).

## 5. Population — `hatyai-population.json`

DOPA yearly files `https://stat.bora.dopa.go.th/new_stat/file/<YY>/stat_a<YY>.txt` (pipe-separated, UTF-8),
registration office **9098 ท้องถิ่นเทศบาลนครหาดใหญ่**, December (year-end) counts:

| Reference date | Total | Male | Female | Houses |
| --- | --- | --- | --- | --- |
| 2025-12-31 (6812) | **138,582** | 63,674 | 74,908 | 70,982 |
| 2024-12-31 (6712) | 140,851 | 64,864 | 75,987 | 70,703 |
| 2023-12-31 (6612) | 143,733 | 66,182 | 77,551 | 70,431 |
| 2022-12-31 (6512) | 146,528 | 67,536 | 78,992 | 68,976 |
| 2021-12-31 (6412) | 149,142 | 68,793 | 80,349 | 68,701 |

Registered (de jure) population; excludes unregistered residents, students, migrant workers and tourists.
Derived density 2025: 6,636.1 persons/km² on the OSM area (20.883 km²), 6,599.1 on the official 21 km².
Not used: PMC12247160's "approximately 191 696 in 2024" (cites "Statistical Yearbook Thailand 2024";
inconsistent with DOPA's 140,851 for 2024-12-31) and the municipality page's undated "~7,542 persons/km²
(21 km²)" / "~20,000 persons/km² in the centre" (text only). No official zone populations are published;
zone values are derived sums of the printed community figures (see §2).

## 6. Waste — `hatyai-waste.json`

**(a) data.go.th `dataset_sw_02`** (CKAN `package_show`, HTTP 200): title "ปริมาณขยะมูลฝอยขององค์กรปกครองส่วนท้องถิ่น",
organisation **สำนักงานจังหวัดนครศรีธรรมราช**, data year 2569, geo coverage อำเภอ, licence "Open Data Common",
source "ระบบสารสนเทศการจัดการมูลฝอยของกรมส่งเสริมการปกครองท้องถิ่น". Resource CSV (184 rows, 23 districts;
columns District, LAO_name, MSWG, CDSW, HMSW, USW, UMSW, Organic waste, Recyclable waste, total) covers
**Nakhon Si Thammarat LAOs only — no Hat Yai / Songkhla rows**. The same id on the Songkhla provincial
catalog returned **HTTP 404** (songkhla.gdcatalog.go.th `package_show?id=dataset_sw_02`, re-checked 2026-11-03T23:06:34Z). Status: not applicable to Hat Yai.

**(b) Songkhla provincial data catalog (songkhla.gdcatalog.go.th), LAO = เทศบาลนครหาดใหญ่**, publisher
สำนักงานท้องถิ่นจังหวัดสงขลา, source "รายงานผลแบบสำรวจเพื่อจัดทำฐานข้อมูลด้านการบริหารจัดการขยะมูลฝอยชุมชนของ อปท.",
licence Open Data Common. Published unit ตัน/ปี; t/day is derived (÷ days in the fiscal year).

| Quantity (definition) | Dataset | FY (period) | t/year (observed) | t/day (derived) |
| --- | --- | --- | --- | --- |
| **Generated** — ปริมาณขยะมูลฝอยชุมชนที่เกิดขึ้น | dataset_10_27 | FY2565 (2021-10-01..2022-09-30) | 101,002.212 | 276.72 |
| Generated | dataset_10_27 | FY2566, FY2567 | empty cell → unavailable | — |
| **Collected** — ปริมาณขยะมูลฝอยชุมชนที่เก็บขนได้ในเขต อปท. | dataset_10_33 | FY2564 (2020-10-01..2021-09-30) | 68,180.77 | 186.80 |
| Collected | dataset_10_33 | FY2565 | 67,193.63 | 184.09 |
| Collected | dataset_10_33 | FY2566, FY2567 | empty → unavailable | — |
| **Utilised** — ปริมาณขยะมูลฝอยที่ถูกนำไปใช้ประโยชน์ | dataset_10_34 | FY2564 / FY2565 | 34,080.973 / 28,613.292 | 93.37 / 78.39 |

Derived per capita (generated FY2565 / DOPA 2021-12-31 = 149,142): 1.855 kg/person/day. The collected
dataset's "ครัวเรือนรับเก็บขยะ" column (807,588 / 740,289) is implausible as a household count (DOPA ~69,000
houses) and is kept but not used. The three quantities are reported independently and need not add up.
Province context (dataset_10_37, PCD, Songkhla province, t/day): generated 1,140.3 (2020), 1,236 (2021),
1,207 (2022), 1,599 (2023) … — province scope only.

**(c) PMC12247160** — Thongham, Khongprom & Sangsubun (2025), "Multiscale characterization of commercial
and landfill-recovered plastics in Songkhla province, Thailand", *RSC Advances* 15(30):24424-24434,
doi:10.1039/d5ra03620h, PMID 40656571, published 2025-07-11, CC BY 3.0. Read via NCBI E-utilities efetch XML;
the article HTML (https://pmc.ncbi.nlm.nih.gov/articles/PMC12247160/) was served normally on 2026-11-03T23:06:34Z (HTTP 200, 183,591 bytes, no CAPTCHA) and contains the same sentence (cross-check only; a CAPTCHA page would never be bypassed).
- **Verified quote** (section 2.1 "Site specification"): "The city produces approximately 237.75 tons of
  household waste per day." — reference 32 = "Hat Yai Municipality, Annual Waste Management Report 2024,
  2024, [in Thai]" (not found online).
- **Period: not stated** (cited report is dated 2024; presumably 2024/FY2567 but the article does not say).
  **Scope:** Hat Yai Municipality (the site description: 21.00 km²), *household* waste, wording = generated
  ("produces"); inclusion of commercial/tourism waste not stated. **Method: not stated** — it is background
  information, not a result of the study (the study measures commercial PE/PP/PET/PVC and PE recovered from a
  local landfill in Songkhla province).
- Stored as `status: "estimated"` (cited figure), never "observed". Context (derived): 1.688 kg/person/day on
  DOPA 2024 (140,851) or 1.240 on the article's 191,696; LAO survey FY2565 generated = 276.72 t/day.
- **Composition: unavailable.** The article has no composition table for Hat Yai (its only tables are
  mechanical properties of plastics and FTIR); the text ranks components qualitatively (organic largest, then
  plastic, then glass and metal) citing UNEP's 2023 regional outlook. No shares can be mapped to
  organic/plastic/paper/glassMetal/hazardous/other, so no Hat Yai composition is published (`shares: null`).

**(d) Municipality statistics:** no machine-readable collected-waste statistics found on hatyaicity.go.th;
the "Annual Waste Management Report 2024" was not located.

## 7. Flood — `hatyai-flood.json`

Source: ThaiWater / Hydro Informatics Institute (สสน.) "บันทึกเหตุการณ์น้ำท่วมอำเภอหาดใหญ่และพื้นที่ภาคใต้ตอนล่าง
ช่วงเดือนพฤศจิกายน 2568" — summary, rain_tele, waterlevel, waterlevel_songkhla, flood_area, damage pages under
https://www.thaiwater.net/uploads/contents/current/2025/hatyai_nov2025/ (all HTTP 200, 2026-11-03T19:26Z).
No explicit licence on the pages. Numbers are kept exactly as published.

- **Event `hy-flood-2025-11`**, 2025-11-19 .. 2025-11-28: two waves, 19-21 Nov and 23-28 Nov 2025
  (waterlevel_songkhla).
- **คลองอู่ตะเภา at X.44 บ้านหาดใหญ่ (ต.หาดใหญ่):** overbank from late night 23 Nov to morning 27 Nov 2025
  (4 days 17 h); peak **9.97 m MSL (ม.รทก.)**, stated as the highest compared with the 2000 (2543) and 2010
  (2553) floods (Thai and English text both say 9.97; time of peak not stated). Other stations: X.174
  คลองหวะ 5 d 14 h (21-27 Nov), X.90 บ้านบางศาลา 5 d 18 h, X.173A บ้านม่วงก็อง 5 d 11 h.
- **Peak inflows into อ.หาดใหญ่ (RID, m³/s, wave 1 / wave 2):** คลองวาด >145/>145, คลองต่ำ >100/>100,
  คลองอู่ตะเภา (from อ.สะเดา) 624 / 2,700, คลองหวะ 443 / >465, เขาคอหงส์ >90/>90; combined outlet capacity
  (คลอง ร.1 + คลองอู่ตะเภา) 1,721 m³/s.
- **Rainfall (mm):** peak daily among stations named หาดใหญ่ or in อ.หาดใหญ่ = **370.2 mm on 2025-11-21 at
  TMD station "หาดใหญ่" (ต.ทุ่งลาน อ.คลองหอยโข่ง — outside the municipality)**; also 363 mm (บ้านวังพา, DWR,
  21 Nov), 359.6 mm (สะพานข้ามคลองอู่ตะเภา, HII, 24 Nov). No listed station is in ต.หาดใหญ่; the table only
  lists > 90 mm/day. 10-day totals 17-26 Nov 2025 (column header; the table title says "7 วัน"): TMD หาดใหญ่
  1,285 mm, สะพานข้ามคลองอู่ตะเภา 1,199.2 mm, คอหงษ์ สกษ. 1,135 mm. Regional maximum daily 624.2 mm (นราธิวาส,
  22 Nov). The flood_area page's "630 mm in 3 days vs 428 mm in 2010" is attributed to "some sources"
  (บางแหล่งข้อมูล) and is not used as a metric.
- **Affected (DDPM report of 2025-11-30, period 17-30 Nov):** southern region 12 provinces, 117 districts,
  778 sub-districts, 5,938 villages, 1,514,895 households, 3,901,155 persons, 169 deaths; Songkhla 16 districts,
  127 sub-districts, 992 villages, 331 communities, 633,105 households, 1,319,536 persons, 131 deaths.
  GISTDA satellite flood area 825,365 rai in 9 provinces (Songkhla 331,821 rai).
- **Earlier floods:** 2000 (2543) and 2010 (2553) recorded as `manual-reference` only — ThaiWater cites them as
  the most-cited major Hat Yai floods and says Nov 2025 exceeded both at X.44; dates, rainfall and peak levels
  for 2000/2010 are not given there and are left null (no other source cited).

## 8. Sources, licences and failures

`hatyai-sources.json` holds 12 `SourceRef` entries: hatyaicity-community-list, hatyaicity-boundary-notices,
hatyaicity-general, osm-hatyai-municipality, osm-hatyai-community-features, hatyai-zones-approx,
dopa-stat-population, datagoth-dataset_sw_02, songkhla-gdcatalog-lao-waste, songkhla-gdcatalog-pcd-province,
pmc-12247160, thaiwater-hatyai-nov2025.

| Item | Result |
| --- | --- |
| Songkhla catalog `dataset_sw_02` | **failed — HTTP 404** (id does not exist there); data.go.th `dataset_sw_02` retrieved but is Nakhon Si Thammarat only |
| Overpass `community-candidates` | 3 failed attempts (HTTP 502 overpass-api.de 1st round, timeouts kumi.systems / private.coffee), 4th attempt HTTP 200; earlier run (between 2026-11-03T18:59Z and 19:26Z) failed on all 6 attempts (HTTP 502/504/timeouts) |
| Hat Yai "Annual Waste Management Report 2024" (cited by PMC) | not found online — not retrieved |
| Machine-readable official zone polygons | none published — zones are approximate |
| Community coordinates | none published; 1 of 103 verifiable via OSM |
| Hat Yai waste FY2566-FY2567 | empty cells in the Songkhla catalog CSVs → unavailable |
| Hat Yai waste composition | not published in any retrieved source → unavailable |
| Scanned announcement pages (zone 1, 23 zone-3 pages) | no text layer → manual transcription |

Licences: OSM ODbL-1.0; data.go.th / Songkhla catalog "Open Data Common" (dataset_10_37: not specified);
PMC article CC BY 3.0; municipality website, DOPA statistics and ThaiWater pages state no open licence.

## Caveats

- Zone polygons are an approximate demonstration partition (label in UI); only the municipality boundary
  is an (OSM) administrative polygon, itself tagged "approximate please verify".
- Community figures are 2022-2023 announcement figures without reference date or method; zone population
  sums are partial (101 of 103 communities) and differ from DOPA by definition.
- Latest Hat Yai waste quantities in the open catalog are FY2564-FY2565; FY2566-2567 cells are empty.
  237.75 t/day (PMC) is a secondary citation without period or method. No Hat Yai composition is available.
- Flood rainfall stations named "หาดใหญ่" are not inside the municipality; X.44 is.
- Manual transcriptions (names, scanned figures) were made by an AI assistant from the official PDFs and
  checked automatically (text layer / total = male + female); verify before official use.

## Reproducing

```
npx tsx scripts/data/fetch-hatyai.ts               # network-first for small files, cache-first for large PDFs
npx tsx scripts/data/fetch-hatyai.ts --offline     # rebuild everything from data/raw (+ data/manual)
npx tsx scripts/data/fetch-hatyai.ts --offline --fetch=community-candidates   # offline except listed keys
```
PDF text layers are extracted read-only with macOS PDFKit (`scripts/data/lib/hatyai-pdftext.jxa.js`) and
cached in `data/raw/hatyaicity/text/`, so `--offline` also works where osascript is unavailable.
