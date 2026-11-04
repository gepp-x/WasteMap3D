# Performance and Leak Audit: WebGL, Runtime and Memory

This audit measures the 3D digital twin (three.js / React Three Fiber) and the 2D map (MapLibre) on the production build. It covers frame rate, interaction frame times, memory growth, WebGL resource lifetimes, listeners, DOM size and React commit rates.

*Audit date: 4 Nov 2026 (BE 2569). Build: `next start -p 3123`. Browser: Playwright Chromium 1.64.*

---

## 1. Summary

| Area | Result |
|---|---|
| three.js GPU resources (geometries, textures, programs, buffers, VAOs) | **No leak.** Flat across 10 neighbourhood open/close cycles, 30 city switches, 20 scenario presets, 10 × 2D↔3D and 12 quality changes. |
| WebGL contexts | **No leak.** At most 2 live contexts (map + twin). Probe contexts are released immediately. A Canvas re-created for an anti-aliasing change frees its old context; `WebGLRenderer` objects are garbage-collected (16 created, 1 alive). |
| JS heap (after forced GC) | **Plateaus.** It grows while caches fill (city bundles, MapLibre tiles), then stays flat: 2D city switch ×30 ends at +0.5 MB over the last 12 switches; 3D city switch ×30 ends at −0.8 MB over the last 6. |
| DOM nodes / event listeners | **Stable.** 2 481 – 2 824 nodes, depending on the open panels. Window listeners stay at 89 – 92 and document listeners at 149 in every loop. |
| Frame loop while the 3D canvas is hidden | **Correct.** In 2D view the twin renders 0 frames per second (`frameloop="never"`). |
| React re-render storms | **None.** About 0 – 0.4 commits/s at idle and about 2 commits/s while orbiting. Each scenario preset costs 2 react-dom commits and 1 R3F commit. Timeline replay costs 1.6 – 3.7 commits/s (it is throttled to ≤ 15 Hz by design). |
| **Defects found** | **2 major, 3 minor.** See §4. |

---

## 2. Method

### Environment

- Apple M1, 8 cores, macOS. Headless Chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`.
- Viewport 1440 × 900 at DPR 1. The twin canvas is 726 × 638 px.
- **SwiftShader rasterises on the CPU, and other agents were running builds and tests at the same time (load average 12 – 20).** Absolute FPS values are therefore far below real hardware and noisy. Read the **trends and A/B ratios**, not the absolute numbers.
- The CPU profiles show the main thread **60 – 90 % idle** even at 2 – 5 fps. The bottleneck is the GPU process (SwiftShader), not the page's JavaScript.

### Instrumentation

All of it is injected with `context.addInitScript`. The app has no debug hooks, and none were added.

| Probe | How |
|---|---|
| three.js renderers and scenes | `window.__THREE_DEVTOOLS__ = new EventTarget()`. three dispatches `observe` from the `WebGLRenderer` and `Scene` constructors. Renderers are held in `WeakRef`s so the probe cannot cause a leak. Readings use `renderer.info.memory` (geometries, textures), `info.programs.length` and `info.render` (calls, triangles, frame). |
| WebGL objects per context | Wrappers on `WebGL2RenderingContext.prototype` for `create*`/`delete*` (Buffer, Texture, Program, Framebuffer, Renderbuffer, VertexArray, Shader) give live counts per context. `bindBuffer` + `bufferData` give buffer bytes. `texStorage2D`/`texImage2D` give approximate texture bytes (4 B/texel, base level). `draw*` and `clear` calls are counted per context to detect rendering. Contexts are labelled by canvas: `map` (`.maplibregl-canvas`), `three` (connected canvas) or `probe` (detached). |
| Context count | `HTMLCanvasElement.prototype.getContext` wrapper. A context is live when it is in a `WeakRef` and `!isContextLost()`. |
| React commits | A stub `__REACT_DEVTOOLS_GLOBAL_HOOK__` counts `onCommitFiberRoot` calls per renderer (`react-dom` and `@react-three/fiber`). |
| Frame times | An in-page `requestAnimationFrame` sampler records p50/p95/p99/max frame time and rAF fps. Over the same window it records the twin's frames/s from `info.render.frame`, the map's `clear`/s, commits/s and `longtask` entries. |
| Memory | CDP `HeapProfiler.collectGarbage` (×2), then `Performance.getMetrics` for `JSHeapUsedSize`, `Nodes` and `JSEventListeners`. `DOMDebugger.getEventListeners` gives counts on `window` and `document`. |
| Hot spots | CDP `Profiler` (500 µs sampling) during idle and replay. Wrappers on `renderer.setSize`/`setPixelRatio` and on `linkProgram`/`getProgramInfoLog` time the hitches. |

The app is driven only through its UI:
- keys `1`/`2`/`3`, `/` + search and `s`;
- the city radiogroup;
- the scope buttons "เมือง/ย่าน";
- the quality button;
- the preset cards;
- the timeline play button.

All screenshots were inspected; every scene rendered correctly (§6).

---

## 3. Results

### 3.1 Frame rate (SwiftShader, auto quality → detected tier *Low*)

These are single runs on a loaded machine, so read them as relative values.

| Scenario | rAF fps | frame p50 / p95 (ms) | Twin fps | Hidden map clears/s | Twin draws/s | Commits/s |
|---|---|---|---|---|---|---|
| 2D idle (flow + pulse ticker) | 8.4 | 16.7 / 217 | — | 5.6 (visible) | — | 0 |
| 2D pan drag | 4.8 | 233 / 383 | — | 8.6 (visible) | — | 0.24 |
| 2D wheel zoom | 2.5 | 483 / 683 | — | 3.6 (visible) | — | 0 |
| 3D city idle (water flowing) | 5.0 | 50 / 600 | 5.0 | **3.9** | 274 | 0.32 |
| 3D city orbit drag | 6.7 | 33 / 533 | 6.7 | **4.5** | 369 | 2.24 |
| 3D city, Extreme Rain | 4.3 | 83 / 900 | 4.3 | **3.3** | 294 | 1.33 |
| 3D neighbourhood (Chatuchak), Normal | 4.6 | 67 / 817 | 4.6 | **3.8** | 88 | 0 |
| 3D neighbourhood, Extreme Rain | 2.6 | 433 / 1 100 | 2.6 | **2.6** | 21 | 0 |
| 3D neighbourhood orbit, Extreme Rain | 4.8 | 33 / 783 | 4.8 | **2.3** | 39 | 2.08 |

Draw calls per frame are low. City scope uses 55 – 68 calls (one per prism, plus outlines, water and rain). Neighbourhood scope uses 8 – 10 calls, because all buildings are merged into one mesh.

### 3.2 Quality tiers (Extreme Rain, same session)

The device DPR is 1, so every tier renders the canvas at 726 × 638. The tiers differ in anti-aliasing, shadows, rain count and building cap.

| Scope @ tier | Twin fps | Draw calls | Triangles | Programs | Approx. texture MB (all contexts) |
|---|---|---|---|---|---|
| City @ Low | 3.2 | 68 | 73 541 | 7 | 0.94 |
| City @ Balanced | 2.8 | 68 | 73 541 | 11 | 0.94 |
| City @ High | 1.9 | 119 (shadow pass) | 91 039 | 10 | **32.9** (2048² shadow map) |
| Neighbourhood @ Low | 2.7 | 8 | 3 799 | 7 | 1.36 |
| Neighbourhood @ Balanced | 1.9 | 8 | 3 799 | 10 | 1.36 |
| Neighbourhood @ High | 3.1 | 10 | 5 876 | 10 | **33.4** |

Cycling quality 12 times (each anti-aliasing flip re-creates the Canvas) gave these counts:
- `webgl2` contexts created rose from 15 to 19;
- live contexts stayed at 2, and live renderers at 1;
- twin context objects stayed flat (buffers 26, textures 7, programs 9).

### 3.3 Leak loops (values after forced GC)

**Neighbourhood open/close across 10 districts:** พระนคร, ดุสิต, บางรัก, ปทุมวัน, จตุจักร, บางกะปิ, พระโขนง, ลาดกระบัง, ยานนาวา, หนองจอก.

| After close # | Heap MB | Nodes | Twin ctx: buffers / MB / textures / VAOs / programs | three geometries / textures | Map ctx buffers / MB |
|---|---|---|---|---|---|
| start (city) | 36.6 | 2 583 | 163 / 3.22 / 5 / 54 / 5 | 54 / 1 | 333 / 9.0 |
| 1 | 39.2 | 2 315 | 169 / 3.22 / 5 / 56 / 7 | 56 / 1 | 697 / 15.2 |
| 5 | 45.1 | 2 319 | 169 / 3.22 / 5 / 56 / 7 | 56 / 1 | 1 694 / 37.3 |
| 10 | 51.1 | 2 324 | **169 / 3.22 / 5 / 56 / 7** | **56 / 1** | 3 062 / **65.2** |

- The twin is perfectly flat; each neighbourhood window's merged geometry is disposed on close.
- The heap and the map context keep growing because the **hidden** 2D map flies to each selected district and caches its tiles (§4.5).

**City switch:**

| Loop | Start → end heap MB | Twin ctx | Map ctx buffers MB | Nodes / listeners |
|---|---|---|---|---|
| 3D ×30 | 36.6 → 45.6 (6) → 47.5 (12) → 50.7 (18) → 51.9 (24) → **51.1 (30)** | flat: buffers 177 / 3.43 MB, programs 6 | 9 → 31.4 → **31.2** (plateau) | 2 601 / 864 – 882 (flat) |
| 2D ×30 | 28.7 → 35.7 → 37.9 → 40.5 → 40.6 → **41.1** | — | 3.3 → 29 → **32.7** (plateau) | 2 499 / 795 – 798 (flat) |

**2D↔3D ×10:**
- Heap: 36.1 → 37.5 MB, +0.14 MB per cycle and slowing (37.28 → 37.53 over the last 6 cycles).
- Nodes stayed at 2 589 throughout.
- Contexts stayed at 2.
- The twin stayed at 54 geometries and 5 programs.
- A further split↔3D ×6 ended at 37.9 MB.

**Scenario presets ×20 (3D):**
- Heap: 35.8 → 40.4 (5) → 41.7 (10) → 42.1 (15) → **42.4 (20)**.
- Programs: 5 → 7, after the rain and flood materials compiled once.
- Buffers: 328, flat.
- Each preset cost 2 react-dom commits and 1 R3F commit.

**2D selection of 30 different districts (map only):** map buffer MB went 51.8 → 63.1 → 73.5 → 77.4 → 84.3 → **87.2**. The growth slows down (+11, +10, +4, +7, +3 MB per 5 selections). It is MapLibre's bounded tile cache settling near 90 MB, not a leak, but the footprint is large (§4.5).

### 3.4 Hidden and idle rendering

| State | Twin fps | Map clears/s | Verdict |
|---|---|---|---|
| 2D, twin mounted but inactive | **0** | 4.0 (visible) | ✔ `frameloop="never"` works |
| 2D with Extreme Rain, twin inactive | **0** | 3.5 | ✔ |
| 3D, map behind (`visibility:hidden`) | 4.4 | **3.5** | ✘ the hidden map keeps rendering (§4.1) |
| 3D, reduced motion, baseline, 3 / 6 / 10 s | **0** | 0 | ✔ demand mode is idle (rAF 60 fps) |
| 3D, waterways off (nothing continuous) | **0** | 0 | ✔ |
| 3D, reduced motion + Extreme Rain, 2 / 6 / 12 s | **9.4 / 10.7 / 9.8** | 0 | ✘ renders every frame indefinitely (§4.2) |

A background tab (another tab brought to the front) could not be tested. Headless Chromium reports `visibilityState: "visible"` for background tabs and keeps running rAF. In a real browser, rAF is suspended in hidden tabs, and the map ticker and timeline already check `document.hidden`.

### 3.5 CPU profile, timeline replay

Total time per category over a 6 s window:

| Window | Idle | Page JS (all chunks) | Notes |
|---|---|---|---|
| 2D idle | 90 % | < 0.5 % | — |
| 2D historical replay | 88 % | ≈ 5 % | GC 1.1 %. No hot React or ECharts function above 0.7 %. |
| 3D idle | 66 % | — | 1 417 ms (26 %) in `WebGLRenderer.setSize`, from the DPR oscillation (§4.4) |
| 3D replay (first time) | 61 % | — | 1 305 ms in `getProgramInfoLog` and 441 ms in `getShaderInfoLog`: synchronous shader compile (§4.3) |

---

## 4. Findings

### 4.1 [Major] The hidden 2D map renders at ≈ 15 fps behind the 3D view

**Where:** `src/components/map/MapLayers.tsx`, effect 8 (the `createTicker(FX_FPS, …)` loop).

**Cause:**
- The decorative flow/pulse ticker calls `map.triggerRepaint()` 15 times a second.
- Its guard is `canvas.clientWidth === 0`. A `SceneLayer` hidden with `visibility: hidden` keeps its layout width, so the guard never fires in 3D view.
- MapLibre therefore re-renders the full vector basemap and all overlays behind an opaque twin.

**Evidence:**
- In 3D view the map context still issues 2.3 – 4.5 `clear`/s and 280 – 550 draws/s (§3.1 and §3.4).
- A/B test in one session, 4 alternating 5 s repetitions per arm. Arm B makes the guard true by overriding the map canvas `clientWidth` to 0 in-page.

  | 3D city | Twin fps median (A current) | Twin fps median (B ticker skipped) | rAF p50 ms, A → B |
  |---|---|---|---|
  | baseline (water flowing) | 3.2 | **16.1 (×5.0)** | 100 → 67 |
  | Extreme Rain | 3.05 | **10.2 (×3.3)** | 275 → 83 |

  On real GPUs the ratio will be smaller, but this is still a whole extra map render pipeline at 15 Hz in 3D view, costing battery and GPU time on laptops and tablets.

**Fix:**
- Gate `flowOn`/`pulseOn` on the map being shown, for example `const mapShown = useDashboard((s) => s.viewMode !== "3d")`.
- Alternatively, skip in the tick when `!canvas.checkVisibility({ visibilityProperty: true })`.
- When the map is revealed, call `triggerRepaint()` once.

### 4.2 [Major] Under reduced motion, an active rain scenario keeps the twin rendering every frame

**Where:** `src/lib/three/runtime/rain.ts`, `RainSystem.tick`, which ends with `return true` whenever rain is visible.

**Cause:**
- `DigitalTwinCanvas` correctly switches to `frameloop="demand"` when `effects && !reduced` is false.
- `RainParticles` calls `state.invalidate()` whenever `tick()` returns true.
- With `animate === false` the streaks are frozen and the level is snapped, yet `tick()` still returns true. Every frame schedules the next one.

**Evidence:**
- Reduced motion + Extreme Rain, 3D city: twin fps 9.4 / 10.7 / 9.8 at 2 / 6 / 12 s after applying the preset, which equals the rAF rate.
- Reduced motion without rain: 0 fps.
- Screenshot: `reduced-extreme.png`.

**Fix:** return `animate || Math.abs(target - this.level) > 0` (still true while fading when animated). The frozen state then draws once per change.

### 4.3 [Minor] First-use shader compile hitch on the first scenario or replay

**Where:**
- the Canvas `onCreated` in `src/components/three/DigitalTwinCanvas.tsx`;
- the rain and flood materials, which are first compiled when a scenario starts.

**Evidence:**
- First Extreme Rain: 2 new twin programs linked. `getProgramInfoLog` time went from 46 to 492 ms, because three checks every program synchronously with `debug.checkShaderErrors === true`. The longest frame was **4 183 ms**.
- The same preset again: 0 new programs, longest frame 1 033 ms.
- The first replay profile shows 1.75 s in `get{Program,Shader}InfoLog`.

**Fix:**
- In production, set `state.gl.debug.checkShaderErrors = process.env.NODE_ENV !== "production"`.
- Warm the rain, flood and risk-outline materials once after the city's first frame with `gl.compileAsync(scene, camera)` (it uses `KHR_parallel_shader_compile`) while those objects are present but at zero intensity.

### 4.4 [Minor] Adaptive DPR goes below the tier floor and oscillates on slow devices, reallocating the drawing buffer each time

**Where:**
- `TierAdaptiveDpr` in `src/components/three/QualityManager.tsx`, which computes `setDpr(Math.max(0.5, base * current))`;
- the `regress` prop on `OrbitControls` in `src/components/three/CityScene.tsx`;
- `performance={{ min: 0.6, debounce: 300 }}` in `DigitalTwinCanvas`.

**Cause:**
- Every OrbitControls `change` calls `performance.regress()`, which drops the DPR to 0.6. R3F restores it 300 ms after the last regress.
- When a frame takes longer than 300 ms, which is the case for a low-end device at ≤ 3 fps, the restore fires between frames. The next damping `change` regresses again, so the DPR alternates on almost every frame.
- Damping is per frame (`dampingFactor` 0.08), so at low fps a camera move keeps emitting `change` events for tens of seconds.

**Evidence:**
- With `setPixelRatio` wrapped: in the first ~6 s of 3D view the DPR went 1 → 0.6 → 1 → 0.6 → 1. The four resizes took 1 149, 26, 259 and 312 ms under SwiftShader. In the CPU profile, 3D idle spent 1 417 ms (26 %) in `setSize`.
- In a 47 s 3D session (intro, one orbit drag, then Extreme Rain) there were **54 DPR changes**. Each one resizes the drawing buffer between 726 × 638 and 435 × 383.
- 0.6 is below the Low tier's `dpr[0] = 0.75`, so the documented "tier-aware" range is not respected.
- The screenshot `fps-3d-city-extreme.png`, taken 4 s after the first Extreme Rain, shows an **empty twin canvas**: no prisms or grid, only the HTML overlays. A resize clears the drawing buffer. The likely cause is a resize landing just before the 4 s first-compile stall (§4.3), leaving the cleared canvas on screen. Second-by-second screenshots of the same sequence (`blank-1…8.png`) rendered correctly, so the blank frame is intermittent.

**Fix:**
- Clamp the DPR to the tier floor: `Math.max(min, base * current)`.
- Set a `performance.debounce` longer than the worst frame time (for example 1 000 ms), or restore only after the controls' `end` event.
- Do not regress during scripted camera tweens (the intro and presets), so that only user drags regress.

### 4.5 [Minor] MapLibre tile cache footprint, and tiles loaded while the map is hidden

**Where:** `src/components/map/use-map-engine.ts` (map options) and `src/components/map/use-map-camera.ts` (`fitBounds`/`flyTo` while the map is hidden).

**Evidence:**
- Browsing 30 districts in 2D brings the map context to **87 MB** of vertex and index buffers and about 2 000 VAOs, with the growth slowing (§3.3).
- In 3D view, 10 neighbourhood visits grow the **hidden** map from 9 MB to 65 MB as it flies to each district.

**Fix:**
- Set `maxTileCacheSize` (for example 50 – 80) and/or `maxTileCacheZoomLevels: 3`.
- While `viewMode === "3d"`, store the requested camera and apply it with `jumpTo` when the map is revealed, instead of animating a hidden map.

### Observation (not a defect)

`window` carries 56 – 63 `blur` listeners. They are stable across every loop, so this is not a leak. They are most likely registered once per mounted Base UI tooltip or popover root.

---

## 5. Re-running the audit

The harness used for this audit (Playwright + CDP, `lib.cjs` and `audit.cjs`) lived in the session scratchpad and is not part of the repository. To reproduce it:

1. Start the production server: `npx next start -p 3123`.
2. Launch Chromium with the SwiftShader flags above.
3. Inject the probes from §2 with `addInitScript`.
4. Drive the UI through the loops in §3.3, measuring after `HeapProfiler.collectGarbage`.

When comparing builds, treat these as regressions:
- any monotonic growth of the twin context's buffers, textures or programs;
- more than 2 live WebGL contexts;
- window or document listeners that grow per cycle;
- twin fps above 0 in 2D view;
- map `clear`s in 3D view (after §4.1 is fixed).

---

## 6. Screenshot evidence

All screenshots are in the audit scratchpad (`qa/perf/shots/`), and each was inspected. Every scene rendered correctly except one:

- `smoke-3d.png`: city prisms.
- `quality-nbhd-high.png`: Chatuchak neighbourhood, High tier, rain and flood sheet.
- `nbhd-10.png`: Nong Chok buildings.
- `reduced-extreme.png`: frozen rain under reduced motion.
- `replay-3d.png`: historical replay.
- `city-after-10.png`, `presets-after-20.png`: final states of the leak loops.
- `blank-1…8.png`: second-by-second frames after Extreme Rain, all rendered.
- **Exception:** `fps-3d-city-extreme.png` shows a transiently empty twin canvas (§4.4).
