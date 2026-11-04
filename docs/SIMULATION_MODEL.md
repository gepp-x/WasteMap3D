# Simulation model: flood-risk scenarios, timeline and accumulation

> **การจำลองเชิงสาธิต — ไม่ใช่การพยากรณ์อย่างเป็นทางการ**
> **Illustrative simulation. Not an official flood forecast.**
>
> The model is an *explainable index*. It is **not** a hydraulic or hydrological model. Its weights, thresholds and capacity assumption have **not** been validated or calibrated against observed flooding. It predicts no water depths, flooded extents or timings. Waste is treated as a **possible contributing factor** to drain obstruction, **not a proven cause** of flooding in any area.

| | |
|---|---|
| Model version | `MODEL_VERSION = "1.0.0"` (`src/lib/simulation/model.ts`) |
| Model code | `src/lib/simulation/model.ts`: pure functions, with no I/O, no randomness and no mutation |
| Wiring | `src/lib/simulation/use-scenario.ts`: `useScenario()`, the single source of modelled values for the map, 3D, KPIs, charts and rankings |
| UI | Scenario Lab (`ScenarioLab.tsx`, `PresetCard.tsx`, `ParamSlider.tsx`, `BeforeAfter.tsx`), Timeline (`Timeline.tsx`, `hooks/use-timeline-playback.ts`), stage banner (`SimulationBanner.tsx`), choreography (`motion/ScenarioTransition.tsx`) |
| Tests | `tests/unit/model.test.ts`, `tests/unit/use-scenario-logic.test.ts` (`npx vitest run`) |

---

## 1. Purpose

The Scenario Lab lets a viewer ask *"what if"* questions about how rainfall, drainage performance and waste management could combine to raise relative flood risk across Bangkok's 50 districts and Hat Yai's 4 community-management zones. It is meant to:

- make the reasoning **transparent**: every score breaks down into four factor contributions (R, D, E, W);
- show **relative** differences between areas and between scenarios;
- connect the waste data to the flood data **without overstating** the causal link.

Observed data is never modified. Scenario outputs are computed on the fly from the immutable dataset plus the scenario parameters, and they always carry the `simulated` status in the UI.

---

## 2. Formula

```
Risk = 100 × (0.45·R + 0.25·D + 0.20·E + 0.10·W)
```

The weights live in `WEIGHTS = { R: 0.45, D: 0.25, E: 0.20, W: 0.10 }`, and they sum to 1 (unit-tested). If a factor has no data, the remaining weights are renormalised (see §8). The score is clamped to 0–100 and rounded to 0.1.

### 2.1 Factor definitions and normalisation

Every factor is normalised to **0–1** before weighting (`clamp(x) = min(1, max(0, x))`).

| Factor | Meaning | Formula | Source of inputs |
|---|---|---|---|
| **R**: rainfall | Depth of the scenario storm relative to a reference | `R = clamp(P / P_REF)`, `P_REF = 150 mm` | `P = intensity × duration × s_area` (mm) |
| **D**: drainage stress | Modelled load on the drainage network relative to its usable capacity | `D = clamp(L / L_SAT)`, `L_SAT = 1.5` | `L = load / capacity` (see below) |
| **E**: geographic / historical exposure | How exposed the area is to flooding regardless of the storm | `E = clamp(floodExposure)` | Per-area index 0–1 from the dataset (`metrics.floodExposure`). Scenarios never change it. |
| **W**: waste-related obstruction | Susceptibility of drains to blockage by solid waste, adjusted by the scenario | `W_eff = clamp(W_area × (0.4 + 1.2·obstruction) × (1 + 2·(1 − η)))` | `W_area` = `metrics.obstructionSusceptibility` (0–1); `obstruction` and `η` (collection efficiency) are scenario parameters |

**Why P_REF = 150 mm.** The Thai Meteorological Department (TMD) classes ≥ 90.1 mm in 24 h as *very heavy rain*. Saturating R at 150 mm leaves headroom above that class, so very heavy storms still separate from each other, while an extreme 180 mm storm reaches R = 1.

**Drainage stress (D).** All quantities are intensities in mm/h, so L has no unit:

```
load      = I × s_area × (1 + 0.6 · upstreamRunoff) × f_dur(h)
capacity  = C_design × (1 − clamp(capacityReduction, 0, 0.95)) × (1 − 0.4 · W_eff)
L         = load / capacity              (∞ when capacity ≤ 0, which gives D = 1)
D         = clamp(L / 1.5)
f_dur(h)  = min(1.25, 0.85 + 0.05 · h)   (h = storm duration in hours; 3 h gives 1.0)
```

- `C_design = DEFAULT_ASSUMPTIONS.designIntensityMmH = 60 mm/h` (see §7).
- At **L = 1** (load exactly at capacity), D = 1/1.5 ≈ **66.7 %**. D reaches 100 % when the load is 1.5 × capacity.
- `f_dur` stands for in-network storage running out during long storms.
- Waste obstruction removes **up to 40 %** of the remaining capacity, scaled by `W_eff`. When `W_area` is unknown, no reduction is applied, so a missing value never adds risk on its own.
- `drainageStressPct = round(D × 100, 1)` is what the UI labels *Modeled drainage stress (%)*.

**Spatial rainfall factor (`s_area`).** In scenario mode each area's depth and intensity are multiplied by `s_area = annualRainfall(area) / mean(annualRainfall over the city's areas)`. When an area has no annual rainfall value, `s_area` falls back to 1. During historical replay `s_area` is forced to 1, because each area's own reanalysis series already carries its spatial pattern.

### 2.2 Outputs (`RiskResult`)

| Field | Meaning |
|---|---|
| `score` | 0–100, or `null` when data completeness is below 0.55 |
| `riskClass` | `low` / `moderate` / `high` / `veryHigh` (or `null`) |
| `factors[k]` | For each of R, D, E, W: `value` (0–1 or null), `weight`, `appliedWeight` (after renormalisation), `points` (contribution to the score), `missing` |
| `drainageStressPct` | Modelled drainage stress, 0–100 % |
| `rainDepthMm` | Storm depth applied to this area (mm) |
| `loadRatio` | L |
| `obstructionEffective` | W_eff (0–1) or null |
| `completeness` | Share of model weight backed by data (0–1) |
| `missing` | Factor keys without data |

---

## 3. Risk classes

| Class | Score | Thai |
|---|---|---|
| Low | 0–24 | ต่ำ |
| Moderate | 25–49 | ปานกลาง |
| High | 50–74 | สูง |
| Very High | 75–100 | สูงมาก |

Boundaries are half-open at the top: `< 25` is Low, `< 50` Moderate, `< 75` High, and anything higher is Very High. In the UI, class colours always appear together with the class name.

---

## 4. Parameters, bounds and presets

### 4.1 Parameters (`ScenarioParams`, `PARAM_BOUNDS`)

| Parameter | Unit | Min | Max | Step | What it represents |
|---|---|---|---|---|---|
| `rainIntensityMmH` | mm/h | 0 | 120 | 1 | Mean intensity of a hypothetical storm |
| `rainDurationH` | h | 0.5 | 12 | 0.5 | Storm duration |
| `drainageCapacityReduction` | share (UI: %) | 0 | 0.60 | 0.01 | Hypothetical loss of drainage capacity, for example from high canal levels or a maintenance backlog |
| `obstruction` | share (UI: %) | 0 | 1 | 0.01 | Hypothetical share of drain inlets partially blocked by solid waste |
| `upstreamRunoff` | share (UI: %) | 0 | 1 | 0.01 | External or upstream inflow intensity |
| `collectionEfficiency` (η) | share (UI: %) | 0.50 | 1 | 0.01 | Share of waste that is collected |

### 4.2 Presets (`SCENARIO_PRESETS`)

| Preset | Thai | I (mm/h) | T (h) | Depth (mm) | TMD class | Capacity loss | Obstruction | Upstream | η |
|---|---|---|---|---|---|---|---|---|---|
| `normal` (**baseline**) | สภาวะปกติ | 10 | 2 | 20 | moderate | 0 | 0.30 | 0.20 | 0.95 |
| `heavyRain` | ฝนตกหนัก | 30 | 2 | 60 | heavy | 0 | 0.30 | 0.30 | 0.95 |
| `extremeRain` | ฝนตกหนักมาก | 60 | 3 | 180 | very heavy | 0 | 0.30 | 0.50 | 0.95 |
| `drainageObstruction` | ท่อระบายน้ำอุดตัน | 30 | 2 | 60 | heavy | 0.25 | 0.80 | 0.30 | 0.80 |
| `combinedStress` | แรงกดดันรวม | 60 | 3 | 180 | very heavy | 0.30 | 0.85 | 0.75 | 0.75 |

`BASELINE_SCENARIO` is the `normal` preset. Every "before" value in the UI is the model evaluated with these parameters. For the same area inputs the tests guarantee `normal < heavyRain < extremeRain`, `drainageObstruction ≥ heavyRain` and `combinedStress ≥ extremeRain`.

### 4.3 Worked example

Values come from `computeAreaRisk({ floodExposure: 0.5, obstructionSusceptibility: 0.5, rainSpatialFactor: 1 }, preset)` with model v1.0.0:

| Preset | R | D | E | W_eff | L | Drainage stress | **Score** | Class |
|---|---|---|---|---|---|---|---|---|
| normal | 0.133 | 0.142 | 0.5 | 0.418 | 0.213 | 14.2 % | **23.7** | Low |
| heavyRain | 0.400 | 0.449 | 0.5 | 0.418 | 0.673 | 44.9 % | **43.4** | Moderate |
| extremeRain | 1.000 | 1.000 | 0.5 | 0.418 | 1.561 | 100 % | **84.2** | Very High |
| drainageObstruction | 0.400 | 0.805 | 0.5 | 0.952 | 1.207 | 80.5 % | **57.6** | High |
| combinedStress | 1.000 | 1.000 | 0.5 | 1.000 | 3.452 | 100 % | **90.0** | Very High |

The same area under `heavyRain` but with **E missing** scores 41.7. Completeness is 0.80, and the applied weights become R 0.5625, D 0.3125 and W 0.125.

---

## 5. TMD 24-hour rainfall classes

From the TMD weather criteria page (`data/raw/tmd/tmd_info_weather_criteria.html`), implemented as `rainClass24h(mm)`:

| Class | Thai | 24 h depth |
|---|---|---|
| Light | ฝนเล็กน้อย | 0.1–10.0 mm |
| Moderate | ฝนปานกลาง | 10.1–35.0 mm |
| Heavy | ฝนหนัก | 35.1–90.0 mm |
| Very heavy | ฝนหนักมาก | ≥ 90.1 mm |

The rain-intensity slider shows the class of the storm's total depth (`intensity × duration`). This treats the whole storm as falling within one 24-hour window, which is always true here because the maximum duration is 12 h. The historical timeline colours each day's bar by the class of that day's city-mean rainfall.

---

## 6. Data status in the UI

| Quantity | Status shown |
|---|---|
| Scenario scores, drainage stress, factor points, before/after deltas, hyetograph | `simulated` (◇ violet, striped) |
| Historical replay scores | `simulated`, derived from `estimated` reanalysis rainfall (◐) |
| Daily rainfall in the historical timeline | The provenance status of `rain-areas.json`, normally `estimated` (reanalysis) |
| Population used as weights | The dataset's own status (normally `observed`) |
| Missing values | `ยังไม่มีข้อมูล / Unavailable`, never 0 |

---

## 7. Design-capacity assumption

The model assumes a **uniform** drainage design capacity of **`C_design = 60 mm/h`** for every area in both cities (`DEFAULT_ASSUMPTIONS.designIntensityMmH`).

**Basis.** The staged evidence file `data/staged/drainage-capacity.json` records publicly reported statements. It states that values are "as stated by the cited source; no value is inferred":

| Statement id | Value | Source | Caveat |
|---|---|---|---|
| `bkk-design-intensity-60mmh-2025` | 60 mm/h | ThaiPublica, 8 Jun 2025, quoting Attasit Petchmeesri, adviser to the Bangkok Governor: "กรุงเทพฯ รองรับปริมาณฝนได้จำกัดสูงสุด 60 มิลลิเมตรต่อชั่วโมง…" | A spoken statement reported by media, not a design document; a citywide figure, so local sub-catchments differ |
| `bkk-pipe-limit-60mmh-2016` | 60 mm/h | Thai PBS, 21 Jun 2016 (reporter's statement) | Not attributed to a named official |
| `bkk-target-76mmh-104mmday-2026` | 76 mm/h (≤ 104 mm/day, ~3 h storm) | Thai PBS, 30 Sep 2026, citing the BMA DDS 2569 flood action plan | A **target**, not current capacity |
| `bkk-rang-o-rang-kaeo-100mmh-target` | 100 mm/h | BMA PR release, 16 Sep 2025: Khlong Rang O – Rang Kaeo project, western Bang Khen (~3 km²) | A local project target for one sub-catchment; under construction at the time |
| *(unknown)* Hat Yai design intensity | none | No verifiable public figure was found. The file lists basin-scale canal capacities instead: RID diversion canal R.1 at 1,200 m³/s, and 1,665 m³/s combined with Khlong U-Taphao (ONEP, 2020). | Basin-scale river and canal conveyance, not street drainage; R.1 was damaged in the 2025 floods |

**Therefore:**

- For **Bangkok**, 60 mm/h matches officials' public statements but is **not** taken from a design document. The primary DDS action-plan book was not retrieved. The model applies it uniformly, even though real capacity varies by sub-catchment, pipe age, pumping and canal levels.
- For **Hat Yai**, 60 mm/h is **purely an illustrative assumption** with no local source. Basin canal capacities in m³/s cannot be converted to an mm/h street-drainage intensity without catchment areas and runoff coefficients that we do not have.
- Planned upgrades (76 mm/h, 100 mm/h locally) are **not** modelled.

> **NOTE (assumption):** replacing the uniform 60 mm/h with per-area capacities requires official per-catchment design data. Until it exists, D measures relative stress under a common assumption. It is not a statement about any specific drain.

---

## 8. Missing-data handling

1. A factor without a defensible value (null, undefined or NaN) is **missing**. It is never counted as 0.
2. **Renormalisation.** The weights of the available factors are divided by their sum: `appliedWeight_k = w_k / Σ_{available} w`. Applied weights therefore always sum to 1.
3. **Completeness** = Σ of the original weights of the available factors.
4. A score is produced only if **completeness ≥ `MIN_COMPLETENESS` = 0.55**. Otherwise `score = null` and `riskClass = null`, and the UI shows "ข้อมูลไม่พอ / Not enough data".
5. R and D always come from the scenario, so they are always available. Completeness therefore never drops below 0.70 (R + D) with the current factor set. The 0.55 threshold guards future factors and partial datasets.
6. `W_area` missing: W is dropped and **no** obstruction reduction is applied to capacity. `E` missing: E is dropped.
7. City summaries (population-weighted means) skip areas with a null score or unknown population. Those areas are never averaged in as 0.

The selected-area view in the Scenario Lab lists missing factors and shows the completeness percentage.

---

## 9. City summary

Computed by `useScenario().summary` for the current state and by `summarizeSide()` (`BeforeAfter.tsx`, same semantics) for the baseline:

| Metric | Definition |
|---|---|
| Mean risk | Population-weighted mean of area scores, over areas with both a population and a score |
| Highest area risk | Maximum area score |
| Mean drainage stress | Population-weighted mean of `drainageStressPct` |
| Population in High / Very High | Population of areas with score ≥ 50, divided by the total population of areas with known population |

---

## 10. Simulated-event timeline (hyetograph)

`scenarioHyetograph(params, stepH = 0.25, tailH = 3)` builds a deterministic **triangular storm**:

- 15-minute steps from t = 0 to T + 3 h, where `T = max(0.25, duration)`;
- intensity rises linearly from 0 to its **peak = 2 × mean intensity** at **t = 0.4 T**, then falls linearly to 0 at t = T;
- a 3-hour **dry recession** follows (intensity 0, cumulative depth constant);
- the cumulative depth comes from exact trapezoid integration of the piecewise-linear curve. The total equals **intensity × duration** (unit-tested within 0.5 % across the full parameter grid).

**Drivers at a time step** (`driversAt`): instantaneous intensity drives the drainage load, cumulative depth drives R, and elapsed storm time `min(t, T)` drives the duration factor. As a result:

- D peaks near the intensity peak (t ≈ 0.4 T) and falls during the recession;
- R keeps rising until the rain stops, then holds.

**Timeline step semantics** (`store.scenarioStep`): `0` shows the full-storm summary (mean intensity over the whole duration). `≥ 1` shows the state at `hyetograph[step]`.

**Playback** (`hooks/use-timeline-playback.ts`): at 1×, the event plays 4 steps per second, which is one simulated hour per second (0.5×, 2× and 4× scale this). The loop runs on requestAnimationFrame and keeps its state in closure variables. It commits to the store at most about 15 times per second, stops at the last step and pauses when the tab is hidden. Under reduced motion it advances in discrete ticks every 600 ms instead of sweeping continuously.

---

## 11. Historical replay

When no scenario is active and the timeline is in *Historical* mode with a date selected, each area's daily rainfall for that date (`rain-areas.json`, reanalysis estimate) goes through the model with the **baseline** scenario parameters and these drivers:

```
depth      = rain24h(area, date)                (mm)
intensity  = rain24h / HISTORICAL_STORM_HOURS   (mm/h)
duration   = HISTORICAL_STORM_HOURS = 3 h       (assumption)
s_area     = 1                                  (spatial pattern already in the series)
```

**Assumption:** each day's total is assumed to fall within **3 hours**. Convective storms in Bangkok and Hat Yai often deliver most of a day's rain within a few hours, but the real sub-daily distribution is unknown. A day's total spread over 24 h would stress drains far less. Areas without a value for that date keep their baseline result and contribute nothing to the replayed city-mean rainfall.

The stage banner reads "แบบจำลองความเสี่ยงจากฝนประมาณการวันที่ … — เชิงสาธิต / Modelled risk for reanalysis rainfall on … — illustrative". Playback runs at about 8 days per second at 1×. Flood-event markers from `flood-events.json` jump to the wettest city-mean day within each event window.

The histogram drawn under the scrubber shows the **city mean** of the area series for each day. Days on which every area is null stay null and are drawn as a faint baseline tick, never as a zero bar. Bars use a square-root height scale so that small days stay visible, and this is stated in the chart's label.

---

## 12. Before / after

- **Before** = model with `BASELINE_SCENARIO` (the *normal* preset).
- **After** = model with the current scenario, or the current timeline step, or the historical date.
- `delta = round(after − before, 1)`; it is null if either side is null.
- With **Compare with baseline** (`store.compareBaseline`) on, the Lab shows baseline and current values side by side, with delta chips (▲/▼ plus a sign, so the direction is never conveyed by colour alone). It also lists the **five areas with the largest increase**. Ties are broken by higher current score and then by area id, so the order is deterministic. Clicking an area selects and focuses it.
- In the selected-area view, each factor row shows `points_before → points_after` out of `100 × appliedWeight`.

---

## 13. Waste accumulation model

`simulateAccumulation(inflow, η, days, A₀)` is an illustrative daily stock model that feeds `metrics.wasteAccumulated` (status `simulated`):

```
Available(t) = A(t−1) + G(t)                 [t]      G = inflow [t/day] × 1 day
Collected(t) = η × Available(t)              [t]
A(t)         = Available(t) − Collected(t)   [t]   = A(t−1) + G(t) − Collected(t)
```

- Units: inflow in **t/day**, a daily time step, so the stock and collected amounts are in **tonnes**.
- **Steady state** for a constant inflow: `A* = G · (1 − η) / η` (`steadyStateAccumulation`). For example, G = 100 t/day at η = 0.95 gives A* ≈ 5.26 t. Convergence is unit-tested.
- Null inflow gives null (never 0). η ≤ 0 has no steady state, which also returns null.
- **Inflow** = the area's `wasteGenerated` when it has a value (Hat Yai zone allocations; Bangkok district allocations of the Pollution Control Department total, both `estimated`), otherwise `wasteCollected` as a labelled proxy. The build (`metrics.wasteAccumulated`) and the dashboard's accumulation chart use the same rule.
- It assumes that waste not collected on a day stays in the system and becomes collectable the next day. It ignores informal recovery, illegal dumping, waste carried into waterways and spatial redistribution.

The waste-related **obstruction** factor (W) is linked to collection efficiency only through the `(1 + 2·(1 − η))` multiplier. The model does **not** feed the accumulated tonnage into the risk score.

---

## 14. Coordinated scenario transitions (for module authors)

Every scenario change (preset, slider, reset, on/off) increments `store.scenarioNonce`. A slider drag can increment it every animation frame, so **do not animate on the raw nonce**. Use the debounced pulse exported by `src/components/motion/ScenarioTransition.tsx` instead:

```tsx
import { ScenarioPulse, useOnScenarioPulse, useScenarioPulse } from "@/components/motion/ScenarioTransition";

const pulse = useScenarioPulse();            // number, increments once per coordinated update
useOnScenarioPulse(() => flashLegend());     // imperative hook; never fires on mount
<ScenarioPulse>{kpiTile}</ScenarioPulse>     // brief cyan→violet hairline highlight (0.7 s)
```

- **Leading edge:** the pulse fires immediately when a change follows ≥ 700 ms of calm, so a preset click pulses on the same frame that its values start tweening (`DURATION.scenario` = 0.7 s).
- **Trailing edge:** during a burst such as a slider drag, one more pulse fires 220 ms after the last change.
- A single module-level subscription serves all consumers, so they pulse on the same tick. No provider is needed.
- The stage sweep in `SimulationBanner` (a thin cyan→violet front plus one vignette breath; GSAP timeline, 0.68 s, transforms and opacity only) runs on this pulse. Reduced motion and `effectsEnabled = false` suppress decorative motion, but values still update.
- Slider commits are coalesced to **one store update per animation frame**, so the model, map and 3D scene recompute at most once per frame while a slider is dragged.

---

## 15. Tests

`npx vitest run` (Node environment, `@` aliased to `src`):

- `tests/unit/model.test.ts`: the weights sum to 1; class and TMD thresholds; R and D normalisation; the duration factor and the W_eff formula; the score equals the sum of factor points; **monotonicity** of the score in intensity, duration, capacity reduction, obstruction and upstream runoff, and inverse monotonicity in collection efficiency, across 60 area-input combinations; missing-factor renormalisation and the completeness threshold; hyetograph depth conservation (±0.5 %) and its shape; the accumulation equation and steady state; preset ordering; determinism (no `Math.random`, frozen inputs).
- `tests/unit/use-scenario-logic.test.ts`: `inputsFor` null handling; the historical-replay drivers; before/after summaries (population weighting, null handling); top increases; factor rows; timeline helpers (city-mean series, event ranges, keyboard stepping, playback rates, the 15 Hz commit limit, reduced-motion stepping).

---

## 16. Limitations

1. **Not a hydraulic model.** There is no routing, no topography-driven flow, no tides or river stage, no pump operation and no flood depths or extents. The 3D water surface is illustrative.
2. **Coefficients are not validated.** The weights (0.45/0.25/0.20/0.10), P_REF = 150 mm, L_SAT = 1.5, the duration factor, the 0.6 runoff multiplier, the 40 % obstruction capacity loss and the W_eff multipliers are all demonstration choices. None has been fitted to observed flood reports.
3. **Not an official forecast.** For warnings, consult TMD, BMA (DDS), Hat Yai Municipality and the Department of Disaster Prevention and Mitigation.
4. **Uniform capacity assumption** (§7). Real capacity varies by catchment, and Hat Yai has no verified figure.
5. **Exposure (E) and obstruction susceptibility (W)** are dataset indices built from proxies. Their construction and limits are documented with the data pipeline and shown in the Data tab.
6. **Waste is a possible contributing factor, not a proven cause.** A higher W raises the modelled score; it does not show that waste caused any flood.
7. **Historical replay** relies on reanalysis rainfall (a model estimate, not gauge observations) and on the 3-hour concentration assumption.
8. **Spatial resolution:** district and community-zone averages hide street-level variation. Hat Yai zone boundaries may be approximate and are labelled as such wherever they are drawn.
