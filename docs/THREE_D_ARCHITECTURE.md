# 3D Digital Twin — Architecture

The 3D twin is the observatory's signature view: the same data, selection and scenario state as the
2D map, rendered as a navigable model of Bangkok (50 districts) and Hat Yai (4 community-management
zones), with a second level of detail that shows real OpenStreetMap buildings around a selected area.

```
src/components/three/          React shells (thin; no per-frame React state)
  DigitalTwinCanvas.tsx        entry: WebGL probe, fallback, <Canvas>, frameloop, quality → canvas
  CityScene.tsx                scene root: frames, LOD switch, geometry cache, OrbitControls
  SceneLighting.tsx            lights / fog / background + rain response
  Ground.tsx                   technical grid, shadow catcher, boundaries
  AreaPrisms.tsx               city prisms (height + colour = active metric), hover / click
  RiskOverlay3D.tsx            risk outlines, selection ring, projects the pinned label
  SelectedAreaLabel.tsx        DOM label for the selection (positioned from useFrame, no drei <Html>)
  Waterways3D.tsx              flow ribbons + water polygons
  BuildingLayer.tsx            neighbourhood buildings / roads / water
  FloodScenario3D.tsx          illustrative flood water
  RainParticles.tsx            GPU rain
  CameraController.tsx         GSAP camera choreography + keyboard navigation
  QualityManager.tsx           tiers, PerformanceMonitor, tier-aware adaptive DPR
  ThreeOverlay.tsx             HTML chrome (scope, camera, quality, legend, credits, tooltip)
  WebglFallback.tsx            unsupported / context-lost card
src/lib/three/                 pure geometry + imperative runtimes
  frame.ts                     coordinate frames (origin, scale, grid)
  area-geometry.ts             polygons → prisms + merged outlines
  building-geometry.ts         merged building extrusion, road classes, height shares
  ribbon-geometry.ts           mitred ribbons, flat polygons
  waterways.ts                 GeoJSON / window water → ribbon & polygon inputs
  area-visuals.ts              metric → height / colour / legend (same breaks as the map)
  flood.ts                     flood visual policy
  quality.ts                   tiers, WebGL2 probe, device heuristics
  ui-store.ts                  edge-triggered state shared by canvas and overlay
  runtime/*.ts                 Atmosphere, GroundField, PrismField, RiskMarkers, WaterField,
                               RainSystem, FloodField, BuildingField, CameraRig
  shaders/*.ts                 grid, water, rain, flood, markers, building-rise
```

**Why imperative runtimes?** Every Three.js object that changes per frame (materials, uniforms,
scales, the camera) lives in a small class (`runtime/*.ts`) created once per component
(`useState(() => new X())` / `useMemo`). React only calls `setTargets()` when data changes and
`tick(dt)` from `useFrame`. The result: no React state per frame, no allocations in the frame loop,
deterministic disposal (`dispose()` in effect cleanups) and code that satisfies the React Compiler
lint rules (which forbid mutating hook-returned objects).

## 1. Coordinates and precision

Geographic lon/lat are **never** used as positions. Each scope has a *frame* (`frame.ts`):

| scope | origin | scale | extent |
|---|---|---|---|
| city | `CITIES[id].center` | fitted so the bbox spans ≈ ±280 units — Bangkok ≈ 1 unit : 118 m, Hat Yai ≈ 1 unit : 16 m | ±280 |
| neighbourhood | `BuildingWindow.origin` | 1 unit = 1 m | ±`halfSizeM` (500) |

`makeProjector(origin)` (equirectangular ENU, < 0.1 % error within 30 km) converts lon/lat to metres
east/north; the frame applies the scale and the Three.js convention **x = east, y = up, z = −north**.
Polygon shapes are built in planar (east, north) space and rotated −90° about X, which maps
north → −z and the extrusion axis → +y. Vertex magnitudes stay below ~1 000, so float32 precision is
sub-centimetre in the neighbourhood and sub-metre at city scale; both scopes share the same camera,
fog and rain tuning because their extents are similar.

The camera target defaults to the bbox centre (`frame.center`), not the origin, so asymmetric
cities (Bangkok's bbox extends further east of its nominal centre) are framed correctly.

## 2. Levels of detail and scopes

* **City (LOD 0)** — one extruded prism per area from `bundle.areasGeo` (Polygon/MultiPolygon,
  holes supported, Ramer–Douglas–Peucker simplified at 0.08 units). Prisms are *unit height*;
  data heights are applied through `mesh.scale.y`, so scenario playback never rebuilds geometry.
  Geometry sets are cached per city (`AreaGeometryCache`) and disposed with the scene.
* **Neighbourhood (LOD 1)** — `public/data/buildings/<areaId>.json` (a ~1 km OSM window in local
  metres). All footprints are merged into **one** indexed BufferGeometry by a custom extruder
  (walls with outward normals and darker bases, roofs via `ShapeUtils.triangulateShape`, winding
  normalised from the signed area). Roads are one merged ribbon mesh; water lines/areas reuse the
  water shaders.

`store.threeScope` is the *requested* scope; `ui-store.displayScope` is what is rendered. The
camera rig performs a two-phase dolly (push toward the area in the city frame → swap → descend into
the neighbourhood frame, and the reverse), so the frame change happens off-screen in motion.
Neighbourhood requires a selected area; the toggle is disabled (with an explanatory tooltip)
otherwise, and clearing the selection returns to the city. A missing window file shows a notice and
falls back to the city scope.

## 3. Data encoding (same rules as the map)

`area-visuals.ts` uses `layerMetric(activeChoropleth)` (fallback `primaryWasteMetric`) and
`areaMetric()` with live `useScenario()` results, so prisms, legend, tooltip and 2D map agree:

* **height** ∝ value / max (linear from zero); modelled risk uses score / 100. Null → a flat slab,
  neutral colour and "ยังไม่มีข้อมูล / Unavailable" in every readout — never 0.
* **colour** — quantile classes over the metric ramp (`quantileBreaks`, step at ≥ break, like the
  map); risk uses the four class colours. Data materials are `toneMapped: false` and the light
  budget is tuned so a roof renders ≈ 0.94 × its legend colour.
* status (observed / derived / estimated / simulated) is shown with `StatusBadge` in the legend
  and tooltip; simulated values are always labelled. Observed data is never mutated.
* The legend states that prism height encodes the value, not physical height. Hat Yai community
  zones with `geometryStatus: "approximate"` are labelled wherever their shapes are shown
  (legend, tooltip, credits).

## 4. Materials and shaders

| element | material | notes |
|---|---|---|
| prisms | `MeshStandardMaterial` per area (one program) | colour/emissive eased in `PrismField.tick`; polygon offset keeps outlines crisp |
| top outlines | `ShaderMaterial` on ONE `LineSegments` | `aArea` attribute + `uHeights[AREA_COUNT]`/`uColors[]` uniform arrays → one draw call for all areas, heights animate on the GPU |
| risk outlines | same outline shader at ground level | High / Very High areas in risk colours while a scenario/replay is active |
| selection | ring shader on the roof | three ripples, then a static ring (lets the canvas idle) |
| ground | grid shader | fwidth anti-aliased minor/major lines, LOD fade (no moiré), radial fade around the target, fog |
| waterways | flow shader | `uv.x` = distance along the line, streaks scroll in the digitised (downstream) direction in three jittered lanes; rain speeds/brightens the flow |
| buildings | `MeshStandardMaterial` + `onBeforeCompile` | rise-in `transformed.y *= smoothstep(uRise·1.6 − aDist·0.6)`; risk tint via uniform (no rebuild during playback) |
| flood | fresnel water shader | translucent, slow shimmer, radial edge fade for the neighbourhood sheet |

Renderer: ACES Filmic tone mapping, sRGB output, `stencil: false`. Environment materials (water,
buildings, flood) are tone mapped; data materials and the grid are not, so legend colours and the
page background match exactly.

## 5. Rain technique

`RainSystem` draws `LineSegments` with two vertices per drop. The `position` attribute holds a
per-drop seed (x, phase, z ∈ [0, 1)), `aEnd` marks head/tail. The vertex shader computes the fall
phase from `uTime`, wraps drops toroidally inside a box centred on the orbit target (world-stable as
the camera pans), slants them by `uWind`, and fades them at the box edges and near the ground —
**zero CPU work per drop**. Counts by tier: high 18 000, balanced 8 000, low 2 500, 0 when effects
are off. `useScenario().visualIntensityMmH` maps to a 0–1 level (`(mm/h ÷ 60)^0.7`: none, ~5 light,
~15 moderate, ~35 heavy, 60+ extreme) that drives density, speed, length, opacity and slant with an
exponential ease in/out. Under reduced motion the streaks hold still (density still conveys
intensity).

The same level drives the **environmental response** (`Atmosphere`): background and fog shift to a
deeper navy, visibility shrinks, the key light dims and cools — all lerped between preallocated
colours. The response is capped so data colours remain readable in a storm.

## 6. Illustrative flood policy

`flood.ts` decides *whether* water appears; nothing in the pipeline computes or displays a depth.

* Water is shown only when a scenario or historical replay is active **and** the live model puts the
  relevant area(s) at **High / Very High** (score ≥ 50).
* City scope: up to 12 highest-risk areas get a translucent water band hugging the prism base (the
  prism's own extrusion, inflated 1.5 % and scaled to the visual level).
  Neighbourhood scope: a sheet across the building window for the selected area.
* Visual level = monotonic mapping of the risk score (purely a metaphor), eased in over ≈ 2.5 s.
* While any water is visible the overlay always shows
  `COMMON.illustrativeFlood` — "ภาพจำลองน้ำท่วม 3 มิติเชิงสาธิต — ไม่ใช่การพยากรณ์ความลึกน้ำท่วมเชิงพื้นที่ /
  Illustrative 3D Flood Scenario — Not Geospatial Flood-Depth Prediction" — with simulated styling.

## 7. Rendering loop and quality tiers

* `frameloop = "never"` when `active === false` (canvas stays mounted), `"always"` only while rain,
  flowing water or flood shimmer animate, otherwise `"demand"`. Transient animations (prism easing,
  building rise, selection pulse, camera tweens) call `invalidate()` from `useFrame`/GSAP
  `onUpdate` until they settle. `dt` is clamped to 0.1 s so idle gaps never cause jumps.
* Tiers (`quality.ts`):

| tier | DPR | AA | shadows | rain | building cap |
|---|---|---|---|---|---|
| high | 1–2 | on | one directional light, PCF, 2048², frustum fitted to the frame | 18 000 | all |
| balanced | 1–1.5 | on | off | 8 000 | 15 000 |
| low | 0.75–1 | off | off | 2 500 | 2 000 largest footprints |

* `quality: "auto"` → a throw-away WebGL2 probe (renderer string, texture limit, cores, memory,
  touch/screen) sets a starting tier and a ceiling; drei `PerformanceMonitor` steps the tier down/up
  (never above the ceiling) and is mounted only during continuous rendering (on-demand frames are
  sparse by design and would read as low fps). Explicit modes map 1:1.
* Antialiasing is a context-creation flag, so the canvas is re-created when an explicit mode changes
  it (auto mode keeps the probed setting; the establishing shot is not replayed).
* Adaptive DPR: OrbitControls `regress` lowers `performance.current` while moving; a tier-aware
  variant of drei's `AdaptiveDpr` scales the *current tier's* DPR (drei's version restores the
  creation-time DPR, which would undo tier changes).

## 8. Disposal and memory

Every runtime owns its geometries/materials and frees them in `dispose()` from effect cleanups:
prism materials and outline shaders per geometry set, cached city geometry sets with the scene,
building/road/water buffers whenever the window changes, rain buffers when the tier changes, the
shadow map when its size changes, GSAP timelines on unmount (`CameraRig.dispose`). No collection
grows unbounded: flood bands are removed once receded, the geometry cache holds at most one entry
per city.

## 9. State sync with the map

All coordination goes through the dashboard store: `selectedAreaId`, `hoveredAreaId` (3D hover
highlights the map and vice versa — hover changes reach the prisms through a store subscription,
not React re-renders), `focusNonce` (ranking/map selection → 3D focus tween), `cameraPreset` +
`cameraNonce`, `threeScope`, `activeChoropleth`, `layers.waterways`, scenario/timeline state via
`useScenario()`, `effectsEnabled`, `reducedMotion`. The overlay and the canvas share only
edge-triggered UI state (`ui-store.ts`: displayed scope, flood visible, building stats, notices).

## 10. Camera

drei `OrbitControls` (`makeDefault`, damping 0.08, `maxPolarAngle` 1.45, scope-specific min/max
distance, ground-plane panning, zoom-to-cursor, target clamped near the content). `CameraRig`
tweens `camera.position` and `controls.target` with GSAP timelines (power3.inOut,
`DURATION.camera`; establishing shot `DURATION.cityFlight`). Controls are disabled and their damping
inertia cleared for the duration of a tween, timelines are killed before a new one starts and on
unmount, and reduced motion applies poses instantly. Keyboard (stage focused): arrows orbit/tilt,
Shift + arrows pan, +/− zoom, 0 / Home overview, Esc clears the selection.

## 11. Accessibility

The stage is a focusable region with a keyboard description; every overlay control is a real
button with an accessible name, visible focus ring and tooltip; the disabled neighbourhood toggle
stays focusable (`aria-disabled`) so its explanation is reachable by keyboard. Status is always
glyph + text, never colour alone. Reduced motion (OS or in-app) makes camera moves instant, freezes
rain/water/flood shimmer and skips the building rise; `effectsEnabled = false` removes rain and stops
the flow animation.

## 12. Limitations

* **Building heights** — OSM `height` or `building:levels × 3.2 m` where tagged, otherwise a
  deterministic estimate; the overlay states the tagged/estimated split for every window and
  estimated buildings are drawn in a muted tone.
* **OSM completeness** varies by district; missing footprints are not inferred.
* **Hat Yai zones** are approximate community-management partitions (labelled); their prisms are
  illustrative shapes, not official boundaries.
* **Waterway widths** at city scale are exaggerated to a minimum on-screen width for legibility;
  flow direction follows OSM digitisation (normally downstream).
* **Flood water** is a visual metaphor of a modelled score — not a hydraulic simulation and not a
  depth prediction.
* The selection label is DOM-based (Thai shaping without font atlases). It is a plain element beside
  the canvas that RiskOverlay3D projects each rendered frame (transform + data-show writes), not drei
  `<Html>`, whose nested React root is unmounted synchronously inside the R3F commit and makes React
  warn about a race. 3D text labels for every area are intentionally omitted to keep the scene calm.

## 3D City mode (MapLibre + Three.js custom layer)

A second, continuous 3D view that sits on the 2D map stage. Open it with **เมือง 3D / 3D City** in the view switcher, or press `4`.

| Piece | Implementation |
|---|---|
| Building massing | MapLibre `fill-extrusion` on the OpenFreeMap / OpenMapTiles `building` layer (`render_height`, `render_min_height`), coloured by height (`src/components/map/City3DMode.tsx`). It covers the whole city continuously from zoom 13.5. |
| Roads, canals, rivers | The basemap's own vector layers (real OSM geometry), plus the app's waterway and drainage overlays. |
| Glowing building edges | A Three.js custom layer (`src/lib/map/city3d.ts`) that shares MapLibre's GL context and camera. Edges are rebuilt from loaded building tiles (`querySourceFeatures`) after each camera move or tile load (debounced, never on `idle`). Roof outlines are bright and corners softer. There is no depth test, by design, which gives the wire-frame "see-through" city look. The cap is 240k vertices. |
| Precision | Vertices are stored in metres around a local origin that re-centres on every rebuild. The model matrix is `translate(origin mercator) · scale(m→mercator, y flipped)`, multiplied with `defaultProjectionData.mainMatrix` in float64. |
| Rain | The same custom layer draws GPU line streaks, animated only in the vertex shader. Density follows `useScenario().visualIntensityMmH`. It is frozen under reduced motion and off when visual effects are disabled. |
| Illustrative flood | A `fill-extrusion` of the area polygons. Its height comes from feature-state `flood` = 0.4 m + (score − 50)/50 × 2.2 m, only for areas modelled High or Very High during a scenario or historical replay. The disclaimer **Illustrative 3D Flood Scenario — Not Geospatial Flood-Depth Prediction** is shown whenever the sheet is visible. |
| Camera | Entering flies to the selected area's anchor (or the current view, or the city centre) at zoom ≥ 15.3, pitch 62°, bearing −24°. Selecting an area while in the mode flies to that area's anchor without leaving the oblique view. Leaving the mode eases back to a flat view. |
| Fallback | The mode needs the online basemap. When offline, the heads-up panel says so and points to the 3D digital twin, which uses bundled OSM windows. |

Limitations:
- Heights are OSM-tagged where available; otherwise they are OpenMapTiles defaults or estimates.
- Coverage follows OSM completeness, so outer districts have fewer buildings.
- Edges are drawn for the loaded tiles around the view, not the whole city at once.
