import type { City, CityId } from "@/lib/types";

/**
 * Static city metadata (camera framing, labels). Available before data loads so the map can
 * frame the city immediately; dataset period labels are refined from areas.json at runtime.
 */
export const CITIES: Record<CityId, City> = {
  bangkok: {
    id: "bangkok",
    nameTh: "กรุงเทพมหานคร",
    nameEn: "Bangkok",
    center: [100.5605, 13.7367],
    zoom: 10.15,
    bbox: [100.3279, 13.4939, 100.9385, 13.9551],
    areaKindTh: "เขต",
    areaKindEn: "District",
    periodLabelTh: "ข้อมูลรายเขต (ปีอ้างอิงตามแหล่งข้อมูล)",
    periodLabelEn: "District data (reference years per source)",
  },
  hatyai: {
    id: "hatyai",
    nameTh: "เทศบาลนครหาดใหญ่",
    nameEn: "Hat Yai Municipality",
    center: [100.4745, 7.0085],
    zoom: 13.1,
    bbox: [100.4351, 6.9695, 100.5118, 7.0491],
    areaKindTh: "เขตชุมชน",
    areaKindEn: "Community zone",
    periodLabelTh: "ข้อมูลระดับเทศบาลและเขตชุมชน",
    periodLabelEn: "Municipality & community-zone data",
  },
};

export const CITY_ORDER: CityId[] = ["bangkok", "hatyai"];
