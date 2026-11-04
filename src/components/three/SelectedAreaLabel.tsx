"use client";

import type { Ref } from "react";
import { useDashboard } from "@/store/dashboard-store";
import { useLang, tr } from "@/lib/i18n";
import { formatMetric } from "@/lib/formatters";
import { STATUS_META, RISK_COLORS } from "@/lib/data/status";
import { RISK_CLASSES } from "@/lib/simulation/model";
import type { AreaRecord } from "@/lib/types";
import type { AreaVisualSet } from "@/lib/three/area-visuals";

/**
 * Label pinned above the selected area's prism (name, value with unit, data status as glyph + text,
 * and the modeled risk class while a scenario / historical replay is active).
 *
 * Plain DOM next to the canvas — not drei <Html>, whose nested React root is unmounted synchronously
 * inside the R3F commit (React warns about a race). RiskOverlay3D positions it from useFrame by writing
 * `transform` and `data-show` directly, so camera moves never re-render React.
 */
export function SelectedAreaLabel({
  ref,
  visuals,
  areasById,
  showRisk,
}: {
  ref: Ref<HTMLDivElement>;
  visuals: AreaVisualSet | null;
  areasById: Map<string, AreaRecord>;
  showRisk: boolean;
}) {
  const lang = useLang();
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const record = selectedId ? areasById.get(selectedId) : undefined;
  const visual = selectedId ? visuals?.byId.get(selectedId) : undefined;
  const status = visual?.metric.provenance.status ?? "unavailable";
  const meta = STATUS_META[status];
  const riskMeta = visual?.riskClass ? RISK_CLASSES.find((c) => c.id === visual.riskClass) : null;

  return (
    <div
      ref={ref}
      aria-hidden
      data-show="false"
      className="pointer-events-none invisible absolute top-0 left-0 z-[5] select-none will-change-transform data-[show=true]:visible"
    >
      {record && (
        <div className="-translate-x-1/2 -translate-y-full pb-2">
          <div className="flex flex-col items-center">
            <div className="rounded-lg border border-ui-cyan/50 bg-[rgba(6,16,28,0.9)] px-2.5 py-1.5 shadow-[0_8px_24px_-10px_rgba(0,0,0,0.8)]">
              <div className="max-w-56 truncate text-[12px] leading-4 font-semibold text-ui-text">{lang === "th" ? record.nameTh : record.nameEn}</div>
              {visuals && (
                <div className="mt-0.5 flex items-baseline gap-1.5 text-[11px] leading-4 whitespace-nowrap">
                  <span className="text-ui-text-3">{tr(lang, visuals.def.short)}</span>
                  <span className="ui-num font-medium text-ui-text">{formatMetric(visual?.metric, lang, visuals.def.decimals)}</span>
                  <span style={{ color: meta.color }}>
                    {meta.glyph} {tr(lang, meta.short)}
                  </span>
                </div>
              )}
              {showRisk && riskMeta && !visuals?.isRisk && (
                <div className="mt-0.5 text-[10.5px] leading-4 whitespace-nowrap text-ui-text-2">
                  {lang === "th" ? "ความเสี่ยง (แบบจำลอง)" : "Modeled risk"}:{" "}
                  <span style={{ color: RISK_COLORS[riskMeta.id] }}>{lang === "th" ? riskMeta.th : riskMeta.en}</span>
                </div>
              )}
            </div>
            <div className="h-4 w-px bg-ui-cyan/70" />
          </div>
        </div>
      )}
    </div>
  );
}
