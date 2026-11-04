/**
 * npm run data:fetch — run every public-data fetcher sequentially.
 *
 *   npm run data:fetch                 # network fetches (cache-first where the fetcher supports it)
 *   npm run data:fetch -- --offline    # rebuild every staged/public layer from cached raw files only
 *
 * Order: fetch-bangkok → fetch-hatyai → fetch-hatyai-community-locations → fetch-waste-gaps →
 * fetch-rainfall → fetch-osm-infra → fetch-hydrology → fetch-buildings bangkok → fetch-buildings hatyai.
 * fetch-hatyai-community-locations reads fetch-hatyai's staged community list and zones; fetch-waste-gaps
 * reads the BMA tables staged by fetch-bangkok; fetch-hydrology merges the official BMA drainage inventory
 * into the OSM drainage layer written by fetch-osm-infra and converts the staged hourly rain, so each must
 * run after its input step. Each step runs in its own process (tsx); a failing step is reported and
 * the remaining steps still run (later steps fall back to cached files). Exit code is non-zero when
 * any step failed. Afterwards run `npm run data:build && npm run data:validate`.
 *
 * Flags passed through to every fetcher: --offline. `--force` is passed to fetch-buildings only.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const force = args.includes("--force");
const pass = offline ? ["--offline"] : [];

const steps: { label: string; script: string; args: string[] }[] = [
  { label: "Bangkok boundaries, population, waste, flood points", script: "scripts/data/fetch-bangkok.ts", args: pass },
  { label: "Hat Yai municipality, communities, population, waste, flood", script: "scripts/data/fetch-hatyai.ts", args: pass },
  { label: "Hat Yai community points (verified OSM matches + labelled illustrative placement)", script: "scripts/data/fetch-hatyai-community-locations.ts", args: pass },
  { label: "Waste gaps (PCD generated, district composition, Hat Yai composition)", script: "scripts/data/fetch-waste-gaps.ts", args: pass },
  { label: "Rainfall (stations, ERA5 grids, normals, drainage capacity)", script: "scripts/data/fetch-rainfall.ts", args: pass },
  { label: "OSM waterways and drainage infrastructure", script: "scripts/data/fetch-osm-infra.ts", args: pass },
  { label: "Hydrology (water levels, BMA drainage inventory, flood history, hourly rain)", script: "scripts/data/fetch-hydrology.ts", args: pass },
  { label: "OSM building windows — Bangkok", script: "scripts/data/fetch-buildings.ts", args: ["bangkok", ...pass, ...(force ? ["--force"] : [])] },
  { label: "OSM building windows — Hat Yai", script: "scripts/data/fetch-buildings.ts", args: ["hatyai", ...pass, ...(force ? ["--force"] : [])] },
];

const tsxCli = require.resolve("tsx/cli");
const results: { label: string; status: number | null; seconds: number }[] = [];
for (const s of steps) {
  console.log(`\n=== ${s.label}\n    npx tsx ${s.script} ${s.args.join(" ")}`.trimEnd());
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [tsxCli, s.script, ...s.args], { cwd: ROOT, stdio: "inherit", env: process.env });
  results.push({ label: s.label, status: r.status, seconds: Math.round((Date.now() - t0) / 1000) });
}

console.log("\n=== data:fetch summary");
for (const r of results) console.log(`  ${r.status === 0 ? "ok  " : "FAIL"} ${r.label} (${r.seconds} s${r.status === 0 ? "" : `, exit ${r.status}`})`);
console.log("Next: npm run data:build && npm run data:validate");
if (results.some((r) => r.status !== 0)) process.exit(1);
