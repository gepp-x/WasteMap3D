/**
 * MapLibre GL 6 derives its worker URL at runtime from `import.meta.url` of its own bundle.
 * Next/Turbopack rewrites `import.meta.url` to a `file:` URL, so MapLibre falls back to "" and the
 * module worker fails to load (it fetches the page HTML). Reference the worker file statically so the
 * bundler emits it as a hashed static asset, and hand that URL to `setWorkerUrl()` before the first map.
 */
export function maplibreWorkerUrl(): string {
  return new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href;
}
