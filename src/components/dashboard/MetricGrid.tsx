"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { LayoutGroup, motion } from "motion/react";
import { AlertTriangle, ExternalLink, Info, MapPinned, ShieldCheck, Shapes } from "lucide-react";
import type { AreaKind, DataProvenance, GeometryStatus, MetricValue } from "@/lib/types";
import type { RiskClass } from "@/lib/simulation/model";
import { RISK_CLASSES } from "@/lib/simulation/model";
import { useLang, useTr, type Bi } from "@/lib/i18n";
import { formatNumber } from "@/lib/formatters";
import { SPRING, useReducedMotionPref } from "@/lib/animation/tokens";
import { useDashboard } from "@/store/dashboard-store";
import { cn } from "@/lib/utils";
import { MetricReadout, StatusBadge } from "@/components/dashboard/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { RISK_CLASS_COLORS } from "@/components/charts/palette";

/* ------------------------------------------------------------------ */
/*  Shared vocabulary                                                  */
/* ------------------------------------------------------------------ */

export const AREA_KIND_LABELS: Record<AreaKind, Bi> = {
  district: { th: "เขต", en: "District" },
  "community-zone": { th: "เขตชุมชน", en: "Community zone" },
  municipality: { th: "เทศบาล", en: "Municipality" },
};

const GEOMETRY: Record<GeometryStatus, { label: Bi; help: Bi }> = {
  official: {
    label: { th: "ขอบเขตทางการ", en: "Official boundary" },
    help: { th: "รูปร่างจากแหล่งข้อมูลภูมิสารสนเทศของรัฐ", en: "Shape from an official government GIS source" },
  },
  osm: {
    label: { th: "ขอบเขต OSM", en: "OSM boundary" },
    help: { th: "ขอบเขตการปกครองจาก OpenStreetMap (ODbL)", en: "OpenStreetMap administrative boundary (ODbL)" },
  },
  approximate: {
    label: { th: "ขอบเขตโดยประมาณ (สาธิต)", en: "Approximate shape (demo)" },
    help: { th: "รูปร่างโดยประมาณเพื่อการสาธิต ไม่ใช่ขอบเขตทางการ", en: "Illustrative partition for demonstration — not an official boundary" },
  },
};

/** Reduced motion (OS or Settings) and whether decorative effects are allowed. */
export function useMotionPrefs() {
  const reduced = useReducedMotionPref();
  const effectsEnabled = useDashboard((s) => s.effectsEnabled);
  return { reduced, effects: effectsEnabled && !reduced };
}

/* ------------------------------------------------------------------ */
/*  Metric tiles                                                       */
/* ------------------------------------------------------------------ */

export function MetricTile({
  label,
  metric,
  decimals = 0,
  hint,
  children,
  className,
  compact = false,
}: {
  label: string;
  metric: MetricValue | null | undefined;
  decimals?: number;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const status = metric?.provenance.status ?? "unavailable";
  return (
    <div role="group" aria-label={label} className={cn("flex min-w-0 flex-col gap-1 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5", className)}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] leading-4 text-ui-text-2">{label}</span>
        <StatusBadge status={status} size="xs" className="shrink-0" />
      </div>
      <MetricReadout metric={metric} decimals={decimals} valueClassName={cn("proportional-nums [font-feature-settings:normal] font-semibold text-ui-text", compact ? "text-[15px]" : "text-[19px]")} />
      {hint && <span className="text-[10.5px] leading-4 text-ui-text-2">{hint}</span>}
      {children}
    </div>
  );
}

export interface MetricGridItem {
  key: string;
  label: string;
  metric: MetricValue | null | undefined;
  decimals?: number;
  hint?: ReactNode;
  extra?: ReactNode;
}

export function MetricGrid({ items, className, compact }: { items: MetricGridItem[]; className?: string; compact?: boolean }) {
  return (
    <div className={cn("grid grid-cols-2 gap-2", className)}>
      {items.map((it) => (
        <MetricTile key={it.key} label={it.label} metric={it.metric} decimals={it.decimals} hint={it.hint} compact={compact}>
          {it.extra}
        </MetricTile>
      ))}
    </div>
  );
}

/** Area value vs a reference (city average) on a shared 0–max track. Decorative; values are printed by the caller. */
export function MiniCompareBar({ value, reference, max, color = "var(--ui-cyan)", className }: { value: number | null; reference: number | null; max: number | null; color?: string; className?: string }) {
  if (max === null || max <= 0) return null;
  const pv = value === null ? null : Math.min(1, Math.max(0, value / max));
  const pr = reference === null ? null : Math.min(1, Math.max(0, reference / max));
  return (
    <div aria-hidden className={cn("relative h-1.5 w-full rounded-full bg-ui-border/60", className)}>
      {pv !== null && (
        <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--motion-scenario) ease-(--ease-out-expo)" style={{ width: `${pv * 100}%`, background: color }} />
      )}
      {pr !== null && <div className="absolute -top-1 h-3.5 w-0.5 rounded-full bg-ui-text" style={{ left: `calc(${pr * 100}% - 1px)` }} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Chips                                                              */
/* ------------------------------------------------------------------ */

export function RiskChip({ cls, score, className }: { cls: RiskClass | null; score?: number | null; className?: string }) {
  const t = useTr();
  const lang = useLang();
  if (!cls) {
    return <span className={cn("inline-flex items-center gap-1 rounded-full border border-ui-border px-2 py-0.5 text-[11px] text-ui-text-2", className)}>{t({ th: "ยังไม่มีข้อมูล", en: "Unavailable" })}</span>;
  }
  const c = RISK_CLASSES.find((r) => r.id === cls)!;
  const color = RISK_CLASS_COLORS[cls];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium text-ui-text", className)}
      style={{ borderColor: `color-mix(in srgb, ${color} 50%, transparent)`, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: color }} />
      {t(c)}
      {score !== undefined && score !== null && <span className="ui-num text-ui-text-2">{formatNumber(score, lang, 1)}</span>}
    </span>
  );
}

/** Signed change with arrow glyph (never colour alone). */
export function DeltaText({ delta, decimals = 1, suffix = "", higherIsWorse = true, label, className }: { delta: number | null; decimals?: number; suffix?: string; higherIsWorse?: boolean; label?: string; className?: string }) {
  const lang = useLang();
  const t = useTr();
  if (delta === null || !Number.isFinite(delta)) return <span className={cn("text-[11px] text-ui-text-2", className)}>—</span>;
  const flat = Math.abs(delta) < 10 ** -decimals / 2;
  const up = delta > 0;
  const worse = !flat && (up === higherIsWorse);
  const glyph = flat ? "=" : up ? "▲" : "▼";
  const text = `${flat ? "" : up ? "+" : "−"}${formatNumber(Math.abs(delta), lang, decimals)}${suffix}`;
  return (
    <span
      className={cn("ui-num inline-flex items-center gap-1 text-[11px]", flat ? "text-ui-text-2" : worse ? "text-[var(--risk-high)]" : "text-[var(--risk-low)]", className)}
      aria-label={`${label ?? t({ th: "เปลี่ยนแปลง", en: "Change" })} ${text}`}
    >
      <span aria-hidden className="text-[9px]">
        {glyph}
      </span>
      {text}
      {label && <span className="text-ui-text-2">{label}</span>}
    </span>
  );
}

export function GeometryBadge({ status, className }: { status: GeometryStatus; className?: string }) {
  const t = useTr();
  const g = GEOMETRY[status] ?? GEOMETRY.approximate;
  const Icon = status === "official" ? ShieldCheck : status === "osm" ? MapPinned : Shapes;
  return (
    <span
      title={t(g.help)}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium",
        status === "approximate" ? "border-[color-mix(in_srgb,var(--ui-orange)_45%,transparent)] bg-[color-mix(in_srgb,var(--ui-orange)_10%,transparent)] text-[var(--ui-orange)]" : "border-ui-border-strong text-ui-text-2",
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {t(g.label)}
    </span>
  );
}

export function geometryHelp(status: GeometryStatus): Bi {
  return (GEOMETRY[status] ?? GEOMETRY.approximate).help;
}

/* ------------------------------------------------------------------ */
/*  Layout primitives                                                  */
/* ------------------------------------------------------------------ */

/**
 * Titled panel section. `id` is a readable prefix only — a per-instance suffix keeps heading ids unique even when
 * the same panel is mounted twice (e.g. desktop column + mobile sheet).
 */
export function PanelSection({ title, eyebrow, actions, children, className, id }: { title?: string; eyebrow?: string; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const headingId = title ? `${id ?? "section"}-${uid}` : undefined;
  return (
    <section className={cn("flex flex-col gap-3 border-t border-ui-border/70 px-4 py-4 first:border-t-0", className)} aria-labelledby={headingId}>
      {(title || eyebrow || actions) && (
        <header className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            {eyebrow && <div className="ui-eyebrow mb-0.5">{eyebrow}</div>}
            {title && (
              <h3 id={headingId} className="text-[13.5px] font-semibold leading-5 text-ui-text">
                {title}
              </h3>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PanelNote({ tone = "info", children, className }: { tone?: "info" | "warn" | "sim"; children: ReactNode; className?: string }) {
  const Icon = tone === "warn" ? AlertTriangle : Info;
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-[1.55]",
        tone === "warn" && "border-[color-mix(in_srgb,var(--ui-orange)_35%,transparent)] bg-[color-mix(in_srgb,var(--ui-orange)_7%,transparent)] text-ui-text",
        tone === "info" && "border-ui-border bg-ui-bg-deep/40 text-ui-text-2",
        tone === "sim" && "ui-sim-stripes border-[color-mix(in_srgb,var(--status-simulated)_35%,transparent)] text-ui-text",
        className,
      )}
    >
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone === "warn" ? "text-[var(--ui-orange)]" : tone === "sim" ? "text-status-simulated" : "text-ui-text-2")} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** "Source: name ↗" line from a provenance record (link only when a URL exists). */
export function SourceLine({ provenance, className, fallbackUrl }: { provenance: DataProvenance | undefined; className?: string; fallbackUrl?: string }) {
  const t = useTr();
  if (!provenance?.sourceName && !provenance?.sourceId) return null;
  const name = provenance.sourceName ?? provenance.sourceId!;
  const url = provenance.sourceUrl ?? fallbackUrl;
  return (
    <div className={cn("text-[10.5px] leading-4 text-ui-text-2", className)}>
      {t({ th: "แหล่งข้อมูล", en: "Source" })}:{" "}
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-ui-text underline decoration-ui-border-strong underline-offset-2 hover:decoration-ui-cyan">
          {name}
          <ExternalLink className="size-2.5" aria-hidden />
          <span className="sr-only">{t({ th: "(เปิดในแท็บใหม่)", en: "(opens in a new tab)" })}</span>
        </a>
      ) : (
        <span className="text-ui-text">{name}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tabs with a shared-layout underline                                */
/* ------------------------------------------------------------------ */

export interface PanelTab<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

/**
 * WAI-ARIA tablist (automatic activation, roving tabindex, ←/→/Home/End) with a Motion `layoutId`
 * underline that glides between tabs. Scoped by `LayoutGroup` so two instances never share the indicator.
 */
export function PanelTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  idBase,
  className,
  dense = false,
}: {
  tabs: PanelTab<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  idBase: string;
  className?: string;
  dense?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const reduced = useReducedMotionPref();

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onChange(tabs[n].id);
    refs.current[n]?.focus();
  };

  return (
    <LayoutGroup id={idBase}>
      <div role="tablist" aria-label={ariaLabel} className={cn("ui-scroll relative flex items-stretch gap-0.5 overflow-x-auto", className)}>
        {tabs.map((tab, i) => {
          const active = tab.id === value;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${idBase}-tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`${idBase}-panel`}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                "relative inline-flex shrink-0 items-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-(--motion-fast) focus-visible:outline-offset-[-2px]",
                dense ? "h-8 px-2.5 text-[12px]" : "h-9 px-2.5 text-[12.5px]",
                active ? "text-ui-text" : "text-ui-text-2 hover:bg-ui-elevated/60 hover:text-ui-text",
              )}
            >
              {tab.icon}
              {tab.label}
              {active && (
                <motion.span
                  layoutId="panel-tab-underline"
                  aria-hidden
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-ui-cyan"
                  transition={reduced ? { duration: 0 } : SPRING.snappy}
                />
              )}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

export function tabPanelProps(idBase: string, value: string) {
  return { role: "tabpanel" as const, id: `${idBase}-panel`, "aria-labelledby": `${idBase}-tab-${value}`, tabIndex: 0 };
}

/* ------------------------------------------------------------------ */
/*  Skeletons & states                                                 */
/* ------------------------------------------------------------------ */

export function PanelSkeleton({ label }: { label?: string }) {
  const t = useTr();
  return (
    <div className="flex flex-col gap-4 p-4" role="status" aria-live="polite">
      <span className="sr-only">{label ?? t({ th: "กำลังโหลดข้อมูล…", en: "Loading data…" })}</span>
      <div className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-2.5 w-24 bg-ui-elevated" />
        <Skeleton className="h-6 w-48 bg-ui-elevated" />
        <Skeleton className="h-3 w-36 bg-ui-elevated/70" />
      </div>
      <div className="grid grid-cols-2 gap-2" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[74px] rounded-lg bg-ui-elevated/60" />
        ))}
      </div>
      <Skeleton className="h-40 rounded-lg bg-ui-elevated/50" aria-hidden />
      <Skeleton className="h-28 rounded-lg bg-ui-elevated/40" aria-hidden />
    </div>
  );
}

export function UnavailableBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const t = useTr();
  return (
    <div role="note" className={cn("rounded-lg border border-dashed border-ui-border px-3 py-3 text-center text-[11.5px] text-ui-text-2", className)}>
      <span aria-hidden className="mr-1.5">
        ○
      </span>
      {children ?? t({ th: "ยังไม่มีข้อมูล", en: "Unavailable" })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Waste generated vs collected                                       */
/* ------------------------------------------------------------------ */

const WM = {
  generated: { th: "ขยะที่เกิดขึ้น", en: "Waste generated" },
  collected: { th: "ขยะที่จัดเก็บได้", en: "Waste collected" },
  aria: { th: "เปรียบเทียบขยะที่เกิดขึ้นกับขยะที่จัดเก็บได้", en: "Waste generated compared with waste collected" },
  scope: { th: "ขอบเขต", en: "Scope" },
  ratio: { th: "จัดเก็บได้ {p}% ของขยะที่เกิดขึ้น", en: "Collected {p}% of waste generated" },
  ratioMethod: { th: "ขยะที่จัดเก็บได้ ÷ ขยะที่เกิดขึ้น (ขอบเขตและปีเดียวกัน)", en: "Collected ÷ generated (same scope and year)" },
  noRatioEst: {
    th: "ไม่คำนวณสัดส่วนการจัดเก็บ เพราะมีค่าประมาณการ (เช่น การกระจายค่าระดับเมืองลงรายพื้นที่) ซึ่งจะทำให้สัดส่วนดูเหมือนข้อมูลจริง",
    en: "No collection ratio: at least one value is an estimate (e.g. a citywide figure allocated to areas), which would make the ratio look measured",
  },
  noRatioScope: { th: "ไม่คำนวณสัดส่วน เพราะขอบเขตหรือปีอ้างอิงของสองค่าไม่ตรงกัน", en: "No ratio: the two values differ in scope or reference year" },
  definitions: {
    th: "ขยะที่เกิดขึ้น = ปริมาณที่ประชากรและกิจกรรมสร้างขึ้น · ขยะที่จัดเก็บได้ = ปริมาณที่ระบบเก็บขนได้จริง ทั้งสองค่าไม่ใช่สิ่งเดียวกัน",
    en: "Generated = what residents and activities produce · Collected = what the collection service actually picks up. They are different measures.",
  },
} satisfies Record<string, Bi>;

const okM = (m: MetricValue | null | undefined): m is MetricValue & { value: number } => !!m && m.value !== null && Number.isFinite(m.value) && m.provenance.status !== "unavailable";

/**
 * Both waste measures side by side — never merged into one number. Each keeps its own status and scope;
 * a collection ratio is shown only when both are measured (observed/derived) for the same scope and year.
 */
export function WasteMeasures({ generated, collected, decimals = 1, className, showDefinitions = false }: { generated: MetricValue | null | undefined; collected: MetricValue | null | undefined; decimals?: number; className?: string; showDefinitions?: boolean }) {
  const t = useTr();
  const lang = useLang();
  const g = okM(generated) ? generated : null;
  const c = okM(collected) ? collected : null;
  const max = Math.max(g?.value ?? 0, c?.value ?? 0);
  const measured = (m: MetricValue) => m.provenance.status === "observed" || m.provenance.status === "derived";
  const sameScope =
    !!g &&
    !!c &&
    (g.provenance.geographicScope ?? "") === (c.provenance.geographicScope ?? "") &&
    (!g.provenance.referenceYear || !c.provenance.referenceYear || g.provenance.referenceYear === c.provenance.referenceYear);
  const ratio = g && c && g.value > 0 && measured(g) && measured(c) && sameScope ? (c.value / g.value) * 100 : null;
  const why = g && c && ratio === null ? (!measured(g) || !measured(c) ? WM.noRatioEst : WM.noRatioScope) : null;
  const rows = [
    { key: "generated", label: t(WM.generated), m: generated, v: g, color: "#2fbf9a" },
    { key: "collected", label: t(WM.collected), m: collected, v: c, color: "#25d9f2" },
  ];
  const scopes = [...new Set(rows.map((r) => r.m?.provenance.geographicScope).filter((x): x is string => !!x))];
  return (
    <div className={cn("flex flex-col gap-2", className)} role="group" aria-label={t(WM.aria)}>
      <div className="grid grid-cols-2 gap-2">
        {rows.map((r) => {
          const status = r.m?.provenance.status ?? "unavailable";
          const est = status === "estimated" || status === "simulated";
          return (
            <div key={r.key} className="flex min-w-0 flex-col gap-1 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2.5" role="group" aria-label={r.label}>
              <div className="flex items-start justify-between gap-2">
                <span className="text-[11px] leading-4 text-ui-text-2">{r.label}</span>
                <StatusBadge status={status} size="xs" className="shrink-0" />
              </div>
              <MetricReadout metric={r.m} decimals={decimals} valueClassName="proportional-nums [font-feature-settings:normal] text-[19px] font-semibold text-ui-text" />
              <div aria-hidden className="relative mt-0.5 h-1.5 w-full rounded-full bg-ui-border/50">
                {r.v && max > 0 && (
                  <div
                    className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--motion-scenario) ease-(--ease-out-expo)", est && "opacity-60")}
                    style={{
                      width: `${(r.v.value / max) * 100}%`,
                      background: est ? `repeating-linear-gradient(-45deg, ${r.color} 0 3px, transparent 3px 5px)` : r.color,
                      boxShadow: est ? `inset 0 0 0 1px ${r.color}` : undefined,
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {ratio !== null && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ui-text-2">
          <StatusBadge status="derived" size="xs" />
          <span className="text-ui-text">{t(WM.ratio).replace("{p}", formatNumber(ratio, lang, 1))}</span>
          <span className="text-[10.5px]">({t(WM.ratioMethod)})</span>
        </div>
      )}
      {why && <p className="text-[10.5px] leading-4 text-ui-text-2">{t(why)}</p>}
      {scopes.length > 0 && (
        <p className="text-[10.5px] leading-4 text-ui-text-2">
          <span className="text-ui-text">{t(WM.scope)}:</span>{" "}
          {scopes.length === 1
            ? scopes[0]
            : rows
                .filter((r) => r.m?.provenance.geographicScope)
                .map((r) => `${r.label} — ${r.m!.provenance.geographicScope}`)
                .join(" · ")}
        </p>
      )}
      {showDefinitions && <p className="text-[10.5px] leading-4 text-ui-text-3">{t(WM.definitions)}</p>}
    </div>
  );
}
