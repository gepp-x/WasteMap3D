"use client";

import { useMemo } from "react";
import type { FeatureCollection } from "geojson";
import { useCityBundle, type CityBundle } from "@/lib/data/loader";
import { useScenario, type ScenarioState } from "@/lib/simulation/use-scenario";
import { useDashboard } from "@/store/dashboard-store";
import type { AreaRecord, CityId } from "@/lib/types";
import { computeChoropleth, stressClass, type ChoroplethModel } from "@/lib/map/choropleth";
import {
  EMPTY_FC,
  anchorsFC,
  areaBboxes,
  hotspotModel,
  makeAreaLocator,
  normalizeDrainage,
  normalizeWaterways,
  rainGridModel,
  stationsFC,
  stationsSummary,
  type BBox,
  type HotspotModel,
  type NormalizedDrainage,
  type NormalizedWaterways,
  type RainGridModel,
} from "@/lib/map/features";
import { normalizeCommunities, type CommunityModel } from "@/lib/map/communities";
import { gaugeModel, type GaugeModel } from "@/lib/map/water-levels";

export interface MapStatic {
  areas: { list: AreaRecord[]; byId: Map<string, AreaRecord>; byFid: Map<number, AreaRecord> };
  bboxes: Map<string, BBox>;
  anchors: FeatureCollection;
  waterways: NormalizedWaterways | null;
  drainage: NormalizedDrainage | null;
  communities: CommunityModel | null;
  /** Water-level gauge snapshot (null when the city has none). */
  waterLevels: GaugeModel | null;
  stations: FeatureCollection;
  stationSummary: ReturnType<typeof stationsSummary>;
  hotspots: HotspotModel | null;
  /** True when any shown polygon is an approximate demonstration partition. */
  hasApproximate: boolean;
}

export interface MapModel {
  cityId: CityId;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  bundle?: CityBundle;
  scenario: ScenarioState;
  /** Bundle-derived, scenario-independent structures (null until the bundle is ready). */
  base: MapStatic | null;
  choropleth: ChoroplethModel | null;
  rainDate: string | null;
  rainGrid: RainGridModel | null;
  /** Modelled drainage-stress class (0–4) per area under the current scenario/timeline. */
  stressByArea: Map<string, number>;
}

/**
 * Everything the map draws, derived once per (bundle × scenario × layer) change and shared by the
 * layer sync, tooltip, legend and camera — a single source of truth for map-side values.
 */
export function useMapModel(): MapModel {
  const { cityId, status, bundle, error } = useCityBundle();
  const scenario = useScenario();
  const activeChoropleth = useDashboard((s) => s.activeChoropleth);
  const dateIndex = useDashboard((s) => s.dateIndex);

  const base = useMemo<MapStatic | null>(() => {
    if (!bundle) return null;
    const list = bundle.dataset.areas;
    const locate = makeAreaLocator(bundle.areasGeo);
    return {
      areas: { list, byId: new Map(list.map((a) => [a.id, a] as const)), byFid: new Map(list.map((a) => [a.fid, a] as const)) },
      bboxes: areaBboxes(bundle.areasGeo),
      anchors: anchorsFC(list),
      waterways: normalizeWaterways(bundle.waterways),
      drainage: normalizeDrainage(bundle.drainage, locate),
      communities: normalizeCommunities(bundle.communities),
      waterLevels: gaugeModel(bundle.waterLevels),
      stations: bundle.stations ? stationsFC(bundle.stations) : EMPTY_FC,
      stationSummary: stationsSummary(bundle.stations),
      hotspots: hotspotModel(list),
      hasApproximate:
        list.some((a) => a.geometryStatus === "approximate") || bundle.areasGeo.features.some((f) => f.properties?.geometryStatus === "approximate"),
    };
  }, [bundle]);

  const choropleth = useMemo(() => computeChoropleth(activeChoropleth, bundle?.dataset, scenario), [activeChoropleth, bundle, scenario]);

  const rainDate = useMemo(() => {
    if (dateIndex === null || !bundle) return null;
    return bundle.rainAreas?.dates[dateIndex] ?? bundle.rainGrid?.dates[dateIndex] ?? null;
  }, [bundle, dateIndex]);

  const rainGrid = useMemo(() => rainGridModel(bundle?.rainGrid, rainDate), [bundle, rainDate]);

  const stressByArea = useMemo(() => {
    const m = new Map<string, number>();
    if (!scenario.ready) return m;
    for (const a of scenario.list) m.set(a.area.id, stressClass(a.current.drainageStressPct));
    return m;
  }, [scenario]);

  return { cityId, status, error, bundle, scenario, base, choropleth, rainDate, rainGrid, stressByArea };
}
