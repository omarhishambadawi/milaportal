import { memo, useMemo } from "react";
import type { LucideIcon } from "lucide-react";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtSAR } from "@/lib/branches";
import { AnalyticsCard } from "./analytics-card";
import {
  AXIS_TICK,
  BAR_CURSOR,
  CATEGORY_TICK_GUTTER,
  CHART_MARGIN,
  CategoryTick,
  ChartTooltip,
  GRID_OPACITY,
  GRID_STROKE,
  TOOLTIP_MOTION,
  TOOLTIP_WRAPPER,
} from "../chart-theme";
import { fmtAxisSAR } from "../chart-format";
import { useChartReveal } from "../chart-motion";
import { rankedPanelHeight, useCategoryAxisWidth, usePanelWidth } from "../hooks/use-ranked-axis";
import { ChartEmpty } from "./chart-empty";

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
 * Axis width, row rhythm and panel height all come from `use-ranked-axis`, which
 * the Complaints branch chart shares. They were local constants here until that
 * second ranked panel existed; a copy of them would be the exact drift the
 * measured axis was built to end.
 */

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
  // The element this panel already measures is the one to watch, so the ranked
  // charts need no extra wrapper of their own. `ready` withholds the chart until
  // it is: mounting a Recharts series still and arming it afterwards is what
  // made these panels blink out and grow back (see `useChartReveal`).
  const { ready, motion } = useChartReveal(data, ref, stillMotion);

  const labels = useMemo(() => data.map((d) => d.name), [data]);
  const axisWidth = useCategoryAxisWidth(labels, width);
  const height = rankedPanelHeight(data.length, compact);

  return (
    <AnalyticsCard title={title} subtitle={subtitle} icon={icon} className={className}>
      <div ref={ref} className="w-full" style={{ height }}>
        {data.length === 0 ? (
          <ChartEmpty hint="No completed sales were recorded in the selected range." />
        ) : (
          ready && (
            <div className="chart-reveal h-full w-full">
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
                    {...TOOLTIP_MOTION}
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
            </div>
          )
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
