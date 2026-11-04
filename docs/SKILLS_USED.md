# Design skills used

Source repository: <https://github.com/freshtechbro/claudedesignskills> (commit `1da73febff0c3e1dfefc07f8a5ef8f7d1dfdb6cd`, 2025-11-19).

## Installation

The repository was cloned fresh (`git clone --depth 1`). The HEAD matched the copy already installed on this machine as Claude Code plugins (`claude-design-skillstack` marketplace).

The six required skills were copied **as extracted directories**, not ZIPs, into `.agents/skills/`. Each copy contains its `SKILL.md` with valid `name`/`description` frontmatter plus `references/`, `scripts/` and `assets/`:

| Skill | Installed path |
|---|---|
| threejs-webgl | `.agents/skills/threejs-webgl/` |
| react-three-fiber | `.agents/skills/react-three-fiber/` |
| web3d-integration-patterns | `.agents/skills/web3d-integration-patterns/` |
| motion-framer | `.agents/skills/motion-framer/` |
| gsap-scrolltrigger | `.agents/skills/gsap-scrolltrigger/` |
| modern-web-design | `.agents/skills/modern-web-design/` |

### Compatibility notes
- The project was built with Claude Code, not Codex. The `.agents/skills/` copy is there for Codex discovery; in Claude Code the same skills were also active as plugins.
- The skills' helper `scripts/*.py` were **not executed**; only the Markdown instructions and references were applied.
- `.agents/` is excluded from `tsconfig.json` and ESLint, so the skills' starter `.jsx` files are never compiled.
- No skill was unavailable. A few referenced files do not exist in the repository, so they were not read: `react-three-fiber/references/hooks_guide.md`, `drei_helpers.md`, and the `web3d-integration-patterns/references/*` files.
- The `dataviz` skill (installed separately in this environment) guided all charts.

## What was read and where it was applied

### threejs-webgl — `SKILL.md`, `references/optimization_checklist.md`, `references/materials_guide.md`
- **Geometry merging:** building footprints for each 0.9 km window are merged into one `BufferGeometry`, and road and water ribbons are merged as well (`src/lib/three/building-geometry.ts`, `ribbon-geometry.ts`). All area-prism outlines draw in a single call.
- **No allocations in the frame loop:** colours and vectors are preallocated. Everything has `dispose()` on scope change or unmount (`src/lib/three/runtime/*`).
- **Colour, depth and shadows:** sRGB output, `polygonOffset` against z-fighting, and one shadow-casting directional light with a tight frustum on the High tier only.
- **Custom `ShaderMaterial`s** for the ground grid, water flow, GPU rain streaks, illustrative flood surface and markers (`src/lib/three/shaders/*`).
- **Quality tiers** following the optimisation checklist: DPR cap, antialiasing, rain-particle count and building cap per tier (`src/lib/three/quality.ts`).

### react-three-fiber — `SKILL.md`, `references/api_reference.md`
- **No React state per frame:** `useFrame` mutates refs only. Store updates happen only on edges (e.g. the flood becoming visible).
- **Rendering cost:** on-demand rendering with `invalidate()`. Narrow `useThree` selectors. Scopes stay mounted and toggle `visible` rather than remounting.
- **drei helpers:** `OrbitControls makeDefault` with damping and limits, `PerformanceMonitor`, a tier-aware `AdaptiveDpr`, and `Html` labels (DOM text, so Thai shapes correctly).

### web3d-integration-patterns — `SKILL.md`
- **Layered separation:** an imperative 3D runtime layer, a GSAP camera layer and a React/HTML UI layer. The map uses the same split: engine hook → renderless layer sync → HTML overlays.
- **Zustand as the single source of truth** (`src/store/dashboard-store.ts`). `useScenario()` derives all modelled values once, so the map, 3D view, KPIs and charts stay in sync.
- **One owner per animated property:** GSAP moves the 3D camera, MapLibre moves the map camera, and Motion animates the UI. Tweens are killed on unmount.

### motion-framer — `SKILL.md`, `references/api_reference.md`
- **Shared `layoutId` indicators** for the city switcher, view-mode / TH-EN segmented controls, detail and dock tabs, and Scenario Lab presets.
- **`AnimatePresence`** for panel and tab swaps (overview ↔ details, sidebar ↔ Scenario Lab, Historical ↔ Simulation chip).
- **Layout animations** reorder the ranking and drainage rows when a scenario changes.
- **Drag with velocity-projected snapping** for the mobile bottom sheet. Motion values drive the dock height and split ratio, so dragging causes no React re-render.
- **Entrance:** variant `staggerChildren` (≤1.2 s, non-blocking). KPI values count up via `AnimatedNumber`.
- **Reduced motion:** `MotionConfig reducedMotion` driven by the OS preference or the user setting.

### gsap-scrolltrigger — `SKILL.md`, `references/easing_guide.md`, `references/common_patterns.md`
- **3D camera timelines** (`src/components/three/CameraController.tsx`): `power3.inOut`; controls are disabled during a tween so GSAP and damping never fight.
- **Scenario "pulse" timeline** in `SimulationBanner`: the sweep and vignette overlap via the position parameter, using `fromTo` with `overwrite: "auto"` and `kill()` on retrigger.
- Easing choices follow the easing guide's decision tree. ScrollTrigger itself is not used, because the dashboard does not scroll.

### modern-web-design — `SKILL.md`, `references/accessibility_guide.md`, `interaction_patterns.md`, `performance_checklist.md`
- **Animation with purpose:** no particles or glow spam. Skeleton screens instead of spinners.
- **Keyboard support:** roving-tabindex tablists, radiogroups and listboxes; a search combobox; slider scrubbers; and a skip link to the stage.
- **Status is never colour-only:** glyph + label in `StatusBadge`, ▲/▼ on deltas, hatch pattern for no-data.
- **Performance:** lazy-loaded 3D (`next/dynamic`, `ssr: false`); the 3D view is mounted on first use and paused while hidden. Reserved KPI space prevents layout shift, and effects are reduced on mobile.
