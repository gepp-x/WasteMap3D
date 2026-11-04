"use client";

import { Play, Route } from "lucide-react";
import { useTr } from "@/lib/i18n";
import { useDashboard } from "@/store/dashboard-store";
import { exitGuidedStory, startGuidedStory, useStorySteps } from "@/hooks/use-story";
import { Button } from "@/components/ui/button";

export const STORY_LABEL = { th: "เล่าเรื่องเมือง", en: "Guided story" } as const;

/** Start the tour, or exit it (restoring the previous view) when it is already running. */
export function toggleGuidedStory() {
  if (useDashboard.getState().storyActive) exitGuidedStory();
  else startGuidedStory();
}

/** Insights entry: a short invitation card at the top of the Insight Explorer. */
export function StoryInsightsEntry() {
  const t = useTr();
  const active = useDashboard((s) => s.storyActive);
  const { steps, ready } = useStorySteps();
  if (!ready) return null;
  return (
    <div className="mx-5 mt-4 flex items-center gap-3 rounded-xl border border-ui-cyan/30 bg-ui-cyan/5 px-3.5 py-3">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-ui-cyan/35 bg-ui-surface text-ui-cyan">
        <Route className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ui-text">{t(STORY_LABEL)}</p>
        <p className="text-[11.5px] leading-snug text-ui-text-3">
          {t({
            th: `ทัวร์ ${steps.length} ขั้นจากข้อมูลจริงของเมืองนี้ — หยุด ย้อน หรือออกได้ทุกเมื่อ`,
            en: `A ${steps.length}-step tour built from this city's data — pause, go back or leave any time.`,
          })}
        </p>
      </div>
      <Button size="sm" onClick={toggleGuidedStory} aria-pressed={active}>
        <Play aria-hidden />
        {active ? t({ th: "ออกจากทัวร์", en: "Exit tour" }) : t({ th: "เริ่ม", en: "Start" })}
      </Button>
    </div>
  );
}
