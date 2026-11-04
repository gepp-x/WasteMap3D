"use client";

import { MonitorX, Map as MapIcon, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTr } from "@/lib/i18n";
import { useDashboard } from "@/store/dashboard-store";

const S = {
  titleUnsupported: { th: "อุปกรณ์นี้ไม่รองรับการแสดงผล 3 มิติ", en: "3D view isn’t supported on this device" },
  titleLost: { th: "การแสดงผล 3 มิติหยุดทำงานชั่วคราว", en: "The 3D view stopped responding" },
  bodyUnsupported: {
    th: "ดิจิทัลทวิน 3 มิติต้องใช้ WebGL 2 ซึ่งเบราว์เซอร์หรือการ์ดจอของอุปกรณ์นี้ไม่ได้เปิดใช้งาน แผนที่ 2 มิติ ตารางอันดับ และแผงข้อมูลทั้งหมดยังใช้งานได้ตามปกติ",
    en: "The 3D digital twin needs WebGL 2, which this browser or graphics driver doesn’t provide. The 2D map, rankings and every data panel keep working as normal.",
  },
  bodyLost: {
    th: "เบราว์เซอร์ปิดบริบทกราฟิก (WebGL context) ของฉาก 3 มิติ อาจเกิดจากหน่วยความจำการ์ดจอไม่พอหรือมีแท็บอื่นใช้ GPU มาก ข้อมูลของคุณไม่ได้รับผลกระทบ",
    en: "The browser released the 3D scene’s graphics context — usually low GPU memory or another tab using the GPU heavily. Your data and selections are unaffected.",
  },
  back2d: { th: "กลับไปแผนที่ 2 มิติ", en: "Back to 2D" },
  retry: { th: "ลองแสดงผล 3 มิติอีกครั้ง", en: "Try 3D again" },
  hint: { th: "เคล็ดลับ: ลดคุณภาพการแสดงผลในการตั้งค่า หรือปิดแท็บที่ใช้กราฟิกมาก", en: "Tip: lower the render quality in Settings or close graphics-heavy tabs." },
};

/** Informative fallback when WebGL 2 is unavailable or the context is lost; the dashboard keeps working. */
export function WebglFallback({ reason, onRetry }: { reason: "unsupported" | "lost"; onRetry?: () => void }) {
  const t = useTr();
  const setViewMode = useDashboard((s) => s.setViewMode);
  return (
    <div className="ui-grid-bg flex h-full w-full items-center justify-center p-4" role="alert" aria-live="polite">
      <div className="ui-panel w-full max-w-md p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-ui-border-strong bg-ui-elevated text-ui-orange">
            <MonitorX className="size-4.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="ui-eyebrow">{t({ th: "ดิจิทัลทวิน 3 มิติ", en: "3D digital twin" })}</p>
            <h2 className="mt-1 text-[15px] font-semibold leading-snug text-ui-text">{t(reason === "lost" ? S.titleLost : S.titleUnsupported)}</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ui-text-2">{t(reason === "lost" ? S.bodyLost : S.bodyUnsupported)}</p>
            {reason === "lost" && <p className="mt-2 text-[12px] text-ui-text-3">{t(S.hint)}</p>}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {reason === "lost" && onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCcw aria-hidden />
              {t(S.retry)}
            </Button>
          )}
          <Button size="sm" onClick={() => setViewMode("2d")}>
            <MapIcon aria-hidden />
            {t(S.back2d)}
          </Button>
        </div>
      </div>
    </div>
  );
}
