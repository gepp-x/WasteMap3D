"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { CloudRain, CloudRainWind, CloudSun, Layers, Trash2, type LucideIcon } from "lucide-react";
import { SCENARIO_PRESETS, type PresetId } from "@/lib/simulation/model";
import { useLang, useTr, type Bi } from "@/lib/i18n";
import { formatNumber } from "@/lib/formatters";
import { SPRING } from "@/lib/animation/tokens";
import { cn } from "@/lib/utils";

export const PRESET_ORDER: PresetId[] = ["normal", "heavyRain", "extremeRain", "drainageObstruction", "combinedStress"];

export const PRESET_ICONS: Record<PresetId, LucideIcon> = {
  normal: CloudSun,
  heavyRain: CloudRain,
  extremeRain: CloudRainWind,
  drainageObstruction: Trash2,
  combinedStress: Layers,
};

const S = {
  depth: { th: "ฝนรวม", en: "Depth" },
  active: { th: "กำลังใช้งาน", en: "Active" },
} satisfies Record<string, Bi>;

/**
 * Preset card. The active highlight is a shared-layout element (`layoutId`) so it glides between
 * cards when the preset changes; wrap the list in a <LayoutGroup id> to keep instances independent.
 */
export function PresetCard({ id, active, onSelect, highlightId = "scenario-preset-highlight" }: { id: PresetId; active: boolean; onSelect: (id: PresetId) => void; highlightId?: string }) {
  const t = useTr();
  const lang = useLang();
  const p = SCENARIO_PRESETS[id];
  const Icon = PRESET_ICONS[id];
  const name: Bi = { th: p.th, en: p.en };
  const desc: Bi = { th: p.descTh, en: p.descEn };
  const depth = p.params.rainIntensityMmH * p.params.rainDurationH;
  const other = lang === "th" ? p.en : p.th;
  const descId = `${useId()}-desc`;

  return (
    <motion.button
      type="button"
      onClick={() => onSelect(id)}
      aria-pressed={active}
      aria-describedby={descId}
      whileTap={{ scale: 0.985 }}
      transition={SPRING.snappy}
      className={cn(
        "group/preset relative flex w-full items-center gap-2.5 rounded-[10px] border px-2.5 py-2 text-left outline-none",
        "transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ui-cyan/60",
        active ? "border-transparent" : "border-ui-border/70 bg-ui-bg-deep/30 hover:border-ui-border-strong hover:bg-ui-elevated/50",
      )}
    >
      {active && (
        <motion.span
          layoutId={highlightId}
          aria-hidden
          className="absolute inset-0 rounded-[10px] border border-ui-cyan/45 bg-[linear-gradient(90deg,rgba(37,217,242,0.10),rgba(37,217,242,0.03))]"
          transition={SPRING.gentle}
        >
          <span className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-ui-cyan" />
        </motion.span>
      )}
      <span
        aria-hidden
        className={cn(
          "relative grid size-8 shrink-0 place-items-center rounded-lg border transition-colors",
          active ? "border-ui-cyan/40 bg-ui-cyan/10 text-ui-cyan" : "border-ui-border bg-ui-elevated/60 text-ui-text-2 group-hover/preset:text-ui-text",
        )}
      >
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[13px] font-medium text-ui-text">{t(name)}</span>
          <span className="hidden truncate text-[10.5px] text-ui-text-3 min-[340px]:inline">{other}</span>
        </span>
        <span id={descId} className="block truncate text-[11px] leading-4 text-ui-text-2" title={t(desc)}>
          {t(desc)}
        </span>
      </span>
      <span className="relative flex shrink-0 flex-col items-end leading-none">
        <span className="ui-num text-[13px] font-semibold text-ui-text">{formatNumber(depth, lang, 0)}</span>
        <span className="mt-0.5 text-[9.5px] text-ui-text-3">
          {t(S.depth)} {lang === "th" ? "มม." : "mm"}
        </span>
      </span>
      {active && <span className="sr-only">{t(S.active)}</span>}
    </motion.button>
  );
}
