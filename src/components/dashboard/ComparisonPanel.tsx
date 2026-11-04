"use client";

import { useMemo } from "react";
import { ArrowLeftRight, Sparkles, X } from "lucide-react";
import type { AreaRecord, CityDataset, MetricValue, RainSeries } from "@/lib/types";
import { useAreas, useCityBundle, useSelectedArea } from "@/lib/data/loader";
import { useScenario, type ScenarioState } from "@/lib/simulation/use-scenario";
import { METRICS, primaryWasteMetric, type MetricId } from "@/lib/metrics";
import { STATUS_META } from "@/lib/data/status";
import { useLang, useTr } from "@/lib/i18n";
import { formatDate, formatMetric, formatNumber, formatYear, unitLabel } from "@/lib/formatters";
import { useDashboard } from "@/store/dashboard-store";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MetricReadout, StatusBadge } from "@/components/dashboard/StatusBadge";
import { PanelNote, RiskChip, UnavailableBlock } from "@/components/dashboard/MetricGrid";
import { CompareBars, type CompareRow } from "@/components/charts/CompareBars";
import { Sparkline } from "@/components/charts/Sparkline";
import { COMPOSITION_COLORS, COMPOSITION_LABELS, COMPOSITION_ORDER, VIZ } from "@/components/charts/palette";
import { ChartSkeleton } from "@/components/charts/chart-kit";
import {
  areaRainSeries,
  baselineAreaMetric,
  derivedMetric,
  liveAreaMetric,
  metricOf,
  nearestArea,
  rainWindow,
  valueOf,
  windowStats,
} from "@/components/charts/derive";

const S = {
  region: { th: "เปรียบเทียบสองพื้นที่", en: "Compare two areas" },
  a: { th: "พื้นที่ A", en: "Area A" },
  b: { th: "พื้นที่ B", en: "Area B" },
  pickA: { th: "เลือกพื้นที่ A", en: "Choose area A" },
  pickB: { th: "เลือกพื้นที่ B", en: "Choose area B" },
  swap: { th: "สลับพื้นที่ A และ B", en: "Swap areas A and B" },
  clearB: { th: "ล้างพื้นที่ B", en: "Clear area B" },
  sameCity: { th: "เปรียบเทียบได้เฉพาะพื้นที่ในเมืองเดียวกัน", en: "Comparison is limited to areas within the same city" },
  needA: { th: "เลือกพื้นที่ A บนแผนที่ จากอันดับ หรือจากรายการด้านบน", en: "Select area A on the map, in the ranking or from the list above" },
  needB: { th: "เลือกพื้นที่ B เพื่อเริ่มเปรียบเทียบ", en: "Choose area B to start comparing" },
  suggest: { th: "ใช้พื้นที่ใกล้เคียงที่สุด", en: "Use the nearest area" },
  kpi: { th: "ตัวชี้วัดหลัก", en: "Key indicators" },
  metric: { th: "ตัวชี้วัด", en: "Metric" },
  diff: { th: "ผลต่าง A − B", en: "Difference A − B" },
  composition: { th: "องค์ประกอบขยะ", en: "Waste composition" },
  noComp: {
    th: "ไม่มีข้อมูลองค์ประกอบขยะรายพื้นที่ (มีเฉพาะสัดส่วนระดับเมือง) จึงเปรียบเทียบรายพื้นที่ไม่ได้",
    en: "No per-area composition data (citywide shares only), so areas cannot be compared on composition",
  },
  rain: { th: "ตัวชี้วัดฝน", en: "Rainfall indicators" },
  rain30: { th: "ฝนสะสม 30 วัน", en: "30-day total" },
  rain30Method: { th: "ผลรวมฝนรายวันของพื้นที่ 30 วัน", en: "Sum of the area's daily values over 30 days" },
  ending: { th: "ถึง {d}", en: "to {d}" },
  model: { th: "ผลแบบจำลอง", en: "Model outputs" },
  baseline: { th: "สภาวะฐาน", en: "Baseline" },
  current: { th: "ปัจจุบัน", en: "Current" },
  score: { th: "คะแนนความเสี่ยง", en: "Risk score" },
  stress: { th: "แรงกดดันระบายน้ำ", en: "Drainage stress" },
  disclosures: { th: "ข้อควรทราบในการเปรียบเทียบ", en: "Comparison disclosures" },
  diffStatus: { th: "{m}: สถานะข้อมูลต่างกัน (A {a} · B {b})", en: "{m}: data status differs (A {a} · B {b})" },
  diffYear: { th: "{m}: ปีอ้างอิงต่างกัน (A {a} · B {b})", en: "{m}: reference year differs (A {a} · B {b})" },
  diffUnit: { th: "{m}: หน่วยต่างกัน จึงไม่คำนวณผลต่าง", en: "{m}: units differ, no difference computed" },
  noDisclosure: { th: "สถานะและปีอ้างอิงของตัวชี้วัดตรงกัน", en: "Statuses and reference years match" },
  simNote: { th: "ผลแบบจำลองเชิงอธิบาย ไม่ใช่การพยากรณ์", en: "Explainable model output, not a forecast" },
  category: { th: "ประเภท", en: "Category" },
  compEst: {
    th: "สัดส่วนรายพื้นที่เป็นค่าประมาณการ ความต่างระหว่างสองพื้นที่จึงสะท้อนวิธีประมาณการ ไม่ใช่ผลสำรวจของแต่ละพื้นที่",
    en: "Per-area shares are estimates, so differences reflect the estimation method rather than a survey of each area",
  },
};

const KPI_KEYS: MetricId[] = ["population", "areaKm2", "populationDensity", "wastePerCapita", "wasteDensity", "rainfallAnnual"];

interface KpiRow {
  key: string;
  label: string;
  a: MetricValue;
  b: MetricValue;
  decimals: number;
  simulated?: boolean;
}

export function ComparisonPanel() {
  const t = useTr();
  const lang = useLang();
  const { bundle } = useCityBundle();
  const { list, byId } = useAreas();
  const sc = useScenario();
  const areaA = useSelectedArea();
  const compareId = useDashboard((s) => s.compareAreaId);
  const selectArea = useDashboard((s) => s.selectArea);
  const setCompareArea = useDashboard((s) => s.setCompareArea);

  const ds = bundle?.dataset;
  const areaB = compareId && compareId !== areaA?.id ? (byId.get(compareId) ?? null) : null;

  const items = useMemo(() => Object.fromEntries(list.map((a) => [a.id, lang === "th" ? a.nameTh : a.nameEn])), [list, lang]);
  const sorted = useMemo(() => [...list].sort((x, y) => (lang === "th" ? x.nameTh.localeCompare(y.nameTh, "th") : x.nameEn.localeCompare(y.nameEn))), [list, lang]);

  if (!ds) {
    return (
      <div className="grid h-full grid-cols-1 gap-4 p-4 md:grid-cols-2" aria-busy>
        <ChartSkeleton height={120} />
        <ChartSkeleton height={120} />
      </div>
    );
  }

  const nameOf = (a: AreaRecord | null) => (a ? (lang === "th" ? a.nameTh : a.nameEn) : "—");
  const swap = () => {
    if (!areaA || !areaB) return;
    const a = areaA.id;
    selectArea(areaB.id, { focus: true });
    setCompareArea(a);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" role="region" aria-label={t(S.region)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-ui-border/70 px-3 py-2">
        <AreaPicker
          tag="A"
          color={VIZ.seriesA}
          label={t(S.pickA)}
          value={areaA?.id ?? null}
          items={items}
          areas={sorted}
          disabledId={null}
          onChange={(id) => selectArea(id, { focus: true })}
          lang={lang}
        />
        <button
          type="button"
          onClick={swap}
          disabled={!areaA || !areaB}
          aria-label={t(S.swap)}
          className="inline-flex size-7 items-center justify-center rounded-md border border-ui-border text-ui-text-2 hover:border-ui-border-strong hover:text-ui-text disabled:opacity-40"
        >
          <ArrowLeftRight className="size-3.5" aria-hidden />
        </button>
        <AreaPicker
          tag="B"
          color={VIZ.seriesB}
          label={t(S.pickB)}
          value={areaB?.id ?? null}
          items={items}
          areas={sorted}
          disabledId={areaA?.id ?? null}
          onChange={(id) => setCompareArea(id)}
          lang={lang}
        />
        {areaB && (
          <button
            type="button"
            onClick={() => setCompareArea(null)}
            aria-label={t(S.clearB)}
            className="inline-flex size-7 items-center justify-center rounded-md text-ui-text-2 hover:bg-ui-elevated hover:text-ui-text"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
        <span className="ml-auto text-[10.5px] text-ui-text-2">{t(S.sameCity)}</span>
      </div>

      <div className="ui-scroll min-h-0 flex-1 overflow-y-auto">
        {!areaA ? (
          <div className="p-4">
            <UnavailableBlock>{t(S.needA)}</UnavailableBlock>
          </div>
        ) : !areaB ? (
          <div className="flex flex-col items-start gap-2 p-4">
            <UnavailableBlock className="w-full">{t(S.needB)}</UnavailableBlock>
            <SuggestButton ds={ds} area={areaA} onPick={setCompareArea} label={t(S.suggest)} />
          </div>
        ) : (
          <CompareBody ds={ds} a={areaA} b={areaB} sc={sc} rainAreas={bundle?.rainAreas ?? null} nameA={nameOf(areaA)} nameB={nameOf(areaB)} />
        )}
      </div>
    </div>
  );
}

function SuggestButton({ ds, area, onPick, label }: { ds: CityDataset; area: AreaRecord; onPick: (id: string) => void; label: string }) {
  const lang = useLang();
  const near = nearestArea(ds, area);
  if (!near) return null;
  return (
    <button
      type="button"
      onClick={() => onPick(near.id)}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-ui-border px-2 text-[11.5px] font-medium text-ui-text hover:border-ui-border-strong hover:bg-ui-elevated"
    >
      <Sparkles className="size-3.5 text-ui-cyan" aria-hidden />
      {label}: {lang === "th" ? near.nameTh : near.nameEn}
    </button>
  );
}

function AreaPicker({
  tag,
  color,
  label,
  value,
  items,
  areas,
  disabledId,
  onChange,
  lang,
}: {
  tag: string;
  color: string;
  label: string;
  value: string | null;
  items: Record<string, string>;
  areas: AreaRecord[];
  disabledId: string | null;
  onChange: (id: string) => void;
  lang: "th" | "en";
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-flex size-5 items-center justify-center rounded text-[10.5px] font-semibold text-ui-bg" style={{ background: color }} aria-hidden>
        {tag}
      </span>
      <Select value={value} onValueChange={(v) => v && onChange(v as string)} items={items}>
        <SelectTrigger size="sm" aria-label={label} className="h-7 w-[190px] text-[12px]">
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {areas.map((a) => (
            <SelectItem key={a.id} value={a.id} disabled={a.id === disabledId} className="text-[12px]">
              {lang === "th" ? a.nameTh : a.nameEn}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CompareBody({ ds, a, b, sc, rainAreas, nameA, nameB }: { ds: CityDataset; a: AreaRecord; b: AreaRecord; sc: ScenarioState; rainAreas: RainSeries | null; nameA: string; nameB: string }) {
  const t = useTr();
  const lang = useLang();
  const primary = primaryWasteMetric(ds);
  const asA = sc.byId.get(a.id);
  const asB = sc.byId.get(b.id);
  const live = sc.source !== "baseline";

  const kpis = useMemo<KpiRow[]>(() => {
    // Both waste measures, each with its own status — generated and collected are never merged.
    const keys: MetricId[] = [KPI_KEYS[0], KPI_KEYS[1], KPI_KEYS[2], "wasteGenerated", "wasteCollected", ...KPI_KEYS.slice(3)];
    const rows: KpiRow[] = keys.map((k) => ({
      key: k,
      label: t(METRICS[k].label),
      a: metricOf(a, k) ?? { value: null, unit: METRICS[k].unit, provenance: { status: "unavailable" } },
      b: metricOf(b, k) ?? { value: null, unit: METRICS[k].unit, provenance: { status: "unavailable" } },
      decimals: METRICS[k].decimals,
    }));
    rows.push({
      key: "rainfall24h",
      label: t(METRICS.rainfall24h.label),
      a: sc.source === "historical" ? liveAreaMetric(a, "rainfall24h", asA, sc.date) : (metricOf(a, "rainfall24h") ?? { value: null, unit: "mm", provenance: { status: "unavailable" } }),
      b: sc.source === "historical" ? liveAreaMetric(b, "rainfall24h", asB, sc.date) : (metricOf(b, "rainfall24h") ?? { value: null, unit: "mm", provenance: { status: "unavailable" } }),
      decimals: 1,
    });
    return rows;
  }, [a, b, t, sc.source, sc.date, asA, asB]);

  const modelRows = useMemo<KpiRow[]>(() => {
    const rows: KpiRow[] = [
      { key: "risk-base", label: `${t(S.score)} · ${t(S.baseline)}`, a: baselineAreaMetric(a, "modeledFloodRisk", asA), b: baselineAreaMetric(b, "modeledFloodRisk", asB), decimals: 1, simulated: true },
      { key: "stress-base", label: `${t(S.stress)} · ${t(S.baseline)}`, a: baselineAreaMetric(a, "drainageStress", asA), b: baselineAreaMetric(b, "drainageStress", asB), decimals: 0, simulated: true },
    ];
    if (live) {
      rows.push(
        { key: "risk-cur", label: `${t(S.score)} · ${t(S.current)}`, a: liveAreaMetric(a, "modeledFloodRisk", asA, sc.date), b: liveAreaMetric(b, "modeledFloodRisk", asB, sc.date), decimals: 1, simulated: true },
        { key: "stress-cur", label: `${t(S.stress)} · ${t(S.current)}`, a: liveAreaMetric(a, "drainageStress", asA, sc.date), b: liveAreaMetric(b, "drainageStress", asB, sc.date), decimals: 0, simulated: true },
      );
    }
    return rows;
  }, [a, b, asA, asB, live, sc.date, t]);

  const barRows = useMemo<CompareRow[]>(() => {
    const hasAny = (k: MetricId) => ds.areas.some((x) => valueOf(metricOf(x, k)) !== null);
    const waste: MetricId[] = (["wasteGenerated", "wasteCollected"] as MetricId[]).filter(hasAny);
    const keys: MetricId[] = ["population", "populationDensity", ...(waste.length ? waste : [primary]), "wastePerCapita", "wasteDensity", "rainfallAnnual"];
    const rows: CompareRow[] = keys.map((k) => {
      let max: number | null = null;
      for (const x of ds.areas) {
        const v = valueOf(metricOf(x, k));
        if (v !== null) max = max === null ? v : Math.max(max, v);
      }
      return {
        label: t(METRICS[k].short),
        a: metricOf(a, k) ?? { value: null, unit: METRICS[k].unit, provenance: { status: "unavailable" } },
        b: metricOf(b, k) ?? { value: null, unit: METRICS[k].unit, provenance: { status: "unavailable" } },
        max,
        decimals: METRICS[k].decimals,
      };
    });
    const maxRisk = sc.list.reduce<number | null>((m, x) => (x.current.score === null ? m : m === null ? x.current.score : Math.max(m, x.current.score)), null);
    rows.push({ label: t(METRICS.modeledFloodRisk.short), a: liveAreaMetric(a, "modeledFloodRisk", asA, sc.date), b: liveAreaMetric(b, "modeledFloodRisk", asB, sc.date), max: maxRisk, decimals: 1 });
    rows.push({ label: t(METRICS.drainageStress.short), a: liveAreaMetric(a, "drainageStress", asA, sc.date), b: liveAreaMetric(b, "drainageStress", asB, sc.date), max: 100, decimals: 0 });
    return rows;
  }, [ds, a, b, primary, t, sc.list, sc.date, asA, asB]);

  const rain = useMemo(() => {
    if (!rainAreas) return null;
    const di = sc.source === "historical" && sc.date ? rainAreas.dates.indexOf(sc.date) : -1;
    const [start, end] = rainWindow(rainAreas.dates.length, di >= 0 ? di : null, 30);
    const one = (area: AreaRecord) => {
      const vals = areaRainSeries(rainAreas, area.id);
      if (!vals) return null;
      const st = windowStats(vals, start, end);
      return {
        metric: derivedMetric(st.sum, "mm", rainAreas.provenance.status, {
          sourceName: rainAreas.provenance.sourceName,
          observedFrom: rainAreas.dates[start],
          observedTo: rainAreas.dates[end],
          methodology: t(S.rain30Method),
        }),
        spark: vals.slice(start, end + 1).map((v) => (v === undefined ? null : v)),
      };
    };
    return { a: one(a), b: one(b), endDate: rainAreas.dates[end] };
  }, [rainAreas, sc.source, sc.date, a, b, t]);

  const disclosures = useMemo(() => {
    const out: string[] = [];
    for (const r of [...kpis, ...modelRows]) {
      const pa = r.a.provenance;
      const pb = r.b.provenance;
      if (pa.status !== pb.status) {
        out.push(t(S.diffStatus).replace("{m}", r.label).replace("{a}", t(STATUS_META[pa.status].label)).replace("{b}", t(STATUS_META[pb.status].label)));
      }
      if (pa.referenceYear && pb.referenceYear && pa.referenceYear !== pb.referenceYear) {
        out.push(t(S.diffYear).replace("{m}", r.label).replace("{a}", formatYear(pa.referenceYear, lang)).replace("{b}", formatYear(pb.referenceYear, lang)));
      }
      if (r.a.value !== null && r.b.value !== null && r.a.unit !== r.b.unit) out.push(t(S.diffUnit).replace("{m}", r.label));
    }
    return out;
  }, [kpis, modelRows, t, lang]);

  return (
    <div className="grid grid-cols-1 gap-5 p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.95fr)]">
      {/* KPI table */}
      <section aria-label={t(S.kpi)} className="flex min-w-0 flex-col gap-2">
        <h4 className="text-[12.5px] font-medium text-ui-text">{t(S.kpi)}</h4>
        <KpiTable rows={kpis} nameA={nameA} nameB={nameB} />
        <h4 className="mt-2 flex items-center gap-2 text-[12.5px] font-medium text-ui-text">
          {t(S.model)} <StatusBadge status="simulated" size="xs" />
        </h4>
        <KpiTable rows={modelRows} nameA={nameA} nameB={nameB} />
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ui-text-2">
          <span className="inline-flex items-center gap-1.5">
            A <RiskChip cls={asA?.current.riskClass ?? null} />
          </span>
          <span className="inline-flex items-center gap-1.5">
            B <RiskChip cls={asB?.current.riskClass ?? null} />
          </span>
          <span>· {t(S.simNote)}</span>
        </div>
      </section>

      {/* Normalised bars */}
      <section className="min-w-0">
        <CompareBars rows={barRows} nameA={nameA} nameB={nameB} />
      </section>

      {/* Composition, rainfall, disclosures */}
      <section className="flex min-w-0 flex-col gap-4 lg:col-span-2 xl:col-span-1">
        <div className="flex flex-col gap-2">
          <h4 className="text-[12.5px] font-medium text-ui-text">{t(S.composition)}</h4>
          {usableComp(a) && usableComp(b) ? <CompositionCompare a={a} b={b} nameA={nameA} nameB={nameB} /> : <UnavailableBlock>{t(S.noComp)}</UnavailableBlock>}
        </div>
        <div className="flex flex-col gap-2">
          <h4 className="text-[12.5px] font-medium text-ui-text">{t(S.rain)}</h4>
          {rain && (rain.a || rain.b) ? (
            <div className="grid grid-cols-2 gap-2">
              {[
                { tag: "A", name: nameA, d: rain.a, color: VIZ.seriesA },
                { tag: "B", name: nameB, d: rain.b, color: VIZ.seriesB },
              ].map((x) => (
                <div key={x.tag} className="flex flex-col gap-1 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-2.5 py-2" role="group" aria-label={`${x.tag} ${x.name} — ${t(S.rain30)}`}>
                  <span className="truncate text-[10.5px] text-ui-text-2">
                    <span className="font-semibold text-ui-text">{x.tag}</span> {t(S.rain30)}
                  </span>
                  <MetricReadout metric={x.d?.metric} decimals={0} valueClassName="proportional-nums [font-feature-settings:normal] text-[16px] font-semibold text-ui-text" />
                  {x.d && <Sparkline values={x.d.spark} width={120} height={18} color={x.color} />}
                  <StatusBadge status={x.d?.metric.provenance.status ?? "unavailable"} size="xs" className="self-start" />
                </div>
              ))}
              <p className="col-span-2 text-[10.5px] text-ui-text-2">{t(S.ending).replace("{d}", formatDate(rain.endDate, lang, "long"))}</p>
            </div>
          ) : (
            <UnavailableBlock />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <h4 className="text-[12.5px] font-medium text-ui-text">{t(S.disclosures)}</h4>
          {disclosures.length ? (
            <PanelNote tone="warn">
              <ul className="flex list-disc flex-col gap-0.5 pl-3.5">
                {disclosures.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </PanelNote>
          ) : (
            <p className="text-[11px] text-ui-text-2">{t(S.noDisclosure)}</p>
          )}
        </div>
      </section>
    </div>
  );
}

const usableComp = (x: AreaRecord) => !!x.composition && x.composition.provenance?.status !== "unavailable";

function KpiTable({ rows, nameA, nameB }: { rows: KpiRow[]; nameA: string; nameB: string }) {
  const t = useTr();
  const lang = useLang();
  return (
    <div className="ui-scroll overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-[11px]">
        <caption className="sr-only">{`${nameA} — ${nameB}`}</caption>
        <thead>
          <tr className="border-b border-ui-border text-left text-[10.5px] text-ui-text-2">
            <th scope="col" className="py-1 pr-2 font-medium">
              {t(S.metric)}
            </th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">
              <span className="mr-1 inline-block size-1.5 rounded-[1px] align-middle" style={{ background: VIZ.seriesA }} aria-hidden />A
              <span className="sr-only"> {nameA}</span>
            </th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">
              <span className="mr-1 inline-block size-1.5 rounded-[1px] align-middle" style={{ background: VIZ.seriesB }} aria-hidden />B
              <span className="sr-only"> {nameB}</span>
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              {t(S.diff)}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const va = valueOf(r.a);
            const vb = valueOf(r.b);
            const comparable = va !== null && vb !== null && r.a.unit === r.b.unit;
            const d = comparable ? va - vb : null;
            const pct = d !== null && vb ? (d / Math.abs(vb)) * 100 : null;
            return (
              <tr key={r.key} className="border-b border-ui-border/50 align-top">
                <th scope="row" className="py-1.5 pr-2 text-left font-normal text-ui-text-2">
                  {r.label}
                  <span className="block text-[10px]">{unitLabel(r.a.unit || r.b.unit, lang)}</span>
                </th>
                <Cell m={r.a} decimals={r.decimals} />
                <Cell m={r.b} decimals={r.decimals} />
                <td className="ui-num py-1.5 text-right text-ui-text">
                  {d === null ? (
                    <span className="text-ui-text-2">—</span>
                  ) : (
                    <span className="inline-flex flex-col items-end">
                      <span>
                        {d > 0 ? "+" : d < 0 ? "−" : ""}
                        {formatNumber(Math.abs(d), lang, r.decimals)}
                      </span>
                      {pct !== null && Number.isFinite(pct) && (
                        <span className="text-[10px] text-ui-text-2">
                          {pct > 0 ? "+" : pct < 0 ? "−" : ""}
                          {formatNumber(Math.abs(pct), lang, 0)}%
                        </span>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ m, decimals }: { m: MetricValue; decimals: number }) {
  const lang = useLang();
  const status = m.provenance.status;
  return (
    <td className="py-1.5 pr-2 text-right">
      <span className="inline-flex flex-col items-end gap-0.5">
        <span className={cn("ui-num", status === "unavailable" ? "text-[10.5px] text-ui-text-2" : "text-ui-text")}>{formatMetric(m, lang, decimals, false)}</span>
        <StatusBadge status={status} size="xs" />
      </span>
    </td>
  );
}

function CompositionCompare({ a, b, nameA, nameB }: { a: AreaRecord; b: AreaRecord; nameA: string; nameB: string }) {
  const t = useTr();
  const lang = useLang();
  return (
    <div className="flex flex-col gap-1.5">
      <table className="w-full text-[11px]">
        <caption className="sr-only">{`${t(S.composition)}: ${nameA} — ${nameB}`}</caption>
        <thead>
          <tr className="text-left text-[10.5px] text-ui-text-2">
            <th scope="col" className="py-1 font-medium">
              {t(S.category)}
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              A
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              B
            </th>
          </tr>
        </thead>
        <tbody>
          {COMPOSITION_ORDER.map((k) => {
            const sa = a.composition?.shares[k] ?? null;
            const sb = b.composition?.shares[k] ?? null;
            return (
              <tr key={k} className="border-t border-ui-border/50">
                <th scope="row" className="py-1 text-left font-normal text-ui-text-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: COMPOSITION_COLORS[k] }} />
                    {t(COMPOSITION_LABELS[k])}
                  </span>
                </th>
                <td className="ui-num py-1 text-right text-ui-text">{sa === null ? "—" : `${formatNumber(sa, lang, 1)}%`}</td>
                <td className="ui-num py-1 text-right text-ui-text">{sb === null ? "—" : `${formatNumber(sb, lang, 1)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-ui-text-2">
        {a.composition && (
          <span className="inline-flex items-center gap-1">
            A <StatusBadge status={a.composition.provenance.status} size="xs" />
          </span>
        )}
        {b.composition && (
          <span className="inline-flex items-center gap-1">
            B <StatusBadge status={b.composition.provenance.status} size="xs" />
          </span>
        )}
      </div>
      {(a.composition?.provenance.status === "estimated" || b.composition?.provenance.status === "estimated") && (
        <p className="text-[10.5px] leading-4 text-ui-text-2">
          {t(S.compEst)}
          {a.composition?.provenance.geographicScope ? ` — ${a.composition.provenance.geographicScope}` : ""}
        </p>
      )}
    </div>
  );
}
