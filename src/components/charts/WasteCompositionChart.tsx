"use client";

import { useMemo, type ReactNode } from "react";
import type { DataStatus, MetricValue, WasteCategory, WasteComposition } from "@/lib/types";
import { useLang, useTr } from "@/lib/i18n";
import { formatNumber, formatYear, unitLabel } from "@/lib/formatters";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ChartCanvas, ChartEmpty, ChartFrame, tipNote, tipRow, tipTitle, tooltipOpt } from "./chart-kit";
import { COMPOSITION_COLORS, COMPOSITION_LABELS, COMPOSITION_ORDER, VIZ } from "./palette";
import { hasValue } from "./derive";

const S = {
  title: { th: "องค์ประกอบขยะ", en: "Waste composition" },
  category: { th: "ประเภท", en: "Category" },
  share: { th: "สัดส่วน", en: "Share" },
  qty: { th: "ปริมาณโดยประมาณ", en: "Approx. quantity" },
  qtyNote: { th: "ปริมาณ = สัดส่วน × ปริมาณรวม (คำนวณ)", en: "Quantity = share × total (derived)" },
  qtyEstNote: {
    th: "ปริมาณ = สัดส่วนระดับเมือง × ปริมาณรวมของพื้นที่ (ประมาณการ)",
    en: "Quantity = citywide share × area total (estimate)",
  },
  noTotal: { th: "ไม่มีปริมาณรวม จึงแสดงเฉพาะสัดส่วน", en: "No total available — shares only" },
  total: { th: "รวม", en: "Total" },
  ref: { th: "ปีอ้างอิง", en: "Reference year" },
  aria: { th: "แผนภูมิวงแหวนองค์ประกอบขยะ", en: "Donut chart of waste composition" },
  unavailable: {
    th: "ยังไม่มีข้อมูลองค์ประกอบขยะที่อ้างอิงได้สำหรับขอบเขตนี้ จึงไม่แสดงแผนภูมิ",
    en: "No citable waste-composition data for this scope, so no chart is drawn",
  },
  scope: { th: "ขอบเขตข้อมูล", en: "Data scope" },
  estNote: {
    th: "สัดส่วนเป็นค่าประมาณการ (ไม่ใช่ผลการสำรวจของพื้นที่นี้โดยตรง) — ดูวิธีการในแท็บข้อมูล",
    en: "Shares are estimates (not a survey of this area itself) — see the method in the Data tab",
  },
};

const STATUS_RANK: Record<DataStatus, number> = { observed: 0, derived: 1, estimated: 2, simulated: 3, unavailable: 4 };
/** Status of a value computed from several inputs: the weakest input wins (observed inputs → derived). */
function weakest(...xs: (DataStatus | undefined)[]): DataStatus {
  const r = xs.filter((x): x is DataStatus => !!x).reduce((m, x) => Math.max(m, STATUS_RANK[x]), 1);
  return (Object.keys(STATUS_RANK) as DataStatus[]).find((k) => STATUS_RANK[k] === r) ?? "derived";
}

export interface WasteCompositionChartProps {
  composition: WasteComposition | null | undefined;
  /** Total waste (t/day) the shares apply to; quantities are shown only when it has a value. */
  total?: MetricValue | null;
  /** Precise label of the total, e.g. "ขยะที่จัดเก็บได้". */
  totalLabel?: string;
  /** Scope line, e.g. "สัดส่วนระดับเมือง / Citywide composition". */
  scopeLabel: string;
  /** Status of the derived quantities (derived when shares and total share a scope; estimated when city shares are applied to an area). */
  quantityStatus?: DataStatus;
  title?: string;
  note?: ReactNode;
  height?: number;
}

export function WasteCompositionChart({ composition, total, totalLabel, scopeLabel, quantityStatus = "derived", title, note, height = 168 }: WasteCompositionChartProps) {
  const t = useTr();
  const lang = useLang();

  const usable = !!composition && composition.provenance?.status !== "unavailable";
  const rows = useMemo(() => {
    if (!composition || composition.provenance?.status === "unavailable") return [];
    const tot = hasValue(total) ? total.value : null;
    return COMPOSITION_ORDER.map((k: WasteCategory) => {
      const share = composition.shares?.[k];
      const ok = typeof share === "number" && Number.isFinite(share);
      return {
        key: k,
        label: t(COMPOSITION_LABELS[k]),
        color: COMPOSITION_COLORS[k],
        share: ok ? share : null,
        qty: ok && tot !== null ? (share / 100) * tot : null,
      };
    });
  }, [composition, total, t]);

  const unit = total ? unitLabel(total.unit, lang) : "";
  const hasQty = rows.some((r) => r.qty !== null);
  const qtyStatus = weakest(quantityStatus, composition?.provenance?.status, hasValue(total) ? total.provenance.status : undefined);
  const valid = useMemo(() => rows.filter((r) => r.share !== null && r.share > 0), [rows]);

  const option = useMemo(
    () => ({
      tooltip: tooltipOpt({
        trigger: "item",
        formatter: (p: { dataIndex: number }) => {
          const r = valid[p.dataIndex];
          if (!r) return "";
          return (
            tipTitle(r.label) +
            tipRow(r.color, `${formatNumber(r.share, lang, 1)}%`, t(S.share), { key: "rect" }) +
            (r.qty !== null ? tipRow(null, `${formatNumber(r.qty, lang, 1)} ${unit}`, t(S.qty)) : "") +
            (r.qty !== null ? tipNote(t(qtyStatus === "derived" ? S.qtyNote : S.qtyEstNote)) : "")
          );
        },
      }),
      series: [
        {
          type: "pie",
          radius: ["60%", "88%"],
          center: ["50%", "50%"],
          padAngle: 1.2,
          minAngle: 2,
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderColor: VIZ.surface, borderWidth: 2, borderRadius: 3 },
          emphasis: { scale: true, scaleSize: 4, itemStyle: { borderColor: VIZ.surface } },
          data: valid.map((r) => ({ name: r.label, value: r.share, itemStyle: { color: r.color } })),
        },
      ],
    }),
    [valid, lang, t, unit, qtyStatus],
  );

  if (!composition || !usable || valid.length === 0) {
    const p = composition?.provenance;
    return (
      <ChartFrame title={title ?? t(S.title)} subtitle={scopeLabel} status="unavailable" footer={note}>
        <ChartEmpty message={t(S.unavailable)} height={96} />
        {p?.limitations?.length ? <p className="text-[10.5px] leading-4 text-ui-text-2">{p.limitations.join(" · ")}</p> : null}
        {p?.methodology && !p.limitations?.length ? <p className="text-[10.5px] leading-4 text-ui-text-2">{p.methodology}</p> : null}
      </ChartFrame>
    );
  }

  const status = composition.provenance?.status ?? "unavailable";
  const scope = composition.provenance?.geographicScope;
  const year = composition.provenance?.referenceYear;
  const top = [...valid].sort((a, b) => (b.share ?? 0) - (a.share ?? 0))[0];
  const aria = `${t(S.aria)} — ${scopeLabel}. ${valid.map((r) => `${r.label} ${formatNumber(r.share, lang, 1)}%`).join(", ")}`;

  return (
    <ChartFrame
      title={title ?? t(S.title)}
      subtitle={
        <>
          {scopeLabel}
          {year ? ` · ${t(S.ref)} ${formatYear(year, lang)}` : ""}
          {composition.provenance?.sourceName ? ` · ${composition.provenance.sourceName}` : ""}
        </>
      }
      status={status}
      footer={
        status === "estimated" || scope || note ? (
          <div className="flex flex-col gap-1.5">
            {scope && (
              <p className="text-[10.5px] leading-4 text-ui-text-2">
                <span className="text-ui-text">{t(S.scope)}:</span> {scope}
              </p>
            )}
            {status === "estimated" && <p className="text-[10.5px] leading-4 text-ui-text-2">{t(S.estNote)}</p>}
            {note}
          </div>
        ) : undefined
      }
    >
      <div className="grid grid-cols-[minmax(0,128px)_1fr] items-center gap-3">
        <div className="relative" style={{ height }}>
          <ChartCanvas option={option} aria={aria} style={{ height, minHeight: height }} />
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center" aria-hidden>
            <span className="ui-num text-[15px] font-semibold text-ui-text">{formatNumber(top.share, lang, 0)}%</span>
            <span className="max-w-[72px] truncate text-[10px] leading-3 text-ui-text-2">{top.label}</span>
          </div>
        </div>
        <table className="w-full text-[11px]">
          <caption className="sr-only">{`${title ?? t(S.title)} — ${scopeLabel}`}</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">{t(S.category)}</th>
              <th scope="col">{t(S.share)}</th>
              {hasQty && <th scope="col">{t(S.qty)}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.share === null ? "opacity-60" : undefined}>
                <th scope="row" className="py-[3px] pr-2 text-left font-normal text-ui-text-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: r.color }} />
                    <span className="truncate">{r.label}</span>
                  </span>
                </th>
                <td className="ui-num py-[3px] text-right text-ui-text">{r.share === null ? "—" : `${formatNumber(r.share, lang, 1)}%`}</td>
                {hasQty && <td className="ui-num py-[3px] pl-2 text-right text-ui-text-2">{r.qty === null ? "—" : formatNumber(r.qty, lang, r.qty < 10 ? 1 : 0)}</td>}
              </tr>
            ))}
          </tbody>
          {hasQty && (
            <tfoot>
              <tr>
                <td colSpan={3} className="pt-1.5 text-[10.5px] leading-4 text-ui-text-2">
                  <span className="mr-1">
                    {t(S.qty)} ({unit}
                    {totalLabel ? ` · ${totalLabel}` : ""})
                  </span>
                  <StatusBadge status={qtyStatus} size="xs" />
                </td>
              </tr>
            </tfoot>
          )}
          {!hasQty && (
            <tfoot>
              <tr>
                <td colSpan={2} className="pt-1.5 text-[10.5px] text-ui-text-2">
                  {t(S.noTotal)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </ChartFrame>
  );
}
