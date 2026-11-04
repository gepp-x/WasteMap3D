"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, MapPin, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTr } from "@/lib/i18n";
import { useAreas, useCityBundle } from "@/lib/data/loader";
import type { AreaRecord } from "@/lib/types";
import { useDashboard } from "@/store/dashboard-store";
import { Kbd } from "@/components/dashboard/ViewModeSwitch";
import { shortcutKey } from "@/hooks/use-keyboard-shortcuts";

/* ------------------------------------------------------------------ */
/*  Focus requests ("/" shortcut, rail button)                         */
/* ------------------------------------------------------------------ */

const FOCUS_EVENT = "urban-intelligence:focus-search";
let pendingFocus = false;

/**
 * Ask the visible search box to take focus. If it is not mounted yet (collapsed rail, closed
 * drawer) the request is remembered and honoured as soon as one mounts.
 */
export function requestSearchFocus() {
  pendingFocus = true;
  window.dispatchEvent(new Event(FOCUS_EVENT));
}

/* ------------------------------------------------------------------ */
/*  Matching                                                           */
/* ------------------------------------------------------------------ */

const STRIP = /^(เขต|แขวง|อำเภอ|เทศบาล|khet\s+|district\s+)/i;
function norm(s: string | undefined) {
  return (s ?? "").normalize("NFC").toLowerCase().replace(STRIP, "").replace(/[\s\-_.]+/g, "");
}

function score(a: AreaRecord, q: string): number {
  if (!q) return 0;
  const fields = [norm(a.nameTh), norm(a.nameEn), norm(a.code), norm(a.id)];
  if (fields.some((f) => f === q)) return 100;
  if (fields.some((f) => f.startsWith(q))) return 60;
  if (fields.some((f) => f.includes(q))) return 30;
  return 0;
}

const MAX_RESULTS = 8;

/**
 * Area search — WAI-ARIA combobox with a listbox popup.
 * ↑/↓/Home/End move, Enter selects and focuses the map, Esc clears.
 */
export function SearchBox({ onSelect, className, autoFocus = false }: { onSelect?: (id: string) => void; className?: string; autoFocus?: boolean }) {
  const t = useTr();
  const lang = useDashboard((s) => s.lang);
  const cityId = useDashboard((s) => s.cityId);
  const selectedId = useDashboard((s) => s.selectedAreaId);
  const selectArea = useDashboard((s) => s.selectArea);
  const { status } = useCityBundle();
  const { list } = useAreas();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const q = norm(query);
  const results = useMemo(() => {
    if (!q) return [];
    return list
      .map((a) => ({ a, s: score(a, q) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || (lang === "th" ? x.a.nameTh.localeCompare(y.a.nameTh, "th") : x.a.nameEn.localeCompare(y.a.nameEn, "en")))
      .slice(0, MAX_RESULTS)
      .map((x) => x.a);
  }, [list, q, lang]);

  // honour focus requests ("/" shortcut, rail search button)
  useEffect(() => {
    const focusNow = () => {
      const el = inputRef.current;
      if (!el || el.offsetParent === null) return;
      pendingFocus = false;
      el.focus();
      el.select();
    };
    const raf = pendingFocus || autoFocus ? requestAnimationFrame(focusNow) : 0;
    window.addEventListener(FOCUS_EVENT, focusNow);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener(FOCUS_EVENT, focusNow);
    };
  }, [autoFocus]);

  const choose = (a: AreaRecord) => {
    selectArea(a.id, { focus: true });
    setQuery("");
    setOpen(false);
    setActive(0);
    onSelect?.(a.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (query || open) {
        e.stopPropagation();
        setQuery("");
        setOpen(false);
      } else {
        inputRef.current?.blur();
      }
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % results.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + results.length) % results.length);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(results.length - 1);
    else if (e.key === "Enter") choose(results[Math.min(active, results.length - 1)]);
    else return;
    e.preventDefault();
    setOpen(true);
  };

  const expanded = open && q.length > 0;
  const kindLabel = cityId === "hatyai" ? t({ th: "เขตชุมชน", en: "Community zone" }) : t({ th: "เขต", en: "District" });
  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div className={cn("relative", className)}>
      <label htmlFor={`${listId}-input`} className="sr-only">
        {t({ th: "ค้นหาพื้นที่ตามชื่อหรือรหัส", en: "Search areas by name or code" })}
      </label>
      <div className="group relative flex items-center">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 size-4 text-ui-text-3 transition-colors group-focus-within:text-ui-cyan" />
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded && results.length ? optionId(Math.min(active, results.length - 1)) : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder={
            status === "loading"
              ? t({ th: "กำลังโหลดรายชื่อพื้นที่…", en: "Loading areas…" })
              : cityId === "hatyai"
                ? t({ th: "ค้นหาเขตชุมชน…", en: "Search community zones…" })
                : t({ th: "ค้นหาเขต ชื่อ หรือรหัส…", en: "Search district, name or code…" })
          }
          className="h-9 w-full rounded-lg border border-ui-border bg-ui-bg-deep/70 pr-9 pl-8.5 text-[13px] text-ui-text transition-colors outline-none placeholder:text-ui-text-3 hover:border-ui-border-strong focus-visible:border-ui-cyan/60 focus-visible:ring-2 focus-visible:ring-ui-cyan/25"
        />
        {query ? (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label={t({ th: "ล้างคำค้นหา", en: "Clear search" })}
            className="absolute right-1.5 inline-flex size-6 items-center justify-center rounded-md text-ui-text-3 hover:bg-ui-elevated hover:text-ui-text"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        ) : (
          <Kbd className="pointer-events-none absolute right-2.5 text-ui-text-3">{shortcutKey("search")}</Kbd>
        )}
      </div>

      {expanded && (
        <div className="ui-panel-float absolute inset-x-0 top-full z-40 mt-1.5 overflow-hidden p-1">
          {results.length ? (
            <ul id={listId} role="listbox" aria-label={t({ th: "ผลการค้นหา", en: "Search results" })} className="ui-scroll max-h-72 overflow-y-auto">
              {results.map((a, i) => {
                const isActive = i === Math.min(active, results.length - 1);
                const primary = lang === "th" ? a.nameTh : a.nameEn;
                const secondary = lang === "th" ? a.nameEn : a.nameTh;
                return (
                  <li
                    key={a.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isActive}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(a)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5",
                      isActive ? "bg-ui-elevated-2 text-ui-text" : "text-ui-text-2",
                    )}
                  >
                    <MapPin aria-hidden className={cn("size-3.5 shrink-0", isActive ? "text-ui-cyan" : "text-ui-text-3")} />
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-[13px] font-medium">{primary}</span>
                      <span className="truncate text-[11px] text-ui-text-3">
                        {secondary}
                        {a.code ? ` · ${a.code}` : ""}
                        {a.geometryStatus === "approximate" ? ` · ${t({ th: "ขอบเขตโดยประมาณ", en: "approx. boundary" })}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10.5px] text-ui-text-3">{kindLabel}</span>
                    {a.id === selectedId && <Check aria-label={t({ th: "เลือกอยู่", en: "Selected" })} className="size-3.5 shrink-0 text-ui-cyan" />}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p id={listId} role="status" className="px-2 py-2 text-[12px] text-ui-text-3">
              {status === "ready"
                ? t({ th: `ไม่พบพื้นที่ที่ตรงกับ “${query}”`, en: `No area matches “${query}”` })
                : t({ th: "รายชื่อพื้นที่ยังโหลดไม่เสร็จ", en: "Area list is still loading" })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
