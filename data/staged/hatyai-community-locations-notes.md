# Hat Yai community locations: notes

Script: `scripts/data/fetch-hatyai-community-locations.ts`

```
npx tsx scripts/data/fetch-hatyai-community-locations.ts            # cache-first (downloads only what is not cached)
npx tsx scripts/data/fetch-hatyai-community-locations.ts --offline  # cached raw files only (output identical apart from generatedAt)
npx tsx scripts/data/fetch-hatyai-community-locations.ts --refresh  # re-download everything
```

Inputs (read-only): `data/staged/hatyai-communities.json` (103 official communities, names and zone assignment, printed household and population figures), `public/data/hatyai/zones.geojson` (approximate demonstration partition into เขต 1–4), `public/data/hatyai/municipality.geojson` (OSM relation 19981578).

## Outputs

| File | Content |
|---|---|
| `public/data/hatyai/communities.geojson` | 103 Point features: **1 verified** and **102 illustrative**. Properties follow `CommunityProps`, plus extra match or placement details. The FeatureCollection has a `metadata` member with both methods, the counts and the checks. |
| `data/staged/hatyai-community-locations-report.json` | Overpass query, Nominatim parameters, thresholds, verified match, every rejected candidate with its reason (27 name-rule rejections, 0 location-rule rejections), and placement statistics for each zone and overall |
| `data/staged/hatyai-community-locations-sources.json` | `SourceRef[]`: 4 new ids, plus 4 reused ids copied verbatim from `hatyai-sources.json` |
| `data/raw/hatyai-community-locations/` | Raw cache: `overpass-named-features.json` and `nominatim/<staged id>.json` (103 files) |
| `data/raw/_manifests/fetch-hatyai-community-locations.json` | URL, HTTP status, bytes, sha256 and retrievedAt for each raw file |

### Feature properties

| Property | Verified | Illustrative |
|---|---|---|
| `id` | `hy-c-<zone>-<seq>`, e.g. `hy-c-3-19` (seq is the 2-digit order in the official zone list) | same |
| `stagedId` | id in `hatyai-communities.json`, e.g. `hy-c3-19` | same |
| `nameTh` / `nameEn` | verbatim official Thai name / `null` (the municipality publishes no English names) | same |
| `zoneId` / `zoneNo` | `hy-z1`..`hy-z4` / 1..4 (official zone assignment) | same |
| `locationStatus` | `"verified"` | `"illustrative"` |
| `method` | which OSM object, rule, confidence and zone check | states that this is an illustrative placement, not a real location |
| `households` / `population` | as printed in the 2022–2023 boundary announcements, or `null` | same |
| `sourceId` | `osm-hatyai-community-location-match` | `hatyai-community-illustrative-placement` |
| `statsStatus`, `statsSourceId` (`hatyaicity-boundary-notices`), `statsSourceUrl`, `statsSourcePage`, `statsNote`, `statsAnomalies?`, `boundaryNoticeNameTh?` | provenance of households and population | same |
| `osmId`, `osmName`, `osmNameTag`, `osmKind`, `matchMethod`, `matchRule`, `confidence`, `foundBy`, `locationKind`, `zoneDistanceM`, `insideAssignedZone`, `insideMunicipality`, `license` | match evidence | — |
| `placement` {slot, jitterM, edgeDistanceM, nearestNeighbourM, seed} | — | placement details |
| `labelTh` / `labelEn` | "ตำแหน่งจาก OpenStreetMap (ตรวจชื่อและเขตแล้ว)" / "Location from OpenStreetMap (name and zone checked)" | **"ตำแหน่งสาธิต ไม่ใช่พิกัดจริง" / "Illustrative position — not a real location"** |

## What was retrieved

1. **Overpass API** (`https://overpass-api.de/api/interpreter`, HTTP 200, 888,722 bytes, retrieved 2026-11-04T01:50:12Z, OSM base 2026-11-04T01:49:58Z). The query covers every node, way and relation that has `name`, `name:th`, `official_name`, `alt_name`, `old_name`, `short_name` or `loc_name`, inside the municipality bbox buffered by 0.005° (6.9823,100.4238,7.0533,100.5112), with `out tags center bb`. It returned **2,681 elements** and 522 Thai name variants. Because this covers every named OSM object in the area, it is the complete set of possible OSM matches.
2. **Nominatim** (`https://nominatim.openstreetmap.org/search`). Each official community name was searched once, for 103 queries in total. Parameters: `format=jsonv2`, `limit=10`, `viewbox=<bbox>`, `bounded=1`, `countrycodes=th`, `namedetails=1`, `extratags=1`, `accept-language=th`. Requests were sequential and at most 1 per second, with UA `UrbanIntelligenceDemo/0.1 (research prototype)`, and results are cached so they are never requested again. All 103 queries returned HTTP 200 (01:50:58Z–01:52:50Z) with only **5 results in total**. Those 5 were the same two OSM health-post nodes returned by fuzzy matching. The name rules below were applied to Nominatim's `namedetails`, not to its ranking.

Nothing failed. No API keys or authentication were used.

## Verification rules (deterministic)

**Normalisation** of both the OSM name and the official name: NFC; zero-width characters removed; Thai digits converted to Arabic; `ํา` converted to `ำ`; `ร.พ./รพ.` expanded to `โรงพยาบาล` and `ร.ร.` to `โรงเรียน`; punctuation and whitespace removed for comparison, with word breaks kept for the boundary test. The tone-insensitive variant also drops ็ ่ ้ ๊ ๋ ์ ํ ๎.

**Name rules** (official name = list name or the variant spelling in the boundary announcement):

- **N1**: the OSM name equals the official name, including "ชุมชน". Confidence: high.
- **N2**: an OSM `place=neighbourhood|quarter|suburb|hamlet|village|…` or `landuse=residential` feature is named exactly the official name without "ชุมชน". Confidence: high.
- **N3**: the OSM name contains the full official name, including "ชุมชน", and the match ends at a word break or at the end of the name. Confidence: medium.
- A match that holds only when tone marks are ignored lowers confidence by one level. **Only high and medium matches are accepted.**
- **Rejected and logged**: names that contain only the bare place name. A temple, school, road, intersection, shop or village named after the place is not evidence of where the community is (for example วัดท่าเคียน, โรงพยาบาลศิครินทร์หาดใหญ่, หอนาฬิกา, บ้านท่าไทร). Also rejected: names that run past the official name without a word break.

**Location rules**: the point must lie inside the OSM municipality polygon **and** inside, or within 150 m of, the community's assigned (approximate) zone polygon. Ways and relations must have a bbox diagonal of 800 m or less.

**Ambiguity**: a community is rejected if its accepted candidates lie more than 300 m apart. When one OSM object matches several communities, the more specific (longer) official name wins; a tie is rejected as ambiguous.

### Result

| Community | Zone | OSM | Evidence |
|---|---|---|---|
| ชุมชนไทยโฮเต็ล (`hy-c-3-19`) | 3 | node/4367170491 "ศูนย์สาธารณสุขมูลฐานชุมชนชุมชนไทยโฮเต็ล" (`amenity=doctors`) | N3, confidence medium. Found by both Overpass and Nominatim. Inside the municipality and inside the เขต 3 polygon. This is a **community health post named after the community**, not a surveyed community centroid (`locationKind`). |

The other 102 communities have no OSM feature carrying their name. Hat Yai's OSM data has no `place=neighbourhood/quarter` features for the municipal communities, and its only `community_centre` is a meditation centre. The 27 bare-name candidates and the reason for each rejection are listed in the report under `nameRuleRejections`.

## Illustrative placement (102 communities): ESTIMATE / DEMONSTRATION, NOT DATA

This step is deterministic and does not depend on randomness, time or iteration order.

1. **Lattice.** For each zone, build a hexagonal lattice with 25 m spacing over the zone polygon. Keep only points inside both the zone and the municipality polygon that are at least 60 m from both edges and at least 120 m from every verified point.
2. **Initial positions.** Choose N positions by farthest-point (maximin) sampling, where N is the number of illustrative communities in the zone. The score is `min(distance to chosen or verified points, 2 × edge distance)`, so the boundary counts as half a spacing. Ties go to the lowest lattice index.
3. **Relaxation.** Run 12 iterations of discrete centroidal-Voronoi (Lloyd) relaxation over the lattice. Verified points stay fixed and own their own cells. Each centroid snaps to the nearest admissible lattice point. The relaxed set is used only if its minimum spacing is at least 120 m and at least 80% of the maximin spacing.
4. **Assignment.** Communities are assigned to positions in the order of SHA-256(nameTh). This order is deliberately non-geographic, so a position says nothing about where a community actually is.
5. **Jitter.** A jitter of up to 12% of the nominal spacing √(zone area / N) is seeded by `mulberry32(first 32 bits of SHA-256(nameTh))`. It is accepted only if every constraint still holds, with up to 8 tries at shrinking radius; otherwise there is no jitter.
6. **Rounding.** Coordinates are rounded to 6 decimals. All checks are recomputed after rounding, and the script **refuses to write** if any check fails.

Checks (in `metadata.checks` and the report):

- 103 features with unique ids; per zone 28/29/25/21, matching the official counts.
- Every illustrative point is inside its own zone and inside the municipality.
- Minimum edge distance is 87.6 m (required: 60 m).
- Minimum distance between any illustrative point and any other point is 259.8 m (required: 120 m).
- Nominal spacing per zone is 420 / 479 / 445 / 450 m.

## Caveats

- **Only zone membership is real for illustrative points.** Do not use their positions for distance, exposure, flood or routing analysis, and always show the label "ตำแหน่งสาธิต ไม่ใช่พิกัดจริง".
- The zone polygons are themselves an *approximate demonstration partition* (`hatyai-zones-approx`), so "inside its zone" means inside the approximate zone.
- The verified point is a facility named after the community, not a community centroid.
- `households` and `population` are printed figures from the Nov 2022 – May 2023 boundary announcements. The reference date and counting method are not stated, and they are not DOPA registration counts. Printed anomalies are kept as published and flagged in `statsAnomalies`: hy-c-1-05, hy-c-1-06 and hy-c-3-18 have households greater than population; hy-c-2-12 and hy-c-3-12 have a total that differs from male + female. Population is `null` for ชุมชนกอบกาญจน์ศึกษา (printed total malformed) and both figures are `null` for ชุมชนรัตนวิบูลย์ (no information page).
- OSM data © OpenStreetMap contributors, ODbL-1.0. Results reflect OSM as of 2026-11-04. A future OSM edit that adds community features would be picked up by `--refresh`.
- Chairperson names and phone numbers are not included.

## Integration notes

- Add `hatyai-community-locations-sources.json` to the staged source list in `scripts/data/build-datasets.ts`. Its reused ids are identical copies, so de-duplication is safe. Then re-run build-datasets so `public/data/manifest.json` gets the new sha256: `validate-data.ts` currently reports `sha256 mismatch for hatyai/communities.geojson`.
- The source id `osm-hatyai-community-features` is no longer referenced by `communities.geojson`.
- **`scripts/data/fetch-hatyai.ts` also writes `public/data/hatyai/communities.geojson`** (the old file with only the verified point). Run `fetch-hatyai-community-locations.ts` after it, or remove that write.
- UI: show `labelTh`/`labelEn` (or test `locationStatus === "illustrative"`) in the tooltip and legend, and style the two statuses differently, for example a hollow marker for illustrative points.
