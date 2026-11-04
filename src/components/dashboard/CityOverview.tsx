"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Layers3 } from "lucide-react";
import type { MetricValue } from "@/lib/types";
import { useCityBundle } from "@/lib/data/loader";
import { useScenario } from "@/lib/simulation/use-scenario";
import { METRICS, primaryWasteMetric, type MetricId } from "@/lib/metrics";
import { useLang, useTr } from "@/lib/i18n";
import { formatDate, formatNumber } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MetricReadout, StatusBadge } from "@/components/dashboard/StatusBadge";
import { FloodEventsList } from "@/components/dashboard/FloodEventsList";
import { MetricGrid, PanelNote, PanelSection, PanelSkeleton, SourceLine, WasteMeasures, type MetricGridItem } from "@/components/dashboard/MetricGrid";
import { WasteCompositionChart } from "@/components/charts/WasteCompositionChart";
import { WasteTrendChart } from "@/components/charts/WasteTrendChart";
import { RiskDistributionBar } from "@/components/charts/RiskDistributionBar";
import { modelMetric } from "@/components/charts/derive";

const S = {
  eyebrow: { th: "ภาพรวมเมือง", en: "City overview" },
  areas: { th: "{n} {kind}", en: "{n} {kind}s" },
  built: { th: "ประมวลผลชุดข้อมูลเมื่อ", en: "Dataset built" },
  keyFigures: { th: "ตัวเลขสำคัญ", en: "Key figures" },
  waste: { th: "ขยะมูลฝอย", en: "Municipal waste" },
  citywide: { th: "สัดส่วนระดับเมือง", en: "Citywide composition" },
  trend: { th: "แนวโน้มรายปี (ทั้งเมือง)", en: "Yearly trend (citywide)" },
  model: { th: "ผลแบบจำลองความเสี่ยงน้ำท่วม", en: "Modeled flood risk" },
  modelEyebrow: { th: "แบบจำลองเชิงอธิบาย — ไม่ใช่การพยากรณ์", en: "Explainable model — not a forecast" },
  srcBaseline: { th: "สภาวะฐาน", en: "Baseline conditions" },
  srcScenario: { th: "สถานการณ์จำลอง", en: "Scenario" },
  srcHistorical: { th: "ย้อนหลัง", en: "Historical replay" },
  meanRisk: { th: "ความเสี่ยงเฉลี่ย (ถ่วงน้ำหนักประชากร)", en: "Mean risk (population-weighted)" },
  meanStress: { th: "แรงกดดันระบายน้ำเฉลี่ย", en: "Mean drainage stress" },
  exposed: { th: "ประชากรในพื้นที่ความเสี่ยงสูงขึ้นไป", en: "Population in High / Very High areas" },
  exposedShare: { th: "{p}% ของประชากรที่มีข้อมูล", en: "{p}% of population with data" },
  distribution: { th: "การกระจายระดับความเสี่ยง", en: "Risk class distribution" },
  baselineRef: { th: "ฐาน {v}", en: "baseline {v}" },
  events: { th: "เหตุการณ์น้ำท่วมในอดีต", en: "Past flood events" },
  limitations: { th: "ข้อจำกัดสำคัญของข้อมูล", en: "Key data limitations" },
  missing: { th: "ไฟล์ข้อมูลเสริมที่ยังโหลดไม่ได้", en: "Optional data files not loaded" },
  hyZones: {
    th: "เขตชุมชนของหาดใหญ่เป็นเขตการบริหารจัดการชุมชนของเทศบาลนครหาดใหญ่ ไม่ใช่เขตการปกครอง (อำเภอ/ตำบล)",
    en: "Hat Yai zones are the municipality's community-management zones, not administrative districts.",
  },
  hyApprox: {
    th: "รูปร่างของเขตชุมชนบนแผนที่เป็นการแบ่งโดยประมาณเพื่อการสาธิตเท่านั้น ไม่ใช่ขอบเขตทางการ",
    en: "Zone shapes on the map are approximate, for demonstration only — not official boundaries.",
  },
  perCapitaHint: { th: "ต่อประชากรที่มีข้อมูล", en: "per resident (where data exists)" },
  noTotals: { th: "ไม่มีค่ารวมระดับเมือง", en: "No citywide totals" },
};

const TOTAL_KEYS: MetricId[] = ["population", "areaKm2", "populationDensity", "wastePerCapita", "rainfallAnnual"];

export function CityOverview() {
  const t = useTr();
  const lang = useLang();
  const { bundle, cityId } = useCityBundle();
  const sc = useScenario();
  const [limitsOpen, setLimitsOpen] = useState(false);

  const ds = bundle?.dataset;
  const primary = primaryWasteMetric(ds);

  const totals = useMemo<MetricGridItem[]>(() => {
    if (!ds) return [];
    const tt = ds.totals;
    const items: MetricGridItem[] = [];
    for (const k of TOTAL_KEYS) {
      items.push({ key: k, label: t(METRICS[k].label), metric: tt?.[k], decimals: METRICS[k].decimals, hint: k === "wastePerCapita" ? t(S.perCapitaHint) : undefined });
    }
    return items;
  }, [ds, t]);

  if (!ds) return <PanelSkeleton />;

  const city = ds.city;
  const kind = lang === "th" ? city.areaKindTh : city.areaKindEn;
  const approx = ds.areas.some((a) => a.geometryStatus === "approximate");
  const sum = sc.summary;
  const scored = Object.values(sum.classCounts).reduce((s, n) => s + n, 0);
  const unscored = sc.list.length - scored;
  const sourceLabel =
    sc.source === "scenario" ? t(S.srcScenario) : sc.source === "historical" ? `${t(S.srcHistorical)} · ${formatDate(sc.date, lang)}` : t(S.srcBaseline);

  const meanRisk: MetricValue = modelMetric(sum.meanScore, "score", { methodology: t(S.meanRisk) });
  const meanStress: MetricValue = modelMetric(sum.meanDrainageStress, "%", { methodology: t(S.meanStress) });
  const exposed: MetricValue = modelMetric(sum.exposedPopulation, "persons", { methodology: t(S.exposed) });
  const totalWaste = ds.totals?.[primary];

  return (
    <div className="flex flex-col">
      {/* Header */}
      <header className="flex flex-col gap-1.5 px-4 pt-4 pb-3">
        <div className="ui-eyebrow">{t(S.eyebrow)}</div>
        <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] text-ui-text">{lang === "th" ? city.nameTh : city.nameEn}</h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ui-text-2">
          <span className="inline-flex items-center gap-1">
            <Layers3 className="size-3.5" aria-hidden />
            {t(S.areas).replace("{n}", formatNumber(ds.areas.length, lang)).replace("{kind}", kind)}
          </span>
          <span aria-hidden>·</span>
          <span>{lang === "th" ? city.periodLabelTh : city.periodLabelEn}</span>
        </div>
        {ds.generatedAt && (
          <div className="text-[10.5px] text-ui-text-2">
            {t(S.built)} {formatDate(ds.generatedAt, lang, "long")}
          </div>
        )}
        {cityId === "hatyai" && (
          <PanelNote tone={approx ? "warn" : "info"} className="mt-2">
            <p>{t(S.hyZones)}</p>
            {approx && <p className="mt-1">{t(S.hyApprox)}</p>}
          </PanelNote>
        )}
      </header>

      {/* Key figures */}
      <PanelSection title={t(S.keyFigures)} id="city-key-figures">
        {ds.totals ? (
          <>
            <WasteMeasures generated={ds.totals.wasteGenerated} collected={ds.totals.wasteCollected} showDefinitions />
            <SourceLine provenance={totalWaste?.provenance} />
            <MetricGrid items={totals} />
          </>
        ) : (
          <PanelNote>{t(S.noTotals)}</PanelNote>
        )}
      </PanelSection>

      {/* Modelled risk (live) */}
      <PanelSection eyebrow={t(S.modelEyebrow)} title={t(S.model)} id="city-model" actions={<StatusBadge status="simulated" size="xs" />}>
        <div className="flex items-center gap-2 text-[11px] text-ui-text-2">
          <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", sc.source === "baseline" ? "border-ui-border" : "border-[color-mix(in_srgb,var(--status-simulated)_45%,transparent)] text-ui-text")}>
            <span aria-hidden>◇</span>
            {sourceLabel}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5" role="group" aria-label={t(S.meanRisk)}>
            <span className="text-[11px] leading-4 text-ui-text-2">{t(S.meanRisk)}</span>
            <MetricReadout metric={meanRisk} decimals={1} valueClassName="proportional-nums [font-feature-settings:normal] text-[19px] font-semibold text-ui-text" />
            {sc.source !== "baseline" && sum.meanBaseline !== null && (
              <span className="text-[10.5px] text-ui-text-2">{t(S.baselineRef).replace("{v}", formatNumber(sum.meanBaseline, lang, 1))}</span>
            )}
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5" role="group" aria-label={t(S.meanStress)}>
            <span className="text-[11px] leading-4 text-ui-text-2">{t(S.meanStress)}</span>
            <MetricReadout metric={meanStress} decimals={0} valueClassName="proportional-nums [font-feature-settings:normal] text-[19px] font-semibold text-ui-text" />
          </div>
          <div className="col-span-2 flex flex-col gap-1 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5" role="group" aria-label={t(S.exposed)}>
            <span className="text-[11px] leading-4 text-ui-text-2">{t(S.exposed)}</span>
            <div className="flex items-baseline gap-2">
              <MetricReadout metric={exposed} decimals={0} compact valueClassName="proportional-nums [font-feature-settings:normal] text-[19px] font-semibold text-ui-text" />
              {sum.exposedPopulationShare !== null && (
                <span className="text-[11px] text-ui-text-2">{t(S.exposedShare).replace("{p}", formatNumber(sum.exposedPopulationShare * 100, lang, 1))}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[12px] font-medium text-ui-text">{t(S.distribution)}</div>
          <RiskDistributionBar counts={sum.classCounts} unavailable={unscored} kindLabel={kind} />
        </div>
      </PanelSection>

      {/* Waste */}
      <PanelSection title={t(S.waste)} id="city-waste">
        <WasteCompositionChart
          composition={ds.composition}
          total={totalWaste}
          totalLabel={t(METRICS[primary].label)}
          scopeLabel={`${t(S.citywide)}`}
          quantityStatus="derived"
        />
        <WasteTrendChart history={ds.wasteHistory} generated={ds.wasteGeneratedHistory} subtitle={t(S.trend)} />
      </PanelSection>

      {/* Flood events */}
      <PanelSection title={t(S.events)} id="city-events">
        <FloodEventsList events={bundle?.floodEvents} max={3} />
      </PanelSection>

      {/* Limitations */}
      <PanelSection id="city-limits">
        <Collapsible open={limitsOpen} onOpenChange={setLimitsOpen}>
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-md py-1 text-left text-[13px] font-semibold text-ui-text hover:text-ui-cyan">
            <span>
              {t(S.limitations)} <span className="ui-num text-[11px] font-normal text-ui-text-2">({formatNumber(ds.limitations?.length ?? 0, lang)})</span>
            </span>
            <ChevronDown className={cn("size-4 text-ui-text-2 transition-transform duration-(--motion-ui)", limitsOpen && "rotate-180")} aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-[11.5px] leading-[1.6] text-ui-text-2 marker:text-ui-text-3">
              {(ds.limitations ?? []).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
        {bundle && bundle.missing.length > 0 && (
          <PanelNote tone="warn">
            <span className="font-medium">{t(S.missing)}:</span> <span className="font-mono text-[10.5px]">{bundle.missing.join(", ")}</span>
          </PanelNote>
        )}
      </PanelSection>
    </div>
  );
}
