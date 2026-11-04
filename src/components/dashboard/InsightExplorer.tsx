"use client";

import { useMemo } from "react";
import { motion } from "motion/react";
import { Box, CloudRain, Crosshair, Gauge, Layers, Lightbulb, Scale, Trash, TriangleAlert, Warehouse, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { COMMON, useLang, useTr, type Bi } from "@/lib/i18n";
import { useCityBundle } from "@/lib/data/loader";
import { primaryWasteMetric, quantileBreaks } from "@/lib/metrics";
import { formatDate, formatNumber, unitLabel } from "@/lib/formatters";
import { SCENARIO_PRESETS } from "@/lib/simulation/model";
import { useScenario, type AreaScenario } from "@/lib/simulation/use-scenario";
import type { AreaRecord, DataStatus, MetricValue } from "@/lib/types";
import { useDashboard } from "@/store/dashboard-store";
import { DURATION, EASE, STAGGER, motionDuration, useReducedMotionPref } from "@/lib/animation/tokens";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ShellSheetContent } from "@/components/motion/AnimatedPanel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Eyebrow } from "@/components/dashboard/Header";
import { StoryInsightsEntry } from "@/components/dashboard/StoryMode";

interface Target {
  id: string;
  name: string;
  detail?: string;
}

interface Insight {
  id: string;
  icon: LucideIcon;
  title: Bi;
  claim: string;
  status: DataStatus;
  note?: string;
  targets: Target[];
}

const valueOf = (m: MetricValue | undefined) => (m && m.provenance.status !== "unavailable" && m.value !== null && Number.isFinite(m.value) ? m.value : null);

function top<T>(items: T[], val: (x: T) => number | null): { item: T; v: number } | null {
  let best: { item: T; v: number } | null = null;
  for (const item of items) {
    const v = val(item);
    if (v === null || !Number.isFinite(v)) continue;
    if (!best || v > best.v) best = { item, v };
  }
  return best;
}

function useInsights() {
  const t = useTr();
  const lang = useLang();
  const { bundle, status } = useCityBundle();
  const scen = useScenario();
  const presetId = useDashboard((s) => s.presetId);

  const insights = useMemo<Insight[] | null>(() => {
    const ds = bundle?.dataset;
    if (!ds || !scen.ready) return null;
    const out: Insight[] = [];
    const nm = (a: AreaRecord) => t({ th: a.nameTh, en: a.nameEn });
    const n = (v: number, d: number) => formatNumber(v, lang, d);
    const u = (unit: string) => unitLabel(unit, lang);
    const presetName = presetId === "custom" ? t({ th: "กำหนดเอง", en: "Custom" }) : t({ th: SCENARIO_PRESETS[presetId].th, en: SCENARIO_PRESETS[presetId].en });
    const context =
      scen.source === "scenario"
        ? t({ th: `ภายใต้สถานการณ์จำลอง “${presetName}”`, en: `Under the “${presetName}” scenario` })
        : scen.source === "historical" && scen.date
          ? t({ th: `เมื่อจำลองด้วยฝนวันที่ ${formatDate(scen.date, "th")}`, en: `Replaying rainfall of ${formatDate(scen.date, "en")}` })
          : t({ th: "ในสถานการณ์ฐาน (ฝนปกติ)", en: "In the baseline scenario (normal rain)" });

    /* 1. highest waste volume (observed) */
    const primary = primaryWasteMetric(ds);
    const w = top(ds.areas, (a) => valueOf(a.metrics[primary]));
    if (w) {
      const m = w.item.metrics[primary];
      const total = valueOf(ds.totals[primary]);
      const share = total ? (w.v / total) * 100 : null;
      const what = primary === "wasteCollected" ? { th: "ปริมาณขยะที่จัดเก็บได้", en: "waste collected" } : { th: "ปริมาณขยะที่เกิดขึ้น", en: "waste generated" };
      out.push({
        id: "waste",
        icon: Trash,
        title: primary === "wasteCollected" ? { th: "ขยะที่จัดเก็บได้สูงสุด", en: "Most waste collected" } : { th: "ขยะที่เกิดขึ้นสูงสุด", en: "Most waste generated" },
        claim: t({
          th: `${nm(w.item)} มี${what.th}สูงที่สุดในเมือง ${n(w.v, 1)} ${u(m.unit)}${share !== null ? ` คิดเป็น ${n(share, 1)}% ของทั้งเมือง` : ""}`,
          en: `${nm(w.item)} has the city's highest ${what.en}: ${n(w.v, 1)} ${u(m.unit)}${share !== null ? `, ${n(share, 1)}% of the city total` : ""}.`,
        }),
        status: m.provenance.status,
        targets: [{ id: w.item.id, name: nm(w.item) }],
      });
    }

    /* 2. highest waste per capita (derived) */
    const pc = top(ds.areas, (a) => valueOf(a.metrics.wastePerCapita));
    if (pc) {
      const m = pc.item.metrics.wastePerCapita;
      const city = valueOf(ds.totals.wastePerCapita);
      const ratio = city ? pc.v / city : null;
      out.push({
        id: "perCapita",
        icon: Scale,
        title: { th: "ขยะต่อคนสูงสุด", en: "Highest waste per capita" },
        claim: t({
          th: `${nm(pc.item)} มีขยะต่อคนสูงที่สุด ${n(pc.v, 2)} ${u(m.unit)}${ratio !== null ? ` หรือ ${n(ratio, 1)} เท่าของค่าทั้งเมือง` : ""}`,
          en: `${nm(pc.item)} has the highest waste per capita: ${n(pc.v, 2)} ${u(m.unit)}${ratio !== null ? `, ${n(ratio, 1)}× the city value` : ""}.`,
        }),
        status: m.provenance.status,
        note: t({ th: "พื้นที่ที่มีผู้คนเข้ามาทำงานหรือท่องเที่ยวมากอาจมีค่าต่อคนสูงกว่าความเป็นจริงของผู้อยู่อาศัย", en: "Areas with many commuters or visitors can show high per-resident values." }),
        targets: [{ id: pc.item.id, name: nm(pc.item) }],
      });
    }

    /* 3. highest modelled accumulation (simulated) */
    const acc = top(ds.areas, (a) => valueOf(a.metrics.wasteAccumulated));
    if (acc) {
      const m = acc.item.metrics.wasteAccumulated;
      out.push({
        id: "accumulation",
        icon: Warehouse,
        title: { th: "ขยะตกค้างสะสมสูงสุด (จำลอง)", en: "Highest modeled accumulation" },
        claim: t({
          th: `แบบจำลองชี้ว่า ${nm(acc.item)} มีขยะตกค้างสะสมสูงที่สุด ${n(acc.v, 1)} ${u(m.unit)}`,
          en: `The model puts the largest uncollected waste stock in ${nm(acc.item)}: ${n(acc.v, 1)} ${u(m.unit)}.`,
        }),
        status: m.provenance.status,
        note: t({ th: "ค่าจำลองเชิงสาธิตจากอัตราการเก็บขนที่สมมติ ไม่ใช่ปริมาณที่ตรวจวัด", en: "Illustrative stock from an assumed collection rate, not a measured quantity." }),
        targets: [{ id: acc.item.id, name: nm(acc.item) }],
      });
    }

    /* 4. highest rainfall (scenario / historical / annual) */
    if (scen.source === "scenario") {
      const r = top(scen.list, (x) => x.current.rainDepthMm);
      if (r) {
        out.push({
          id: "rain",
          icon: CloudRain,
          title: { th: "ฝนสะสมสูงสุดในสถานการณ์", en: "Wettest area in the scenario" },
          claim: t({
            th: `${context} ${nm(r.item.area)} ได้รับฝนสะสมมากที่สุด ${n(r.v, 1)} ${u("mm")}`,
            en: `${context}, ${nm(r.item.area)} receives the most rain: ${n(r.v, 1)} ${u("mm")}.`,
          }),
          status: "simulated",
          targets: [{ id: r.item.area.id, name: nm(r.item.area) }],
        });
      }
    } else if (scen.source === "historical") {
      const r = top(scen.list, (x) => x.rain24h);
      if (r) {
        out.push({
          id: "rain",
          icon: CloudRain,
          title: { th: "ฝนสูงสุดของวันที่เลือก", en: "Wettest area on the selected day" },
          claim: t({
            th: `วันที่ ${formatDate(scen.date, "th")} ${nm(r.item.area)} มีฝนประมาณการสูงที่สุด ${n(r.v, 1)} ${u("mm")}`,
            en: `On ${formatDate(scen.date, "en")}, ${nm(r.item.area)} had the highest estimated rainfall: ${n(r.v, 1)} ${u("mm")}.`,
          }),
          status: bundle.rainAreas?.provenance.status ?? "estimated",
          targets: [{ id: r.item.area.id, name: nm(r.item.area) }],
        });
      }
    } else {
      const r = top(ds.areas, (a) => valueOf(a.metrics.rainfallAnnual));
      if (r) {
        const m = r.item.metrics.rainfallAnnual;
        out.push({
          id: "rain",
          icon: CloudRain,
          title: { th: "ฝนรายปีสูงสุด", en: "Highest annual rainfall" },
          claim: t({
            th: `${nm(r.item)} มีปริมาณฝนเฉลี่ยรายปีสูงที่สุด ${n(r.v, 0)} ${u(m.unit)}`,
            en: `${nm(r.item)} has the highest mean annual rainfall: ${n(r.v, 0)} ${u(m.unit)}.`,
          }),
          status: m.provenance.status,
          targets: [{ id: r.item.id, name: nm(r.item) }],
        });
      }
    }

    /* 5. highest modelled drainage stress (simulated) */
    const d = top(scen.list, (x) => x.current.drainageStressPct);
    if (d) {
      out.push({
        id: "drainage",
        icon: Gauge,
        title: { th: "แรงกดดันระบายน้ำสูงสุด (จำลอง)", en: "Highest modeled drainage stress" },
        claim: t({
          th: `${context} ${nm(d.item.area)} มีแรงกดดันระบบระบายน้ำสูงที่สุด ${n(d.v, 1)}%`,
          en: `${context}, ${nm(d.item.area)} shows the highest modeled drainage stress: ${n(d.v, 1)}%.`,
        }),
        status: "simulated",
        targets: [{ id: d.item.area.id, name: nm(d.item.area) }],
      });
    }

    /* 6. compound stress — ≥ 3 of 4 factors in the city's top quartile */
    const factors: { key: string; label: Bi; val: (x: AreaScenario) => number | null }[] = [
      { key: "E", label: { th: "ความเปราะบาง", en: "Exposure" }, val: (x) => valueOf(x.area.metrics.floodExposure) },
      { key: "W", label: { th: "ขยะอุดตัน", en: "Obstruction" }, val: (x) => valueOf(x.area.metrics.obstructionSusceptibility) },
      { key: "R", label: { th: "ความเสี่ยงปัจจุบัน", en: "Current risk" }, val: (x) => x.current.score },
      { key: "D", label: { th: "แรงกดดันระบายน้ำ", en: "Drainage stress" }, val: (x) => x.current.drainageStressPct },
    ];
    const usable = factors
      .map((f) => {
        const vals = scen.list.map(f.val).filter((v): v is number => v !== null && Number.isFinite(v));
        if (vals.length < 4 || Math.max(...vals) === Math.min(...vals)) return null;
        return { ...f, q75: quantileBreaks(vals, 4)[2] };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);
    if (usable.length >= 3) {
      const flagged = scen.list
        .map((x) => ({ x, hits: usable.filter((f) => {
          const v = f.val(x);
          return v !== null && v >= f.q75;
        }) }))
        .filter((r) => r.hits.length >= 3)
        .sort((a, b) => b.hits.length - a.hits.length || (b.x.current.score ?? 0) - (a.x.current.score ?? 0));
      if (flagged.length) {
        out.push({
          id: "compound",
          icon: Layers,
          title: { th: "พื้นที่ที่ปัจจัยเสี่ยงซ้อนกัน", en: "Compounding stress" },
          claim: t({
            th: `${flagged.length} พื้นที่มีปัจจัยอย่างน้อย 3 จาก ${usable.length} ด้านอยู่ในกลุ่มสูงสุดหนึ่งในสี่ของเมือง ${context}`,
            en: `${flagged.length} area${flagged.length > 1 ? "s have" : " has"} at least 3 of ${usable.length} factors in the city's top quartile — ${context.charAt(0).toLowerCase()}${context.slice(1)}.`,
          }),
          status: "simulated",
          note: t({
            th: "ความเปราะบางและขยะอุดตันเป็นดัชนีจากชุดข้อมูล ส่วนความเสี่ยงและแรงกดดันระบายน้ำมาจากแบบจำลองเชิงสาธิต",
            en: "Exposure and obstruction are dataset indices; risk and drainage stress come from the illustrative model.",
          }),
          targets: flagged.slice(0, 8).map((r) => ({
            id: r.x.area.id,
            name: nm(r.x.area),
            detail: r.hits.map((h) => t(h.label)).join(" · "),
          })),
        });
      }
    }
    return out;
  }, [bundle, scen, presetId, t, lang]);

  return { insights, status, source: scen.source };
}

function InsightCard({ insight, index }: { insight: Insight; index: number }) {
  const t = useTr();
  const reduced = useReducedMotionPref();
  const webgl = useDashboard((s) => s.webglSupported);
  const Icon = insight.icon;
  const locate = (id: string) => {
    const s = useDashboard.getState();
    s.selectArea(id, { focus: true });
    s.setPanel("insightsOpen", false);
  };
  const view3d = (id: string) => {
    const s = useDashboard.getState();
    s.selectArea(id, { focus: true });
    s.setViewMode("3d");
    s.setThreeScope("neighborhood");
    s.setPanel("insightsOpen", false);
  };
  const single = insight.targets.length === 1 ? insight.targets[0] : null;

  const actions = (target: Target, small = false) => (
    <div className="flex shrink-0 gap-1.5">
      <Button variant="outline" size={small ? "xs" : "sm"} onClick={() => locate(target.id)} aria-label={`${t({ th: "ระบุตำแหน่ง", en: "Locate" })} ${target.name}`}>
        <Crosshair aria-hidden />
        {t({ th: "ระบุตำแหน่ง", en: "Locate" })}
      </Button>
      <Button
        variant="ghost"
        size={small ? "xs" : "sm"}
        onClick={() => view3d(target.id)}
        disabled={webgl === false}
        title={webgl === false ? t({ th: "อุปกรณ์นี้ไม่รองรับ WebGL", en: "WebGL is unavailable on this device" }) : undefined}
        aria-label={`${t({ th: "ดูแบบ 3 มิติ", en: "View in 3D" })} ${target.name}`}
        className="text-ui-text-2 hover:text-ui-text"
      >
        <Box aria-hidden />
        {t({ th: "ดูแบบ 3 มิติ", en: "View in 3D" })}
      </Button>
    </div>
  );

  return (
    <motion.li
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: motionDuration(DURATION.panel, reduced), ease: EASE.outExpo, delay: reduced ? 0 : index * STAGGER }}
      className={cn("relative overflow-hidden rounded-xl border border-ui-border bg-ui-bg-deep/40 p-4", insight.status === "simulated" && "border-status-simulated/30")}
    >
      {insight.status === "simulated" && <span aria-hidden className="ui-sim-stripes absolute inset-x-0 top-0 h-[3px]" />}
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2">
          <span aria-hidden className="flex size-7 items-center justify-center rounded-md border border-ui-border bg-ui-surface text-ui-cyan">
            <Icon className="size-3.5" />
          </span>
          <Eyebrow as="h3">{t(insight.title)}</Eyebrow>
        </span>
        <StatusBadge status={insight.status} size="xs" />
      </div>
      <p className="mt-2.5 text-[13.5px] leading-relaxed text-ui-text">{insight.claim}</p>
      {insight.note && <p className="mt-1.5 text-[11.5px] leading-relaxed text-ui-text-3">{insight.note}</p>}
      {single ? (
        <div className="mt-3">{actions(single)}</div>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-ui-border/60 rounded-lg border border-ui-border">
          {insight.targets.map((tg) => (
            <li key={tg.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] text-ui-text">{tg.name}</span>
                {tg.detail && <span className="block truncate text-[11px] text-ui-text-3">{tg.detail}</span>}
              </span>
              {actions(tg, true)}
            </li>
          ))}
        </ul>
      )}
    </motion.li>
  );
}

function InsightBody() {
  const t = useTr();
  const { insights, status } = useInsights();
  if (status === "error") {
    return (
      <p role="alert" className="mx-5 mt-4 flex items-start gap-2 text-[12.5px] text-ui-text-2">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-ui-orange" />
        {t({ th: "ยังไม่สามารถคำนวณข้อค้นพบได้ เพราะโหลดชุดข้อมูลของเมืองไม่สำเร็จ", en: "Insights are unavailable because the city dataset failed to load." })}
      </p>
    );
  }
  if (!insights) {
    return (
      <div className="flex flex-col gap-3 px-5 py-4" aria-busy>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-xl bg-ui-elevated" />
        ))}
      </div>
    );
  }
  if (!insights.length) {
    return (
      <p className="px-5 py-6 text-[12.5px] text-ui-text-3">
        {t({ th: "ชุดข้อมูลของเมืองนี้ยังมีค่าไม่พอสำหรับสรุปข้อค้นพบ", en: "This city's dataset does not yet have enough values to derive insights." })}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3 px-5 py-4">
      {insights.map((ins, i) => (
        <InsightCard key={ins.id} insight={ins} index={i} />
      ))}
    </ul>
  );
}

/** Live insights computed from the dataset + current scenario; an insight is skipped when its data is missing. */
export function InsightExplorer() {
  const t = useTr();
  const open = useDashboard((s) => s.insightsOpen);
  const setPanel = useDashboard((s) => s.setPanel);
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  return (
    <Sheet open={open} onOpenChange={(v) => setPanel("insightsOpen", v)}>
      <ShellSheetContent side="right" closeLabel={t(COMMON.close)} className="w-full gap-0 border-ui-border bg-ui-surface p-0 sm:max-w-[520px]">
        <SheetHeader className="border-b border-ui-border px-5 pt-4 pr-12 pb-3">
          <SheetTitle className="flex items-center gap-2 text-[15px]">
            <Lightbulb aria-hidden className="size-4 text-ui-cyan" />
            {t({ th: "ข้อค้นพบสำคัญ", en: "Insights" })}
          </SheetTitle>
          <SheetDescription className="text-[12.5px] text-ui-text-3">
            {scenarioActive
              ? t({ th: "คำนวณสดจากข้อมูลและสถานการณ์จำลองที่เปิดอยู่ — ค่าจำลองมีป้ายกำกับเสมอ", en: "Computed live from the data and the active scenario — simulated values are always labelled." })
              : t({ th: "คำนวณสดจากชุดข้อมูลและแบบจำลองสถานการณ์ฐาน", en: "Computed live from the dataset and the baseline model." })}
          </SheetDescription>
        </SheetHeader>
        <div className="ui-scroll min-h-0 flex-1 overflow-y-auto">
          <StoryInsightsEntry />
          <InsightBody />
        </div>
      </ShellSheetContent>
    </Sheet>
  );
}
