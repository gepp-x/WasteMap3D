import { cn } from "@/lib/utils";
import geppLogo from "@/assets/gepp-logo.png";

/**
 * GEPP brand mark (the GEPP recycling-bin "G" logo), rendered from the bundled PNG.
 * Static import so the URL is fingerprinted and respects any basePath in static exports.
 */
export function BrandMark({ size = 30, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny static brand asset; next/image adds no value here
    <img
      src={geppLogo.src}
      width={Math.round(size * (geppLogo.width / geppLogo.height))}
      height={size}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0 object-contain", className)}
      draggable={false}
    />
  );
}
