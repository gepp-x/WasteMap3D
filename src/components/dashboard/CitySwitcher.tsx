"use client";

import { CITIES, CITY_ORDER } from "@/lib/data/cities";
import { useTr, type Bi } from "@/lib/i18n";
import type { CityId } from "@/lib/types";
import { useDashboard } from "@/store/dashboard-store";
import { SegmentedControl, type SegmentOption } from "@/components/dashboard/ViewModeSwitch";

const LABELS: Record<CityId, { full: Bi; short: Bi; scope: Bi }> = {
  bangkok: {
    full: { th: "กรุงเทพมหานคร", en: "Bangkok" },
    short: { th: "กทม.", en: "BKK" },
    scope: { th: "กรุงเทพมหานคร · ข้อมูลรายเขตการปกครอง", en: "Bangkok · district-level data" },
  },
  hatyai: {
    full: { th: "หาดใหญ่", en: "Hat Yai" },
    short: { th: "หาดใหญ่", en: "Hat Yai" },
    scope: {
      th: "เทศบาลนครหาดใหญ่ · ข้อมูลรายเขตการบริหารจัดการชุมชน (ไม่ใช่เขตการปกครอง)",
      en: "Hat Yai Municipality · community-management zones (not administrative districts)",
    },
  },
};

/** Bangkok ↔ Hat Yai segmented switch (shared-layout indicator, radiogroup semantics). */
export function CitySwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const t = useTr();
  const cityId = useDashboard((s) => s.cityId);
  const setCity = useDashboard((s) => s.setCity);
  const options: SegmentOption<CityId>[] = CITY_ORDER.map((id) => ({
    value: id,
    label: t(compact ? LABELS[id].short : LABELS[id].full),
    ariaLabel: t({ th: CITIES[id].nameTh, en: CITIES[id].nameEn }),
    tooltip: t(LABELS[id].scope),
  }));
  return (
    <SegmentedControl
      value={cityId}
      onChange={setCity}
      options={options}
      ariaLabel={t({ th: "เลือกเมือง", en: "Choose city" })}
      size={compact ? "sm" : "md"}
      className={className}
    />
  );
}
