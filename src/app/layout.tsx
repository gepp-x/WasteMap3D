import type { Metadata, Viewport } from "next";
import "@fontsource/ibm-plex-sans-thai/300.css";
import "@fontsource/ibm-plex-sans-thai/400.css";
import "@fontsource/ibm-plex-sans-thai/500.css";
import "@fontsource/ibm-plex-sans-thai/600.css";
import "@fontsource/ibm-plex-sans-thai/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource-variable/inter/index.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "GEPP Urban Intelligence — Waste & Flood Observatory",
  description:
    "Explore relationships between municipal waste, population, rainfall, drainage and flood exposure in Bangkok and Hat Yai. Scenario outputs are illustrative simulations, not official forecasts.",
  applicationName: "GEPP Urban Intelligence",
};

export const viewport: Viewport = {
  themeColor: "#06111e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th" className="dark h-full" suppressHydrationWarning>
      <body className="h-full overflow-hidden bg-ui-bg text-ui-text antialiased">
        <TooltipProvider delay={250}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
