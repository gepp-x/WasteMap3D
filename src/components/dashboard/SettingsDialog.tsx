"use client";

import { useId, useState, type ReactNode } from "react";
import { Gauge, Keyboard, Languages, RotateCcw, Settings2, Sparkles, Tags } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTr, type Bi } from "@/lib/i18n";
import { STATUS_META } from "@/lib/data/status";
import type { DataStatus } from "@/lib/types";
import { useDashboard, type QualityMode } from "@/store/dashboard-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ShellDialogContent } from "@/components/motion/AnimatedPanel";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Eyebrow, LangSwitch } from "@/components/dashboard/Header";
import { ShortcutList } from "@/components/dashboard/ShortcutsHelp";

const QUALITY: { id: QualityMode; label: Bi; desc: Bi }[] = [
  {
    id: "auto",
    label: { th: "อัตโนมัติ", en: "Auto" },
    desc: { th: "ปรับระดับตามประสิทธิภาพของอุปกรณ์ระหว่างใช้งาน", en: "Adapts to your device's performance while you work" },
  },
  {
    id: "high",
    label: { th: "สูง", en: "High" },
    desc: { th: "แสง เงา อาคาร และฝนละเอียดที่สุด เหมาะกับเครื่องที่มีการ์ดจอแยก", en: "Full lighting, shadows, buildings and rain — for discrete GPUs" },
  },
  {
    id: "balanced",
    label: { th: "สมดุล", en: "Balanced" },
    desc: { th: "สมดุลระหว่างความสวยงามและความลื่นไหล เหมาะกับแล็ปท็อปทั่วไป", en: "Balanced fidelity and smoothness — for typical laptops" },
  },
  {
    id: "low",
    label: { th: "ประหยัด", en: "Low" },
    desc: { th: "ลดเอฟเฟกต์และความละเอียด เหมาะกับมือถือหรือเมื่อต้องการประหยัดแบตเตอรี่", en: "Fewer effects and lower resolution — for phones and battery saving" },
  },
];

const TIER_LABEL: Record<"high" | "balanced" | "low", Bi> = {
  high: { th: "สูง", en: "High" },
  balanced: { th: "สมดุล", en: "Balanced" },
  low: { th: "ประหยัด", en: "Low" },
};

const STATUS_ORDER: DataStatus[] = ["observed", "derived", "estimated", "simulated", "unavailable"];

function Section({ icon: Icon, title, children, description }: { icon: typeof Gauge; title: Bi; description?: Bi; children: ReactNode }) {
  const t = useTr();
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-b border-ui-border px-5 py-4 last:border-b-0">
      <div className="flex flex-col gap-0.5">
        <h3 id={id} className="flex items-center gap-2 text-[13px] font-semibold text-ui-text">
          <Icon aria-hidden className="size-4 text-ui-cyan" />
          {t(title)}
        </h3>
        {description && <p className="pl-6 text-[12px] text-ui-text-3">{t(description)}</p>}
      </div>
      <div className="pl-6">{children}</div>
    </section>
  );
}

function ToggleRow({ label, desc, checked, onChange, note }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void; note?: string }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-[12.5px] text-ui-text">
          {label}
        </label>
        <p id={`${id}-d`} className="text-[11.5px] leading-relaxed text-ui-text-3">
          {desc}
        </p>
        {note && <p className="text-[11.5px] text-ui-cyan">{note}</p>}
      </div>
      <Switch id={id} aria-describedby={`${id}-d`} checked={checked} onCheckedChange={(v) => onChange(v)} className="mt-0.5" />
    </div>
  );
}

function QualityPicker() {
  const t = useTr();
  const quality = useDashboard((s) => s.quality);
  const tier = useDashboard((s) => s.qualityTier);
  const setQuality = useDashboard((s) => s.setQuality);
  const setQualityTier = useDashboard((s) => s.setQualityTier);
  const name = useId();
  const choose = (q: QualityMode) => {
    setQuality(q);
    if (q !== "auto") setQualityTier(q);
  };
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={t({ th: "คุณภาพการแสดงผล", en: "Rendering quality" })} className="grid gap-1.5 sm:grid-cols-2">
        {QUALITY.map((q) => {
          const checked = quality === q.id;
          return (
            <label
              key={q.id}
              className={cn(
                "flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ui-cyan/60",
                checked ? "border-ui-cyan/50 bg-ui-cyan/8" : "border-ui-border hover:border-ui-border-strong hover:bg-ui-elevated/50",
              )}
            >
              <span className="flex items-center gap-2">
                <input type="radio" name={name} value={q.id} checked={checked} onChange={() => choose(q.id)} className="sr-only" />
                <span aria-hidden className={cn("flex size-3.5 items-center justify-center rounded-full border", checked ? "border-ui-cyan" : "border-ui-text-3")}>
                  {checked && <span className="size-1.5 rounded-full bg-ui-cyan" />}
                </span>
                <span className="text-[12.5px] font-medium text-ui-text">{t(q.label)}</span>
              </span>
              <span className="pl-5.5 text-[11.5px] leading-snug text-ui-text-3">{t(q.desc)}</span>
            </label>
          );
        })}
      </div>
      <p className="flex items-center gap-1.5 text-[12px] text-ui-text-2" aria-live="polite">
        <Gauge aria-hidden className="size-3.5 text-ui-cyan" />
        {t({ th: "ระดับที่ใช้งานอยู่ขณะนี้", en: "Active tier" })}: <span className="font-medium text-ui-text">{t(TIER_LABEL[tier])}</span>
        {quality === "auto" && <span className="text-ui-text-3">· {t({ th: "เลือกโดยอัตโนมัติ", en: "chosen automatically" })}</span>}
      </p>
    </div>
  );
}

function ResetButton({ onDone }: { onDone: () => void }) {
  const t = useTr();
  const resetAll = useDashboard((s) => s.resetAll);
  const [armed, setArmed] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={armed ? "destructive" : "outline"}
        size="sm"
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          resetAll();
          setArmed(false);
          onDone();
        }}
        onBlur={() => setArmed(false)}
      >
        <RotateCcw aria-hidden />
        {armed ? t({ th: "ยืนยันการรีเซ็ต", en: "Confirm reset" }) : t({ th: "รีเซ็ตแดชบอร์ด", en: "Reset dashboard" })}
      </Button>
      {armed && (
        <span role="status" className="text-[11.5px] text-ui-text-3">
          {t({ th: "กดอีกครั้งเพื่อยืนยัน", en: "Press again to confirm" })}
        </span>
      )}
    </div>
  );
}

/** Settings: language, quality, motion & effects, data-status legend, shortcuts, reset. */
export function SettingsDialog({ onAfterReset }: { onAfterReset?: () => void }) {
  const t = useTr();
  const open = useDashboard((s) => s.settingsOpen);
  const setPanel = useDashboard((s) => s.setPanel);
  const reducedMotion = useDashboard((s) => s.reducedMotion);
  const setReducedMotion = useDashboard((s) => s.setReducedMotion);
  const effectsEnabled = useDashboard((s) => s.effectsEnabled);
  const setEffectsEnabled = useDashboard((s) => s.setEffectsEnabled);
  const osReduced = useMediaQuery("(prefers-reduced-motion: reduce)");

  return (
    <Dialog open={open} onOpenChange={(v) => setPanel("settingsOpen", v)}>
      <ShellDialogContent
        closeLabel={t({ th: "ปิด", en: "Close" })}
        className="flex max-h-[min(88dvh,820px)] flex-col gap-0 overflow-hidden border border-ui-border bg-ui-surface p-0 ring-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-ui-border px-5 pt-4 pb-3">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Settings2 aria-hidden className="size-4 text-ui-cyan" />
            {t({ th: "การตั้งค่า", en: "Settings" })}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-ui-text-3">
            {t({ th: "ปรับภาษา คุณภาพการแสดงผล และการเคลื่อนไหวให้เหมาะกับคุณ", en: "Tune language, rendering quality and motion to suit you." })}
          </DialogDescription>
        </DialogHeader>

        <div className="ui-scroll min-h-0 flex-1 overflow-y-auto">
          <Section icon={Languages} title={{ th: "ภาษา", en: "Language" }}>
            <LangSwitch size="md" />
          </Section>

          <Section icon={Gauge} title={{ th: "คุณภาพการแสดงผล 3 มิติ", en: "3D rendering quality" }}>
            <QualityPicker />
          </Section>

          <Section icon={Sparkles} title={{ th: "การเคลื่อนไหวและเอฟเฟกต์", en: "Motion & effects" }}>
            <div className="flex flex-col gap-2">
              <ToggleRow
                label={t({ th: "ลดการเคลื่อนไหว", en: "Reduce motion" })}
                desc={t({
                  th: "ปิดการเคลื่อนไหวของแผง ตัวเลข และกล้อง — การเปลี่ยนแปลงจะแสดงทันที",
                  en: "Turns off panel, number and camera animation — changes appear instantly.",
                })}
                checked={reducedMotion}
                onChange={setReducedMotion}
                note={osReduced ? t({ th: "ระบบปฏิบัติการของคุณขอให้ลดการเคลื่อนไหว จึงเปิดใช้อยู่แล้ว", en: "Your operating system requests reduced motion, so it is already applied." }) : undefined}
              />
              <ToggleRow
                label={t({ th: "เอฟเฟกต์ภาพ", en: "Visual effects" })}
                desc={t({
                  th: "ฝนตกและผิวน้ำเคลื่อนไหวในมุมมอง 3 มิติ ปิดเพื่อประหยัดพลังงาน",
                  en: "Falling rain and animated water in the 3D view. Turn off to save power.",
                })}
                checked={effectsEnabled}
                onChange={setEffectsEnabled}
              />
            </div>
          </Section>

          <Section
            icon={Tags}
            title={{ th: "สถานะของข้อมูล", en: "Data status legend" }}
            description={{ th: "ทุกตัวเลขในแดชบอร์ดมีป้ายบอกที่มา สถานะแสดงทั้งสัญลักษณ์ ข้อความ และสี", en: "Every number carries its provenance, shown as glyph, text and colour." }}
          >
            <ul className="flex flex-col gap-2">
              {STATUS_ORDER.map((s) => (
                <li key={s} className="grid grid-cols-[minmax(0,10.5rem)_1fr] items-start gap-3">
                  <StatusBadge status={s} className="justify-self-start" />
                  <span className="text-[12px] leading-snug text-ui-text-2">{t(STATUS_META[s].description)}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section icon={Keyboard} title={{ th: "แป้นพิมพ์ลัด", en: "Keyboard shortcuts" }}>
            <ShortcutList columns={2} />
          </Section>

          <Section
            icon={RotateCcw}
            title={{ th: "รีเซ็ตแดชบอร์ด", en: "Reset dashboard" }}
            description={{
              th: "ล้างการเลือก ชั้นข้อมูล สถานการณ์จำลอง ไทม์ไลน์ และการตั้งค่าการแสดงผล กลับสู่ค่าเริ่มต้น (คงเมืองและภาษาไว้)",
              en: "Restores selection, layers, scenario, timeline and display settings to defaults (keeps city and language).",
            }}
          >
            <ResetButton
              onDone={() => {
                onAfterReset?.();
                setPanel("settingsOpen", false);
              }}
            />
          </Section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-ui-border px-5 py-3">
          <Eyebrow>{t({ th: "การตั้งค่าใช้กับเบราว์เซอร์นี้ในเซสชันนี้", en: "Settings apply to this session" })}</Eyebrow>
          <Button variant="secondary" size="sm" onClick={() => setPanel("settingsOpen", false)}>
            {t({ th: "เสร็จสิ้น", en: "Done" })}
          </Button>
        </div>
      </ShellDialogContent>
    </Dialog>
  );
}
