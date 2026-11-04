import { beforeEach, describe, expect, it } from "vitest";
import { useDashboard } from "@/store/dashboard-store";
import { BASELINE_SCENARIO } from "@/lib/simulation/model";

/**
 * Cross-module contract of the shared store: the nonces engines react to (map camera, 3D camera,
 * scenario transitions) and what a dashboard reset keeps or clears.
 */

const initial = useDashboard.getState();
const get = () => useDashboard.getState();

beforeEach(() => {
  useDashboard.setState(initial, true);
});

describe("selection and focus requests", () => {
  it("selectArea bumps focusNonce unless focus is false", () => {
    const n0 = get().focusNonce;
    get().selectArea("bkk-1001");
    expect(get().focusNonce).toBe(n0 + 1);
    get().selectArea("bkk-1002", { focus: false });
    expect(get().focusNonce).toBe(n0 + 1);
    expect(get().selectedAreaId).toBe("bkk-1002");
  });

  it("clearing the selection returns the 3D view to city scope", () => {
    get().selectArea("bkk-1001");
    get().setThreeScope("neighborhood");
    get().selectArea(null);
    expect(get().threeScope).toBe("city");
  });

  it("setCity clears area state and requests a 3D camera preset", () => {
    get().selectArea("bkk-1001");
    get().setCompareArea("bkk-1002");
    get().setDateIndex(12);
    const cam = get().cameraNonce;
    get().setCity("hatyai");
    const s = get();
    expect(s.cityId).toBe("hatyai");
    expect([s.selectedAreaId, s.compareAreaId, s.dateIndex]).toEqual([null, null, null]);
    expect(s.cameraNonce).toBe(cam + 1);
    expect(s.cameraPreset).toBe("overview");
  });
});

describe("scenario lab", () => {
  it("presets and parameter edits activate the scenario and bump scenarioNonce", () => {
    const n0 = get().scenarioNonce;
    get().applyPreset("heavyRain");
    expect(get().scenarioActive).toBe(true);
    expect(get().timelineMode).toBe("scenario");
    get().setScenarioParam("rainDurationH", 4);
    expect(get().presetId).toBe("custom");
    expect(get().scenarioNonce).toBe(n0 + 2);
  });

  it("resetScenario restores the baseline without touching observed-data state", () => {
    get().setDateIndex(5);
    get().applyPreset("extremeRain");
    get().resetScenario();
    const s = get();
    expect(s.scenarioActive).toBe(false);
    expect(s.scenario).toEqual(BASELINE_SCENARIO);
    expect(s.timelineMode).toBe("historical");
  });
});

describe("resetAll", () => {
  it("clears selection, scenario and view but keeps city, language, capabilities and shell layout", () => {
    const s0 = get();
    s0.setCity("hatyai");
    s0.setLang("en");
    s0.setWebglSupported(true);
    s0.setQualityTier("high");
    s0.setPanel("bottomOpen", false);
    s0.setPanel("leftOpen", false);
    s0.setViewMode("split");
    s0.selectArea("hy-z1");
    s0.applyPreset("combinedStress");

    get().resetAll();
    const s = get();
    expect(s.cityId).toBe("hatyai");
    expect(s.lang).toBe("en");
    expect(s.webglSupported).toBe(true);
    expect(s.qualityTier).toBe("high");
    expect(s.bottomOpen).toBe(false);
    expect(s.leftOpen).toBe(false);
    expect(s.viewMode).toBe("2d");
    expect(s.selectedAreaId).toBeNull();
    expect(s.scenarioActive).toBe(false);
    expect(s.layers.wasteVolume.visible).toBe(true);
  });

  it("keeps every nonce monotonic and signals engines through resetNonce / cameraNonce", () => {
    get().selectArea("bkk-1001");
    get().selectArea("bkk-1002");
    const before = get();
    get().resetAll();
    const s = get();
    expect(s.focusNonce).toBe(before.focusNonce);
    expect(s.cameraNonce).toBe(before.cameraNonce + 1);
    expect(s.scenarioNonce).toBe(before.scenarioNonce + 1);
    expect(s.resetNonce).toBe(before.resetNonce + 1);
  });
});

describe("layers", () => {
  it("choropleths are mutually exclusive; overlays stack", () => {
    get().setLayerVisible("floodRisk", true);
    get().setLayerVisible("hotspots", true);
    const s = get();
    expect(s.activeChoropleth).toBe("floodRisk");
    expect(s.layers.wasteVolume.visible).toBe(false);
    expect(s.layers.waterways.visible).toBe(true);
    expect(s.layers.hotspots.visible).toBe(true);
    get().setActiveChoropleth(null);
    expect(get().activeChoropleth).toBeNull();
    expect(get().layers.floodRisk.visible).toBe(false);
  });
});
