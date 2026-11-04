"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart, CustomChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DatasetComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  DataZoomComponent,
  VisualMapComponent,
  AriaComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
// ECharts 6 moved `grid.containLabel` behind a feature; the charts use it to keep axis labels inside the grid.
import { LegacyGridContainLabel } from "echarts/features";
import type { EChartsCoreOption, ECElementEvent } from "echarts/core";
import { useReducedMotionPref } from "@/lib/animation/tokens";
import { cn } from "@/lib/utils";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DatasetComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  DataZoomComponent,
  VisualMapComponent,
  AriaComponent,
  LegacyGridContainLabel,
  CanvasRenderer,
]);

const FONT = '"IBM Plex Sans Thai", "Inter Variable", system-ui, sans-serif';

/** Shared dark theme so every chart reads as one system. */
export const CHART_THEME = {
  text: "#91a8ba",
  textStrong: "#eaf4fa",
  axis: "#20364a",
  split: "rgba(145,168,186,0.10)",
  tooltipBg: "rgba(9,22,37,0.96)",
  font: FONT,
  series: ["#25d9f2", "#12c9b0", "#f5d65a", "#f6a34b", "#a78bfa", "#46d98b", "#f05b63"],
};

export const baseOption = (): EChartsCoreOption => ({
  backgroundColor: "transparent",
  textStyle: { fontFamily: FONT, color: CHART_THEME.text, fontSize: 11 },
  color: CHART_THEME.series,
  aria: { enabled: true },
  tooltip: {
    backgroundColor: CHART_THEME.tooltipBg,
    borderColor: "#2c4a63",
    borderWidth: 1,
    textStyle: { color: CHART_THEME.textStrong, fontFamily: FONT, fontSize: 12 },
    extraCssText: "border-radius:10px;box-shadow:0 12px 32px -12px rgba(0,0,0,.7);",
  },
  grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
});

export const axisStyle = {
  axisLine: { lineStyle: { color: CHART_THEME.axis } },
  axisTick: { show: false },
  axisLabel: { color: CHART_THEME.text, fontSize: 10.5, fontFamily: FONT },
  splitLine: { lineStyle: { color: CHART_THEME.split } },
};

interface Props {
  option: EChartsCoreOption;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: ECElementEvent) => void;
  /** Accessible summary of what the chart shows. */
  ariaLabel?: string;
}

/** Thin, tree-shaken ECharts wrapper: resize-aware, theme-merged, reduced-motion aware. */
export function EChart({ option, className, style, onClick, ariaLabel }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const reduced = useReducedMotionPref();
  const clickRef = useRef(onClick);
  // keep the latest handler without re-binding the ECharts listener (written after commit, never during render)
  useEffect(() => {
    clickRef.current = onClick;
  }, [onClick]);

  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: "canvas" });
    chart.current = c;
    c.on("click", (e) => clickRef.current?.(e as ECElementEvent));
    const ro = new ResizeObserver(() => c.resize({ animation: { duration: 0 } }));
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(
      { ...baseOption(), animation: !reduced, animationDuration: 600, animationDurationUpdate: 700, animationEasingUpdate: "cubicOut", ...option },
      { notMerge: false, lazyUpdate: true },
    );
  }, [option, reduced]);

  return <div ref={el} role="img" aria-label={ariaLabel} className={cn("w-full", className)} style={{ minHeight: 120, ...style }} />;
}
