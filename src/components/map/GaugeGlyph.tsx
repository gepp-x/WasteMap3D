import { cn } from "@/lib/utils";
import { GAUGE_CLASS, type GaugeClass } from "@/lib/map/water-levels";

/** SVG twin of the map's water-level gauge icon (icons.ts drawGaugeGlyph) for legends, tables and chips. */
export function GaugeGlyph({ cls, className }: { cls: GaugeClass; className?: string }) {
  const def = GAUGE_CLASS[cls];
  const hollow = cls === "unknown";
  return (
    <svg aria-hidden viewBox="0 0 20 24" className={cn("h-[15px] w-[12.5px] shrink-0", className)}>
      <path
        d="M5.6 1.6h8.8a4 4 0 0 1 4 4V15a4 4 0 0 1-4 4H13l-3 4-3-4H5.6a4 4 0 0 1-4-4V5.6a4 4 0 0 1 4-4Z"
        fill={hollow ? "#08192a" : def.color}
        stroke={hollow ? def.color : "#06111e"}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M6 4.8h8L10 9.4Z" fill={hollow ? def.color : "#06111e"} />
      <path d="M4.6 11.8h10.8M6.4 14.6h7.2" stroke={hollow ? def.color : "#06111e"} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

