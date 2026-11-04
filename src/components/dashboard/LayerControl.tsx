"use client";

import { useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import {
  ChevronDown,
  CloudDrizzle,
  CloudRain,
  Flame,
  Gauge,
  MapPinHouse,
  Scale,
  ShieldAlert,
  Trash,
  Users,
  WavesHorizontal,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTr, type Bi } from "@/lib/i18n";
import { useCityBundle } from "@/lib/data/loader";
import { primaryWasteMetric } from "@/lib/metrics";
import type { CityId, DataStatus, MetricValue } from "@/lib/types";
import { normalizeCommunities } from "@/lib/map/communities";
import { formatNumber } from "@/lib/formatters";
import { CHOROPLETH_LAYERS, useDashboard, type LayerId } from "@/store/dashboard-store";
import { DURATION, EASE, motionDuration, useReducedMotionPref } from "@/lib/animation/tokens";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Eyebrow } from "@/components/dashboard/Header";

interface LayerMeta {
  icon: LucideIcon;
  label: Bi;
  desc: Bi;
}

const LAYER_META: Record<LayerId, LayerMeta> = {
  wasteVolume: {
    icon: Trash,
    label: { th: "ปริมาณขยะ", en: "Waste volume" },
    desc: { th: "ตัน/วัน รายพื้นที่", en: "Tonnes per day by area" },
  },
  wastePerCapita: {
    icon: Scale,
    label: { th: "ขยะต่อคน", en: "Waste per capita" },
    desc: { th: "กก./คน/วัน = ขยะที่จัดเก็บได้ ÷ ประชากร", en: "kg/person/day = collected waste ÷ population" },
  },
  hotspots: {
    icon: Flame,
    label: { th: "จุดเฝ้าระวังขยะ", en: "Waste hotspots" },
    desc: { th: "พื้นที่ที่ค่าขยะสูงเมื่อเทียบกับทั้งเมือง", en: "Areas with high waste relative to the city" },
  },
  populationDensity: {
    icon: Users,
    label: { th: "ความหนาแน่นประชากร", en: "Population density" },
    desc: { th: "คน/ตร.กม.", en: "People per km²" },
  },
  rainObserved: {
    icon: CloudRain,
    label: { th: "ฝนจากสถานีตรวจวัด", en: "Observed rainfall" },
    desc: { th: "ค่าฝนจากสถานีตรวจวัด", en: "Rain-gauge station readings" },
  },
  rainEstimated: {
    icon: CloudDrizzle,
    label: { th: "ฝนประมาณการรายพื้นที่", en: "Estimated rainfall" },
    desc: { th: "จากข้อมูลแบบจำลองสภาพอากาศย้อนหลัง", en: "From weather reanalysis data" },
  },
  waterways: {
    icon: WavesHorizontal,
    label: { th: "คลองและทางน้ำ", en: "Canals & waterways" },
    desc: { th: "เส้นทางน้ำและระบบระบายน้ำหลัก", en: "Waterways and main drainage" },
  },
  floodRisk: {
    icon: ShieldAlert,
    label: { th: "ความเสี่ยงน้ำท่วม (แบบจำลอง)", en: "Modeled flood risk" },
    desc: { th: "คะแนน 0–100 จากแบบจำลองเชิงสาธิต", en: "0–100 score from an illustrative model" },
  },
  waterLevel: {
    icon: Gauge,
    label: { th: "ระดับน้ำในคลอง/แม่น้ำ", en: "River & canal water levels" },
    desc: { th: "สถานีวัดระดับน้ำ ค่า ณ เวลาดึงข้อมูล (ไม่ใช่ข้อมูลสด)", en: "Water-level gauges, snapshot at retrieval (not live)" },
  },
  communities: {
    icon: MapPinHouse,
    label: { th: "ชุมชน", en: "Communities" },
    desc: { th: "รายชื่อชุมชนตามประกาศเทศบาล — จุดเส้นประคือตำแหน่งสาธิต ไม่ใช่พิกัดจริง", en: "Official community list — dashed markers are illustrative placements, not real locations" },
  },
};

const GROUPS: { id: string; label: Bi; layers: LayerId[]; /** Only for cities that publish this layer at all. */ cities?: CityId[] }[] = [
  { id: "waste", label: { th: "ขยะ", en: "Waste" }, layers: ["wasteVolume", "wastePerCapita", "hotspots"] },
  { id: "population", label: { th: "ประชากร", en: "Population" }, layers: ["populationDensity"] },
  { id: "community", label: { th: "ชุมชน", en: "Communities" }, layers: ["communities"], cities: ["hatyai"] },
  { id: "rain", label: { th: "ฝนและการระบายน้ำ", en: "Rain & drainage" }, layers: ["rainObserved", "rainEstimated", "waterways", "waterLevel"] },
  { id: "risk", label: { th: "ความเสี่ยง", en: "Risk" }, layers: ["floodRisk"] },
];

const statusOf = (m: MetricValue | undefined): DataStatus => m?.provenance.status ?? "unavailable";

/** Data status per layer, read from the loaded bundle (never assumed), plus a short note where one status is not the whole story. */
function useLayerStatuses(): { status: Record<LayerId, DataStatus>; notes: Partial<Record<LayerId, Bi>> } | null {
  const { bundle } = useCityBundle();
  return useMemo(() => {
    const ds = bundle?.dataset;
    if (!bundle || !ds) return null;
    const gauge = bundle.waterLevels?.find((g) => g.waterLevel?.value !== null && g.waterLevel?.provenance.status !== "unavailable");
    const comm = normalizeCommunities(bundle.communities);
    const placed = comm ? comm.verified + comm.illustrative : 0;
    const notes: Partial<Record<LayerId, Bi>> = {};
    if (gauge) notes.waterLevel = { th: "ค่า ณ เวลาดึงข้อมูล", en: "Snapshot" };
    if (comm && placed) {
      notes.communities =
        comm.illustrative > 0
          ? {
              th: `ตำแหน่งสาธิต ${formatNumber(comm.illustrative, "th")} จาก ${formatNumber(placed, "th")} จุด`,
              en: `${formatNumber(comm.illustrative, "en")} of ${formatNumber(placed, "en")} illustrative`,
            }
          : { th: "ตำแหน่งยืนยันแล้วทั้งหมด", en: "All locations verified" };
    }
    const station = bundle.stations?.find((s) => s.rain24h.provenance.status !== "unavailable");
    const rainSeries = bundle.rainAreas ?? bundle.rainGrid;
    const status: Record<LayerId, DataStatus> = {
      wasteVolume: statusOf(ds.totals[primaryWasteMetric(ds)]),
      wastePerCapita: statusOf(ds.totals.wastePerCapita),
      // hotspots are classified from the observed/derived waste metrics of each area
      hotspots: ds.areas.some((a) => a.metrics.wasteDensity?.value !== null || a.metrics.wastePerCapita?.value !== null) ? "derived" : "unavailable",
      populationDensity: statusOf(ds.totals.populationDensity),
      rainObserved: station ? station.rain24h.provenance.status : "unavailable",
      rainEstimated: rainSeries ? rainSeries.provenance.status : statusOf(ds.totals.rainfall24h),
      waterways: bundle.waterways || bundle.drainage ? "observed" : "unavailable",
      floodRisk: ds.areas.some((a) => a.metrics.floodExposure?.value !== null) ? "simulated" : "unavailable",
      waterLevel: gauge ? gauge.waterLevel.provenance.status : "unavailable",
      // What the map draws are positions: any illustrative placement makes the layer a demonstration layer.
      communities: !comm || !placed ? "unavailable" : comm.illustrative > 0 ? "simulated" : "observed",
    };
    return { status, notes };
  }, [bundle]);
}

function OpacitySlider({ id, label }: { id: LayerId; label: string }) {
  const t = useTr();
  const opacity = useDashboard((s) => s.layers[id].opacity);
  const setOpacity = useDashboard((s) => s.setLayerOpacity);
  const pct = Math.round(opacity * 100);
  return (
    <div className="flex items-center gap-3 pt-1 pr-1 pb-2 pl-9">
      <span className="w-14 shrink-0 text-[11px] text-ui-text-3">{t({ th: "ความทึบ", en: "Opacity" })}</span>
      <SliderPrimitive.Root
        value={pct}
        min={10}
        max={100}
        step={5}
        onValueChange={(v) => setOpacity(id, (Array.isArray(v) ? (v[0] as number) : (v as number)) / 100)}
        className="flex-1"
      >
        <SliderPrimitive.Control className="relative flex h-5 w-full touch-none items-center select-none">
          <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-ui-elevated-2">
            <SliderPrimitive.Indicator className="h-full rounded-full bg-ui-cyan/75" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            getAriaLabel={() => `${t({ th: "ความทึบของชั้น", en: "Opacity of" })} ${label}`}
            getAriaValueText={(_f, v) => `${v}%`}
            className="block size-3.5 rounded-full border border-ui-cyan bg-ui-text shadow transition-shadow outline-none hover:ring-3 hover:ring-ui-cyan/25 focus-visible:ring-3 focus-visible:ring-ui-cyan/50"
          />
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>
      <span className="ui-num w-9 shrink-0 text-right text-[11px] text-ui-text-2">{pct}%</span>
    </div>
  );
}

function LayerRow({ id, status, note }: { id: LayerId; status: DataStatus | null; note?: string }) {
  const t = useTr();
  const reduced = useReducedMotionPref();
  const visible = useDashboard((s) => s.layers[id].visible);
  const setVisible = useDashboard((s) => s.setLayerVisible);
  const [expanded, setExpanded] = useState(false);
  const uid = useId();
  const meta = LAYER_META[id];
  const Icon = meta.icon;
  const label = t(meta.label);
  const choropleth = CHOROPLETH_LAYERS.includes(id);
  const unavailable = status === "unavailable";

  return (
    <li className={cn("rounded-lg transition-colors", visible && !unavailable ? "bg-ui-elevated/60" : "hover:bg-ui-elevated/35")}>
      <div className="flex items-center gap-2.5 px-1.5 py-1.5">
        <span
          aria-hidden
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors",
            visible && !unavailable ? "border-ui-cyan/40 bg-ui-cyan/10 text-ui-cyan" : "border-ui-border text-ui-text-3",
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor={`${uid}-switch`} className={cn("truncate text-[12.5px] leading-tight", unavailable ? "text-ui-text-3" : "text-ui-text")} title={t(meta.desc)}>
            {label}
          </label>
          <span className="flex items-center gap-1.5">
            {status ? <StatusBadge status={status} size="xs" /> : <Skeleton className="h-4 w-12 rounded-full" />}
            {choropleth && <span className="text-[10px] text-ui-text-3">{t({ th: "ระบายสีพื้นที่", en: "Area fill" })}</span>}
            {note && <span className="min-w-0 truncate text-[10px] text-ui-text-3">{note}</span>}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={`${uid}-opacity`}
          aria-label={`${t({ th: "ปรับความทึบ", en: "Adjust opacity" })}: ${label}`}
          disabled={unavailable}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ui-text-3 transition-colors outline-none hover:bg-ui-elevated hover:text-ui-text focus-visible:ring-2 focus-visible:ring-ui-cyan/60 disabled:opacity-40"
        >
          <ChevronDown aria-hidden className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-180")} />
        </button>
        <Switch
          id={`${uid}-switch`}
          checked={visible && !unavailable}
          disabled={unavailable}
          onCheckedChange={(v) => setVisible(id, v)}
          aria-label={label}
        />
      </div>
      <AnimatePresence initial={false}>
        {expanded && !unavailable && (
          <motion.div
            id={`${uid}-opacity`}
            key="opacity"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: motionDuration(DURATION.ui, reduced), ease: EASE.outExpo }}
            className="overflow-hidden"
          >
            <OpacitySlider id={id} label={label} />
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/** Map layers in groups (city-specific groups only where the city publishes them). Choropleth exclusivity is enforced by the store. */
export function LayerControl({ className }: { className?: string }) {
  const t = useTr();
  const meta = useLayerStatuses();
  const { status, cityId } = useCityBundle();
  const statuses = meta?.status ?? null;
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {GROUPS.filter((g) => !g.cities || g.cities.includes(cityId)).map((g) => {
        const headingId = `layer-group-${g.id}`;
        return (
          <section key={g.id} aria-labelledby={headingId} className="flex flex-col gap-1">
            <Eyebrow as="h3" id={headingId} className="px-1.5">
              {t(g.label)}
            </Eyebrow>
            <ul className="flex flex-col gap-0.5">
              {g.layers.map((id) => (
                <LayerRow key={id} id={id} status={statuses ? statuses[id] : status === "error" ? "unavailable" : null} note={meta?.notes[id] ? t(meta.notes[id]) : undefined} />
              ))}
            </ul>
          </section>
        );
      })}
      <p className="px-1.5 text-[11px] leading-relaxed text-ui-text-3">
        {t({
          th: "ชั้นข้อมูลแบบระบายสีพื้นที่แสดงได้ครั้งละหนึ่งชั้น ชั้นอื่นซ้อนทับได้",
          en: "Only one area-fill layer shows at a time; other layers can overlay it.",
        })}
      </p>
    </div>
  );
}
