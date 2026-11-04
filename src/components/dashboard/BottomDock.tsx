"use client";

import { useMemo } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { CloudRain, GitCompareArrows, ListOrdered, Waves } from "lucide-react";
import { useCityBundle } from "@/lib/data/loader";
import { useLang, useTr } from "@/lib/i18n";
import { formatDate } from "@/lib/formatters";
import { DURATION, EASE } from "@/lib/animation/tokens";
import { useDashboard, type DashboardState } from "@/store/dashboard-store";
import { cn } from "@/lib/utils";
import { PanelTabs, tabPanelProps, useMotionPrefs } from "@/components/dashboard/MetricGrid";
import { RankingPanel } from "@/components/dashboard/RankingPanel";
import { RainfallPanel } from "@/components/dashboard/RainfallPanel";
import { DrainagePanel } from "@/components/dashboard/DrainagePanel";
import { ComparisonPanel } from "@/components/dashboard/ComparisonPanel";

type DockTab = DashboardState["bottomTab"];

const S = {
  region: { th: "แผงวิเคราะห์ด้านล่าง", en: "Analysis dock" },
  tabs: { th: "มุมมองการวิเคราะห์", en: "Analysis views" },
  ranking: { th: "อันดับ", en: "Ranking" },
  rainfall: { th: "ฝน", en: "Rainfall" },
  drainage: { th: "การระบายน้ำ", en: "Drainage" },
  compare: { th: "เปรียบเทียบ", en: "Compare" },
  baseline: { th: "สภาวะฐาน", en: "Baseline" },
  scenario: { th: "สถานการณ์จำลอง", en: "Scenario" },
  historical: { th: "ย้อนหลัง", en: "Historical" },
};

const ID_BASE = "bottom-dock";

/** Bottom dock: Ranking | Rainfall | Drainage | Compare (bound to store.bottomTab) with a shared-layout tab indicator. */
export function BottomDock() {
  const t = useTr();
  const lang = useLang();
  const tab = useDashboard((s) => s.bottomTab);
  const setTab = useDashboard((s) => s.setBottomTab);
  const scenarioActive = useDashboard((s) => s.scenarioActive);
  const dateIndex = useDashboard((s) => s.dateIndex);
  const timelineMode = useDashboard((s) => s.timelineMode);
  const { bundle } = useCityBundle();
  const { reduced } = useMotionPrefs();

  const tabs = useMemo(
    () => [
      { id: "ranking" as DockTab, label: t(S.ranking), icon: <ListOrdered className="size-3.5" aria-hidden /> },
      { id: "rainfall" as DockTab, label: t(S.rainfall), icon: <CloudRain className="size-3.5" aria-hidden /> },
      { id: "drainage" as DockTab, label: t(S.drainage), icon: <Waves className="size-3.5" aria-hidden /> },
      { id: "compare" as DockTab, label: t(S.compare), icon: <GitCompareArrows className="size-3.5" aria-hidden /> },
    ],
    [t],
  );

  const date = !scenarioActive && timelineMode === "historical" && dateIndex !== null ? (bundle?.rainAreas?.dates[dateIndex] ?? null) : null;
  const context = scenarioActive ? t(S.scenario) : date ? `${t(S.historical)} · ${formatDate(date, lang)}` : t(S.baseline);

  return (
    <MotionConfig reducedMotion={reduced ? "always" : "never"}>
      <section className="flex h-full min-h-0 w-full flex-col" aria-label={t(S.region)}>
        <div className="flex items-center gap-2 border-b border-ui-border/70 px-2">
          <PanelTabs tabs={tabs} value={tab} onChange={setTab} ariaLabel={t(S.tabs)} idBase={ID_BASE} dense className="min-w-0" />
          <span
            className={cn(
              "ml-auto hidden shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] sm:inline-flex",
              scenarioActive ? "ui-sim-stripes border-[color-mix(in_srgb,var(--status-simulated)_45%,transparent)] text-ui-text" : "border-ui-border text-ui-text-2",
            )}
          >
            <span aria-hidden>{scenarioActive ? "◇" : date ? "◐" : "○"}</span>
            {context}
          </span>
        </div>
        <div className="relative min-h-0 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              {...tabPanelProps(ID_BASE, tab)}
              className="absolute inset-0 flex flex-col outline-none"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4, transition: { duration: DURATION.fast } }}
              transition={{ duration: DURATION.ui, ease: EASE.outExpo }}
            >
              {tab === "ranking" && <RankingPanel compact />}
              {tab === "rainfall" && <RainfallPanel />}
              {tab === "drainage" && <DrainagePanel />}
              {tab === "compare" && <ComparisonPanel />}
            </motion.div>
          </AnimatePresence>
        </div>
      </section>
    </MotionConfig>
  );
}
