import { memo, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ShieldAlert } from "lucide-react";

import {
  AXIS_TICK,
  BAR_CURSOR,
  CATEGORY_TICK_GUTTER,
  CHART_MARGIN,
  CategoryTick,
  ChartTooltip,
  GRID_OPACITY,
  GRID_STROKE,
  LEGEND_STYLE,
  TOOLTIP_MOTION,
  TOOLTIP_WRAPPER,
  legendText,
} from "../chart-theme";
import { useChartReveal } from "../chart-motion";
import { formatCount, formatPercent } from "../format";
import { rankedPanelHeight, useCategoryAxisWidth, usePanelWidth } from "../hooks/use-ranked-axis";
import { AnalyticsCard } from "./analytics-card";
import { ChartEmpty } from "./chart-empty";

/**
 * Complaints, as a picture.
 *
 * ---------------------------------------------------------------------------
 * Why this shape and not another
 * ---------------------------------------------------------------------------
 * The section had four KPI tiles and two tables and no visual analytic at all,
 * so the question a manager actually opens it with — *where is the backlog* —
 * took reading twenty numbers to answer.
 *
 * The choice of chart is constrained by what the data genuinely contains, and no
 * new RPC was added to widen it. `complaints_locations` returns, per branch and
 * per city: total, resolved, open and a resolution rate. `complaints_kpis`
 * returns the same four figures for the period as a whole. There is **no
 * complaint date series, no category, no channel and no source** — so a trend
 * line, a reason breakdown or a channel split could only be invented, and this
 * chart does not invent them.
 *
 * What the data does support is the one composition that matters: each branch's
 * complaint count *split by whether it has been dealt with*. Stacked, the bar's
 * full length is the branch's volume — the ranking the table gives — and the
 * amber portion is the part still owed to a customer. A branch with forty
 * resolved complaints and a branch with fifteen open ones are different
 * problems, and on a plain total bar they look like the same one.
 *
 * Ranked horizontally rather than as columns because the categories are branch
 * names: they are words, of unpredictable length, some of them Arabic, and a
 * vertical axis is the only one that can give them room. It also puts this panel
 * in the same visual family as the three ranked sales charts above it, using the
 * same measured axis (`use-ranked-axis`) and the same reveal.
 */

export interface ComplaintBranchRow {
  name: string;
  total: number;
  resolved: number;
  open: number;
}

/** Resolved is done, open is owed. The page's own semantic pair, not new hues. */
const RESOLVED_COLOR = "var(--positive)";
const OPEN_COLOR = "var(--attention)";

const fmtTooltipCount = (value: number | string) =>
  formatCount(typeof value === "string" ? Number(value) : value);

const fmtAxisCount = (value: number | string) => {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? String(Math.round(n)) : "";
};

function ComplaintsBranchChartImpl({ data }: { data: readonly ComplaintBranchRow[] }) {
  const { ref, width } = usePanelWidth();
  const series = useMemo(
    () =>
      data.map((r) => ({
        name: r.name,
        resolved: r.resolved,
        open: r.open,
        // The closing line of the tooltip. Precomputed per row because it is
        // per-row: the rate is this branch's, not the period's.
        note: `${formatCount(r.total)} total · ${formatPercent(
          r.total > 0 ? (r.resolved / r.total) * 100 : 0,
        )} resolved`,
      })),
    [data],
  );
  const { ready, motion } = useChartReveal(series, ref);

  const labels = useMemo(() => series.map((r) => r.name), [series]);
  const axisWidth = useCategoryAxisWidth(labels, width);
  const height = rankedPanelHeight(series.length);

  return (
    <AnalyticsCard
      title="Complaints by branch"
      subtitle="Top 10 by volume · resolved against still open"
      icon={ShieldAlert}
    >
      <div ref={ref} className="w-full" style={{ height }}>
        {series.length === 0 ? (
          <ChartEmpty
            label="No complaints in this period"
            hint="Nothing was logged against a branch in the selected range."
          />
        ) : (
          ready && (
            <div className="chart-reveal h-full w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={series}
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
                    tickFormatter={fmtAxisCount}
                    // Complaints are counted, never fractional; without this a
                    // branch with three of them gets an axis reading 0, 0.75, 1.5.
                    allowDecimals={false}
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
                    tickSize={0}
                    tickMargin={CATEGORY_TICK_GUTTER}
                    tick={<CategoryTick maxWidth={axisWidth - CATEGORY_TICK_GUTTER - 4} />}
                  />
                  <Tooltip
                    content={
                      <ChartTooltip format={fmtTooltipCount} unit="complaints" footerKey="note" />
                    }
                    cursor={BAR_CURSOR}
                    wrapperStyle={TOOLTIP_WRAPPER}
                    {...TOOLTIP_MOTION}
                  />
                  <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
                  {/* Resolved first, so the settled part of every bar starts at
                      the axis and the outstanding part is what the eye follows
                      to the right — the ragged edge IS the backlog. */}
                  <Bar
                    dataKey="resolved"
                    name="Resolved"
                    stackId="complaints"
                    fill={RESOLVED_COLOR}
                    {...motion.bar}
                  />
                  <Bar
                    dataKey="open"
                    name="Open"
                    stackId="complaints"
                    fill={OPEN_COLOR}
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
 * Memoised on the rows themselves.
 *
 * `cmpBranchData` is a `useMemo` in `use-dashboard-data`, so the reference is
 * stable across the ten other aggregation queries settling — and re-running a
 * Recharts layout plus a canvas label measurement for unchanged data is the
 * most expensive no-op available on this page.
 */
export const ComplaintsBranchChart = memo(ComplaintsBranchChartImpl);
