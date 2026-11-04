"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useBuildingWindow } from "@/lib/data/loader";
import type { BuildingWindow } from "@/lib/types";
import { BuildingField } from "@/lib/three/runtime/buildings";
import type { Atmosphere } from "@/lib/three/runtime/atmosphere";
import { waterFromWindow } from "@/lib/three/waterways";
import { useThreeUi } from "@/lib/three/ui-store";
import { Waterways3D } from "./Waterways3D";

/**
 * Neighbourhood scope: real OpenStreetMap footprints from public/data/buildings/<areaId>.json in
 * local metres (1 unit = 1 m around BuildingWindow.origin). One merged building mesh (custom fast
 * extrusion, vertex colours, rise-in shader), one merged road mesh, water from the same window.
 * (A missing window is handled by CityScene: notice + fall back to the city scope.)
 * Everything is disposed on change/unmount.
 */
export function BuildingLayer({
  areaId,
  cap,
  shadows,
  reduced,
  riskColor,
  atmosphere,
  flowing,
  waterVisible,
  waterOpacity,
}: {
  areaId: string;
  cap: number;
  shadows: boolean;
  reduced: boolean;
  riskColor: string | null;
  atmosphere: Atmosphere;
  flowing: boolean;
  waterVisible: boolean;
  waterOpacity: number;
}) {
  const win = useBuildingWindow(areaId);
  const data: BuildingWindow | null = win.status === "ready" && "data" in win && win.data ? win.data : null;
  const [field] = useState(() => new BuildingField());
  const invalidate = useThree((s) => s.invalidate);
  const reducedRef = useRef(reduced);

  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  useEffect(
    () => () => {
      field.dispose();
      useThreeUi.getState().setBuildingStats(null);
    },
    [field],
  );

  useEffect(() => {
    const build = field.setWindow(data, cap, reducedRef.current);
    const ui = useThreeUi.getState();
    if (data) {
      ui.setBuildingStats({
        areaId: data.areaId,
        total: build?.total ?? data.buildings?.length ?? 0,
        shown: build?.shown ?? 0,
        tagged: build?.tagged ?? 0,
        levels: build?.levels ?? 0,
        estimated: build?.estimated ?? 0,
        halfSizeM: data.halfSizeM,
        waterCount: data.water?.length ?? 0,
      });
    } else ui.setBuildingStats(null);
    invalidate();
  }, [field, data, cap, invalidate]);

  useEffect(() => {
    field.setShadows(shadows);
    invalidate();
  }, [field, shadows, invalidate]);

  useEffect(() => {
    field.setTint(riskColor, riskColor ? 0.14 : 0);
    invalidate();
  }, [field, riskColor, invalidate]);

  useFrame((state, dt) => {
    if (field.tick(Math.min(dt, 0.1), reduced)) state.invalidate();
  });

  const water = useMemo(() => (data ? waterFromWindow(data) : null), [data]);

  return (
    <>
      <primitive object={field.group} />
      <Waterways3D
        inputs={water}
        y={0.03}
        spacing={22}
        shimmerScale={28}
        atmosphere={atmosphere}
        flowing={flowing}
        visible={waterVisible}
        opacity={waterOpacity}
      />
    </>
  );
}
