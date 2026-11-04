import { cn } from "@/lib/utils";

/**
 * Urban Intelligence glyph — an isometric survey plate with a 3 × 3 measurement grid and an
 * observation point, resting on two stacked contour strata (waste ↔ water layers).
 * Pure inline SVG, currentColor-free so it renders identically in every context.
 */
export function BrandMark({ size = 30, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {/* plate fill */}
      <path d="M16 4 28 11 16 18 4 11Z" fill="var(--ui-cyan)" fillOpacity={0.08} />
      {/* measurement grid */}
      <g stroke="var(--ui-cyan)" strokeOpacity={0.45} strokeWidth={0.7} strokeLinecap="round">
        <path d="M8 8.667 20 15.667" />
        <path d="M12 6.333 24 13.333" />
        <path d="M8 13.333 20 6.333" />
        <path d="M12 15.667 24 8.667" />
      </g>
      {/* plate outline */}
      <path d="M16 4 28 11 16 18 4 11Z" stroke="var(--ui-cyan)" strokeWidth={1.4} strokeLinejoin="round" />
      {/* contour strata */}
      <path d="M4 15.5 16 22.5 28 15.5" stroke="var(--ui-cyan)" strokeOpacity={0.7} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 20 16 27 28 20" stroke="var(--ui-teal)" strokeOpacity={0.45} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
      {/* observation point */}
      <circle cx={16} cy={8.667} r={1.7} fill="var(--ui-cyan)" />
      <circle cx={16} cy={8.667} r={3.1} stroke="var(--ui-cyan)" strokeOpacity={0.35} strokeWidth={0.7} />
    </svg>
  );
}
