"use client";

import { AnimatePresence, motion } from "motion/react";
import { CloudOff, MonitorX, RefreshCw, TriangleAlert } from "lucide-react";
import { useTr, type Bi } from "@/lib/i18n";
import { useDataStore } from "@/lib/data/loader";
import { CITIES } from "@/lib/data/cities";
import type { CityId } from "@/lib/types";
import { DURATION, EASE, useReducedMotionPref } from "@/lib/animation/tokens";
import { MAP_STRINGS } from "@/lib/map/labels";
import type { BasemapMode, EngineFailure } from "./use-map-engine";

const S = {
  loading: { th: "กำลังโหลดข้อมูลเชิงพื้นที่", en: "Loading spatial data" },
  loadingSub: { th: "ขอบเขตพื้นที่ ทางน้ำ ระบบระบายน้ำ และข้อมูลฝน", en: "Boundaries, waterways, drainage and rainfall" },
  error: { th: "โหลดข้อมูลเมืองไม่สำเร็จ", en: "Couldn't load city data" },
  errorSub: { th: "แผนที่ฐานยังใช้งานได้ แต่ยังไม่มีชั้นข้อมูลของเมืองนี้", en: "The basemap still works, but this city's data layers are missing" },
  retry: { th: "ลองอีกครั้ง", en: "Retry" },
  retryBasemap: { th: "ลองเชื่อมต่อแผนที่ฐานอีกครั้ง", en: "Retry online basemap" },
  webgl: { th: "ไม่สามารถแสดงแผนที่ได้", en: "Map can't be displayed" },
  webglSub: {
    th: "เบราว์เซอร์หรืออุปกรณ์นี้ไม่รองรับ WebGL — ข้อมูลตัวเลขยังดูได้จากแผงข้อมูลและตารางอันดับ",
    en: "This browser/device doesn't support WebGL — figures remain available in the panels and ranking table",
  },
  loadFail: { th: "โหลดโมดูลแผนที่ไม่สำเร็จ", en: "Couldn't load the map module" },
  reload: { th: "โหลดหน้าใหม่", en: "Reload page" },
} satisfies Record<string, Bi>;

/** Grid veil + skeleton card while the city bundle loads (the basemap stays visible underneath). */
export function MapLoadingVeil({ cityId, show }: { cityId: CityId; show: boolean }) {
  const t = useTr();
  const reduced = useReducedMotionPref();
  const city = CITIES[cityId];
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="veil"
          className="pointer-events-none absolute inset-0 z-20 grid place-items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : DURATION.panel, ease: EASE.standard }}
        >
          <div className="ui-grid-bg absolute inset-0 bg-ui-bg/45" aria-hidden />
          <div role="status" aria-live="polite" className="ui-panel-float relative w-[min(300px,calc(100%-2rem))] px-4 py-3.5">
            <p className="ui-eyebrow">{t({ th: city.nameTh, en: city.nameEn })}</p>
            <p className="mt-1 text-[13.5px] font-semibold text-ui-text">{t(S.loading)}</p>
            <p className="text-[11px] text-ui-text-3">{t(S.loadingSub)}</p>
            <div className="mt-3 space-y-1.5" aria-hidden>
              <div className="relative h-1 overflow-hidden rounded-full bg-ui-elevated-2">
                <span className="absolute inset-y-0 left-0 w-1/3 animate-[ui-map-scan_1.4s_var(--ease-standard)_infinite] rounded-full bg-ui-cyan/70" />
              </div>
              <div className="flex gap-1.5">
                {[0.62, 0.38, 0.5].map((w, i) => (
                  <span key={i} className="h-2 animate-pulse rounded bg-ui-elevated" style={{ width: `${w * 100}%` }} />
                ))}
              </div>
            </div>
          </div>
          <style>{`@keyframes ui-map-scan { 0% { transform: translateX(-110%); } 100% { transform: translateX(330%); } }`}</style>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function MapErrorCard({ cityId, error }: { cityId: CityId; error?: string }) {
  const t = useTr();
  const loadCity = useDataStore((s) => s.loadCity);
  return (
    <div className="absolute inset-0 z-20 grid place-items-center p-4">
      <div role="alert" className="ui-panel-float w-[min(340px,100%)] px-4 py-4">
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full border border-ui-red/40 bg-ui-red/10 text-ui-red">
            <TriangleAlert className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-semibold text-ui-text">{t(S.error)}</p>
            <p className="mt-0.5 text-[11.5px] text-ui-text-2">{t(S.errorSub)}</p>
            {error && <p className="mt-2 truncate rounded bg-ui-bg/60 px-2 py-1 font-mono text-[10.5px] text-ui-text-3" title={error}>{error}</p>}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadCity(cityId)}
          className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-ui-cyan/40 bg-ui-cyan/10 text-[12.5px] font-medium text-ui-cyan transition-colors outline-none hover:bg-ui-cyan/20 focus-visible:ring-2 focus-visible:ring-ui-cyan"
        >
          <RefreshCw className="size-3.5" aria-hidden />
          {t(S.retry)}
        </button>
      </div>
    </div>
  );
}

/** Small badge shown while the offline basemap is in use, with a retry action. */
export function BasemapBadge({ mode, onRetry }: { mode: BasemapMode; onRetry: () => void }) {
  const t = useTr();
  const reduced = useReducedMotionPref();
  return (
    <AnimatePresence initial={false}>
      {mode === "offline" && (
        <motion.div
          key="offline"
          role="status"
          className="ui-panel-float flex max-w-[288px] items-center gap-2 !rounded-full py-1 pr-1 pl-2.5"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: reduced ? 0 : DURATION.ui, ease: EASE.outExpo }}
        >
          <CloudOff className="size-3.5 shrink-0 text-ui-yellow" aria-hidden />
          <span className="min-w-0 text-[11px] leading-tight text-ui-text-2">{t(MAP_STRINGS.offlineBadge)}</span>
          <button
            type="button"
            onClick={onRetry}
            aria-label={t(S.retryBasemap)}
            title={t(S.retryBasemap)}
            className="grid size-6 shrink-0 place-items-center rounded-full text-ui-text-2 outline-none hover:bg-ui-elevated-2 hover:text-ui-text focus-visible:ring-2 focus-visible:ring-ui-cyan"
          >
            <RefreshCw className="size-3" aria-hidden />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function EngineFailureCard({ failure }: { failure: EngineFailure }) {
  const t = useTr();
  return (
    <div className="ui-grid-bg absolute inset-0 z-20 grid place-items-center p-4">
      <div role="alert" className="ui-panel-float w-[min(360px,100%)] px-4 py-4">
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full border border-ui-border-strong text-ui-text-2">
            <MonitorX className="size-4" aria-hidden />
          </span>
          <div>
            <p className="text-[13.5px] font-semibold text-ui-text">{failure === "webgl" ? t(S.webgl) : t(S.loadFail)}</p>
            <p className="mt-0.5 text-[11.5px] text-ui-text-2">{t(S.webglSub)}</p>
          </div>
        </div>
        {failure === "load" && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-ui-border-strong text-[12.5px] text-ui-text transition-colors outline-none hover:bg-ui-elevated-2 focus-visible:ring-2 focus-visible:ring-ui-cyan"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {t(S.reload)}
          </button>
        )}
      </div>
    </div>
  );
}
