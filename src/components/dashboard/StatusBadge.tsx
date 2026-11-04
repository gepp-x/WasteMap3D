"use client";

import type { DataStatus, MetricValue } from "@/lib/types";
import { STATUS_META } from "@/lib/data/status";
import { useTr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDate, formatYear, unitLabel } from "@/lib/formatters";
import { useLang } from "@/lib/i18n";
import { AnimatedNumber } from "@/components/motion/AnimatedNumber";

/** Data-status pill: glyph + label + colour (never colour alone), with a provenance tooltip. */
export function StatusBadge({ status, size = "sm", className, showLabel = true }: { status: DataStatus; size?: "xs" | "sm"; className?: string; showLabel?: boolean }) {
  const t = useTr();
  const m = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap",
        size === "xs" ? "px-1.5 py-0 text-[10px] leading-4" : "px-2 py-0.5 text-[11px] leading-4",
        status === "simulated" && "ui-sim-stripes",
        className,
      )}
      style={{ color: m.color, borderColor: `color-mix(in srgb, ${m.color} 45%, transparent)`, background: status === "simulated" ? undefined : `color-mix(in srgb, ${m.color} 10%, transparent)` }}
      aria-label={t(m.label)}
    >
      <span aria-hidden>{m.glyph}</span>
      {showLabel && <span>{t(size === "xs" ? m.short : m.label)}</span>}
    </span>
  );
}

/** Value + unit + status with provenance tooltip. Null → "Unavailable" (never 0). */
export function MetricReadout({
  metric,
  decimals = 0,
  className,
  valueClassName,
  animate = true,
  compact = false,
}: {
  metric: MetricValue | null | undefined;
  decimals?: number;
  className?: string;
  valueClassName?: string;
  animate?: boolean;
  compact?: boolean;
}) {
  const lang = useLang();
  const t = useTr();
  const status: DataStatus = metric?.provenance.status ?? "unavailable";
  const value = metric && status !== "unavailable" ? metric.value : null;
  const p = metric?.provenance;
  const period = p?.observedFrom
    ? p.observedFrom === p.observedTo || !p.observedTo
      ? formatDate(p.observedFrom, lang)
      : `${formatDate(p.observedFrom, lang)} – ${formatDate(p.observedTo, lang)}`
    : p?.referenceYear
      ? formatYear(p.referenceYear, lang)
      : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn("inline-flex items-baseline gap-1.5 cursor-help", className)}>
            <span className={cn("ui-num", value === null && "text-ui-text-3 text-[0.85em] font-normal", valueClassName)}>
              {animate ? <AnimatedNumber value={value} decimals={decimals} compact={compact} /> : value === null ? t({ th: "ยังไม่มีข้อมูล", en: "Unavailable" }) : value.toLocaleString(lang === "th" ? "th-TH" : "en-US", { maximumFractionDigits: decimals })}
            </span>
            {value !== null && metric && <span className="text-[0.72em] text-ui-text-2">{unitLabel(metric.unit, lang)}</span>}
          </span>
        }
      />
      <TooltipContent className="max-w-72 text-left">
        <div className="flex flex-col gap-1 py-0.5">
          <StatusBadge status={status} size="xs" />
          {p?.sourceName && <span className="text-[11px]">{p.sourceName}</span>}
          {period && <span className="text-[11px] opacity-80">{t({ th: "ช่วงอ้างอิง", en: "Period" })}: {period}</span>}
          {p?.methodology && <span className="text-[11px] opacity-80 line-clamp-4">{p.methodology}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
