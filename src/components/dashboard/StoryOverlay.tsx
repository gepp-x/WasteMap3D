"use client";

import { useEffect, useId, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, Database, FlaskConical, GitCompareArrows, Lightbulb, Pause, Play, Route, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTr } from "@/lib/i18n";
import { useDashboard } from "@/store/dashboard-store";
import { DURATION, EASE, motionDuration, useReducedMotionPref } from "@/lib/animation/tokens";
import { STORY_AUTO_ADVANCE_MS, type StoryStep } from "@/lib/story/build-story";
import {
  applyStoryView,
  discardStorySnapshot,
  exitGuidedStory,
  goToStoryStep,
  pauseStoryForInteraction,
  setStoryAutoPlay,
  useStorySteps,
  useStoryUi,
} from "@/hooks/use-story";
import { openModal } from "@/hooks/use-keyboard-shortcuts";
import { Button } from "@/components/ui/button";
import { MetricReadout, StatusBadge } from "@/components/dashboard/StatusBadge";

const S = {
  story: { th: "เล่าเรื่องเมือง", en: "Guided story" },
  step: { th: "ขั้นที่", en: "Step" },
  of: { th: "จาก", en: "of" },
  back: { th: "ย้อนกลับ", en: "Back" },
  next: { th: "ถัดไป", en: "Next" },
  finish: { th: "จบทัวร์", en: "Finish" },
  play: { th: "เล่นอัตโนมัติ (ขั้นละ 8 วินาที)", en: "Auto-play (8 s per step)" },
  pause: { th: "หยุดเล่นอัตโนมัติ", en: "Pause auto-play" },
  exit: { th: "ออกจากทัวร์และกลับสู่มุมมองเดิม (Esc)", en: "Exit the tour and restore your view (Esc)" },
  progress: { th: "ความคืบหน้าของทัวร์", en: "Tour progress" },
  paused: { th: "หยุดเล่นอัตโนมัติชั่วคราวขณะคุณสำรวจเอง — กด ▶ เพื่อเล่นต่อ", en: "Auto-play paused while you explore — press ▶ to resume" },
  autoOn: { th: "เล่นอัตโนมัติ", en: "Auto-playing" },
  lab: { th: "ห้องทดลองสถานการณ์", en: "Scenario Lab" },
  insights: { th: "ข้อค้นพบสำคัญ", en: "Insights" },
  compare: { th: "เปรียบเทียบพื้นที่", en: "Compare areas" },
  sources: { th: "แหล่งข้อมูล", en: "Data sources" },
  exploreNext: { th: "สำรวจต่อ", en: "Explore next" },
} as const;

/* ------------------------------------------------------------------ */
/*  Step content                                                       */
/* ------------------------------------------------------------------ */

function StepBody({ step, titleId, bodyId }: { step: StoryStep; titleId: string; bodyId: string }) {
  const t = useTr();
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <h2 id={titleId} tabIndex={-1} className="text-[14.5px] leading-snug font-semibold text-ui-text outline-none">
          {t(step.title)}
        </h2>
        <StatusBadge status={step.status} size="xs" className="mt-0.5 shrink-0" />
      </div>
      <p id={bodyId} className="text-[12.5px] leading-relaxed text-ui-text-2">
        {t(step.body)}
      </p>
      {step.metrics.length > 0 && (
        <dl className="grid grid-cols-1 gap-1.5 rounded-lg border border-ui-border bg-ui-bg-deep/50 p-2.5 min-[420px]:grid-cols-2">
          {step.metrics.map((m) => (
            <div key={m.id} className="flex min-w-0 flex-col gap-0.5">
              <dt className="truncate text-[11px] text-ui-text-3" title={t(m.label)}>
                {t(m.label)}
              </dt>
              <dd className="flex min-w-0 items-center gap-1.5">
                <MetricReadout metric={m.metric} decimals={m.decimals} animate={false} valueClassName="text-[14px] font-semibold text-ui-text" />
                <StatusBadge status={m.metric.provenance.status} size="xs" showLabel={false} className="shrink-0" />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {step.note && <p className="text-[11.5px] leading-relaxed text-ui-text-3">{t(step.note)}</p>}
    </div>
  );
}

function ExploreActions() {
  const t = useTr();
  const go = (fn: () => void) => () => {
    exitGuidedStory({ restore: false });
    fn();
  };
  const items = [
    {
      icon: FlaskConical,
      label: S.lab,
      run: () => {
        const s = useDashboard.getState();
        s.setPanel("leftOpen", true);
        s.setPanel("labOpen", true);
      },
    },
    {
      icon: GitCompareArrows,
      label: S.compare,
      run: () => {
        const s = useDashboard.getState();
        s.setBottomTab("compare");
        s.setPanel("bottomOpen", true);
      },
    },
    { icon: Lightbulb, label: S.insights, run: () => openModal("insightsOpen") },
    { icon: Database, label: S.sources, run: () => openModal("sourcesOpen") },
  ];
  return (
    <div role="group" aria-label={t(S.exploreNext)} className="grid grid-cols-2 gap-1.5">
      {items.map(({ icon: Icon, label, run }) => (
        <Button key={label.en} variant="outline" size="sm" onClick={go(run)} className="justify-start">
          <Icon aria-hidden />
          <span className="truncate">{t(label)}</span>
        </Button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Card                                                               */
/* ------------------------------------------------------------------ */

function StoryCard({ steps, compact }: { steps: StoryStep[]; compact: boolean }) {
  const t = useTr();
  const reduced = useReducedMotionPref();
  const cityId = useDashboard((s) => s.cityId);
  const rawIndex = useDashboard((s) => s.storyStep);
  const autoPlay = useStoryUi((s) => s.autoPlay);
  const pausedByUser = useStoryUi((s) => s.pausedByUser);
  const cardRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const total = steps.length;
  const index = Math.min(Math.max(0, rawIndex), total - 1);
  const step = steps[index];
  const last = index === total - 1;

  // Drive the store when the step changes (once per city × step; rebuilding steps never re-applies).
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const key = `${cityId}:${index}:${step.id}`;
    if (applied.current === key) return;
    applied.current = key;
    applyStoryView(step.view);
  }, [cityId, index, step]);

  // Move focus into the card when the tour starts (non-modal: focus is never trapped).
  useEffect(() => {
    const id = requestAnimationFrame(() => document.getElementById(titleId)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [titleId]);

  // Auto-advance while playing (the dwell restarts on every step); auto-play switches off on the last step.
  useEffect(() => {
    if (!autoPlay) return;
    if (last) {
      setStoryAutoPlay(false);
      return;
    }
    const timer = window.setTimeout(() => goToStoryStep(index + 1, total), STORY_AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [autoPlay, index, last, total]);

  // Any interaction outside the card (map, panels, keys) pauses auto-advance; a hidden tab pauses too.
  useEffect(() => {
    const outside = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && cardRef.current?.contains(target)) return;
      if (e instanceof KeyboardEvent && e.key === "Escape") return;
      pauseStoryForInteraction();
    };
    const onVisibility = () => {
      if (document.hidden) pauseStoryForInteraction();
    };
    const opts = { capture: true, passive: true } as const;
    document.addEventListener("pointerdown", outside, opts);
    document.addEventListener("wheel", outside, opts);
    document.addEventListener("keydown", outside, opts);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("pointerdown", outside, opts);
      document.removeEventListener("wheel", outside, opts);
      document.removeEventListener("keydown", outside, opts);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const d = motionDuration(DURATION.ui, reduced);
  const next = () => (last ? exitGuidedStory() : goToStoryStep(index + 1, total));

  return (
    <motion.section
      ref={cardRef}
      data-story-card=""
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: compact ? 12 : -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: motionDuration(DURATION.panel, reduced), ease: EASE.outExpo } }}
      exit={{ opacity: 0, y: reduced ? 0 : compact ? 12 : -8, transition: { duration: d, ease: EASE.standard } }}
      className={cn(
        "ui-panel-float pointer-events-auto absolute z-40 flex flex-col overflow-hidden",
        compact ? "inset-x-2 bottom-5 max-h-[min(62%,26rem)]" : "top-[4.5rem] left-3 max-h-[calc(100%-6rem)] w-[min(24rem,calc(100%-1.5rem))]",
      )}
    >
      {/* auto-advance progress (decorative; static under reduced motion) */}
      <div aria-hidden className="h-[2px] w-full shrink-0 bg-ui-border/60">
        {autoPlay && (
          <motion.div
            key={`${index}-${String(autoPlay)}`}
            className="h-full origin-left bg-ui-cyan"
            initial={{ scaleX: reduced ? 1 : 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: reduced ? 0 : STORY_AUTO_ADVANCE_MS / 1000, ease: "linear" }}
          />
        )}
      </div>

      <header className="flex shrink-0 items-center justify-between gap-2 px-3.5 pt-2.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-ui-text-3">
          <Route aria-hidden className="size-3.5 shrink-0 text-ui-cyan" />
          <span className="truncate">{t(S.story)}</span>
          <span aria-hidden>·</span>
          <span className="ui-num shrink-0">
            {index + 1}/{total}
          </span>
        </span>
        <Button variant="ghost" size="icon-sm" onClick={() => exitGuidedStory()} aria-label={t(S.exit)} title={t(S.exit)} className="-mr-1.5 text-ui-text-2 hover:text-ui-text">
          <X aria-hidden />
        </Button>
      </header>

      <div className="ui-scroll min-h-0 flex-1 overflow-y-auto px-3.5 pt-1.5 pb-3">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step.id}
            initial={{ opacity: 0, x: reduced ? 0 : 8 }}
            animate={{ opacity: 1, x: 0, transition: { duration: d, ease: EASE.outExpo } }}
            exit={{ opacity: 0, x: reduced ? 0 : -8, transition: { duration: d * 0.6, ease: EASE.standard } }}
            className="flex flex-col gap-3"
          >
            <StepBody step={step} titleId={titleId} bodyId={bodyId} />
            {step.kind === "explore" && <ExploreActions />}
          </motion.div>
        </AnimatePresence>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {`${t(S.step)} ${index + 1} ${t(S.of)} ${total}: ${t(step.title)}`}
        </p>
      </div>

      {pausedByUser && (
        <p className="shrink-0 border-t border-ui-border bg-ui-bg-deep/40 px-3.5 py-1.5 text-[11px] text-ui-text-3" role="status">
          {t(S.paused)}
        </p>
      )}

      <footer className="flex shrink-0 items-center gap-2 border-t border-ui-border px-3 py-2">
        <ol aria-label={t(S.progress)} className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => goToStoryStep(i, total)}
                aria-label={`${t(S.step)} ${i + 1}: ${t(s.title)}`}
                aria-current={i === index ? "step" : undefined}
                className="group grid size-5 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ui-cyan/60"
              >
                <span
                  aria-hidden
                  className={cn(
                    "block rounded-full transition-all duration-200",
                    i === index ? "h-1.5 w-3.5 bg-ui-cyan" : i < index ? "size-1.5 bg-ui-cyan/45 group-hover:bg-ui-cyan/70" : "size-1.5 bg-ui-border-strong group-hover:bg-ui-text-3",
                  )}
                />
              </button>
            </li>
          ))}
        </ol>
        <Button variant="ghost" size="icon-sm" onClick={() => goToStoryStep(index - 1, total)} disabled={index === 0} aria-label={t(S.back)} title={t(S.back)}>
          <ChevronLeft aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setStoryAutoPlay(!autoPlay)}
          disabled={last}
          aria-pressed={autoPlay}
          aria-label={autoPlay ? t(S.pause) : t(S.play)}
          title={autoPlay ? t(S.pause) : t(S.play)}
          className={cn(autoPlay && "text-ui-cyan")}
        >
          {autoPlay ? <Pause aria-hidden /> : <Play aria-hidden />}
        </Button>
        <Button size="sm" onClick={next} className="min-w-20">
          {last ? t(S.finish) : t(S.next)}
          {!last && <ChevronRight aria-hidden />}
        </Button>
      </footer>
    </motion.section>
  );
}

/**
 * Floating, non-modal story card rendered inside the stage. The dashboard stays fully usable
 * underneath; interacting with it pauses auto-advance, Esc / ✕ exits and restores the view.
 */
export function StoryOverlay({ compact = false }: { compact?: boolean }) {
  const active = useDashboard((s) => s.storyActive);
  const { steps, ready } = useStorySteps();

  // The tour can end without exitGuidedStory() (city switch, dashboard reset): drop the snapshot.
  useEffect(() => {
    if (!active) discardStorySnapshot();
  }, [active]);

  return <AnimatePresence>{active && ready && <StoryCard key="story" steps={steps} compact={compact} />}</AnimatePresence>;
}
