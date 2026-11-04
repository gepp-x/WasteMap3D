"use client";

import { useId, useMemo, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Box, CloudRain, Database, Droplets, FlaskConical, GitCompareArrows, LayoutGrid, Trash2, Waves, X } from "lucide-react";
import type { AreaRecord, CityDataset, DataProvenance, MetricValue, SourceRef } from "@/lib/types";
import { useCityBundle, useSources, type CityBundle } from "@/lib/data/loader";
import { useScenario, type AreaScenario, type ScenarioState } from "@/lib/simulation/use-scenario";
import { BASELINE_SCENARIO, L_SAT, MIN_COMPLETENESS, DEFAULT_ASSUMPTIONS } from "@/lib/simulation/model";
import { METRICS, primaryWasteMetric, type MetricId } from "@/lib/metrics";
import { STATUS_META } from "@/lib/data/status";
import { COMMON, useLang, useTr } from "@/lib/i18n";
import { formatDate, formatMetric, formatNumber, formatYear, unitLabel } from "@/lib/formatters";
import { DURATION, EASE } from "@/lib/animation/tokens";
import { useDashboard, type DashboardState, type Lang } from "@/store/dashboard-store";
import { cn } from "@/lib/utils";
import { MetricReadout, StatusBadge } from "@/components/dashboard/StatusBadge";
import { FloodEventsList } from "@/components/dashboard/FloodEventsList";
import {
  AREA_KIND_LABELS,
  DeltaText,
  GeometryBadge,
  MetricGrid,
  MetricTile,
  MiniCompareBar,
  PanelNote,
  PanelSection,
  PanelTabs,
  RiskChip,
  SourceLine,
  UnavailableBlock,
  WasteMeasures,
  geometryHelp,
  tabPanelProps,
  useMotionPrefs,
  type MetricGridItem,
} from "@/components/dashboard/MetricGrid";
import { WasteCompositionChart } from "@/components/charts/WasteCompositionChart";
import { WasteTrendChart } from "@/components/charts/WasteTrendChart";
import { RainfallChart } from "@/components/charts/RainfallChart";
import { RiskContributionChart, type RiskContributionRow } from "@/components/charts/RiskContributionChart";
import { SensitivityChart } from "@/components/charts/SensitivityChart";
import { AccumulationChart } from "@/components/charts/AccumulationChart";
import { Sparkline } from "@/components/charts/Sparkline";
import { FACTOR_LABELS } from "@/components/charts/palette";
import { HourlyRainPanel } from "@/components/charts/HourlyRainPanel";
import { CommunityList } from "@/components/map/CommunityList";
import { GaugeGlyph } from "@/components/map/GaugeGlyph";
import { normalizeCommunities } from "@/lib/map/communities";
import { GAUGE_CLASS, GAUGE_SNAPSHOT, formatLevel, gaugeName, nearbyGauges } from "@/lib/map/water-levels";
import {
  areaMean,
  areaPolygon,
  areaRainSeries,
  derivedMetric,
  hasValue,
  infrastructureInArea,
  kindLabel,
  liveAreaMetric,
  metricOf,
  nearbyStations,
  nearestArea,
  rainWindow,
  rankAreas,
  valueOf,
  windowStats,
  type KindCount,
} from "@/components/charts/derive";

type DetailTab = DashboardState["detailTab"];

const S = {
  close: { th: "ปิดรายละเอียดพื้นที่", en: "Close area details" },
  compare: { th: "เปรียบเทียบ", en: "Compare" },
  compareAria: { th: "เปรียบเทียบพื้นที่นี้กับพื้นที่อื่น", en: "Compare this area with another" },
  explore3d: { th: "สำรวจแบบ 3 มิติ", en: "Explore in 3D" },
  code: { th: "รหัส", en: "Code" },
  tabs: { th: "หมวดรายละเอียดพื้นที่", en: "Area detail sections" },
  tOverview: { th: "ภาพรวม", en: "Overview" },
  tWaste: { th: "ขยะ", en: "Waste" },
  tRain: { th: "ฝนและการระบายน้ำ", en: "Rain & Drainage" },
  tFlood: { th: "ปัจจัยน้ำท่วม", en: "Flood Factors" },
  tData: { th: "ข้อมูล", en: "Data" },
  approxNote: {
    th: "รูปร่างของพื้นที่นี้เป็นการแบ่งโดยประมาณเพื่อการสาธิตเท่านั้น ค่าที่คำนวณจากขอบเขต (เช่น ความยาวทางน้ำ) จึงเป็นค่าประมาณ",
    en: "This area's shape is an approximate demonstration partition; values computed from its boundary (e.g. waterway length) are approximate.",
  },
  hyZone: {
    th: "เขตชุมชนเป็นเขตการบริหารจัดการชุมชนของเทศบาล ไม่ใช่เขตการปกครอง",
    en: "A community-management zone of the municipality, not an administrative district.",
  },
  // overview
  modelled: { th: "ความเสี่ยงน้ำท่วม (แบบจำลอง)", en: "Modeled flood risk" },
  vsBaseline: { th: "จากสภาวะฐาน", en: "vs baseline" },
  baselineIs: { th: "สภาวะฐาน {v}", en: "Baseline {v}" },
  stressNow: { th: "แรงกดดันระบายน้ำ", en: "Drainage stress" },
  facts: { th: "ข้อมูลพื้นที่", en: "Area profile" },
  avgOfAreas: { th: "เฉลี่ยรายพื้นที่ {v}", en: "Area average {v}" },
  rainSel: { th: "ฝน 24 ชม. (วันที่เลือก)", en: "Rain 24 h (selected date)" },
  rainLatest: { th: "ฝน 24 ชม. (ล่าสุดในชุดข้อมูล)", en: "Rain 24 h (latest in dataset)" },
  barLegend: { th: "แถบ = พื้นที่นี้ · ขีด = ค่าเฉลี่ยรายพื้นที่ของเมือง", en: "Bar = this area · tick = city area average" },
  communities: { th: "ชุมชนในเขตนี้", en: "Communities in this zone" },
  // waste
  areaComp: { th: "สัดส่วนของพื้นที่นี้", en: "This area's composition" },
  cityComp: { th: "สัดส่วนระดับเมือง", en: "Citywide composition" },
  cityCompNote: { th: "ใช้สัดส่วนระดับเมือง — ไม่มีข้อมูลรายเขต", en: "City-level composition shown — no district composition data" },
  areaCompApplied: { th: "สัดส่วนประมาณการของพื้นที่นี้ (ใช้ค่าระดับเมือง)", en: "Estimated for this area (citywide shares applied)" },
  areaCompAppliedNote: {
    th: "ไม่มีการสำรวจองค์ประกอบขยะรายเขต — ใช้สัดส่วนของทั้งเมืองกับทุกเขต (ข้อมูลประมาณการ) จึงไม่สะท้อนความต่างระหว่างเขต",
    en: "No district composition survey exists — the citywide shares are applied to every district (estimated), so differences between districts are not shown",
  },
  rankTitle: { th: "ตำแหน่งเทียบกับพื้นที่อื่น", en: "Position among areas" },
  rankOf: { th: "อันดับ {r} จาก {n}", en: "Rank {r} of {n}" },
  rankNA: { th: "ไม่มีอันดับ (ไม่มีข้อมูล)", en: "Not ranked (no data)" },
  vsMean: { th: "เทียบค่าเฉลี่ยรายพื้นที่", en: "vs area average" },
  historyTitle: { th: "ประวัติปริมาณขยะของพื้นที่", en: "Area waste history" },
  accInputs: { th: "ข้อมูลนำเข้าแบบจำลอง", en: "Model inputs" },
  inflow: { th: "ขยะเข้าสู่ระบบต่อวัน", en: "Daily inflow" },
  inflowProxy: {
    th: "ใช้ปริมาณขยะที่จัดเก็บได้เป็นตัวแทนปริมาณขยะที่เกิดขึ้น (ไม่มีข้อมูลขยะที่เกิดขึ้นรายพื้นที่)",
    en: "Collected waste is used as a proxy for generated waste (no area-level generation data).",
  },
  efficiency: { th: "ประสิทธิภาพการเก็บขน", en: "Collection efficiency" },
  effSource: { th: "จากสถานการณ์ปัจจุบัน", en: "from the current scenario" },
  effBase: { th: "สภาวะฐาน", en: "baseline" },
  openLab: { th: "ปรับใน Scenario Lab", en: "Adjust in Scenario Lab" },
  wasteFigures: { th: "ตัวชี้วัดขยะ", en: "Waste indicators" },
  measures: { th: "ขยะที่เกิดขึ้นและขยะที่จัดเก็บได้", en: "Waste generated and collected" },
  compTotalGen: { th: "ขยะที่เกิดขึ้น", en: "waste generated" },
  // rain
  hourly: { th: "ฝนรายชั่วโมงช่วงเหตุการณ์ (ทั้งเมือง)", en: "Hourly rainfall during events (citywide)" },
  gauges: { th: "สถานีวัดระดับน้ำใกล้เคียง (≤ 8 กม.)", en: "Nearby water-level gauges (≤ 8 km)" },
  gauge: { th: "สถานี", en: "Gauge" },
  level: { th: "ระดับน้ำ", en: "Level" },
  capacity: { th: "% ความจุ", en: "% capacity" },
  noGauges: { th: "ไม่มีข้อมูลสถานีวัดระดับน้ำสำหรับเมืองนี้", en: "No water-level gauge data for this city" },
  noNearGauge: { th: "ไม่มีสถานีวัดระดับน้ำภายใน 8 กม. จากจุดอ้างอิงของพื้นที่", en: "No gauge within 8 km of the area anchor" },
  bankShort: { th: "ตลิ่ง", en: "bank" },
  rainTitle: { th: "ฝนรายวัน 90 วัน", en: "Daily rainfall, 90 days" },
  rainEnd: { th: "สิ้นสุด {d}", en: "ending {d}" },
  rain90: { th: "ฝนสะสม 90 วัน", en: "90-day total" },
  rain90Method: { th: "ผลรวมฝนรายวันของพื้นที่ (ข้อมูลแบบจำลองสภาพอากาศย้อนหลัง)", en: "Sum of the area's daily values (reanalysis)" },
  wetDays: { th: "{n} วันที่มีฝน ≥ 0.1 มม.", en: "{n} wet days (≥ 0.1 mm)" },
  stations: { th: "สถานีวัดฝนใกล้เคียง (≤ 6 กม.)", en: "Nearby rain stations (≤ 6 km)" },
  station: { th: "สถานี", en: "Station" },
  distance: { th: "ระยะ", en: "Distance" },
  rain24: { th: "ฝน 24 ชม.", en: "Rain 24 h" },
  observedAt: { th: "เวลาที่ตรวจวัด", en: "Observed at" },
  noStations: { th: "ไม่มีข้อมูลสถานีวัดฝนสำหรับเมืองนี้", en: "No rain-station data for this city" },
  noNearby: { th: "ไม่มีสถานีภายในรัศมี 6 กม. จากจุดอ้างอิงของพื้นที่", en: "No station within 6 km of the area anchor" },
  waterways: { th: "ทางน้ำและโครงสร้างระบายน้ำในพื้นที่", en: "Waterways & drainage infrastructure in the area" },
  wwLength: { th: "ความยาวทางน้ำในขอบเขตพื้นที่", en: "Waterway length inside the boundary" },
  wwMethod: {
    th: "คำนวณด้วย turf: แบ่งเส้นทางน้ำเป็นช่วง ≤150 ม. แล้วนับช่วงที่จุดกึ่งกลางอยู่ในขอบเขต",
    en: "Computed with turf: lines split into ≤150 m pieces, counted when the piece midpoint is inside the boundary",
  },
  wwNone: { th: "ไม่มีข้อมูลทางน้ำ (OpenStreetMap) สำหรับเมืองนี้", en: "No waterway data (OpenStreetMap) for this city" },
  wwNoPoly: { th: "ไม่พบรูปร่างของพื้นที่สำหรับคำนวณ", en: "Area geometry not available for the calculation" },
  wwEmpty: { th: "ไม่พบทางน้ำหรือโครงสร้างที่ทำแผนที่ไว้ในขอบเขตนี้", en: "No mapped waterways or structures inside this boundary" },
  features: { th: "{n} รายการ", en: "{n} features" },
  osm: { th: "© ผู้ร่วมพัฒนา OpenStreetMap (ODbL) — ความครบถ้วนขึ้นกับการทำแผนที่", en: "© OpenStreetMap contributors (ODbL) — completeness depends on mapping coverage" },
  gaugeTitle: { th: "แรงกดดันระบบระบายน้ำ (แบบจำลอง, %)", en: "Modeled Drainage Stress (%)" },
  gaugeNow: { th: "ปัจจุบัน", en: "Current" },
  gaugeBase: { th: "สภาวะฐาน", en: "Baseline" },
  gaugeCap: { th: "เต็มความจุ", en: "At capacity" },
  loadRatio: { th: "ภาระ / ความจุที่สมมติ", en: "Load / assumed capacity" },
  gaugeExplain: {
    th: "ค่านี้คือภาระน้ำฝน (รวมน้ำหลากจากต้นน้ำและระยะเวลาฝน) เทียบกับความจุของระบบระบายน้ำที่ “สมมติ” ไว้ที่ {cap} มม./ชม. ซึ่งลดลงได้จากการอุดตันของขยะและการเสื่อมสภาพ ค่า {full}% หมายถึงภาระเท่ากับความจุพอดี ค่าเกินกว่านั้นหมายถึงภาระเกินความจุ ไม่ใช่ค่าที่ตรวจวัดจริง",
    en: "Load from rainfall (including upstream runoff and storm duration) relative to an assumed drainage design capacity of {cap} mm/h, reduced by waste obstruction and capacity loss. {full}% means load equals capacity; above it the network is over capacity. This is a model output, not a measurement.",
  },
  // flood
  completeness: { th: "คำนวณจาก {p}% ของน้ำหนักแบบจำลอง", en: "Computed from {p}% of the model weight" },
  minComplete: { th: "ต้องมีอย่างน้อย {p}% จึงจะแสดงคะแนน", en: "At least {p}% is required for a score" },
  missingFactors: { th: "ปัจจัยที่ไม่มีข้อมูล", en: "Missing factors" },
  noneMissing: { th: "ครบทุกปัจจัย", en: "All factors available" },
  baselineRow: { th: "สภาวะฐาน", en: "Baseline" },
  currentRow: { th: "ปัจจุบัน", en: "Current" },
  cityEvents: { th: "บริบทเหตุการณ์น้ำท่วมของเมือง", en: "City flood-event context" },
  // data
  provenance: { th: "ที่มาของข้อมูลทุกตัวชี้วัด", en: "Provenance of every metric" },
  cMetric: { th: "ตัวชี้วัด", en: "Metric" },
  cValue: { th: "ค่า", en: "Value" },
  cUnit: { th: "หน่วย", en: "Unit" },
  cScope: { th: "ขอบเขตพื้นที่", en: "Geographic scope" },
  cPeriod: { th: "ช่วงเวลา", en: "Period" },
  cStatus: { th: "สถานะ", en: "Status" },
  cSource: { th: "แหล่งข้อมูล", en: "Source" },
  cMethod: { th: "วิธีการ", en: "Method" },
  cLimits: { th: "ข้อจำกัด", en: "Limitations" },
  compositionRow: { th: "องค์ประกอบขยะ", en: "Waste composition" },
  historyRow: { th: "ประวัติปริมาณขยะรายปี", en: "Yearly waste history" },
  yearsCount: { th: "{n} ปีที่มีข้อมูล", en: "{n} years with data" },
  mixedStatus: { th: "สถานะข้อมูลต่างกันในแต่ละปี (แสดงสถานะของปีล่าสุด) — ดูรายปีในแท็บขยะ", en: "Status differs by year (latest year shown) — see the Waste tab per year" },
  dataNote: {
    th: "ตารางนี้แสดงค่าในชุดข้อมูล (สภาวะฐาน) ค่าผลแบบจำลองที่เปลี่ยนตามสถานการณ์แสดงในแท็บอื่น",
    en: "This table lists dataset values (baseline). Scenario-dependent model outputs are shown in the other tabs.",
  },
  notes: { th: "หมายเหตุของพื้นที่", en: "Area notes" },
  scrollHint: { th: "เลื่อนตารางในแนวนอนเพื่อดูคอลัมน์ทั้งหมด", en: "Scroll the table horizontally for all columns" },
  simNote: { th: "ผลแบบจำลองเชิงอธิบาย — ไม่ใช่การพยากรณ์น้ำท่วมอย่างเป็นทางการ", en: "Explainable model output — not an official flood forecast" },
};

const KM = { th: "กม.", en: "km" };

interface Ctx {
  area: AreaRecord;
  ds: CityDataset;
  bundle: CityBundle;
  sc: ScenarioState;
  as: AreaScenario | undefined;
}

export function DistrictDetails({ area }: { area: AreaRecord }) {
  const t = useTr();
  const { bundle } = useCityBundle();
  const sc = useScenario();
  const tab = useDashboard((s) => s.detailTab);
  const setTab = useDashboard((s) => s.setDetailTab);
  const idBase = `area-details-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { reduced } = useMotionPrefs();

  const ds = bundle?.dataset;
  const as = sc.byId.get(area.id);

  const tabs = useMemo(
    () => [
      { id: "overview" as DetailTab, label: t(S.tOverview), icon: <LayoutGrid className="size-3.5" aria-hidden /> },
      { id: "waste" as DetailTab, label: t(S.tWaste), icon: <Trash2 className="size-3.5" aria-hidden /> },
      { id: "rain" as DetailTab, label: t(S.tRain), icon: <CloudRain className="size-3.5" aria-hidden /> },
      { id: "flood" as DetailTab, label: t(S.tFlood), icon: <Waves className="size-3.5" aria-hidden /> },
      { id: "data" as DetailTab, label: t(S.tData), icon: <Database className="size-3.5" aria-hidden /> },
    ],
    [t],
  );

  if (!ds || !bundle) return null;
  const ctx: Ctx = { area, ds, bundle, sc, as };

  return (
    <article aria-labelledby={`${idBase}-title`} className="flex flex-col">
      <DetailsHeader ctx={ctx} titleId={`${idBase}-title`} />
      <div className="sticky top-0 z-10 border-b border-ui-border bg-ui-surface/95 px-2 backdrop-blur-sm">
        <PanelTabs tabs={tabs} value={tab} onChange={setTab} ariaLabel={t(S.tabs)} idBase={idBase} dense />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          {...tabPanelProps(idBase, tab)}
          className="outline-none"
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4 }}
          transition={{ duration: reduced ? 0 : DURATION.ui, ease: EASE.outExpo }}
        >
          {tab === "overview" && <OverviewTab ctx={ctx} />}
          {tab === "waste" && <WasteTab ctx={ctx} />}
          {tab === "rain" && <RainTab ctx={ctx} />}
          {tab === "flood" && <FloodTab ctx={ctx} />}
          {tab === "data" && <DataTab ctx={ctx} />}
        </motion.div>
      </AnimatePresence>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/*  Header                                                             */
/* ------------------------------------------------------------------ */

function DetailsHeader({ ctx, titleId }: { ctx: Ctx; titleId: string }) {
  const t = useTr();
  const { area, ds } = ctx;
  const selectArea = useDashboard((s) => s.selectArea);
  const setCompareArea = useDashboard((s) => s.setCompareArea);
  const setBottomTab = useDashboard((s) => s.setBottomTab);
  const setPanel = useDashboard((s) => s.setPanel);
  const setViewMode = useDashboard((s) => s.setViewMode);
  const setThreeScope = useDashboard((s) => s.setThreeScope);

  const onCompare = () => {
    const current = useDashboard.getState().compareAreaId;
    const valid = current && current !== area.id && ds.areas.some((a) => a.id === current);
    setCompareArea(valid ? current : (nearestArea(ds, area)?.id ?? null));
    setBottomTab("compare");
    setPanel("bottomOpen", true);
  };
  const on3d = () => {
    setViewMode("3d");
    setThreeScope("neighborhood");
  };

  return (
    <header className="flex flex-col gap-2 px-4 pt-4 pb-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="ui-eyebrow flex flex-wrap items-center gap-x-1.5">
            <span>{t(AREA_KIND_LABELS[area.kind] ?? AREA_KIND_LABELS.district)}</span>
            {area.code && (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono tracking-normal normal-case">
                  {t(S.code)} {area.code}
                </span>
              </>
            )}
          </div>
          <h2 id={titleId} lang="th" className="mt-0.5 text-[24px] leading-8 font-semibold tracking-[-0.01em] text-ui-text">
            {area.nameTh}
          </h2>
          <div lang="en" className="text-[12.5px] text-ui-text-2">
            {area.nameEn}
          </div>
        </div>
        <button
          type="button"
          onClick={() => selectArea(null, { focus: false })}
          aria-label={t(S.close)}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-ui-border text-ui-text-2 transition-colors hover:border-ui-border-strong hover:bg-ui-elevated hover:text-ui-text"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <GeometryBadge status={area.geometryStatus} />
        <span className="sr-only">{t(geometryHelp(area.geometryStatus))}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCompare}
          aria-label={t(S.compareAria)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ui-border-strong px-2.5 text-[12px] font-medium text-ui-text transition-colors hover:border-ui-cyan/60 hover:bg-ui-elevated"
        >
          <GitCompareArrows className="size-3.5" aria-hidden />
          {t(S.compare)}
        </button>
        <button
          type="button"
          onClick={on3d}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--ui-cyan)_45%,transparent)] bg-[color-mix(in_srgb,var(--ui-cyan)_10%,transparent)] px-2.5 text-[12px] font-medium text-ui-text transition-colors hover:bg-[color-mix(in_srgb,var(--ui-cyan)_18%,transparent)]"
        >
          <Box className="size-3.5 text-ui-cyan" aria-hidden />
          {t(S.explore3d)}
        </button>
      </div>
      {area.kind === "community-zone" && <p className="text-[11px] leading-4 text-ui-text-2">{t(S.hyZone)}</p>}
      {area.geometryStatus === "approximate" && <PanelNote tone="warn">{t(S.approxNote)}</PanelNote>}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/*  Overview                                                           */
/* ------------------------------------------------------------------ */

const PROFILE_KEYS: MetricId[] = ["population", "areaKm2", "populationDensity", "wastePerCapita", "rainfallAnnual"];

function OverviewTab({ ctx }: { ctx: Ctx }) {
  const t = useTr();
  const lang = useLang();
  const { area, ds, sc, as, bundle } = ctx;
  const primary = primaryWasteMetric(ds);
  const communities = useMemo(() => normalizeCommunities(bundle.communities), [bundle.communities]);

  const items = useMemo<MetricGridItem[]>(() => {
    const keys: MetricId[] = [primary, ...PROFILE_KEYS];
    return keys.map((k) => {
      const m = metricOf(area, k);
      const { mean, max } = areaMean(ds.areas, k);
      const def = METRICS[k];
      return {
        key: k,
        label: t(def.label),
        metric: m,
        decimals: def.decimals,
        extra:
          mean !== null && k !== "areaKm2" ? (
            <div className="mt-1 flex flex-col gap-1">
              <MiniCompareBar value={valueOf(m)} reference={mean} max={max} />
              <span className="ui-num text-[10px] text-ui-text-2">{t(S.avgOfAreas).replace("{v}", `${formatNumber(mean, lang, def.decimals)} ${unitLabel(def.unit, lang)}`)}</span>
            </div>
          ) : undefined,
      };
    });
  }, [area, ds, primary, t, lang]);

  const historical = sc.source === "historical";
  const rain24 = historical ? liveAreaMetric(area, "rainfall24h", as, sc.date) : metricOf(area, "rainfall24h");
  const rainDate = historical ? sc.date : (rain24?.provenance.observedTo ?? rain24?.provenance.observedFrom ?? null);
  const risk = liveAreaMetric(area, "modeledFloodRisk", as, sc.date);
  const stress = liveAreaMetric(area, "drainageStress", as, sc.date);

  return (
    <>
      <PanelSection title={t(S.modelled)} id={`${area.id}-ov-model`} actions={<StatusBadge status="simulated" size="xs" />}>
        <div className="grid grid-cols-[1.2fr_1fr] gap-2">
          <div className="flex flex-col gap-1.5 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5" role="group" aria-label={t(S.modelled)}>
            <div className="flex items-baseline gap-2">
              <MetricReadout metric={risk} decimals={1} valueClassName="proportional-nums [font-feature-settings:normal] text-[26px] font-semibold text-ui-text" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <RiskChip cls={as?.current.riskClass ?? null} />
              {sc.source !== "baseline" && as && <DeltaText delta={as.delta} label={t(S.vsBaseline)} />}
            </div>
            {sc.source !== "baseline" && as && as.baseline.score !== null && (
              <span className="text-[10.5px] text-ui-text-2">{t(S.baselineIs).replace("{v}", formatNumber(as.baseline.score, lang, 1))}</span>
            )}
          </div>
          <MetricTile label={t(S.stressNow)} metric={stress} decimals={0}>
            {as && <StressMiniGauge current={as.current.drainageStressPct} baseline={sc.source !== "baseline" ? as.baseline.drainageStressPct : null} />}
          </MetricTile>
        </div>
      </PanelSection>
      <PanelSection title={t(S.facts)} id={`${area.id}-ov-facts`}>
        <MetricGrid items={items} />
        <MetricTile label={t(historical ? S.rainSel : S.rainLatest)} metric={rain24} decimals={1} hint={rainDate ? formatDate(rainDate, lang, "long") : undefined} />
        <p className="text-[10.5px] text-ui-text-2">{t(S.barLegend)}</p>
      </PanelSection>
      {communities?.byZone.has(area.id) && (
        <PanelSection title={t(S.communities)} id={`${area.id}-ov-communities`} actions={<StatusBadge status="observed" size="xs" />}>
          <CommunityList model={communities} zoneId={area.id} />
        </PanelSection>
      )}
    </>
  );
}

function StressMiniGauge({ current, baseline }: { current: number; baseline: number | null }) {
  const cap = 100 / L_SAT;
  return (
    <div aria-hidden className="relative mt-1 h-1.5 w-full rounded-full bg-ui-border/60">
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--motion-scenario) ease-(--ease-out-expo)"
        style={{ width: `${Math.min(100, current)}%`, background: current >= cap ? "var(--risk-very-high)" : current >= cap * 0.75 ? "var(--risk-high)" : "var(--ui-cyan)" }}
      />
      <div className="absolute -top-1 h-3.5 w-px bg-ui-text-2" style={{ left: `${cap}%` }} />
      {baseline !== null && <div className="absolute -bottom-1.5 size-1.5 -translate-x-1/2 rotate-45 bg-ui-text-2" style={{ left: `${Math.min(100, baseline)}%` }} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Waste                                                              */
/* ------------------------------------------------------------------ */

function WasteTab({ ctx }: { ctx: Ctx }) {
  const t = useTr();
  const lang = useLang();
  const { area, ds, sc } = ctx;
  const setPanel = useDashboard((s) => s.setPanel);
  const primary = primaryWasteMetric(ds);
  const def = METRICS[primary];
  const total = metricOf(area, primary);
  const hasAreaComp = !!area.composition && area.composition.provenance?.status !== "unavailable";
  // An "estimated" area composition is the citywide composition applied to the area, not an area measurement.
  const areaCompApplied = hasAreaComp && area.composition!.provenance.status === "estimated";

  // ≤ 50 areas: cheap enough to derive on render (and left to the React Compiler to memoize).
  const rank = rankStats(ds.areas, area.id, primary);
  const perCapRank = rankStats(ds.areas, area.id, "wastePerCapita");

  const generated = metricOf(area, "wasteGenerated");
  const inflowMetric = hasValue(generated) ? generated : total;
  const inflowIsProxy = !hasValue(generated) && hasValue(total) && primary === "wasteCollected";
  const effParams = sc.source === "scenario" ? sc.params : BASELINE_SCENARIO;

  const tiles: MetricGridItem[] = [
    { key: "wastePerCapita", label: t(METRICS.wastePerCapita.label), metric: metricOf(area, "wastePerCapita"), decimals: METRICS.wastePerCapita.decimals },
    { key: "wasteDensity", label: t(METRICS.wasteDensity.label), metric: metricOf(area, "wasteDensity"), decimals: METRICS.wasteDensity.decimals },
  ];
  const genRank = hasValue(generated) && primary !== "wasteGenerated" ? rankStats(ds.areas, area.id, "wasteGenerated") : null;
  // Composition studies describe generated waste; apply shares to it when the area has a value, else to the primary measure.
  const compTotal = hasValue(generated) ? generated : total;
  const compTotalLabel = hasValue(generated) ? t(METRICS.wasteGenerated.label) : t(def.label);
  const composition = hasAreaComp ? area.composition : ds.composition;

  return (
    <>
      <PanelSection title={t(S.measures)} id={`${area.id}-w-measures`}>
        <WasteMeasures generated={metricOf(area, "wasteGenerated")} collected={metricOf(area, "wasteCollected")} showDefinitions />
        <SourceLine provenance={total?.provenance} />
      </PanelSection>

      <PanelSection title={t(S.wasteFigures)} id={`${area.id}-w-figs`}>
        <MetricGrid items={tiles} />
        <MetricTile label={t(METRICS.wasteAccumulated.label)} metric={metricOf(area, "wasteAccumulated")} decimals={METRICS.wasteAccumulated.decimals} compact />
      </PanelSection>

      <PanelSection title={t(S.rankTitle)} id={`${area.id}-w-rank`}>
        <div className="grid grid-cols-2 gap-2">
          <RankCard label={t(def.label)} rank={rank.rank} n={rank.n}>
            {rank.diff !== null && (
              <div className="flex flex-col gap-0.5">
                <DeltaText delta={rank.diff} decimals={def.decimals} suffix={` ${unitLabel(def.unit, lang)}`} label={t(S.vsMean)} />
                {rank.pct !== null && <DeltaText delta={rank.pct} decimals={0} suffix="%" />}
              </div>
            )}
          </RankCard>
          <RankCard label={t(METRICS.wastePerCapita.label)} rank={perCapRank.rank} n={perCapRank.n} />
          {genRank && (
            <RankCard label={t(METRICS.wasteGenerated.label)} rank={genRank.rank} n={genRank.n}>
              <StatusBadge status={generated?.provenance.status ?? "unavailable"} size="xs" className="self-start" />
            </RankCard>
          )}
        </div>
      </PanelSection>

      <PanelSection id={`${area.id}-w-comp`}>
        <WasteCompositionChart
          composition={composition}
          total={compTotal}
          totalLabel={compTotalLabel}
          scopeLabel={t(areaCompApplied ? S.areaCompApplied : hasAreaComp ? S.areaComp : S.cityComp)}
          quantityStatus={hasAreaComp && !areaCompApplied ? "derived" : "estimated"}
          note={
            areaCompApplied ? (
              <PanelNote tone="warn">{t(S.areaCompAppliedNote)}</PanelNote>
            ) : !hasAreaComp && composition?.provenance.status !== "unavailable" ? (
              <PanelNote tone="warn">{t(S.cityCompNote)}</PanelNote>
            ) : undefined
          }
        />
        <SourceLine provenance={composition?.provenance} />
      </PanelSection>

      <PanelSection id={`${area.id}-w-hist`}>
        <WasteTrendChart history={area.wasteHistory} generated={area.wasteGeneratedHistory} title={t(S.historyTitle)} />
      </PanelSection>

      <PanelSection id={`${area.id}-w-acc`}>
        <div className="flex flex-col gap-2 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5">
          <div className="text-[11px] font-medium text-ui-text-2">{t(S.accInputs)}</div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
            <span className="text-ui-text-2">{t(S.inflow)}</span>
            <span className="inline-flex items-center gap-1.5">
              <MetricReadout metric={inflowMetric} decimals={1} animate={false} valueClassName="text-ui-text font-medium" />
              <StatusBadge status={inflowMetric?.provenance.status ?? "unavailable"} size="xs" />
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
            <span className="text-ui-text-2">
              {t(S.efficiency)} <span className="text-[10.5px]">({sc.source === "scenario" ? t(S.effSource) : t(S.effBase)})</span>
            </span>
            <span className="ui-num font-medium text-ui-text">{formatNumber(effParams.collectionEfficiency * 100, lang, 0)}%</span>
          </div>
          {inflowIsProxy && <p className="text-[10.5px] leading-4 text-ui-text-2">{t(S.inflowProxy)}</p>}
          <button
            type="button"
            onClick={() => {
              // Same as the shell's "open lab": the lab lives in the left column, so make sure it is visible.
              setPanel("labOpen", true);
              setPanel("leftOpen", true);
            }}
            className="inline-flex h-7 items-center gap-1.5 self-start rounded-md border border-ui-border px-2 text-[11px] font-medium text-ui-text transition-colors hover:border-ui-border-strong hover:bg-ui-elevated"
          >
            <FlaskConical className="size-3.5 text-status-simulated" aria-hidden />
            {t(S.openLab)}
          </button>
        </div>
        <AccumulationChart inflow={valueOf(inflowMetric)} efficiency={effParams.collectionEfficiency} baselineEfficiency={BASELINE_SCENARIO.collectionEfficiency} />
      </PanelSection>
    </>
  );
}

/** Rank (1 = highest) of an area among areas with a value, plus its difference from the area mean. */
function rankStats(areas: AreaRecord[], areaId: string, id: MetricId) {
  const rows = rankAreas(areas, (a) => metricOf(a, id) ?? { value: null, unit: METRICS[id].unit, provenance: { status: "unavailable" } });
  const n = rows.filter((r) => r.rank !== null).length;
  const me = rows.find((r) => r.area.id === areaId);
  const { mean } = areaMean(areas, id);
  const v = me?.value ?? null;
  const diff = v !== null && mean !== null ? v - mean : null;
  const pct = diff !== null && mean ? (diff / mean) * 100 : null;
  return { rank: me?.rank ?? null, n, mean, diff, pct };
}

function RankCard({ label, rank, n, children }: { label: string; rank: number | null; n: number; children?: ReactNode }) {
  const t = useTr();
  const lang = useLang();
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5" role="group" aria-label={label}>
      <span className="text-[11px] leading-4 text-ui-text-2">{label}</span>
      {rank !== null ? (
        <span className="text-[12px] text-ui-text-2">
          <span className="ui-num proportional-nums [font-feature-settings:normal] mr-1 text-[20px] font-semibold text-ui-text">{formatNumber(rank, lang)}</span>
          {t({ th: "จาก", en: "of" })} <span className="ui-num">{formatNumber(n, lang)}</span>
          <span className="sr-only">{t(S.rankOf).replace("{r}", String(rank)).replace("{n}", String(n))}</span>
        </span>
      ) : (
        <span className="text-[12px] text-ui-text-2">{t(S.rankNA)}</span>
      )}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Rain & drainage                                                    */
/* ------------------------------------------------------------------ */

const timeFmt = new Map<Lang, Intl.DateTimeFormat>();
function formatDateTime(iso: string | undefined, lang: Lang) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let f = timeFmt.get(lang);
  if (!f) {
    f = new Intl.DateTimeFormat(lang === "th" ? "th-TH" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
    timeFmt.set(lang, f);
  }
  return `${formatDate(iso, lang)} ${f.format(d)}`;
}

function RainTab({ ctx }: { ctx: Ctx }) {
  const t = useTr();
  const lang = useLang();
  const { area, bundle, as, sc } = ctx;
  const dateIndex = useDashboard((s) => s.dateIndex);
  const setDateIndex = useDashboard((s) => s.setDateIndex);
  const rs = bundle.rainAreas;
  // Clicking a day drives the shared historical timeline (as the Rainfall dock does).
  const onSelectDay = (i: number) => {
    setDateIndex(i);
    const st = useDashboard.getState();
    if (!st.scenarioActive && st.timelineMode !== "historical") st.setTimelineMode("historical");
  };

  const rain = useMemo(() => {
    const values = areaRainSeries(rs, area.id);
    if (!rs || !values) return null;
    const [start, end] = rainWindow(rs.dates.length, dateIndex, 90);
    const stats = windowStats(values, start, end);
    const last30 = values.slice(Math.max(start, end - 29), end + 1).map((v) => (v === undefined ? null : v));
    return { start, end, stats, last30, endDate: rs.dates[end] };
  }, [rs, area.id, dateIndex]);

  const near = useMemo(() => nearbyStations(bundle.stations, area.anchor, 6), [bundle.stations, area.anchor]);
  const gauges = useMemo(() => nearbyGauges(bundle.waterLevels, area.anchor, 8), [bundle.waterLevels, area.anchor]);

  const infra = useMemo(() => {
    const poly = areaPolygon(bundle.areasGeo, area.id);
    return {
      poly: !!poly,
      ww: infrastructureInArea(bundle.waterways, poly),
      dr: infrastructureInArea(bundle.drainage, poly),
    };
  }, [bundle.areasGeo, bundle.waterways, bundle.drainage, area.id]);

  const rain90: MetricValue | null = rain
    ? derivedMetric(rain.stats.sum, "mm", rs?.provenance.status ?? "estimated", {
        sourceName: rs?.provenance.sourceName,
        sourceUrl: rs?.provenance.sourceUrl,
        observedFrom: rs?.dates[rain.start],
        observedTo: rain.endDate,
        methodology: t(S.rain90Method),
      })
    : null;
  const rain24 = sc.source === "historical" ? liveAreaMetric(area, "rainfall24h", as, sc.date) : metricOf(area, "rainfall24h");
  const kinds = mergeKinds([...(infra.ww?.byKind ?? []), ...(infra.dr?.byKind ?? [])]);

  return (
    <>
      <PanelSection id={`${area.id}-r-chart`}>
        <RainfallChart
          series={rs}
          areaId={area.id}
          endIndex={dateIndex}
          days={90}
          selectedIndex={dateIndex}
          onSelectIndex={onSelectDay}
          title={t(S.rainTitle)}
          subtitle={rain ? t(S.rainEnd).replace("{d}", formatDate(rain.endDate, lang, "long")) : undefined}
          height={160}
        />
        <div className="grid grid-cols-2 gap-2">
          <MetricTile label={t(METRICS.rainfallAnnual.label)} metric={metricOf(area, "rainfallAnnual")} decimals={0} compact />
          <MetricTile
            label={t(S.rain90)}
            metric={rain90}
            decimals={0}
            compact
            hint={rain ? t(S.wetDays).replace("{n}", formatNumber(rain.stats.wetDays, lang)) : undefined}
          >
            {rain && rain.last30.filter((v) => v !== null).length > 1 && <Sparkline values={rain.last30} width={110} height={18} className="mt-1" color="#1f95d0" />}
          </MetricTile>
          <MetricTile label={t(METRICS.rainfall24h.label)} metric={rain24} decimals={1} compact className="col-span-2" hint={sc.source === "historical" && sc.date ? formatDate(sc.date, lang, "long") : undefined} />
        </div>
      </PanelSection>

      {!!bundle.rainHourly?.length && (
        <PanelSection title={t(S.hourly)} id={`${area.id}-r-hourly`}>
          <HourlyRainPanel events={bundle.rainHourly} daily={rs} height={150} compact />
        </PanelSection>
      )}

      <PanelSection title={t(S.stations)} id={`${area.id}-r-stations`}>
        {!bundle.stations ? (
          <UnavailableBlock>{t(S.noStations)}</UnavailableBlock>
        ) : near.length === 0 ? (
          <UnavailableBlock>{t(S.noNearby)}</UnavailableBlock>
        ) : (
          <div className="ui-scroll overflow-x-auto">
            <table className="w-full min-w-[320px] text-[11px]">
              <caption className="sr-only">{t(S.stations)}</caption>
              <thead>
                <tr className="text-left text-[10.5px] text-ui-text-2">
                  <th scope="col" className="py-1 font-medium">
                    {t(S.station)}
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    {t(S.distance)}
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    {t(S.rain24)}
                  </th>
                  <th scope="col" className="py-1 pl-2 text-right font-medium">
                    {t(S.observedAt)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {near.slice(0, 8).map(({ station, distanceKm }) => (
                  <tr key={station.id} className="border-t border-ui-border/60 align-top">
                    <th scope="row" className="py-1.5 pr-2 text-left font-normal text-ui-text">
                      {lang === "th" && station.nameTh ? station.nameTh : station.nameEn}
                      <span className="block text-[10px] text-ui-text-2">{station.agency}</span>
                    </th>
                    <td className="ui-num py-1.5 text-right text-ui-text-2">
                      {formatNumber(distanceKm, lang, 1)} {t(KM)}
                    </td>
                    <td className="py-1.5 text-right">
                      <span className="inline-flex flex-col items-end gap-0.5">
                        <MetricReadout metric={station.rain24h} decimals={1} animate={false} valueClassName="text-ui-text" />
                        <StatusBadge status={station.rain24h?.provenance.status ?? "unavailable"} size="xs" />
                      </span>
                    </td>
                    <td className="ui-num py-1.5 pl-2 text-right text-[10.5px] text-ui-text-2">{formatDateTime(station.observedAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelSection>

      <PanelSection
        title={t(S.gauges)}
        id={`${area.id}-r-gauges`}
        actions={bundle.waterLevels?.length ? <StatusBadge status={gauges.length ? "observed" : "unavailable"} size="xs" /> : undefined}
      >
        {!bundle.waterLevels?.length ? (
          <UnavailableBlock>{t(S.noGauges)}</UnavailableBlock>
        ) : gauges.length === 0 ? (
          <UnavailableBlock>{t(S.noNearGauge)}</UnavailableBlock>
        ) : (
          <>
            <div className="ui-scroll overflow-x-auto">
              <table className="w-full min-w-[340px] text-[11px]">
                <caption className="sr-only">{t(S.gauges)}</caption>
                <thead>
                  <tr className="text-left text-[10.5px] text-ui-text-2">
                    <th scope="col" className="py-1 font-medium">
                      {t(S.gauge)}
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      {t(S.distance)}
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      {t(S.level)}
                    </th>
                    <th scope="col" className="py-1 pl-2 text-right font-medium">
                      {t(S.capacity)}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {gauges.slice(0, 6).map((g) => {
                    const cls = GAUGE_CLASS[g.cls];
                    const cap = g.station.capacityPct && g.station.capacityPct.value !== null && g.station.capacityPct.provenance.status !== "unavailable" ? g.station.capacityPct.value : null;
                    const lv = formatLevel(g.station.waterLevel, lang);
                    const bank = formatLevel(g.station.bankLevel, lang);
                    return (
                      <tr key={g.station.id} className="border-t border-ui-border/60 align-top">
                        <th scope="row" className="py-1.5 pr-2 text-left font-normal text-ui-text">
                          <span className="flex items-start gap-1.5">
                            <GaugeGlyph cls={g.cls} className="mt-0.5" />
                            <span className="min-w-0">
                              {gaugeName(g.station, lang)}
                              <span className="block text-[10px] text-ui-text-2">{[g.station.waterway, g.station.agency].filter(Boolean).join(" · ")}</span>
                              <span className="block text-[10px] text-ui-text-3">{formatDateTime(g.station.observedAt ?? g.station.waterLevel?.provenance.observedTo, lang)}</span>
                            </span>
                          </span>
                        </th>
                        <td className="ui-num py-1.5 text-right text-ui-text-2">
                          {formatNumber(g.distanceKm, lang, 1)} {t(KM)}
                        </td>
                        <td className="py-1.5 text-right">
                          <span className="inline-flex flex-col items-end gap-0.5">
                            <span className={cn("ui-num", lv ? "text-ui-text" : "text-[10.5px] text-ui-text-2")}>{lv ?? t(COMMON.unavailable)}</span>
                            {bank && (
                              <span className="ui-num text-[10px] text-ui-text-2">
                                {t(S.bankShort)} {bank}
                              </span>
                            )}
                            <StatusBadge status={lv ? g.station.waterLevel.provenance.status : "unavailable"} size="xs" />
                          </span>
                        </td>
                        <td className="py-1.5 pl-2 text-right">
                          <span className="inline-flex flex-col items-end gap-0.5">
                            <span className="ui-num text-ui-text">{cap !== null ? `${formatNumber(cap, lang, 0)}%` : "—"}</span>
                            <span className="text-[10px] font-medium" style={{ color: cls.color }}>
                              {t(cls.label)}
                            </span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[10.5px] leading-4 text-ui-text-2">{t(GAUGE_SNAPSHOT)}</p>
          </>
        )}
      </PanelSection>

      <PanelSection title={t(S.waterways)} id={`${area.id}-r-ww`} actions={<StatusBadge status={infra.ww ? "derived" : "unavailable"} size="xs" />}>
        {!bundle.waterways && !bundle.drainage ? (
          <UnavailableBlock>{t(S.wwNone)}</UnavailableBlock>
        ) : !infra.poly ? (
          <UnavailableBlock>{t(S.wwNoPoly)}</UnavailableBlock>
        ) : (
          <>
            {infra.ww && (
              <div className="flex items-baseline justify-between gap-2 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5">
                <span className="text-[11px] text-ui-text-2">{t(S.wwLength)}</span>
                <span className="text-[12px] text-ui-text-2">
                  <span className="ui-num proportional-nums [font-feature-settings:normal] mr-1 text-[18px] font-semibold text-ui-text">{formatNumber(infra.ww.totalKm, lang, 1)}</span>
                  {t(KM)}
                </span>
              </div>
            )}
            {kinds.length === 0 ? (
              <UnavailableBlock>{t(S.wwEmpty)}</UnavailableBlock>
            ) : (
              <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                {kinds.map((k) => (
                  <li key={k.kind} className="flex items-baseline justify-between gap-2 border-b border-ui-border/50 py-1">
                    <span className="truncate text-ui-text-2">{t(kindLabel(k.kind))}</span>
                    <span className="ui-num shrink-0 text-ui-text">
                      {k.lengthKm > 0.05 ? `${formatNumber(k.lengthKm, lang, 1)} ${t(KM)}` : t(S.features).replace("{n}", formatNumber(k.count, lang))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10.5px] leading-4 text-ui-text-2">
              {t(S.wwMethod)}. {t(S.osm)}
              {ctx.area.geometryStatus === "approximate" ? ` ${t(S.approxNote)}` : ""}
            </p>
          </>
        )}
      </PanelSection>

      <PanelSection title={t(S.gaugeTitle)} id={`${area.id}-r-gauge`} actions={<StatusBadge status="simulated" size="xs" />}>
        {as ? <DrainageGauge current={as.current.drainageStressPct} baseline={as.baseline.drainageStressPct} loadRatio={as.current.loadRatio} showBaseline={sc.source !== "baseline"} /> : <UnavailableBlock />}
        <p className="text-[11.5px] leading-[1.6] text-ui-text-2">
          {t(S.gaugeExplain).replace("{cap}", formatNumber(DEFAULT_ASSUMPTIONS.designIntensityMmH, lang)).replace("{full}", formatNumber(100 / L_SAT, lang, 1))}
        </p>
      </PanelSection>
    </>
  );
}

function mergeKinds(rows: KindCount[]): KindCount[] {
  const m = new Map<string, KindCount>();
  for (const r of rows) {
    const cur = m.get(r.kind);
    m.set(r.kind, cur ? { kind: r.kind, count: cur.count + r.count, lengthKm: cur.lengthKm + r.lengthKm } : { ...r });
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

function DrainageGauge({ current, baseline, loadRatio, showBaseline }: { current: number; baseline: number; loadRatio: number; showBaseline: boolean }) {
  const t = useTr();
  const lang = useLang();
  const cap = 100 / L_SAT;
  const over = current >= cap;
  const color = over ? "var(--risk-very-high)" : current >= cap * 0.75 ? "var(--risk-high)" : "var(--ui-cyan)";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <span className="ui-num proportional-nums [font-feature-settings:normal] text-[26px] font-semibold text-ui-text">{formatNumber(current, lang, 0)}</span>
          <span className="ml-1 text-[12px] text-ui-text-2">%</span>
        </div>
        <div className="text-right text-[11px] text-ui-text-2">
          {t(S.loadRatio)} <span className="ui-num text-ui-text">{Number.isFinite(loadRatio) ? `${formatNumber(loadRatio, lang, 2)}×` : "∞"}</span>
          {over && (
            <span className="ml-1.5 inline-flex items-center gap-1 text-[var(--risk-very-high)]">
              <Droplets className="size-3" aria-hidden />
              {t({ th: "เกินความจุ", en: "Over capacity" })}
            </span>
          )}
        </div>
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(current)}
        aria-valuetext={`${formatNumber(current, lang, 0)}% — ${t(S.gaugeCap)} ${formatNumber(cap, lang, 1)}%`}
        aria-label={t(S.gaugeTitle)}
        className="relative h-2.5 w-full rounded-full bg-[color-mix(in_srgb,var(--ui-cyan)_12%,transparent)]"
      >
        <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--motion-scenario) ease-(--ease-out-expo)" style={{ width: `${Math.min(100, current)}%`, background: color }} />
        <div className="absolute -top-1.5 h-5.5 w-0.5 rounded bg-ui-text" style={{ left: `calc(${cap}% - 1px)` }} />
        {showBaseline && <div className="absolute -bottom-2 size-2 -translate-x-1/2 rotate-45 border border-ui-surface bg-ui-text-2" style={{ left: `${Math.min(100, baseline)}%` }} />}
      </div>
      <div className="relative h-4 text-[10px] text-ui-text-2">
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-ui-text" style={{ left: `${cap}%` }}>
          {t(S.gaugeCap)} {formatNumber(cap, lang, 1)}%
        </span>
        <span className="absolute right-0">100</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-ui-text-2">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-1.5 w-3 rounded-full" style={{ background: color }} />
          {t(S.gaugeNow)} {formatNumber(current, lang, 0)}%
        </span>
        {showBaseline && (
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block size-1.5 rotate-45 bg-ui-text-2" />
            {t(S.gaugeBase)} {formatNumber(baseline, lang, 0)}%
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Flood factors                                                      */
/* ------------------------------------------------------------------ */

function FloodTab({ ctx }: { ctx: Ctx }) {
  const t = useTr();
  const lang = useLang();
  const { area, as, sc, bundle } = ctx;

  const baseRes = as?.baseline;
  const curRes = as?.current;
  const isBaseline = sc.source === "baseline";
  const rows = useMemo<RiskContributionRow[]>(() => {
    if (!baseRes || !curRes) return [];
    const base = { label: t(S.baselineRow), result: baseRes };
    return isBaseline ? [base] : [base, { label: t(S.currentRow), result: curRes }];
  }, [baseRes, curRes, isBaseline, t]);

  if (!as) return <PanelSection>{<UnavailableBlock />}</PanelSection>;
  const cur = as.current;
  const risk = liveAreaMetric(area, "modeledFloodRisk", as, sc.date);
  const sensParams = sc.source === "scenario" ? sc.params : BASELINE_SCENARIO;

  return (
    <>
      <PanelSection title={t(S.modelled)} id={`${area.id}-f-score`} actions={<StatusBadge status={risk.provenance.status} size="xs" />}>
        <div className="flex flex-col gap-2 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <MetricReadout metric={risk} decimals={1} valueClassName="proportional-nums [font-feature-settings:normal] text-[26px] font-semibold text-ui-text" />
            <RiskChip cls={cur.riskClass} />
            {sc.source !== "baseline" && <DeltaText delta={as.delta} label={t(S.vsBaseline)} />}
          </div>
          <div className="text-[11.5px] text-ui-text-2">
            {t(S.completeness).replace("{p}", formatNumber(cur.completeness * 100, lang, 0))}
            {cur.score === null && <span className="ml-1">· {t(S.minComplete).replace("{p}", formatNumber(MIN_COMPLETENESS * 100, lang, 0))}</span>}
          </div>
          <div className="text-[11.5px]">
            <span className="text-ui-text-2">{t(S.missingFactors)}: </span>
            {cur.missing.length ? (
              <span className="text-ui-text">{cur.missing.map((k) => t(FACTOR_LABELS[k])).join(", ")}</span>
            ) : (
              <span className="text-ui-text">{t(S.noneMissing)}</span>
            )}
          </div>
        </div>
        <PanelNote tone="sim">{t(S.simNote)}</PanelNote>
      </PanelSection>

      <PanelSection id={`${area.id}-f-contrib`}>
        <RiskContributionChart rows={rows} />
      </PanelSection>

      <PanelSection id={`${area.id}-f-sens`}>
        <SensitivityChart inputs={as.inputs} params={sensParams} />
      </PanelSection>

      <PanelSection title={t(S.cityEvents)} id={`${area.id}-f-events`}>
        <FloodEventsList events={bundle.floodEvents} max={3} dense />
      </PanelSection>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Data / provenance                                                  */
/* ------------------------------------------------------------------ */

const DATA_KEYS = Object.keys(METRICS) as MetricId[];

function periodText(p: DataProvenance | undefined, lang: Lang): string {
  if (!p) return "—";
  if (p.observedFrom) {
    if (!p.observedTo || p.observedTo === p.observedFrom) return formatDate(p.observedFrom, lang);
    return `${formatDate(p.observedFrom, lang)} – ${formatDate(p.observedTo, lang)}`;
  }
  if (p.referenceYear) return formatYear(p.referenceYear, lang);
  return "—";
}

function DataTab({ ctx }: { ctx: Ctx }) {
  const t = useTr();
  const lang = useLang();
  const { area } = ctx;
  const sources = useSources();
  const reg = useMemo(() => new Map<string, SourceRef>((sources.data ?? []).map((s) => [s.id, s] as const)), [sources.data]);

  const rows = useMemo(() => {
    const out: { key: string; label: string; value: string; unit: string; p: DataProvenance | undefined; period?: string }[] = DATA_KEYS.map((k) => {
      const m = metricOf(area, k);
      return {
        key: k,
        label: t(METRICS[k].label),
        value: formatMetric(m, lang, METRICS[k].decimals, false),
        unit: m ? unitLabel(m.unit, lang) : unitLabel(METRICS[k].unit, lang),
        p: m?.provenance ?? { status: "unavailable" },
      };
    });
    const comp = area.composition;
    out.push({
      key: "composition",
      label: t(S.compositionRow),
      value: comp ? `${formatNumber(Object.values(comp.shares).reduce((s, v) => s + (v ?? 0), 0), lang, 1)}%` : t(COMMON.unavailable),
      unit: "%",
      p: comp?.provenance ?? { status: "unavailable" },
    });
    const valued = [...(area.wasteHistory ?? [])].filter((h) => h.value !== null).sort((a, b) => a.year - b.year);
    const mixed = valued.some((h) => h.status !== valued[0]?.status);
    out.push({
      key: "history",
      label: t(S.historyRow),
      value: valued.length ? t(S.yearsCount).replace("{n}", formatNumber(valued.length, lang)) : t(COMMON.unavailable),
      unit: valued[0] ? unitLabel(valued[0].unit, lang) : "—",
      // Status shown is the latest year's; mixed statuses are disclosed in the method column.
      p: valued.length ? { status: valued[valued.length - 1].status, methodology: mixed ? t(S.mixedStatus) : undefined } : { status: "unavailable" },
      period: valued.length ? `${formatYear(valued[0].year, lang)}–${formatYear(valued[valued.length - 1].year, lang)}` : undefined,
    });
    return out;
  }, [area, lang, t]);

  const notes = lang === "th" ? area.notesTh : area.notesEn;

  return (
    <>
      <PanelSection title={t(S.provenance)} id={`${area.id}-d-table`}>
        <PanelNote>{t(S.dataNote)}</PanelNote>
        <p className="text-[10.5px] text-ui-text-2">{t(S.scrollHint)}</p>
        <div className="ui-scroll -mx-4 overflow-x-auto px-4" tabIndex={0} role="region" aria-label={t(S.provenance)}>
          <table className="w-full min-w-[920px] border-collapse text-left text-[11px]">
            <caption className="sr-only">
              {t(S.provenance)} — {area.nameTh} / {area.nameEn}
            </caption>
            <thead>
              <tr className="border-b border-ui-border text-[10.5px] text-ui-text-2">
                {[S.cMetric, S.cValue, S.cUnit, S.cScope, S.cPeriod, S.cStatus, S.cSource, S.cMethod, S.cLimits].map((c, i) => (
                  <th key={c.en} scope="col" className={cn("px-2 py-1.5 font-medium whitespace-nowrap", i === 0 && "sticky left-0 z-[1] bg-ui-surface")}>
                    {t(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = r.p;
                const status = p?.status ?? "unavailable";
                const src = p?.sourceId ? reg.get(p.sourceId) : undefined;
                const srcName = p?.sourceName ?? (src ? (lang === "th" && src.nameTh ? src.nameTh : src.nameEn) : p?.sourceId);
                const url = p?.sourceUrl ?? src?.url;
                return (
                  <tr key={r.key} className="border-b border-ui-border/50 align-top">
                    <th scope="row" className="sticky left-0 z-[1] bg-ui-surface px-2 py-1.5 font-medium text-ui-text">
                      {r.label}
                    </th>
                    <td className={cn("ui-num px-2 py-1.5 whitespace-nowrap", status === "unavailable" ? "text-ui-text-2" : "text-ui-text")}>{status === "unavailable" ? t(STATUS_META.unavailable.label) : r.value}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-ui-text-2">{r.unit}</td>
                    <td className="px-2 py-1.5 text-ui-text-2">{p?.geographicScope ?? "—"}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-ui-text-2">{r.period ?? periodText(p, lang)}</td>
                    <td className="px-2 py-1.5">
                      <StatusBadge status={status} size="xs" />
                    </td>
                    <td className="px-2 py-1.5 text-ui-text-2">
                      {srcName ? (
                        url ? (
                          <a href={url} target="_blank" rel="noopener noreferrer" className="text-ui-text underline decoration-ui-border-strong underline-offset-2 hover:decoration-ui-cyan">
                            {srcName}
                            <span className="sr-only"> {t({ th: "(เปิดในแท็บใหม่)", en: "(opens in a new tab)" })}</span>
                          </a>
                        ) : (
                          srcName
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="max-w-[220px] px-2 py-1.5 text-ui-text-2">{p?.methodology ?? "—"}</td>
                    <td className="max-w-[220px] px-2 py-1.5 text-ui-text-2">{p?.limitations?.length ? p.limitations.join(" · ") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </PanelSection>
      {notes && notes.length > 0 && (
        <PanelSection title={t(S.notes)} id={`${area.id}-d-notes`}>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[11.5px] leading-[1.6] text-ui-text-2">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </PanelSection>
      )}
    </>
  );
}
