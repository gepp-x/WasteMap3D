"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { RotateCw, TriangleAlert } from "lucide-react";
import { useCityBundle, useDataStore, useSelectedArea } from "@/lib/data/loader";
import { useTr } from "@/lib/i18n";
import { DURATION, EASE } from "@/lib/animation/tokens";
import { CityOverview } from "@/components/dashboard/CityOverview";
import { DistrictDetails } from "@/components/dashboard/DistrictDetails";
import { PanelSkeleton, useMotionPrefs } from "@/components/dashboard/MetricGrid";

const S = {
  region: { th: "แผงข้อมูลเมืองและพื้นที่", en: "City and area information panel" },
  loading: { th: "กำลังโหลดข้อมูลเมือง…", en: "Loading city data…" },
  errorTitle: { th: "โหลดชุดข้อมูลไม่สำเร็จ", en: "Could not load the dataset" },
  errorBody: {
    th: "ชุดข้อมูลของเมืองนี้อาจยังไม่ถูกสร้างหรือไม่สมบูรณ์ ข้อมูลอื่นจะไม่ถูกแทนด้วยค่าสมมติ",
    en: "This city's dataset may not be built yet or is incomplete. Nothing is filled in with placeholder values.",
  },
  retry: { th: "ลองโหลดอีกครั้ง", en: "Retry" },
};

/**
 * Right column: city overview when nothing is selected, area details for the selection.
 * The two views cross-slide with AnimatePresence (panel token); scroll resets on switch.
 */
export function RightPanel() {
  const t = useTr();
  const { status, bundle, error, cityId } = useCityBundle();
  const selected = useSelectedArea();
  const { reduced } = useMotionPrefs();
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewKey = selected ? `area:${selected.id}` : `city:${cityId}`;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [viewKey]);

  // loadCity() re-fetches when the previous attempt ended in "error".
  const retry = () => void useDataStore.getState().loadCity(cityId);

  return (
    <MotionConfig reducedMotion={reduced ? "always" : "never"}>
      <div className="relative flex h-full min-h-0 w-full flex-col" role="region" aria-label={t(S.region)}>
        <div ref={scrollRef} className="ui-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          {status === "error" ? (
            <div className="flex flex-col items-start gap-3 p-5" role="alert">
              <TriangleAlert className="size-5 text-[var(--ui-orange)]" aria-hidden />
              <div>
                <div className="text-[14px] font-semibold text-ui-text">{t(S.errorTitle)}</div>
                <p className="mt-1 text-[12px] leading-[1.6] text-ui-text-2">{t(S.errorBody)}</p>
                {error && <p className="mt-2 font-mono text-[10.5px] break-all text-ui-text-2">{error}</p>}
              </div>
              <button
                type="button"
                onClick={retry}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ui-border-strong px-3 text-[12px] font-medium text-ui-text hover:bg-ui-elevated"
              >
                <RotateCw className="size-3.5" aria-hidden />
                {t(S.retry)}
              </button>
            </div>
          ) : !bundle ? (
            <PanelSkeleton label={t(S.loading)} />
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={viewKey}
                initial={{ opacity: 0, x: 18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12, transition: { duration: DURATION.ui * 0.6, ease: EASE.standard } }}
                transition={{ duration: DURATION.panel, ease: EASE.outExpo }}
              >
                {selected ? <DistrictDetails area={selected} /> : <CityOverview />}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </div>
    </MotionConfig>
  );
}
