/**
 * Hat Yai communities (public/data/hatyai/communities.geojson, `CommunityProps`).
 *
 * The community *list* (names, zone, published households / population) is official. Locations are
 * split by `locationStatus`:
 *   verified      — matched to an authoritative or OpenStreetMap feature → drawn solid;
 *   illustrative  — a deterministic demonstration placement inside the community's own zone →
 *                   drawn as a dashed ring and always labelled "not a real location".
 * Features without `locationStatus` (older pipeline output) count as verified only when they carry
 * explicit match evidence (an OSM id or an osm/official geometry status); otherwise illustrative.
 */
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { create } from "zustand";
import type { CommunityProps } from "@/lib/types";
import type { Bi } from "@/lib/i18n";

export interface CommunityItem {
  index: number;
  id: string;
  nameTh: string;
  nameEn: string | null;
  zoneId: string | null;
  zoneNo: number | null;
  locationStatus: CommunityProps["locationStatus"];
  method: string | null;
  households: number | null;
  population: number | null;
  sourceId: string | null;
  /** [lon, lat] when the feature has a point (or a representative point of its polygon). */
  point: [number, number] | null;
}

export interface CommunityModel {
  fc: FeatureCollection;
  items: CommunityItem[];
  byZone: Map<string, CommunityItem[]>;
  verified: number;
  illustrative: number;
  /** Communities listed without any geometry (never drawn). */
  unplaced: number;
}

export const COMMUNITY_TEXT = {
  illustrative: {
    th: "ตำแหน่งสาธิต ไม่ใช่พิกัดจริง",
    en: "Illustrative placement — not a real location",
  },
  verified: { th: "ตำแหน่งยืนยันแล้ว", en: "Verified location" },
  verifiedShort: { th: "ยืนยันแล้ว", en: "Verified" },
  illustrativeShort: { th: "ตำแหน่งสาธิต", en: "Illustrative" },
  community: { th: "ชุมชน", en: "Community" },
  zone: { th: "เขต {n}", en: "Zone {n}" },
  households: { th: "ครัวเรือน", en: "Households" },
  population: { th: "ประชากร", en: "Population" },
  published: { th: "ตามประกาศของเทศบาล", en: "As published by the municipality" },
} satisfies Record<string, Bi>;

type Props = Record<string, unknown>;

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

function pointOf(g: Geometry | null | undefined): [number, number] | null {
  if (!g) return null;
  if (g.type === "Point") return [g.coordinates[0], g.coordinates[1]];
  if (g.type === "MultiPoint" && g.coordinates[0]) return [g.coordinates[0][0], g.coordinates[0][1]];
  if (g.type === "Polygon" || g.type === "MultiPolygon") {
    let w = Infinity,
      so = Infinity,
      e = -Infinity,
      no = -Infinity;
    const rings = g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
    for (const r of rings)
      for (const [x, y] of r) {
        w = Math.min(w, x);
        e = Math.max(e, x);
        so = Math.min(so, y);
        no = Math.max(no, y);
      }
    return Number.isFinite(w) ? [(w + e) / 2, (so + no) / 2] : null;
  }
  return null;
}

function locationStatusOf(p: Props): CommunityProps["locationStatus"] {
  const ls = s(p.locationStatus);
  if (ls === "verified" || ls === "illustrative") return ls;
  const geom = s(p.geometryStatus);
  return s(p.osmId) || geom === "osm" || geom === "official" ? "verified" : "illustrative";
}

export function normalizeCommunities(src: FeatureCollection | null | undefined): CommunityModel | null {
  if (!src || !Array.isArray(src.features)) return null;
  const items: CommunityItem[] = [];
  const features: Feature[] = [];
  const byZone = new Map<string, CommunityItem[]>();
  let verified = 0,
    illustrative = 0,
    unplaced = 0;
  for (const f of src.features) {
    const p = (f?.properties ?? {}) as Props;
    const nameTh = s(p.nameTh) ?? s(p.name) ?? s(p["name:th"]);
    if (!nameTh) continue;
    const index = items.length;
    const zoneNo = n(p.zoneNo);
    const zoneId = s(p.zoneId) ?? (zoneNo !== null ? `hy-z${zoneNo}` : null);
    const locationStatus = locationStatusOf(p);
    const point = pointOf(f.geometry);
    const it: CommunityItem = {
      index,
      id: s(p.id) ?? `community-${index}`,
      nameTh,
      nameEn: s(p.nameEn) ?? s(p["name:en"]),
      zoneId,
      zoneNo,
      locationStatus,
      method: s(p.method) ?? s(p.matchMethod) ?? s(p.locationKind),
      households: n(p.households),
      population: n(p.population),
      sourceId: s(p.sourceId),
      point,
    };
    items.push(it);
    if (zoneId) {
      const list = byZone.get(zoneId);
      if (list) list.push(it);
      else byZone.set(zoneId, [it]);
    }
    if (!f.geometry || !point) {
      unplaced++;
      continue;
    }
    if (locationStatus === "verified") verified++;
    else illustrative++;
    const isArea = f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon";
    // Polygons keep their outline; every community also gets a point symbol so it can be hovered / clicked.
    if (isArea) features.push({ type: "Feature", properties: { _i: index, _g: "area", _v: locationStatus === "verified" ? 1 : 0, _z: zoneId ?? "" }, geometry: f.geometry });
    features.push({
      type: "Feature",
      properties: { _i: index, _g: "point", _v: locationStatus === "verified" ? 1 : 0, _z: zoneId ?? "" },
      geometry: { type: "Point", coordinates: point },
    });
  }
  for (const list of byZone.values()) list.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return { fc: { type: "FeatureCollection", features }, items, byZone, verified, illustrative, unplaced };
}

/** Community picked on the map, so the details panel can highlight and scroll to it. Module-local UI state. */
export const useCommunityFocus = create<{ id: string | null; nonce: number; focus: (id: string | null) => void }>()((set, get) => ({
  id: null,
  nonce: 0,
  focus: (id) => set({ id, nonce: get().nonce + 1 }),
}));
