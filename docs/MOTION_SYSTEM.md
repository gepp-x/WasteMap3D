# Motion System — Urban Intelligence

Motion in the observatory exists to **explain change**: where a value came from, what a scenario
did, where the camera went. It is never decoration. Every animation must answer "what does this help
the user understand?" — if it cannot, it is removed.

Principles

1. **One engine per property.** A DOM property, camera, map paint value or shader uniform is
   animated by exactly one engine at a time (see §3).
2. **Compositor first.** UI motion uses `opacity`, `transform` and short-lived `filter`. The single
   deliberate exception is the width of the two shell columns (§6.1).
3. **Never block.** Nothing waits for an animation to finish before it becomes interactive.
4. **No React state at frame rate.** Per-frame values live in Motion values, GSAP targets, MapLibre
   or `useFrame`; React state is written on commit (drag end, key press, debounced pulse).
5. **Reduced motion is a first-class mode**, not an afterthought (§5).

---

## 1. Tokens

Source of truth: `src/lib/animation/tokens.ts`, mirrored as CSS custom properties in
`src/app/globals.css` (`--motion-*`, `--ease-*`) so CSS transitions and JS tweens land together.

| Token | Value | CSS var | Used for |
| --- | --- | --- | --- |
| `DURATION.fast` | 0.15 s | `--motion-fast` | hover / press / toggle feedback |
| `DURATION.ui` | 0.24 s | `--motion-ui` | tabs, tooltips, cross-fades, small layout changes |
| `DURATION.panel` | 0.32 s | `--motion-panel` | drawers, sheets, column collapse, stage cross-fade |
| `DURATION.scenario` | 0.70 s | `--motion-scenario` | synchronized scenario update (KPI tweens, colours, charts, pulse) |
| `DURATION.camera` | 1.6 s | — | geographic camera moves (3D focus, map focus) |
| `DURATION.cityFlight` | 2.4 s | — | Bangkok ↔ Hat Yai flight |
| `EASE.outExpo` | `cubic-bezier(.16,1,.3,1)` | `--ease-out-expo` | anything arriving (panels, numbers, entrance) |
| `EASE.standard` | `cubic-bezier(.2,0,0,1)` | `--ease-standard` | state swaps, exits, cross-fades |
| `EASE.inOut` | `cubic-bezier(.65,0,.35,1)` | — | symmetric moves |
| `GSAP_EASE.camera` | `power3.inOut` | — | GSAP camera timelines |
| `SPRING.snappy` | k 420 / c 32 / m 0.8 | — | segmented-control indicator (`layoutId`) |
| `SPRING.gentle` | k 220 / c 28 | — | mobile bottom-sheet snapping |
| `STAGGER` | 0.05 s | — | entrance + list reveals |

Helpers: `useReducedMotionPref()` (OS **or** user setting) and `motionDuration(d, reduced)` which
collapses a duration to ~0 when reduced motion is on.

---

## 2. Shell motion primitives (`src/components/motion/`)

| Component | File | What it does |
| --- | --- | --- |
| `EntranceRoot` / `EntranceItem` / `EntranceGroup` | `Entrance.tsx` | First-load choreography via Motion variants + `staggerChildren` (§4) |
| `CollapsibleColumn` | `AnimatedPanel.tsx` | Sidebar ↔ 56 px rail, details ↔ 44 px rail (animated width) |
| `CrossFade` | `AnimatedPanel.tsx` | True cross-fade of two views in one grid cell (sidebar ↔ Scenario Lab, rail ↔ full) |
| `SlideOver` | `AnimatedPanel.tsx` | Tablet details overlay (AnimatePresence enter/exit) |
| `SwapText` | `AnimatedPanel.tsx` | Vertical swap for status chips (Historical ↔ Simulation) |
| `SceneLayer` | `SceneTransition.tsx` | 2D / 3D stage layers: opacity + 1.5 % scale + 6 px blur cross-fade, layers stay mounted |
| `AnimatedNumber` | `AnimatedNumber.tsx` (foundation) | Value tweens from previous → next; null renders "Unavailable", never 0 |
| `ScenarioPulse` | `ScenarioTransition.tsx` (scenario module) | Debounced, app-wide highlight synchronised to scenario changes |

---

## 3. Which engine owns which effect

| Domain | Engine | Owner / file | Notes |
| --- | --- | --- | --- |
| React UI: panels, drawers, tabs, chips, segmented indicators, KPI cards | **Motion** (`motion/react`) | shell + panels | variants, `layoutId`, `AnimatePresence` |
| Numbers (KPIs, readouts) | **Motion** `animate()` on a motion value | `AnimatedNumber` | `DURATION.scenario`, `EASE.outExpo` |
| Mobile sheet drag + snap, split divider, dock resize | **Motion values** (`useMotionValue`, `useDragControls`, `animate`) | `MobileShell`, `Stage`, `AppShell` | pointer moves write motion values only; React state on release |
| 3D camera (presets, focus, approach) | **GSAP timelines** | `src/lib/three/runtime/camera-rig.ts` | OrbitControls disabled during a tween, damping cleared, timeline killed before the next |
| Multi-step scenario sequences (stage sweep, banner) | **GSAP timeline** | `SimulationBanner.tsx` | triggered by the debounced scenario pulse |
| Map camera (city flight, area focus) | **MapLibre native easing** (`flyTo`, `fitBounds`) | `src/components/map/use-map-camera.ts` | never tweened from React |
| Map choropleth recolouring | **Imperative feature-state tween** (throttled rAF, ≤ 30 fps) | `src/lib/map/animation.ts` | MapLibre does not transition feature-state paint |
| Map paint transitions (opacity, line width) | **MapLibre style `transition`** | `src/lib/map/style.ts` | 300 ms |
| Environmental transitions (storm sky, fog, light, building rise/tint, water) | **Shader / material uniforms lerped in `useFrame`** | `src/lib/three/runtime/*`, `src/lib/three/shaders/*` | frame-rate-independent damping; no React state |
| Hover / press micro-feedback | **CSS transitions** | Tailwind `transition-colors duration-150` | colours only |

### Conflict avoidance

* **One engine per property.** e.g. the 3D camera position is GSAP's while a timeline runs and
  OrbitControls' otherwise — never both; map camera is MapLibre's only.
* **Kill before start.** GSAP timelines, Motion `animate()` controls and MapLibre camera moves are
  stopped/replaced before a new one targets the same property, and on unmount.
* **Layout vs. transform.** Motion `layout` animations are used only for the small segmented
  indicators (`layoutId`), never on containers that hold a WebGL canvas.
* **Stage geometry snaps, opacity animates.** Switching 2D / 3D / split changes pane geometry
  instantly and cross-fades the layers, so each canvas resizes once instead of every frame.
* **Entrance transforms are transient.** The stage's entrance blur/scale ends with
  `filter: none; transform: none`, so MapLibre/R3F pointer maths are never offset afterwards.
* **Scenario sync goes through one clock.** Sliders can change parameters every frame; modules
  subscribe to the debounced *scenario pulse* (`useScenarioPulse`, leading edge after 700 ms calm,
  trailing 220 ms after a burst) rather than to the raw `scenarioNonce`.

---

## 4. Entrance sequence (first load only, ≤ 1.2 s, never blocks input)

`EntranceRoot` staggers its children by `STAGGER` (0.05 s); KPI cards run their own group.

| t (s) | Element | Motion | Duration |
| --- | --- | --- | --- |
| 0.00 | Header | fade + slide down 10 px | 0.50 |
| 0.05 | Left column | fade + slide in from −12 px | 0.50 |
| 0.10 | Stage | resolves from 14 px blur + 1.2 % scale → sharp | 0.90 (done ≈ 1.0) |
| 0.15 | Right column | fade + slide in from +12 px | 0.50 |
| 0.20 | Timeline + dock | fade + rise 12 px | 0.50 |
| 0.12 + i·0.05 | KPI cards (6) | fade + rise 8 px | 0.45 (done ≈ 0.82) |
| on data | KPI values | count up **from 0 to the real value** (0 rendered first, real value next frame) | 0.70 |

* Before the breakpoint is known the server and first client render show the same neutral
  skeleton (`ShellSkeleton`) — no hydration mismatch, no layout jump.
* The choreography plays **once per session**; breakpoint changes and remounts appear instantly.
* Count-up only happens for non-null values (null stays "ยังไม่มีข้อมูล / Unavailable", never 0)
  and replays when a different city's data loads.

---

## 5. Reduced motion & effects policy

| Switch | Source | Effect |
| --- | --- | --- |
| OS `prefers-reduced-motion` | media query | CSS: all transitions/animations ≈ 0 ms (`globals.css`); JS: `useReducedMotionPref()` → true |
| Settings → "ลดการเคลื่อนไหว / Reduce motion" | `store.reducedMotion` | same as OS, plus `data-reduced-motion="true"` on `<html>` (CSS kill-switch) |
| `MotionConfig reducedMotion` | `AppShell` | `"always"` when either switch is on → Motion skips transform/layout animation app-wide; `"user"` otherwise |
| Settings → "เอฟเฟกต์ภาพ / Visual effects" | `store.effectsEnabled` | turns off rain particles, animated water and the scenario highlight sweep; data still updates |
| Quality tier | `store.quality` / `qualityTier` | phones default to the **low** tier when quality is "auto" |

Under reduced motion: the entrance is skipped, numbers jump to their final value, panels and
sheets snap, cameras cut to their final pose, scene layers swap without blur/scale, and
smooth scrolling becomes instant. Information is never conveyed by motion alone — every state
change is also visible as text, glyph or colour.

---

## 6. Shell transitions

### 6.1 Columns (desktop)
* Left: 296 px ↔ 56 px icon rail; right: 384 px ↔ 44 px rail — `CollapsibleColumn`,
  `DURATION.panel`, `EASE.outExpo`.
* Width is animated on purpose (the stage must reflow so nothing is occluded). It stays cheap:
  children render at their fixed inner width (no text reflow — only the clip moves) and the column
  is `contain: layout paint`.
* Content swaps (rail ↔ full, controls ↔ Scenario Lab) use `CrossFade`: both views overlap in one
  grid cell for a true cross-fade with a 10 px directional drift.

### 6.2 Stage modes (2D / 3D / split)
* `SceneLayer`: visible → `opacity 1, scale 1, blur 0`; hidden → `opacity 0, scale .985, blur 6px`,
  then `visibility: hidden` + `inert`. CityMap is always mounted; DigitalTwinCanvas mounts on first
  3D/split use and then receives `active={visible}` so its render loop stops while hidden.
* Split divider: pointer moves write a Motion value (`ratio`); ARIA value is committed on release.
  Keyboard: ←/→ ±5 %, Home/End, Enter = 50 %, double-click = reset.

### 6.3 Bottom dock
* Collapse/expand tweens a height Motion value (`DURATION.panel`); drag-to-resize writes the same
  motion value directly (180–420 px), committing the height to React state on release.
  Keyboard: ↑/↓ ±20 px, Home/End.

### 6.4 Mobile bottom sheet
* Snap points collapsed (78 px chrome) / half (50 % vh) / full (vh − header) bound to
  `store.sheetSnap`. Drag starts only from the handle/tab bar (`useDragControls`) so the content
  scrolls normally; release projects the position with velocity (×0.2 s) to the nearest snap and
  springs there (`SPRING.gentle`). The scroll area's height follows the sheet's motion value.

### 6.5 Micro-interactions
* Segmented controls (city, view mode, language): shared-layout pill (`layoutId`, `SPRING.snappy`).
* Mode chip Historical ↔ Simulation: `SwapText` vertical swap + violet stripes when simulating.
* KPI cards: cyan top hairline marks the active choropleth; simulated cards carry a violet
  striped hairline and join the scenario pulse.

---

## 7. Scenario transition choreography

A scenario change (preset chip, slider, reset, timeline scrub) is one coordinated update:

1. **Store** — parameters change; `useScenario()` re-derives modelled values (observed data is
   never mutated).
2. **Pulse** — the debounced scenario pulse fires once (leading or trailing edge).
3. **Same tick, `DURATION.scenario` (0.7 s):**
   * KPI numbers tween (Motion), delta chips update (▲/▼ + sign, never colour-only);
   * simulated KPI cards and panels flash the hairline highlight (`ScenarioPulse`);
   * map choropleth colours tween through feature-state (map module);
   * 3D prisms/buildings/water ease their uniforms in `useFrame` (3D module);
   * the stage sweep / banner timeline plays (GSAP, `SimulationBanner`).
4. **Mode chip** swaps to "การจำลอง · Simulation" with stripes; the simulation banner states that
   the output is not an official forecast.
5. **Exit** (reset) runs the same path in reverse to the baseline/historical state.

With effects off or reduced motion on, steps 3–4 apply their final state instantly; values and
labels still update.

---

## 8. Adding motion — checklist

- [ ] Does it explain a change? If not, drop it.
- [ ] Uses tokens (`DURATION`, `EASE`, `SPRING`, `STAGGER`) — no ad-hoc timings.
- [ ] One engine owns the property; previous tween is stopped first and on unmount.
- [ ] Only `opacity` / `transform` (or a documented exception).
- [ ] No React `setState` per frame; motion values / refs / uniforms instead.
- [ ] Honours `useReducedMotionPref()` and, for environmental effects, `effectsEnabled`.
- [ ] Interactive immediately; keyboard path exists; state also conveyed without motion.
