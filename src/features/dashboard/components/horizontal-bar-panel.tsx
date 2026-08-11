import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtSAR } from "@/lib/branches";
import { AnalyticsCard } from "./analytics-card";
import {
  AXIS_TICK,
  BAR_CURSOR,
  CATEGORY_TICK_GUTTER,
  CATEGORY_TICK_SIZE,
  CHART_MARGIN,
  CategoryTick,
  ChartTooltip,
  GRID_OPACITY,
  GRID_STROKE,
  TOOLTIP_WRAPPER,
} from "../chart-theme";
import { fmtAxisSAR } from "../chart-format";
import { useSettledChartMotion } from "../chart-motion";
import { widestLabel } from "../text-metrics";

/**
 * The three ranked bar charts — top agents, sales by branch, sales by city.
 *
 * They were three near-identical `<BarChart layout="vertical">` blocks whose
 * only real difference was a hard-coded `YAxis width` (130, 80, 90) chosen by
 * eye against whatever data happened to be on screen at the time. That is the
 * bug behind every clipped name on this page: the axis reserves a fixed number
 * of pixels and Recharts clips whatever exceeds it, silently. A long agent name
 * or a full Arabic city name simply vanished off the left edge.
 *
 * Here the width is measured from the labels themselves, every render, against
 * the font actually in use — so the axis is exactly as wide as it needs to be
 * and never wider. Ellipsis is the fallback for the pathological case only, and
 * when it happens the full name is one hover away.
 */

interface Row {
  name: string;
  sales: number;
}

/**
 * Ceiling on the category axis, as a share of panel width.
 *
 * Without a ceiling one 40-character name would take the plot area to nothing
 * and the chart would stop being a chart. A third is the point where the bars
 * still carry the comparison; past it, ellipsis is the better trade.
 */
const MAX_AXIS_SHARE = 0.34;

/** Floor, so a panel of short names still has a tidy left margin. */
const MIN_AXIS_WIDTH = 64;

/** Per-bar vertical rhythm — bar plus the gap under it. */
const ROW_HEIGHT = 34;

/**
 * The same rhythm, tightened for a panel that is sharing a row on A4.
 *
 * The Dashboard's 34px assumes a half-width card on a wide monitor. The Monthly
 * Report puts the same panel in a ~345px column on paper, where ten rows at the
 * full rhythm is a card taller than it is wide and mostly gap.
 */
const COMPACT_ROW_HEIGHT = 26;

/** Chart chrome that is not plot area: the value axis and its labels. */
const CHART_CHROME = 56;

/**
 * Panel width, tracked so the axis can be capped against it.
 *
 * `ResponsiveContainer` knows this number but will not share it, and the axis
 * width has to be decided before the container renders. One `ResizeObserver` per
 * panel is the cheapest way to learn it.
 */
function usePanelWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured synchronously, before the browser paints. A `ResizeObserver`
    // delivers its first entry in a later task, so waiting for it meant the
    // first painted frame used the 190px fallback ceiling and the axis — and
    // with it the whole plot area — resized underneath the bars while their
    // entrance was still running. That is a visible jump, not a resize.
    setWidth(Math.round(el.getBoundingClientRect().width));

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      // Whole pixels only: a fractional resize storm during a CSS transition
      // would otherwise re-render the chart on every frame of it.
      setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : Math.round(next)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

function HorizontalBarPanelImpl({
  title,
  subtitle,
  icon,
  data,
  color,
  barName = "Completed sales",
  className,
  compact = false,
  stillMotion = false,
}: {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  data: Row[];
  color: string;
  barName?: string;
  /** Card-level classes — the Monthly Report uses it for `break-inside-avoid`. */
  className?: string;
  /** Tighter row rhythm, for a panel sharing a row on A4. */
  compact?: boolean;
  /** No enter animation. The PDF export prints one instant; see `chart-motion`. */
  stillMotion?: boolean;
}) {
  const { ref, width } = usePanelWidth();
  const motion = useSettledChartMotion(data, stillMotion);

  const axisWidth = useMemo(() => {
    const widest = widestLabel(
      data.map((d) => d.name),
      CATEGORY_TICK_SIZE,
    );
    const ceiling = width > 0 ? Math.round(width * MAX_AXIS_SHARE) : 190;
    return Math.min(
      Math.max(MIN_AXIS_WIDTH, Math.ceil(widest) + CATEGORY_TICK_GUTTER + 4),
      ceiling,
    );
  }, [data, width]);

  /**
   * Height follows the row count instead of a fixed `h-64`.
   *
   * Ten branches crammed into 256px gave each bar ~18px including its gap, which
   * is what made these panels read as compressed. Growing with the data keeps
   * the bar rhythm constant whether there are three rows or ten.
   */
  const rowHeight = compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
  const height = Math.max(compact ? 180 : 232, data.length * rowHeight + CHART_CHROME);

  return (
    <AnalyticsCard title={title} subtitle={subtitle} icon={icon} className={className}>
      <div ref={ref} className="w-full" style={{ height }}>
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={CHART_MARGIN}
              barCategoryGap="22%"
              maxBarSize={22}
            >
              <CartesianGrid
                horizontal={false}
                strokeDasharray="3 3"
                stroke={GRID_STROKE}
                strokeOpacity={GRID_OPACITY}
              />
              <XAxis
                type="number"
                tick={AXIS_TICK}
                tickFormatter={fmtAxisSAR}
                tickLine={false}
                axisLine={false}
                tickMargin={6}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={axisWidth}
                tickLine={false}
                axisLine={false}
                interval={0}
                // The axis owns the gutter, the tick owns the text. Recharts
                // offsets a tick by `tickSize + tickMargin` (6 + 2 by default),
                // so leaving those at their defaults silently stole 8px from
                // the space the width calculation had reserved.
                tickSize={0}
                tickMargin={CATEGORY_TICK_GUTTER}
                tick={<CategoryTick maxWidth={axisWidth - CATEGORY_TICK_GUTTER - 4} />}
              />
              <Tooltip
                content={<ChartTooltip format={fmtSAR} />}
                cursor={BAR_CURSOR}
                wrapperStyle={TOOLTIP_WRAPPER}
              />
              <Bar
                dataKey="sales"
                name={barName}
                fill={color}
                radius={[0, 5, 5, 0]}
                {...motion.bar}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </AnalyticsCard>
  );
}

/**
 * Memoised: the dashboard re-renders on every filter keystroke and every
 * background refetch, and re-running the label measurement and Recharts'
 * layout for unchanged data is the most expensive no-op on the page.
 */
export const HorizontalBarPanel = memo(HorizontalBarPanelImpl);
