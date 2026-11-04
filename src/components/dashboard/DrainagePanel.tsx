"use client";

import { memo, useMemo } from "react";
import { motion } from "motion/react";
import { Gauge } from "lucide-react";
import { useCityBundle } from "@/lib/data/loader";
import { useScenario, type AreaScenario } from "@/lib/simulation/use-scenario";
import { DEFAULT_ASSUMPTIONS, L_SAT } from "@/lib/simulation/model";
import { useLang, useTr } from "@/lib/i18n";
import { formatDate, formatNumber } from "@/lib/formatters";
import { DURATION, EASE } from "@/lib/animation/tokens";
import { useDashboard, type Lang } from "@/store/dashboard-store";
import { cn } from "@/lib/utils";
import { MetricReadout, StatusBadge } from "@/components/dashboard/StatusBadge";
import { PanelNote, UnavailableBlock, useMotionPrefs } from "@/components/dashboard/MetricGrid";
import { ChartSkeleton } from "@/components/charts/chart-kit";
import { infrastructureByKind, kindLabel, modelMetric } from "@/components/charts/derive";
import { GaugeGlyph } from "@/components/map/GaugeGlyph";
import { normalizeDrainage } from "@/lib/map/features";
import { GAUGE_CLASSES, GAUGE_CLASS, GAUGE_SCHEME, GAUGE_SNAPSHOT, formatLevel, gaugeModel, gaugeName, situationLabel, type GaugeInfo } from "@/lib/map/water-levels";
import { formatDateTime } from "@/lib/map/labels";

const S = {
  region: { th: "การระบายน้ำ", en: "Drainage" },
  title: { th: "แรงกดดันระบบระบายน้ำรายพื้นที่ (แบบจำลอง, %)", en: "Modeled Drainage Stress (%) by area" },
  cityMean: { th: "ค่าเฉลี่ยถ่วงน้ำหนักประชากร", en: "Population-weighted mean" },
  overCap: { th: "{n} พื้นที่ภาระเกินความจุ", en: "{n} areas over capacity" },
  srcBaseline: { th: "สภาวะฐาน", en: "Baseline" },
  srcScenario: { th: "สถานการณ์จำลอง", en: "Scenario" },
  srcHistorical: { th: "ย้อนหลัง {d}", en: "Historical {d}" },
  cap: { th: "เต็มความจุ {v}%", en: "At capacity {v}%" },
  vsBase: { th: "จากฐาน", en: "vs baseline" },
  list: { th: "พื้นที่เรียงตามแรงกดดันระบายน้ำ", en: "Areas sorted by drainage stress" },
  assumption: { th: "สมมติฐานของแบบจำลอง", en: "Model assumption" },
  assumptionBody: {
    th: "สมมติว่าระบบระบายน้ำรองรับฝนได้ {cap} มม./ชม. เมื่อทำงานเต็มประสิทธิภาพ (ค่าสมมติเชิงสาธิต ไม่ใช่ค่าออกแบบจริงของแต่ละพื้นที่) ความจุลดลงตามการเสื่อมสภาพและการอุดตันจากขยะในสถานการณ์",
    en: "The drainage network is assumed to handle {cap} mm/h at full capacity (an illustrative assumption, not each area's actual design value). Capacity is reduced by scenario capacity loss and waste obstruction.",
  },
  meaning: { th: "ค่านี้หมายถึงอะไร", en: "What this means" },
  meaningBody: {
    th: "แรงกดดัน = ภาระน้ำฝน ÷ ความจุที่สมมติ แปลงเป็น 0–100% โดย {full}% คือภาระเท่ากับความจุพอดี และ 100% คือภาระ {lsat} เท่าของความจุ ใช้เพื่ออธิบายความสัมพันธ์ ไม่ใช่การตรวจวัดหรือการพยากรณ์",
    en: "Stress = rainfall load ÷ assumed capacity, mapped to 0–100%: {full}% means load equals capacity and 100% means load is {lsat}× capacity. It explains relationships; it is not a measurement or a forecast.",
  },
  infra: { th: "โครงสร้างที่ทำแผนที่ไว้ (OpenStreetMap)", en: "Mapped infrastructure (OpenStreetMap)" },
  waterways: { th: "ทางน้ำ", en: "Waterways" },
  drainage: { th: "โครงสร้างระบายน้ำ", en: "Drainage structures" },
  count: { th: "จำนวน", en: "Count" },
  length: { th: "ความยาว", en: "Length" },
  type: { th: "ประเภท", en: "Type" },
  km: { th: "กม.", en: "km" },
  noInfra: { th: "ยังไม่มีข้อมูลโครงสร้างจาก OpenStreetMap สำหรับเมืองนี้", en: "No OpenStreetMap infrastructure data for this city yet" },
  levels: { th: "ระดับน้ำในคลองและแม่น้ำ", en: "River & canal water levels" },
  gauge: { th: "สถานี", en: "Gauge" },
  level: { th: "ระดับน้ำ", en: "Level" },
  bank: { th: "ระดับตลิ่ง", en: "Bank" },
  pct: { th: "% ความจุ", en: "% capacity" },
  situation: { th: "สถานการณ์", en: "Situation" },
  time: { th: "เวลา", en: "Time" },
  noLevels: { th: "ไม่มีข้อมูลสถานีวัดระดับน้ำสำหรับเมืองนี้", en: "No water-level gauge data for this city" },
  gaugesN: { th: "{n} สถานี", en: "{n} gauges" },
  agencyText: { th: "ตามหน่วยงาน: {s}", en: "Agency: {s}" },
  pumps: { th: "สถานีสูบน้ำ", en: "Pump stations" },
  pumpOfficial: { th: "ทะเบียนทางการ กทม. (สำนักการระบายน้ำ)", en: "Official BMA register (DDS)" },
  pumpOsm: { th: "ทำแผนที่ใน OpenStreetMap", en: "Mapped in OpenStreetMap" },
  pumpOther: { th: "แหล่งอื่น", en: "Other source" },
  pumpNote: {
    th: "นับแยกตามแหล่งข้อมูล ไม่รวมกันเพราะอาจซ้ำซ้อน ทะเบียนทางการเป็นข้อมูลอ้างอิงหลัก ส่วน OSM อาจไม่ครบ",
    en: "Counted per source and not summed (they may overlap). The official register is the reference; OSM may be incomplete.",
  },
  osmNote: {
    th: "© ผู้ร่วมพัฒนา OpenStreetMap (ODbL) — นับเฉพาะที่ทำแผนที่ไว้ ความครบถ้วนแตกต่างกันตามพื้นที่ ไม่ได้ใช้เป็นข้อมูลนำเข้าของแบบจำลอง",
    en: "© OpenStreetMap contributors (ODbL) — counts only what is mapped; completeness varies and these are not model inputs",
  },
};

export function DrainagePanel() {
  const t = useTr();
  const lang = useLang();
  const { bundle } = useCityBundle();
  const sc = useScenario();
  const { reduced } = useMotionPrefs();

  const rows = useMemo(() => [...sc.list].sort((a, b) => b.current.drainageStressPct - a.current.drainageStressPct || a.area.id.localeCompare(b.area.id)), [sc.list]);
  const ww = useMemo(() => infrastructureByKind(bundle?.waterways), [bundle?.waterways]);
  const dr = useMemo(() => infrastructureByKind(bundle?.drainage), [bundle?.drainage]);
  const gauges = useMemo(() => gaugeModel(bundle?.waterLevels), [bundle?.waterLevels]);
  const pumps = useMemo(() => normalizeDrainage(bundle?.drainage, () => null)?.counts.pump ?? null, [bundle?.drainage]);

  if (!bundle || !sc.ready) {
    return (
      <div className="grid h-full grid-cols-1 gap-4 p-4 lg:grid-cols-2" aria-busy>
        <ChartSkeleton height={150} />
        <ChartSkeleton height={150} />
      </div>
    );
  }

  const cap = 100 / L_SAT;
  const over = rows.filter((r) => r.current.drainageStressPct >= cap).length;
  const showDelta = sc.source !== "baseline";
  const sourceText =
    sc.source === "scenario" ? t(S.srcScenario) : sc.source === "historical" ? t(S.srcHistorical).replace("{d}", formatDate(sc.date, lang)) : t(S.srcBaseline);
  const mean = modelMetric(sc.summary.meanDrainageStress, "%", { methodology: t(S.cityMean) });
  const layoutTransition = reduced ? { duration: 0 } : { duration: DURATION.scenario, ease: EASE.outExpo };

  return (
    <div className="ui-scroll h-full min-h-0 overflow-y-auto" role="region" aria-label={t(S.region)}>
      <div className="grid grid-cols-1 gap-5 p-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section className="flex min-w-0 flex-col gap-3" aria-label={t(S.title)}>
          <header className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold text-ui-text">{t(S.title)}</h3>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ui-text-2">
                <StatusBadge status="simulated" size="xs" />
                <span>{sourceText}</span>
                <span>· {t(S.overCap).replace("{n}", formatNumber(over, lang))}</span>
              </div>
            </div>
            <div className="ml-auto flex items-baseline gap-2">
              <span className="text-[10.5px] text-ui-text-2">{t(S.cityMean)}</span>
              <MetricReadout metric={mean} decimals={0} valueClassName="proportional-nums [font-feature-settings:normal] text-[18px] font-semibold text-ui-text" />
            </div>
          </header>
          <div className="grid grid-cols-[40%_minmax(0,1fr)_5.5rem] gap-2 px-1.5 text-[10px] text-ui-text-2" aria-hidden>
            <span />
            <div className="relative h-3">
              <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${cap}%` }}>
                ▾ {t(S.cap).replace("{v}", formatNumber(cap, lang, 1))}
              </span>
            </div>
            <span />
          </div>
          <ol className="flex flex-col" aria-label={t(S.list)}>
            {rows.map((r) => (
              <motion.li key={r.area.id} layout="position" transition={{ layout: layoutTransition }}>
                <StressRow as={r} cap={cap} showDelta={showDelta} lang={lang} vsBase={t(S.vsBase)} />
              </motion.li>
            ))}
          </ol>
        </section>

        <aside className="flex min-w-0 flex-col gap-4">
          <div className="rounded-lg border border-ui-border bg-ui-bg-deep/40 px-3 py-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-ui-text">
              <Gauge className="size-3.5 text-status-estimated" aria-hidden />
              {t(S.assumption)}
              <StatusBadge status="estimated" size="xs" className="ml-auto" />
            </div>
            <p className="text-[11.5px] leading-[1.6] text-ui-text-2">{t(S.assumptionBody).replace("{cap}", formatNumber(DEFAULT_ASSUMPTIONS.designIntensityMmH, lang))}</p>
          </div>
          <PanelNote>
            <span className="font-medium text-ui-text">{t(S.meaning)}: </span>
            {t(S.meaningBody).replace("{full}", formatNumber(cap, lang, 1)).replace("{lsat}", formatNumber(L_SAT, lang, 1))}
          </PanelNote>
          <div className="flex flex-col gap-2">
            <div className="text-[12.5px] font-medium text-ui-text">{t(S.infra)}</div>
            {!bundle.waterways && !bundle.drainage ? (
              <UnavailableBlock>{t(S.noInfra)}</UnavailableBlock>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <InfraTable title={t(S.waterways)} rows={ww} lang={lang} />
                <InfraTable title={t(S.drainage)} rows={dr} lang={lang} />
              </div>
            )}
            <p className="text-[10.5px] leading-4 text-ui-text-2">{t(S.osmNote)}</p>
          </div>
          {pumps && pumps.official + pumps.osm + pumps.other > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-[12.5px] font-medium text-ui-text">{t(S.pumps)}</div>
              <dl className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["official", S.pumpOfficial, pumps.official],
                    ["osm", S.pumpOsm, pumps.osm],
                    ["other", S.pumpOther, pumps.other],
                  ] as const
                )
                  .filter(([k, , n]) => k !== "other" || n > 0)
                  .map(([k, label, n]) => (
                    <div key={k} className="flex flex-col gap-0.5 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2">
                      <dt className="flex items-start justify-between gap-1 text-[10.5px] leading-4 text-ui-text-2">
                        {t(label)}
                        <StatusBadge status={n > 0 ? "observed" : "unavailable"} size="xs" />
                      </dt>
                      <dd className="ui-num text-[17px] font-semibold text-ui-text">{formatNumber(n, lang)}</dd>
                    </div>
                  ))}
              </dl>
              <p className="text-[10.5px] leading-4 text-ui-text-2">{t(S.pumpNote)}</p>
            </div>
          )}
        </aside>

        <section className="flex min-w-0 flex-col gap-2 lg:col-span-2" aria-label={t(S.levels)}>
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-[13px] font-semibold text-ui-text">{t(S.levels)}</h3>
            {gauges && (
              <>
                <span className="text-[11px] text-ui-text-2">{t(S.gaugesN).replace("{n}", formatNumber(gauges.total, lang))}</span>
                {gauges.statuses.map((st) => (
                  <StatusBadge key={st} status={st} size="xs" />
                ))}
                <span className="text-[10.5px] text-ui-text-2">
                  {gauges.latest ? `${formatDateTime(gauges.latest, lang)} · ` : ""}
                  {t(GAUGE_SNAPSHOT)}
                </span>
              </>
            )}
          </header>
          {!gauges ? <UnavailableBlock>{t(S.noLevels)}</UnavailableBlock> : <GaugeTable items={gauges.items} lang={lang} />}
          {gauges && <p className="text-[10.5px] leading-4 text-ui-text-2">{t(GAUGE_SCHEME)}</p>}
        </section>
      </div>
    </div>
  );
}

const SEVERITY = new Map(GAUGE_CLASSES.map((c, i) => [c.id, i] as const));

function GaugeTable({ items, lang }: { items: GaugeInfo[]; lang: Lang }) {
  const t = useTr();
  const rows = useMemo(
    () =>
      [...items].sort((a, b) => {
        const s = (SEVERITY.get(a.cls) ?? 9) - (SEVERITY.get(b.cls) ?? 9);
        if (s) return s;
        return (b.station.capacityPct?.value ?? -1) - (a.station.capacityPct?.value ?? -1) || gaugeName(a.station, lang).localeCompare(gaugeName(b.station, lang));
      }),
    [items, lang],
  );
  return (
    <div className="ui-scroll max-h-[260px] overflow-auto rounded-md border border-ui-border/70" tabIndex={0} role="region" aria-label={t(S.levels)}>
      <table className="w-full min-w-[640px] text-[11px]">
        <caption className="sr-only">{t(S.levels)}</caption>
        <thead className="sticky top-0 z-[1] bg-ui-elevated">
          <tr className="text-left text-[10.5px] text-ui-text-2">
            <th scope="col" className="px-2 py-1.5 font-medium">
              {t(S.gauge)}
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              {t(S.level)}
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              {t(S.bank)} <span className="font-normal">({lang === "th" ? "ม.รทก." : "m MSL"})</span>
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              {t(S.pct)}
            </th>
            <th scope="col" className="px-2 py-1.5 font-medium">
              {t(S.situation)}
            </th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">
              {t(S.time)}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => {
            const st = g.station;
            const cls = GAUGE_CLASS[g.cls];
            const lv = formatLevel(st.waterLevel, lang, false);
            const bk = formatLevel(st.bankLevel, lang, false);
            const cap = st.capacityPct && st.capacityPct.value !== null && st.capacityPct.provenance.status !== "unavailable" ? { value: st.capacityPct.value } : null;
            const unit = lang === "th" ? "ม.รทก." : "m MSL";
            return (
              <tr key={st.id} className="border-t border-ui-border/50 align-top">
                <th scope="row" className="px-2 py-1.5 text-left font-normal">
                  <span className="flex items-start gap-1.5">
                    <GaugeGlyph cls={g.cls} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block text-ui-text">{gaugeName(st, lang)}</span>
                      <span className="block text-[10px] text-ui-text-2">{[st.waterway, st.agency].filter(Boolean).join(" · ")}</span>
                    </span>
                  </span>
                </th>
                <td className="px-2 py-1.5 text-right">
                  <span className={cn("ui-num", lv ? "text-ui-text" : "text-[10.5px] text-ui-text-2")}>{lv ?? t({ th: "ยังไม่มีข้อมูล", en: "Unavailable" })}</span>
                  {lv && <span className="block text-[10px] text-ui-text-2">{unit}</span>}
                </td>
                <td className="ui-num px-2 py-1.5 text-right text-ui-text-2">{bk ?? "—"}</td>
                <td className="px-2 py-1.5 text-right">
                  {cap ? (
                    <span className="inline-flex flex-col items-end gap-0.5">
                      <span className="ui-num text-ui-text">{formatNumber(cap.value, lang, 0)}%</span>
                      <span aria-hidden className="relative block h-1 w-14 rounded-full bg-ui-border/60">
                        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, Math.max(0, cap.value))}%`, background: cls.color }} />
                      </span>
                    </span>
                  ) : (
                    <span className="text-ui-text-2">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <span className="font-medium" style={{ color: cls.color }}>
                    {t(cls.label)}
                  </span>
                  {st.situation && g.classFrom !== "capacity" && <span className="block text-[10px] text-ui-text-2">{t(S.agencyText).replace("{s}", t(situationLabel(st.situation)))}</span>}
                </td>
                <td className="ui-num px-2 py-1.5 text-right text-[10.5px] whitespace-nowrap text-ui-text-2">{formatDateTime(st.observedAt ?? st.waterLevel?.provenance.observedTo, lang)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const StressRow = memo(function StressRow({ as, cap, showDelta, lang, vsBase }: { as: AreaScenario; cap: number; showDelta: boolean; lang: Lang; vsBase: string }) {
  const id = as.area.id;
  const selected = useDashboard((s) => s.selectedAreaId === id);
  const hovered = useDashboard((s) => s.hoveredAreaId === id);
  const selectArea = useDashboard((s) => s.selectArea);
  const hoverArea = useDashboard((s) => s.hoverArea);
  const v = as.current.drainageStressPct;
  const b = as.baseline.drainageStressPct;
  const d = Math.round((v - b) * 10) / 10;
  const name = lang === "th" ? as.area.nameTh : as.area.nameEn;
  const color = v >= cap ? "var(--risk-very-high)" : v >= cap * 0.75 ? "var(--risk-high)" : "color-mix(in srgb, var(--ui-cyan) 70%, transparent)";
  return (
    <button
      type="button"
      onClick={() => selectArea(id, { focus: true })}
      onMouseEnter={() => hoverArea(id)}
      onMouseLeave={() => hoverArea(null)}
      onFocus={() => hoverArea(id)}
      onBlur={() => hoverArea(null)}
      aria-pressed={selected}
      aria-label={`${name}: ${formatNumber(v, lang, 0)}%${v >= cap ? " ▲" : ""}${showDelta ? `, ${vsBase} ${d >= 0 ? "+" : "−"}${formatNumber(Math.abs(d), lang, 0)}` : ""}`}
      className={cn(
        "grid min-h-7 w-full grid-cols-[40%_minmax(0,1fr)_5.5rem] items-center gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors duration-(--motion-fast) focus-visible:outline-offset-[-2px]",
        selected ? "bg-[color-mix(in_srgb,var(--ui-cyan)_12%,transparent)]" : hovered ? "bg-ui-elevated/80" : "hover:bg-ui-elevated/60",
      )}
    >
      <span className="truncate text-[12px] text-ui-text" aria-hidden>
        {name}
      </span>
      <span className="relative h-2 rounded-full bg-ui-border/50" aria-hidden>
        <span
          className="absolute inset-y-0 left-0 w-full origin-left rounded-full transition-transform duration-(--motion-scenario) ease-(--ease-out-expo)"
          style={{ transform: `scaleX(${Math.min(1, Math.max(0, v / 100))})`, background: color }}
        />
        <span className="absolute -top-0.5 h-3 w-px bg-ui-text/70" style={{ left: `${cap}%` }} />
      </span>
      <span className="flex items-center justify-end gap-1.5" aria-hidden>
        <span className="ui-num text-[11.5px] text-ui-text">
          {formatNumber(v, lang, 0)}%{v >= cap && <span className="ml-0.5 text-[9px] text-[var(--risk-very-high)]">▲</span>}
        </span>
        {showDelta && (
          <span className={cn("ui-num text-[10px]", d > 0 ? "text-[var(--risk-high)]" : d < 0 ? "text-[var(--risk-low)]" : "text-ui-text-2")}>
            {d > 0 ? "+" : d < 0 ? "−" : "±"}
            {formatNumber(Math.abs(d), lang, 0)}
          </span>
        )}
      </span>
    </button>
  );
});

function InfraTable({ title, rows, lang }: { title: string; rows: ReturnType<typeof infrastructureByKind>; lang: Lang }) {
  const t = useTr();
  const hasLength = rows.some((r) => r.lengthKm > 0.05);
  if (!rows.length) {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-[11px] font-medium text-ui-text-2">{title}</div>
        <UnavailableBlock />
      </div>
    );
  }
  return (
    <table className="w-full text-[11px]">
      <caption className="pb-1 text-left text-[11px] font-medium text-ui-text-2">
        {title} <StatusBadge status="derived" size="xs" />
      </caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">{t(S.type)}</th>
          <th scope="col">{t(S.count)}</th>
          {hasLength && <th scope="col">{t(S.length)}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 10).map((r) => (
          <tr key={r.kind} className="border-t border-ui-border/50">
            <th scope="row" className="py-1 pr-2 text-left font-normal text-ui-text-2">
              {t(kindLabel(r.kind))}
            </th>
            <td className="ui-num py-1 text-right text-ui-text">{formatNumber(r.count, lang)}</td>
            {hasLength && <td className="ui-num py-1 pl-2 text-right text-ui-text-2">{r.lengthKm > 0.05 ? `${formatNumber(r.lengthKm, lang, 0)} ${t(S.km)}` : "—"}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
