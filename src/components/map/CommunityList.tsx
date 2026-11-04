"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useLang, useTr } from "@/lib/i18n";
import { formatNumber } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { COMMUNITY_TEXT, useCommunityFocus, type CommunityModel } from "@/lib/map/communities";

const S = {
  count: { th: "{n} ชุมชน", en: "{n} communities" },
  sums: { th: "รวมตามประกาศ", en: "Published totals" },
  sumNote: {
    th: "ผลรวมของตัวเลขที่พิมพ์ในประกาศแนวเขตชุมชน (นับเฉพาะชุมชนที่มีตัวเลข) ประกาศไม่ระบุวันอ้างอิงของการนับ",
    en: "Sum of the figures printed in the community-boundary announcements (communities with a figure only); the announcements do not state the count date",
  },
  filter: { th: "ค้นหาชุมชนในเขตนี้", en: "Search communities in this zone" },
  noMatch: { th: "ไม่พบชุมชนที่ตรงกับคำค้น", en: "No community matches" },
  showAll: { th: "แสดงทั้งหมด ({n})", en: "Show all ({n})" },
  showLess: { th: "แสดงน้อยลง", en: "Show fewer" },
  hh: { th: "ครัวเรือน", en: "hh" },
  pp: { th: "คน", en: "people" },
  list: { th: "รายชื่อชุมชน", en: "Community list" },
  placementNote: {
    th: "ชุมชนที่มีเครื่องหมายเส้นประบนแผนที่ใช้ตำแหน่งสาธิตภายในเขตของตัวเอง ไม่ใช่พิกัดจริง รายชื่อและตัวเลขเป็นข้อมูลตามประกาศ",
    en: "Dashed markers on the map are illustrative placements inside the community's own zone, not real locations. Names and figures are as published.",
  },
  noLocation: { th: "ไม่มีตำแหน่ง", en: "No location" },
};

const PAGE = 8;

/** Communities of one Hat Yai zone: official list with verified / illustrative location badges and published figures. */
export function CommunityList({ model, zoneId, className }: { model: CommunityModel; zoneId: string; className?: string }) {
  const t = useTr();
  const lang = useLang();
  const focusId = useCommunityFocus((s) => s.id);
  const focusNonce = useCommunityFocus((s) => s.nonce);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const list = useMemo(() => model.byZone.get(zoneId) ?? [], [model, zoneId]);
  const sums = useMemo(() => {
    let hh = 0,
      nh = 0,
      pp = 0,
      np = 0;
    for (const c of list) {
      if (c.households !== null) {
        hh += c.households;
        nh++;
      }
      if (c.population !== null) {
        pp += c.population;
        np++;
      }
    }
    return { hh: nh ? hh : null, pp: np ? pp : null, nh, np };
  }, [list]);
  const verified = list.filter((c) => c.locationStatus === "verified" && c.point).length;
  const illustrative = list.filter((c) => c.locationStatus === "illustrative" && c.point).length;

  const needle = q.trim().toLowerCase();
  const filtered = needle ? list.filter((c) => c.nameTh.toLowerCase().includes(needle) || (c.nameEn ?? "").toLowerCase().includes(needle)) : list;
  const focusInList = !!focusId && filtered.some((c) => c.id === focusId);
  const focusIdx = focusInList ? filtered.findIndex((c) => c.id === focusId) : -1;
  // A community picked on the map is always visible, even beyond the first page.
  const expanded = all || needle !== "" || focusIdx >= PAGE;
  const shown = expanded ? filtered : filtered.slice(0, PAGE);

  useEffect(() => {
    if (!focusId) return;
    const el = rowRefs.current.get(focusId);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusId, focusNonce, shown.length]);

  if (!list.length) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ui-text-2">
        <span className="font-medium text-ui-text">{t(S.count).replace("{n}", formatNumber(list.length, lang))}</span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block size-2 rounded-full bg-[#c7b8ff]" />
          {t(COMMUNITY_TEXT.verifiedShort)} <span className="ui-num text-ui-text">{formatNumber(verified, lang)}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block size-2.5 rounded-full border border-dashed border-[#b9a9f5]" />
          {t(COMMUNITY_TEXT.illustrativeShort)} <span className="ui-num text-ui-text">{formatNumber(illustrative, lang)}</span>
        </span>
      </div>

      {(sums.hh !== null || sums.pp !== null) && (
        <div className="grid grid-cols-2 gap-2">
          {[
            { k: "hh", label: t(COMMUNITY_TEXT.households), v: sums.hh, n: sums.nh },
            { k: "pp", label: t(COMMUNITY_TEXT.population), v: sums.pp, n: sums.np },
          ].map((x) => (
            <div key={x.k} className="flex flex-col gap-0.5 rounded-lg border border-ui-border/70 bg-ui-bg-deep/35 px-3 py-2" role="group" aria-label={`${t(S.sums)} — ${x.label}`}>
              <span className="flex items-start justify-between gap-1 text-[10.5px] text-ui-text-2">
                {t(S.sums)} · {x.label}
                <StatusBadge status="derived" size="xs" />
              </span>
              <span className="ui-num text-[16px] font-semibold text-ui-text">{x.v === null ? "—" : formatNumber(x.v, lang)}</span>
              <span className="text-[10px] text-ui-text-3">
                {formatNumber(x.n, lang)}/{formatNumber(list.length, lang)}
              </span>
            </div>
          ))}
          <p className="col-span-2 text-[10px] leading-4 text-ui-text-3">{t(S.sumNote)}</p>
        </div>
      )}

      {list.length > PAGE && (
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-ui-text-3" aria-hidden />
          <span className="sr-only">{t(S.filter)}</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t(S.filter)}
            className="h-7 w-full rounded-md border border-ui-border bg-ui-bg-deep/40 pr-2 pl-7 text-[12px] text-ui-text placeholder:text-ui-text-3 focus-visible:border-ui-cyan/60 focus-visible:outline-none"
          />
        </label>
      )}

      {filtered.length === 0 ? (
        <p className="py-2 text-center text-[11px] text-ui-text-2">{t(S.noMatch)}</p>
      ) : (
        <ol className="flex flex-col" aria-label={t(S.list)}>
          {shown.map((c) => {
            const focused = c.id === focusId;
            const illus = c.locationStatus === "illustrative";
            return (
              <li
                key={c.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(c.id, el);
                  else rowRefs.current.delete(c.id);
                }}
                aria-current={focused ? "true" : undefined}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 border-b border-ui-border/50 px-1.5 py-1.5 transition-colors duration-(--motion-ui)",
                  focused && "rounded-md border-transparent bg-[color-mix(in_srgb,var(--ui-cyan)_12%,transparent)]",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn("inline-block shrink-0 rounded-full", !c.point ? "size-2 bg-ui-border" : illus ? "size-2.5 border border-dashed border-[#b9a9f5]" : "size-2 bg-[#c7b8ff]")}
                  />
                  <span lang="th" className="truncate text-[12px] text-ui-text">
                    {c.nameTh}
                  </span>
                </span>
                <span className="ui-num text-right text-[11px] text-ui-text-2">
                  {c.households !== null && (
                    <>
                      {formatNumber(c.households, lang)} <span className="text-[10px]">{t(S.hh)}</span>
                    </>
                  )}
                  {c.households !== null && c.population !== null && <span aria-hidden> · </span>}
                  {c.population !== null && (
                    <>
                      {formatNumber(c.population, lang)} <span className="text-[10px]">{t(S.pp)}</span>
                    </>
                  )}
                </span>
                <span className={cn("col-span-2 pl-3.5 text-[10px]", illus ? "text-ui-text-2" : "text-ui-text-3")}>
                  {!c.point ? t(S.noLocation) : illus ? t(COMMUNITY_TEXT.illustrative) : t(COMMUNITY_TEXT.verified)}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {!needle && filtered.length > PAGE && focusIdx < PAGE && (
        <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} className="self-start rounded-md px-1.5 py-1 text-[11px] font-medium text-ui-cyan hover:bg-ui-elevated/60">
          {all ? t(S.showLess) : t(S.showAll).replace("{n}", formatNumber(filtered.length, lang))}
        </button>
      )}
      <p className="text-[10.5px] leading-4 text-ui-text-2">{t(S.placementNote)}</p>
    </div>
  );
}
