"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { Geometry } from "geojson";
import { OrbitControls } from "@react-three/drei";
import { useBuildingWindow, type CityBundle } from "@/lib/data/loader";
import { CITIES } from "@/lib/data/cities";
import { useDashboard } from "@/store/dashboard-store";
import type { AreaRecord } from "@/lib/types";
import { RISK_COLORS } from "@/lib/data/status";
import { cityFrame, neighborhoodFrame, DEFAULT_WINDOW_HALF_M, type SceneFrame } from "@/lib/three/frame";
import { buildAreaGeometry, type AreaGeomSet } from "@/lib/three/area-geometry";
import type { AreaVisualSet } from "@/lib/three/area-visuals";
import type { FloodTarget } from "@/lib/three/flood";
import { TIER_SETTINGS, type QualityTier } from "@/lib/three/quality";
import { waterFromGeoJSON } from "@/lib/three/waterways";
import { useThreeUi } from "@/lib/three/ui-store";
import { Atmosphere, rainLevel } from "@/lib/three/runtime/atmosphere";
import { PrismField } from "@/lib/three/runtime/prisms";
import { CameraRig } from "@/lib/three/runtime/camera-rig";
import { SceneLighting } from "./SceneLighting";
import { Ground } from "./Ground";
import { AreaPrisms } from "./AreaPrisms";
import { RiskOverlay3D } from "./RiskOverlay3D";
import { Waterways3D } from "./Waterways3D";
import { BuildingLayer } from "./BuildingLayer";
import { FloodScenario3D } from "./FloodScenario3D";
import { RainParticles } from "./RainParticles";
import { CameraController } from "./CameraController";
import { QualityManager } from "./QualityManager";

/** Per-city geometry cache (owned by the scene, disposed with it). */
class AreaGeometryCache {
  private readonly entries = new Map<string, { bundle: CityBundle; set: AreaGeomSet }>();
  get(bundle: CityBundle, frame: SceneFrame): AreaGeomSet {
    const hit = this.entries.get(frame.key);
    if (hit && hit.bundle === bundle) return hit.set;
    hit?.set.dispose();
    const set = buildAreaGeometry(bundle.areasGeo, bundle.dataset.areas, frame);
    this.entries.set(frame.key, { bundle, set });
    return set;
  }
  dispose() {
    for (const e of this.entries.values()) e.set.dispose();
    this.entries.clear();
  }
}

export interface CitySceneProps {
  bundle: CityBundle | undefined;
  visuals: AreaVisualSet | null;
  scenarioSource: "baseline" | "scenario" | "historical";
  visualIntensityMmH: number;
  flood: FloodTarget[];
  tier: QualityTier;
  /** Probed device tier (auto-quality ceiling). */
  autoCeiling: QualityTier;
  reduced: boolean;
  effects: boolean;
  continuous: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  /** DOM label pinned over the selected prism (positioned by RiskOverlay3D). */
  labelRef?: RefObject<HTMLDivElement | null>;
  playIntro: boolean;
  onIntroStarted: () => void;
}

/**
 * Scene graph root. Two levels of detail share one canvas:
 *   city scope          → area prisms + waterways + risk overlay (city frame, ≈±280 units)
 *   neighbourhood scope → OSM buildings/roads/water of a 1 km window (local metres)
 * The rendered scope (`displayScope`) lags the requested one so the camera can dolly between frames.
 */
export function CityScene({ bundle, visuals, scenarioSource, visualIntensityMmH, flood, tier, autoCeiling, reduced, effects, continuous, stageRef, labelRef, playIntro, onIntroStarted }: CitySceneProps) {
  const cityId = useDashboard((s) => s.cityId);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const requestedScope = useDashboard((s) => s.threeScope);
  const waterLayer = useDashboard((s) => s.layers.waterways);
  const displayScope = useThreeUi((s) => s.displayScope);
  const settings = TIER_SETTINGS[tier];
  const shadows = settings.shadows;

  const [atmosphere] = useState(() => new Atmosphere());
  const [rig] = useState(() => new CameraRig());
  const [cache] = useState(() => new AreaGeometryCache());
  useEffect(() => () => atmosphere.dispose(), [atmosphere]);
  useEffect(() => () => cache.dispose(), [cache]);

  // ---- city frame + prisms
  const cFrame = useMemo(() => cityFrame(CITIES[cityId]), [cityId]);
  const bundleForCity = bundle && bundle.dataset.city.id === cityId ? bundle : undefined;
  const set = useMemo(() => (bundleForCity ? cache.get(bundleForCity, cFrame) : null), [cache, bundleForCity, cFrame]);
  const field = useMemo(() => (set ? new PrismField(set) : null), [set]);
  useEffect(() => () => field?.dispose(), [field]);

  const areasById = useMemo(() => new Map<string, AreaRecord>((bundleForCity?.dataset.areas ?? []).map((a) => [a.id, a])), [bundleForCity]);
  const cityWater = useMemo(() => (bundleForCity ? waterFromGeoJSON(bundleForCity.waterways, cFrame) : null), [bundleForCity, cFrame]);

  // ---- neighbourhood frame (default from the area anchor until the window file arrives)
  const nbAreaId = (requestedScope === "neighborhood" || displayScope === "neighborhood") && selectedId ? selectedId : null;
  const win = useBuildingWindow(nbAreaId);
  const winData = win.status === "ready" && "data" in win && win.data ? win.data : null;
  const nbFrame = useMemo(() => {
    if (!nbAreaId) return null;
    // the store keys windows by area id, so ready data always belongs to nbAreaId
    if (winData) return neighborhoodFrame(nbAreaId, winData.origin, winData.halfSizeM);
    const rec = areasById.get(nbAreaId);
    return rec ? neighborhoodFrame(nbAreaId, rec.anchor, DEFAULT_WINDOW_HALF_M) : null;
  }, [nbAreaId, winData, areasById]);

  // missing / unreadable window file → explain and fall back to the city scope (aborts a dolly-in early)
  useEffect(() => {
    if (!nbAreaId || win.status !== "error" || useDashboard.getState().threeScope !== "neighborhood") return;
    useThreeUi.getState().showNotice({
      th: "ยังไม่มีข้อมูลอาคารสำหรับพื้นที่นี้ — กลับสู่มุมมองระดับเมือง",
      en: "No building data for this area yet — returning to the city view",
    });
    useDashboard.getState().setThreeScope("city");
  }, [nbAreaId, win.status]);

  const inNeighborhood = displayScope === "neighborhood" && !!nbFrame && !!nbAreaId;
  const activeFrame = inNeighborhood ? nbFrame! : cFrame;

  // ---- ground boundary: Hat Yai municipality (city) / selected area (neighbourhood)
  const boundary = useMemo<Geometry[] | null>(() => {
    if (!bundleForCity) return null;
    if (inNeighborhood && nbAreaId) {
      const f = bundleForCity.areasGeo.features.find((x) => x.properties?.id === nbAreaId);
      return f?.geometry ? [f.geometry] : null;
    }
    const m = bundleForCity.municipality?.features.map((f) => f.geometry).filter((g): g is Geometry => !!g);
    return m && m.length ? m : null;
  }, [bundleForCity, inNeighborhood, nbAreaId]);

  const rainTarget = rainLevel(visualIntensityMmH);
  const flowing = effects && !reduced;
  const maxHeight = cFrame.half * 0.16;
  const selectedVisual = selectedId ? visuals?.byId.get(selectedId) : undefined;
  const riskTint = selectedVisual?.riskClass && scenarioSource !== "baseline" ? RISK_COLORS[selectedVisual.riskClass] : null;
  const showRisk = scenarioSource !== "baseline";
  const onControlsChange = useCallback(() => rig.clampTarget(activeFrame), [rig, activeFrame]);

  return (
    <>
      <SceneLighting atmosphere={atmosphere} frame={activeFrame} shadows={shadows} mapSize={settings.shadowMapSize} rainTarget={rainTarget} reduced={reduced} />
      <Ground
        frame={activeFrame}
        shadows={shadows}
        boundary={boundary}
        boundaryColor={inNeighborhood ? "#25d9f2" : "#5fb8d6"}
        boundaryOpacity={inNeighborhood ? 0.8 : 0.5}
      />

      <group visible={!inNeighborhood}>
        {set && field && (
          <>
            <AreaPrisms field={field} visuals={visuals} interactive={!inNeighborhood} reduced={reduced} shadows={shadows} maxHeight={maxHeight} />
            <RiskOverlay3D set={set} field={field} visuals={visuals} areasById={areasById} showRisk={showRisk} reduced={reduced} effects={effects} active={!inNeighborhood} labelRef={labelRef} />
          </>
        )}
        <Waterways3D
          inputs={cityWater}
          spacing={Math.max(3, cFrame.half * 0.03)}
          shimmerScale={Math.max(2, cFrame.half * 0.02)}
          atmosphere={atmosphere}
          flowing={flowing && !inNeighborhood}
          visible={waterLayer.visible}
          opacity={waterLayer.opacity}
        />
      </group>

      {inNeighborhood && nbAreaId && (
        <BuildingLayer
          key={nbAreaId}
          areaId={nbAreaId}
          cap={settings.buildingCap}
          shadows={shadows}
          reduced={reduced}
          riskColor={riskTint}
          atmosphere={atmosphere}
          flowing={flowing}
          waterVisible={waterLayer.visible}
          waterOpacity={waterLayer.opacity}
        />
      )}

      <FloodScenario3D targets={flood} scope={inNeighborhood ? "neighborhood" : "city"} set={set} frame={activeFrame} reduced={reduced} effects={effects} />
      <RainParticles count={effects ? settings.rainCount : 0} target={rainTarget} animate={!reduced} />

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={1.45}
        minDistance={inNeighborhood ? 18 : 10}
        maxDistance={activeFrame.half * 4.2}
        screenSpacePanning={false}
        zoomToCursor
        regress
        onChange={onControlsChange}
      />
      <CameraController rig={rig} cityFrame={cFrame} nbFrame={nbFrame} set={set} field={field} stageRef={stageRef} reduced={reduced} playIntro={playIntro} onIntroStarted={onIntroStarted} />
      <QualityManager continuous={continuous} dpr={settings.dpr} ceiling={autoCeiling} />
    </>
  );
}
