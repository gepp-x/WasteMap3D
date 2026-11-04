# Waste data gaps: Bangkok generated waste, district composition and Hat Yai composition

Script: `scripts/data/fetch-waste-gaps.ts`

- Run `npx tsx scripts/data/fetch-waste-gaps.ts` to fetch politely and fall back to the cache.
- Add `--offline` to use only cached raw files.
- Two offline runs produced byte-identical outputs (md5 checked). Timestamps come from `data/raw/_manifests/fetch-waste-gaps.json`.
- Each run writes its fetch attempts to `data/raw/_manifests/fetch-waste-gaps-attempts.json`.

Raw cache: `data/raw/pcd/`, `data/raw/psu/`. Inputs reused read-only:
- `data/staged/bangkok-waste.json`: BMA collected tonnes by district, FY2562–FY2569.
- `data/staged/bangkok-composition.json`: BMA FY2565 citywide composition.
- `data/raw/pmc/hatyai/PMC12247160.html`.

| Output | Content | Status |
|---|---|---|
| `data/staged/bangkok-generated.json` | PCD Bangkok **generated** t/day (BE 2556–2568) plus a district allocation for BE 2562–2568 | city: `observed`; districts: `estimated` |
| `data/staged/bangkok-district-composition.json` | 50 districts with the FY2565 city composition applied, plus per-disposal-centre reference tables | districts: `estimated`; centre tables: `derived` |
| `data/staged/hatyai-composition.json` | Hat Yai-specific composition (PSU/TSRI report, Aug 2021) | `derived` |
| `data/staged/waste-gaps-sources.json` | SourceRef[] (18 entries) | — |

---

## 1. Bangkok waste generated (PCD)

### Retrieved
PCD community solid-waste information system (ระบบสารสนเทศด้านการจัดการขยะมูลฝอยชุมชน):
- Page: `https://thaimsw.pcd.go.th/report_country.php?year=<BE>`. All years returned HTTP 200 with no login or CAPTCHA.
- Table used: "ปริมาณขยะมูลฝอยจำแนกตามจังหวัด", row **กรุงเทพมหานคร**, unit **ตัน/วัน** as published.
- Bangkok province page `report_province.php?year=<BE>&province=1` gives annual totals in million tonnes. It was used as a cross-check.

| PCD year (BE) | Year | Generated t/day | Utilised | Disposed correctly | Disposed incorrectly | Annual (Mt, published) |
|---|---|---|---|---|---|---|
| 2556 | 2013 | 11,335 | 1,410 | 9,925 | 0 | – |
| 2557 | 2014 | 10,800 | 1,600 | 9,200 | 0 | – |
| 2558 | 2015 | 11,500 | 1,310 | 10,190 | 0 | – |
| 2559 | 2016 | 11,530 | 1,320 | 10,210 | 0 | – |
| 2560 | 2017 | 13,327 | 2,738 | 10,589 | 0 | – |
| 2561 | 2018 | 13,240.49 | 2,521.87 | 10,718.62 | 0 | – |
| 2562 | 2019 | 13,583.48 | 3,029.98 | 10,553.50 | 0 | 4.96 |
| 2563 | 2020 | 12,281.70 | 3,672.50 | 8,609.20 | 0 | 4.50 |
| 2564 | 2021 | 12,214 | 3,564 | 8,650 | 0 | 4.46 |
| 2565 | 2022 | 12,890 | 3,840 | 9,050 | 0 | (blank on PCD page) |
| 2566 | 2023 | 12,748 | 3,940 | 8,808 | 0 | 4.65 |
| 2567 | 2024 | 12,847 | 3,940 | 8,907 | 0 | 4.69 |
| **2568** | **2025** | **13,254** | 3,592 | 9,662 | 0 | 4.84 |
| 2569, 2570 | — | all-zero rows (not yet reported) → **unavailable**, not 0 | | | | |

### Cross-checks
- **PCD annual PDF reports agree exactly.**
  - The BE 2566 report (`pcdnew-2024-05-09…pdf`, table p. 34) gives "กรุงเทพมหานคร 12,748 3,940 8,808 0".
  - The BE 2564 report (`pcdnew-2022-08-18…pdf`, p. 9) gives "กรุงเทพมหานคร 12,214 ตันต่อวัน".
  - The PDFs (45–51 MB) were deleted after their text layers were cached in `data/raw/pcd/text/` (with sha256 headers). Their hashes and sizes are in the manifest.
  - A third PCD PDF (`pcdnew-2023-05-23…pdf`, 58.9 MB) is scanned with no text layer. It was not parsed, its edition year is unconfirmed, and it was deleted. It is recorded as `failed`.
- **Accounting identity.** In every year, generated = utilised + disposed correctly + disposed incorrectly. PCD's Bangkok "generated" is therefore constructed from those parts, not measured at source.
- **Annual vs t/day.**
  - × 365 reproduces the published million tonnes for 2562, 2564, 2566, 2567 and 2568.
  - × 366 reproduces it for 2563.
  - PCD's divisor is not stated and is not applied consistently (2567 is also a leap year but matches 365). Only the t/day values are used.
- **PCD vs BMA collected** (BMA FY with the same BE number):
  - PCD "disposed correctly" matches BMA collected to within about ±1% in most years (2568: 9,662 vs 9,560.56).
  - BMA collected ÷ PCD generated was 0.88–0.92 in 2556–2559 and 0.69–0.78 in 2560–2568 (2568: **0.7213**).
  - The gap is mostly PCD's "utilised" (recycled or sold at source).

### Reference period
- PCD labels the year "ปี พ.ศ. …" and does not say whether it is a calendar or fiscal year.
- The BE 2566 report footnote says the generation figures come from DLA reporting, "ข้อมูล ณ กุมภาพันธ์ 2567".
- Stored as `referenceYear` = BE − 543. `observedFrom`/`observedTo` are deliberately left unset.

### District allocation (`estimated`)
- **Formula:** district generated (t/day) = PCD Bangkok generated (year Y) × (district collected tonnes ÷ Σ collected tonnes of the 50 district offices, BMA fiscal year BE Y).
- **Weights:** the BMA annual tonnages (`valuePublished`, sum of 12 monthly tonnages) are used, not the rounded t/day values.
- **"Others" row is NOT included** in the denominator.
  - In FY2568 it was 136,664.82 t, 3.92% of the BMA grand total of 3,489,604.87 t.
  - It is waste delivered by sources other than the 50 district offices and cannot be located in a district.
  - Its share is therefore spread pro rata, and the 50 district values sum to the **full** PCD city total. There is no "unallocated" row.
- **Rounding:** integer hundredths of a t/day, using the largest-remainder method (ties by DOPA code order). Σ districts = 13,254.00 exactly for 2568. Every year 2562–2568 also sums exactly (`checks.everyYearSumEqualsCityTotal: true`).
- **FY matching:** PCD BE Y is paired with BMA FY BE Y (1 Oct → 30 Sep). If PCD uses calendar years, the overlap is 9 of 12 months. This is the closest BMA district table available.
- **2568 result:**
  - Largest: Chatuchak 499.01, Bang Kapi 477.54, Bang Khun Thian 445.98 t/day.
  - Smallest: Samphanthawong 63.84, Pom Prap Sattru Phai 94.38, Bangkok Yai 102.93 t/day.
- **Limitations:**
  - The method assumes generation share equals collected share.
  - Districts with more recycling at source, or with less collection coverage, are misallocated.
  - No district generation survey exists.

## 2. Bangkok district-level composition (`estimated`)

**Method:** "city composition applied; district surveys unavailable".
- Every one of the 50 districts receives the BMA FY2565 citywide shares (1 Oct 2021 → 30 Sep 2022): organic 54.1, plastic 21.0, paper 11.6, glassMetal 3.1, hazardous 0.0, other 10.2.
- The script re-maps the 14 source categories, re-rounds them, and asserts they equal `bangkok-composition.json`.

**Zone (กลุ่มเขต) research.** BMA does **not** publish composition by district group or by district.
- Pages checked:
  - BMA Environment Department composition pages: `webportal.bangkok.go.th/environmentbma/page/sub/20995` and `/28232` (cached by `fetch-bangkok.ts`).
  - The data.bangkok.go.th composition CSV.
  - Web searches in Thai.
- What BMA does publish is composition **by disposal centre** (ศูนย์กำจัดมูลฝอย On Nut / Nong Khaem / Sai Mai) for FY2563 and FY2564.
- No official district → disposal-centre assignment was found. News reports describe temporary diversions of some districts to On Nut, so the assignment also changes over time.
- Applying centre tables to districts would therefore need an invented mapping, so they are **not** applied.
- They are kept as reference in `zoneResearch.disposalCentreTables` with status `derived`. They were transcribed from the scanned PDFs (no text layer); every column is verified to sum to 100.00, and the average columns match the staged city history.

| FY | Centre | organic | plastic | paper | glassMetal | hazardous | other |
|---|---|---|---|---|---|---|---|
| 2563 | On Nut | 48.0 | 25.3 | 15.9 | 2.7 | 0.0 | 8.1 |
| 2563 | Nong Khaem | 53.0 | 20.8 | 13.5 | 4.6 | 0.0 | 8.1 |
| 2563 | Sai Mai | 52.5 | 21.6 | 12.6 | 3.8 | 0.0 | 9.5 |
| 2564 | On Nut | 50.5 | 22.7 | 13.5 | 3.5 | 0.0 | 9.8 |
| 2564 | Sai Mai | 51.3 | 23.6 | 12.2 | 3.4 | 0.0 | 9.5 |
| 2564 | Nong Khaem | 56.0 | 22.3 | 10.5 | 2.4 | 0.0 | 8.8 |

(Values come from the JSON output; see the file for unrounded shares. FY2564 footnote: in Jul–Aug 2564 samples were taken only at On Nut because of COVID-19.)

## 3. Hat Yai composition (`derived`, Hat Yai-specific)

1. **PMC12247160 (re-checked).**
   - The cached HTML has one table (mechanical properties of plastics) and no composition table, and no food/organic percentage appears in the text.
   - The article ranks components only qualitatively. It is not usable.
2. **Used: PSU / TSRI final research report ENV6405051S.**
   - Title: "การศึกษาแนวทางการสร้างชุมชนขยะเป็นศูนย์ ด้วยการแปลงขยะเป็นพลังงาน" (Feasibility Study of Waste to Energy for Sustainable Zero Waste Community).
   - Authors: PSU Faculty of Environmental Management. Funded by TSRI in FY2564.
   - URL: `https://kb.psu.ac.th/psukb/bitstream/2016/19489/1/64052245_400371.pdf`. Retrieved with HTTP 200 (2,992,818 bytes, 51 pages) and parsed from the PDF text layer.
   - Quote (p. 27, also in the executive summary on p. 3): "ปริมาณขยะที่เกิดขึ้นในเขตเทศบาล 200 ตัน/วัน มีองค์ประกอบขยะ (ณ เดือน สิงหาคม 2564) ดังนี้ เศษอาหาร ร้อยละ 22 กระดาษ ร้อยละ 12 พลาสติก ร้อยละ 49 แก้ว ร้อยละ 3 โลหะ ร้อยละ 1 ยาง/หนัง ร้อยละ 1 ผ้า ร้อยละ 4 อื่นๆ ร้อยละ 8 …"
   - Scope: Hat Yai City Municipality as a whole. Reference: August 2021. The 8 categories sum to 100.
   - Mapping:
     - organic = food 22
     - paper = 12
     - plastic = 49
     - glassMetal = glass 3 + metal 1 = 4
     - other = rubber/leather 1 + textiles 4 + others 8 = 13
     - hazardous = 0.0 (not a source category; e-waste parts sit inside "others")
   - Rounding: largest remainder to 0.1 changes nothing, because the inputs are integers.
   - **Result: organic 22.0, plastic 49.0, paper 12.0, glassMetal 4.0, hazardous 0.0, other 13.0 (sum 100.0).**
   - Caveats (stored in `provenance.limitations`):
     - The report presents these figures as secondary data from municipal operations. Sampling design, sample size and basis (weight or volume) are not stated.
     - Shares are integers.
     - The plastic share of 49% is far above Bangkok (21.0%) and above the PCD national description (organic ≈ 64%). It should be treated as indicative.
3. **Considered and not used:**
   - The same report's landfill-mined waste characterisation (p. 40) describes aged landfill material, and its table is garbled in the text layer.
   - PCD's national 4-class split (organic / recyclable / general / hazardous ≈ 64 / 30 / 3 / 3) cannot be split into plastic, paper and glassMetal without inventing proportions. A national fallback was not needed.

## Failures and HTTP status
- PCD BE 2569 and 2570 pages: HTTP 200, but the Bangkok rows are all zeros, so the years are not yet reported (`unavailable`).
- PCD Bangkok province page for BE 2565: HTTP 200, but the annual summary fields are blank. Only the t/day row is used.
- PCD PDF `pcdnew-2023-05-23_07-53-42_299799.pdf`: HTTP 200, but it is scanned with no text layer (`failed`, not OCR'd).
- No HTTP errors were encountered. A full per-run log is in `data/raw/_manifests/fetch-waste-gaps-attempts.json`.

## Licenses
- PCD web system and reports: license not stated (Thai government publications, public, no login).
- BMA tables: see `bangkok-sources.json`.
- PSU report: institutional repository, license not stated. It is cited, and only percentages are reproduced.

## Integrator hand-off (exact fields)
- `bangkok-generated.json`:
  - `city.wasteGenerated` is a full MetricValue (observed, 13,254 t/day, referenceYear 2025).
  - `citySeries[]` holds `{yearBE, year, generatedTPerDay, status:"observed"}` for wasteHistory (definition "generated").
  - `districts[].wasteGenerated` is a full MetricValue keyed by `code` / `areaId` (`bkk-<code>`), with status `estimated`.
  - `districts[].history[]` holds the estimated generated values for 2019–2025.
  - Use `checks` and `latestAllocation` for validation.
- `bangkok-district-composition.json`: `districts[].composition` is a WasteComposition (`shares` and `provenance`, status `estimated`), keyed by `code` / `areaId`.
- `hatyai-composition.json`: `composition` is a WasteComposition (`shares` and `provenance`, status `derived`). It **supersedes** `hatyai-waste.json → composition` (which said unavailable).
- Register `waste-gaps-sources.json` in `public/data/sources.json`. The `bma-env-*` and `pmc-12247160` entries duplicate IDs already in `bangkok-sources.json` / `hatyai-sources.json` as pointers, so de-duplicate by `id` and prefer the original entries.
