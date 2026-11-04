"use client";

import { useMemo, type ReactNode } from "react";
import { BookOpen, Database, ExternalLink, FileWarning, ListChecks, TableProperties, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { COMMON, useLang, useTr, type Bi } from "@/lib/i18n";
import { useCityBundle, useSources } from "@/lib/data/loader";
import { METRICS, type MetricId } from "@/lib/metrics";
import { formatDate, formatMetric, formatYear } from "@/lib/formatters";
import { DEFAULT_ASSUMPTIONS, L_SAT, MODEL_VERSION, P_REF_MM, WEIGHTS } from "@/lib/simulation/model";
import type { DataProvenance, SourceRef } from "@/lib/types";
import type { Lang } from "@/store/dashboard-store";
import { useDashboard } from "@/store/dashboard-store";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ShellSheetContent } from "@/components/motion/AnimatedPanel";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Eyebrow } from "@/components/dashboard/Header";

const ACCESS: Record<SourceRef["accessStatus"], { label: Bi; glyph: string; color: string }> = {
  retrieved: { label: { th: "ดึงข้อมูลแล้ว", en: "Retrieved" }, glyph: "●", color: "var(--status-observed)" },
  partial: { label: { th: "ได้ข้อมูลบางส่วน", en: "Partial" }, glyph: "◐", color: "var(--status-estimated)" },
  failed: { label: { th: "ดึงข้อมูลไม่สำเร็จ", en: "Failed" }, glyph: "✕", color: "var(--ui-red)" },
  "manual-reference": { label: { th: "อ้างอิงจากเอกสาร", en: "Manual reference" }, glyph: "◇", color: "var(--status-derived)" },
};

const METRIC_ORDER: MetricId[] = [
  "population",
  "areaKm2",
  "populationDensity",
  "wasteCollected",
  "wasteGenerated",
  "wastePerCapita",
  "wasteDensity",
  "wasteAccumulated",
  "rainfallAnnual",
  "rainfall24h",
  "floodExposure",
  "obstructionSusceptibility",
  "drainageStress",
  "modeledFloodRisk",
];

function periodText(p: DataProvenance | undefined, lang: Lang) {
  if (!p) return null;
  if (p.observedFrom) {
    return p.observedTo && p.observedTo !== p.observedFrom ? `${formatDate(p.observedFrom, lang)} – ${formatDate(p.observedTo, lang)}` : formatDate(p.observedFrom, lang);
  }
  return p.referenceYear ? formatYear(p.referenceYear, lang) : null;
}

function Block({ icon: Icon, title, children, id }: { icon: typeof Database; title: Bi; children: ReactNode; id: string }) {
  const t = useTr();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-b border-ui-border px-5 py-4 last:border-b-0">
      <h3 id={id} className="flex items-center gap-2 text-[13px] font-semibold text-ui-text">
        <Icon aria-hidden className="size-4 text-ui-cyan" />
        {t(title)}
      </h3>
      {children}
    </section>
  );
}

function AccessBadge({ status }: { status: SourceRef["accessStatus"] }) {
  const t = useTr();
  const m = ACCESS[status];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] leading-4 font-medium"
      style={{ color: m.color, borderColor: `color-mix(in srgb, ${m.color} 45%, transparent)`, background: `color-mix(in srgb, ${m.color} 10%, transparent)` }}
    >
      <span aria-hidden>{m.glyph}</span>
      {t(m.label)}
    </span>
  );
}

function SourceLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const t = useTr();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("inline-flex items-center gap-1 text-ui-cyan underline-offset-2 hover:underline focus-visible:underline", className)}
    >
      {children}
      <ExternalLink aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">({t({ th: "เปิดในแท็บใหม่", en: "opens in a new tab" })})</span>
    </a>
  );
}

function ProvenanceTable({ sources }: { sources: Map<string, SourceRef> }) {
  const t = useTr();
  const lang = useLang();
  const { bundle } = useCityBundle();
  const ds = bundle?.dataset;
  if (!ds) return <Skeleton className="h-40 w-full bg-ui-elevated" />;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-left text-[12px]">
        <caption className="sr-only">{t({ th: "ที่มาของตัวเลขระดับเมือง", en: "Provenance of citywide figures" })}</caption>
        <thead>
          <tr className="border-b border-ui-border text-[11px] text-ui-text-3">
            <th scope="col" className="px-1 py-1.5 font-medium">{t({ th: "ตัวชี้วัด / วิธีการ", en: "Metric / method" })}</th>
            <th scope="col" className="px-1 py-1.5 font-medium">{t({ th: "ค่า / ช่วงเวลา", en: "Value / period" })}</th>
            <th scope="col" className="px-1 py-1.5 font-medium">{t({ th: "สถานะ / แหล่งข้อมูล", en: "Status / source" })}</th>
          </tr>
        </thead>
        <tbody>
          {METRIC_ORDER.map((id) => {
            const m = ds.totals[id];
            if (!m) return null;
            const def = METRICS[id];
            const p = m.provenance;
            const src = p.sourceId ? sources.get(p.sourceId) : undefined;
            const srcName = src ? (lang === "th" && src.nameTh ? src.nameTh : src.nameEn) : p.sourceName;
            const srcUrl = src?.url ?? p.sourceUrl;
            const period = periodText(p, lang);
            return (
              <tr key={id} className="border-b border-ui-border/60 align-top last:border-b-0">
                <th scope="row" className="max-w-56 px-1 py-2 font-normal">
                  <span className="block text-ui-text">{t(def.label)}</span>
                  {p.methodology && (
                    <span className="mt-0.5 line-clamp-3 block text-[11px] leading-snug text-ui-text-3" title={p.methodology}>
                      {p.methodology}
                    </span>
                  )}
                </th>
                <td className="px-1 py-2 whitespace-nowrap">
                  <span className={cn("ui-num block", m.value === null || p.status === "unavailable" ? "text-ui-text-3" : "text-ui-text")}>
                    {formatMetric(m, lang, def.decimals)}
                  </span>
                  {period && <span className="block text-[11px] text-ui-text-3">{period}</span>}
                </td>
                <td className="px-1 py-2">
                  <StatusBadge status={p.status} size="xs" />
                  <span className="mt-1 block text-[11px] leading-snug text-ui-text-2">
                    {srcName ? srcUrl ? <SourceLink href={srcUrl}>{srcName}</SourceLink> : srcName : <span className="text-ui-text-3">{t({ th: "ไม่ระบุแหล่ง", en: "No source recorded" })}</span>}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SourceRegistry({ state }: { state: ReturnType<typeof useSources> }) {
  const t = useTr();
  const lang = useLang();
  const groups = useMemo(() => {
    const map = new Map<string, SourceRef[]>();
    for (const s of state.data ?? []) {
      const arr = map.get(s.publisher) ?? [];
      arr.push(s);
      map.set(s.publisher, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [state.data]);

  if (state.status === "loading" || state.status === "idle") {
    return (
      <div className="flex flex-col gap-2" aria-busy>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full bg-ui-elevated" />
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" className="flex items-start gap-2 text-[12px] text-ui-text-2">
        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ui-orange" />
        {t({ th: "ไม่สามารถโหลดทะเบียนแหล่งข้อมูลได้", en: "The source registry could not be loaded" })}
        {state.error && <span className="font-mono text-[11px] text-ui-text-3"> ({state.error})</span>}
      </p>
    );
  }
  if (!groups.length) return <p className="text-[12px] text-ui-text-3">{t({ th: "ยังไม่มีรายการแหล่งข้อมูล", en: "No sources registered yet" })}</p>;
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([publisher, items]) => (
        <div key={publisher} className="flex flex-col gap-1.5">
          <Eyebrow as="h4">{publisher}</Eyebrow>
          <ul className="flex flex-col gap-1.5">
            {items.map((s) => (
              <li key={s.id} className="rounded-lg border border-ui-border bg-ui-bg-deep/40 px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <SourceLink href={s.url} className="min-w-0 text-[12.5px] leading-snug">
                    {lang === "th" && s.nameTh ? s.nameTh : s.nameEn}
                  </SourceLink>
                  <AccessBadge status={s.accessStatus} />
                </div>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ui-text-3">
                  {s.license && (
                    <span>
                      {t({ th: "สัญญาอนุญาต", en: "License" })}: <span className="text-ui-text-2">{s.license}</span>
                    </span>
                  )}
                  {s.retrievedAt && (
                    <span>
                      {t({ th: "ดึงข้อมูลเมื่อ", en: "Retrieved" })}: <span className="text-ui-text-2">{formatDate(s.retrievedAt, lang)}</span>
                    </span>
                  )}
                </p>
                {s.notes && <p className="mt-1 text-[11.5px] leading-snug text-ui-text-2">{s.notes}</p>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function DrawerBody() {
  const t = useTr();
  const sources = useSources();
  const { bundle, status, error } = useCityBundle();
  const ds = bundle?.dataset;
  const byId = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s] as const)), [sources.data]);
  const approx = ds?.areas.some((a) => a.geometryStatus === "approximate") ?? false;
  const w = WEIGHTS;

  return (
    <div className="ui-scroll min-h-0 flex-1 overflow-y-auto">
      {status === "error" && (
        <p role="alert" className="mx-5 mt-4 flex items-start gap-2 rounded-lg border border-ui-red/35 bg-ui-red/5 px-3 py-2 text-[12px] text-ui-text-2">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ui-red" />
          {t({ th: "โหลดชุดข้อมูลของเมืองไม่สำเร็จ", en: "City dataset failed to load" })}
          {error && <span className="font-mono text-[11px] text-ui-text-3"> ({error})</span>}
        </p>
      )}

      <Block id="ds-provenance" icon={TableProperties} title={{ th: "ที่มาของตัวเลขระดับเมือง", en: "Provenance of citywide figures" }}>
        <ProvenanceTable sources={byId} />
      </Block>

      <Block id="ds-sources" icon={Database} title={{ th: "ทะเบียนแหล่งข้อมูล", en: "Source registry" }}>
        <SourceRegistry state={sources} />
      </Block>

      <Block id="ds-limits" icon={ListChecks} title={{ th: "ข้อจำกัดของชุดข้อมูล", en: "Dataset limitations" }}>
        {approx && (
          <p className="rounded-lg border border-status-estimated/35 bg-status-estimated/5 px-3 py-2 text-[12px] leading-relaxed text-ui-text-2">
            <span aria-hidden className="mr-1 text-status-estimated">◐</span>
            {t({
              th: "เขตชุมชนของเทศบาลนครหาดใหญ่เป็นเขตการบริหารจัดการชุมชน ไม่ใช่เขตการปกครอง และขอบเขตบนแผนที่เป็นการแบ่งพื้นที่โดยประมาณเพื่อการสาธิต",
              en: "Hat Yai zones are community-management zones, not administrative districts, and their map boundaries are approximate demo partitions.",
            })}
          </p>
        )}
        {ds ? (
          ds.limitations.length ? (
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[12px] leading-relaxed text-ui-text-2 marker:text-ui-text-3">
              {ds.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-ui-text-3">{t({ th: "ชุดข้อมูลไม่ได้ระบุข้อจำกัดเพิ่มเติม", en: "The dataset lists no further limitations." })}</p>
          )
        ) : (
          <Skeleton className="h-16 w-full bg-ui-elevated" />
        )}
      </Block>

      {bundle && bundle.missing.length > 0 && (
        <Block id="ds-missing" icon={FileWarning} title={{ th: "ไฟล์เสริมที่โหลดไม่สำเร็จ", en: "Optional files not loaded" }}>
          <p className="text-[12px] text-ui-text-3">
            {t({ th: "ชั้นข้อมูลที่ขึ้นกับไฟล์เหล่านี้จะแสดงสถานะ “ยังไม่มีข้อมูล”", en: "Layers that depend on these files show “Unavailable”." })}
          </p>
          <ul className="flex flex-col gap-1">
            {bundle.missing.map((m) => (
              <li key={m} className="font-mono text-[11.5px] text-ui-text-2">
                {m}
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block id="ds-method" icon={BookOpen} title={{ th: "สรุปวิธีการ", en: "Methodology summary" }}>
        <div className="flex flex-col gap-2.5 text-[12px] leading-relaxed text-ui-text-2">
          <p>
            {t({
              th: "ตัวเลขทุกค่ามีสถานะกำกับ: ข้อมูลอ้างอิงมาจากชุดข้อมูลสาธารณะโดยตรง ค่าคำนวณได้จากค่าที่มีแหล่งอ้างอิง (เช่น ขยะต่อคน = ขยะ ÷ ประชากร, ความหนาแน่น = ประชากร ÷ พื้นที่) ส่วนค่าประมาณการและค่าจำลองระบุสมมติฐานไว้เสมอ",
              en: "Every number carries a status: observed values come straight from public datasets; derived values are computed from sourced values (e.g. waste per capita = waste ÷ population, density = population ÷ area); estimated and simulated values always state their assumptions.",
            })}
          </p>
          <p>
            {t({ th: "แบบจำลองความเสี่ยงน้ำท่วมเชิงสาธิต", en: "Illustrative flood-risk model" })} (v{MODEL_VERSION}):{" "}
            <code className="rounded bg-ui-bg-deep px-1.5 py-0.5 font-mono text-[11px] text-ui-text">
              100 × ({w.R}·R + {w.D}·D + {w.E}·E + {w.W}·W)
            </code>
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-ui-text-3">
            <li>
              {t({ th: `R = ปริมาณฝนของพายุ ÷ ${P_REF_MM} มม. (อิ่มตัวที่ค่านี้)`, en: `R = storm depth ÷ ${P_REF_MM} mm (saturates there)` })}
            </li>
            <li>
              {t({
                th: `D = ภาระน้ำฝน ÷ ความสามารถระบายน้ำที่สมมติ (${DEFAULT_ASSUMPTIONS.designIntensityMmH} มม./ชม.) ÷ ${L_SAT}`,
                en: `D = rain load ÷ assumed drainage capacity (${DEFAULT_ASSUMPTIONS.designIntensityMmH} mm/h) ÷ ${L_SAT}`,
              })}
            </li>
            <li>{t({ th: "E = ดัชนีความเปราะบางเชิงพื้นที่ต่อน้ำท่วมของแต่ละพื้นที่", en: "E = each area's geographic flood-exposure index" })}</li>
            <li>{t({ th: "W = ความเสี่ยงขยะอุดตันทางระบายน้ำ ปรับตามประสิทธิภาพการเก็บขยะ", en: "W = waste-obstruction susceptibility, adjusted by collection efficiency" })}</li>
          </ul>
          <p className="rounded-lg border border-status-simulated/35 bg-status-simulated/5 px-3 py-2 text-ui-text-2">
            <span aria-hidden className="mr-1 text-status-simulated">◇</span>
            {t(COMMON.simulationBanner)} —{" "}
            {t({
              th: "น้ำหนัก เกณฑ์ และค่าความจุเป็นสมมติฐานเพื่อการสาธิต ไม่ใช่ค่าสัมประสิทธิ์ทางชลศาสตร์ที่ผ่านการสอบเทียบ",
              en: "weights, thresholds and capacity are demo assumptions, not calibrated hydraulic coefficients.",
            })}
          </p>
          <p className="text-ui-text-3">
            {t({ th: "รายละเอียดฉบับเต็มอยู่ในเอกสารของโครงการ:", en: "Full details live in the project docs:" })}{" "}
            <code className="font-mono text-[11px] text-ui-text-2">docs/DATA_METHODOLOGY.md</code> ·{" "}
            <code className="font-mono text-[11px] text-ui-text-2">docs/SIMULATION_MODEL.md</code>
          </p>
        </div>
      </Block>
    </div>
  );
}

/** Right-hand drawer: provenance table, source registry, limitations, missing files, methodology. */
export function DataSourceDrawer() {
  const t = useTr();
  const open = useDashboard((s) => s.sourcesOpen);
  const setPanel = useDashboard((s) => s.setPanel);
  const cityId = useDashboard((s) => s.cityId);
  return (
    <Sheet open={open} onOpenChange={(v) => setPanel("sourcesOpen", v)}>
      <ShellSheetContent side="right" closeLabel={t(COMMON.close)} className="w-full gap-0 border-ui-border bg-ui-surface p-0 sm:max-w-[600px]">
        <SheetHeader className="border-b border-ui-border px-5 pt-4 pr-12 pb-3">
          <SheetTitle className="flex items-center gap-2 text-[15px]">
            <Database aria-hidden className="size-4 text-ui-cyan" />
            {t({ th: "แหล่งข้อมูลและวิธีการ", en: "Data sources & methodology" })}
          </SheetTitle>
          <SheetDescription className="text-[12.5px] text-ui-text-3">
            {cityId === "hatyai"
              ? t({ th: "เทศบาลนครหาดใหญ่ — ที่มา ข้อจำกัด และวิธีคำนวณของทุกตัวเลข", en: "Hat Yai Municipality — where every number comes from and how it is computed" })
              : t({ th: "กรุงเทพมหานคร — ที่มา ข้อจำกัด และวิธีคำนวณของทุกตัวเลข", en: "Bangkok — where every number comes from and how it is computed" })}
          </SheetDescription>
        </SheetHeader>
        <DrawerBody />
      </ShellSheetContent>
    </Sheet>
  );
}
