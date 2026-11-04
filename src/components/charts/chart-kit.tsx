"use client";

import { useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { BarChart3, Table2 } from "lucide-react";
import type { DataStatus } from "@/lib/types";
import type { Lang } from "@/store/dashboard-store";
import { useTr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { EChart, baseOption } from "@/components/charts/EChart";

const S = {
  table: { th: "ตาราง", en: "Table" },
  chart: { th: "กราฟ", en: "Chart" },
  showTable: { th: "แสดงข้อมูลเป็นตาราง", en: "Show data as a table" },
  showChart: { th: "แสดงเป็นกราฟ", en: "Show as chart" },
  noData: { th: "ยังไม่มีข้อมูลสำหรับกราฟนี้", en: "No data available for this chart" },
};

export interface ChartTable {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}

/**
 * Chart container (dataviz "figure" contract): title, scope/status line, optional table-view twin
 * so no value is gated behind a hover tooltip.
 */
export function ChartFrame({
  title,
  subtitle,
  status,
  extraStatus,
  actions,
  table,
  footer,
  children,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  status?: DataStatus;
  extraStatus?: ReactNode;
  actions?: ReactNode;
  table?: ChartTable | null;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const t = useTr();
  const [asTable, setAsTable] = useState(false);
  const headingId = useId();
  return (
    <figure className={cn("flex min-w-0 flex-col gap-2", className)} aria-labelledby={headingId}>
      <figcaption className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div id={headingId} className="text-[12.5px] font-medium leading-5 text-ui-text">
            {title}
          </div>
          {subtitle && <div className="text-[11px] leading-4 text-ui-text-2">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {extraStatus}
          {status && <StatusBadge status={status} size="xs" />}
          {actions}
          {table && table.rows.length > 0 && (
            <button
              type="button"
              onClick={() => setAsTable((v) => !v)}
              aria-pressed={asTable}
              aria-label={t(asTable ? S.showChart : S.showTable)}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-ui-border px-1.5 text-[10.5px] text-ui-text-2 transition-colors hover:border-ui-border-strong hover:text-ui-text"
            >
              {asTable ? <BarChart3 className="size-3" aria-hidden /> : <Table2 className="size-3" aria-hidden />}
              {t(asTable ? S.chart : S.table)}
            </button>
          )}
        </div>
      </figcaption>
      {asTable && table ? <DataTable table={table} /> : children}
      {footer}
    </figure>
  );
}

export function DataTable({ table, className }: { table: ChartTable; className?: string }) {
  return (
    <div className={cn("ui-scroll max-h-64 overflow-auto rounded-md border border-ui-border", className)}>
      <table className="w-full border-collapse text-left text-[11px]">
        <caption className="sr-only">{table.caption}</caption>
        <thead className="sticky top-0 bg-ui-elevated">
          <tr>
            {table.columns.map((c) => (
              <th key={c} scope="col" className="px-2 py-1.5 font-medium text-ui-text-2">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-t border-ui-border/60">
              {r.map((c, j) => (
                <td key={j} className={cn("px-2 py-1 text-ui-text", j > 0 && "ui-num")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartEmpty({ message, height = 120, className }: { message?: string; height?: number; className?: string }) {
  const t = useTr();
  return (
    <div
      role="note"
      className={cn("flex items-center justify-center rounded-lg border border-dashed border-ui-border px-4 text-center text-[11.5px] text-ui-text-2", className)}
      style={{ minHeight: height }}
    >
      <span>
        <span aria-hidden className="mr-1.5 text-ui-text-3">
          ○
        </span>
        {message ?? t(S.noData)}
      </span>
    </div>
  );
}

export function ChartSkeleton({ height = 160, className }: { height?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden>
      <Skeleton className="h-3 w-1/3 bg-ui-elevated" />
      <Skeleton className="w-full bg-ui-elevated/70" style={{ height }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Option helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * The EChart wrapper shallow-merges `option` over `baseOption()`, so a chart that sets its own `tooltip`
 * must re-include the shared tooltip styling. `confine` keeps tooltips inside narrow side panels.
 */
export function tooltipOpt(o: Record<string, unknown>) {
  const base = ((baseOption() as Record<string, unknown>).tooltip ?? {}) as Record<string, unknown>;
  return { ...base, confine: true, ...o };
}

/** ECharts' aria component writes its own aria-label on the chart root; give it our precise description instead. */
export function ariaOpt(description: string) {
  return { enabled: true, label: { enabled: true, description } };
}

/** EChart with the accessible description injected into the option (so ECharts' aria label matches ours). */
export function ChartCanvas({ option, aria, ...rest }: Omit<ComponentProps<typeof EChart>, "ariaLabel"> & { aria: string }) {
  const merged = useMemo(() => ({ ...option, aria: ariaOpt(aria) }), [option, aria]);
  return <EChart option={merged} ariaLabel={aria} {...rest} />;
}

/* ------------------------------------------------------------------ */
/*  Tooltip HTML helpers (labels are untrusted data → escaped)         */
/* ------------------------------------------------------------------ */

export function esc(s: string | number | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tooltip row: value leads (strong), label follows; a short line key carries identity. */
export function tipRow(color: string | null, value: string, label: string, opts: { muted?: boolean; key?: "line" | "rect" } = {}) {
  const key = color
    ? opts.key === "rect"
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:6px"></span>`
      : `<span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${color};margin-right:6px;vertical-align:middle"></span>`
    : "";
  return `<div style="display:flex;align-items:center;gap:6px;line-height:18px">${key}<b style="font-weight:600;color:${opts.muted ? "#91a8ba" : "#eaf4fa"}">${esc(value)}</b><span style="color:#91a8ba">${esc(label)}</span></div>`;
}

export function tipTitle(s: string) {
  return `<div style="font-size:11px;color:#91a8ba;margin-bottom:3px">${esc(s)}</div>`;
}

export function tipNote(s: string) {
  return `<div style="font-size:10.5px;color:#91a8ba;margin-top:4px;max-width:240px;white-space:normal">${esc(s)}</div>`;
}

const dayMonthCache = new Map<Lang, Intl.DateTimeFormat>();
/** Compact day + month tick label ("4 พ.ย." / "4 Nov"). */
export function formatDayMonth(iso: string, lang: Lang) {
  let f = dayMonthCache.get(lang);
  if (!f) {
    f = new Intl.DateTimeFormat(lang === "th" ? "th-TH-u-ca-buddhist" : "en-GB", { day: "numeric", month: "short", timeZone: "Asia/Bangkok" });
    dayMonthCache.set(lang, f);
  }
  const d = new Date(`${iso}T00:00:00+07:00`);
  return Number.isNaN(d.getTime()) ? iso : f.format(d);
}
