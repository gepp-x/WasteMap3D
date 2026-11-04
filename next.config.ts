import type { NextConfig } from "next";

/**
 * Static export: the dashboard is one prerendered page plus bundled data in public/data, so it can be
 * hosted on any static host. NEXT_PUBLIC_BASE_PATH sets the sub-path for project sites such as
 * GitHub Pages (https://<org>.github.io/WasteMap3D → "/WasteMap3D"); leave it unset for local use.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  images: { unoptimized: true },
  trailingSlash: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
