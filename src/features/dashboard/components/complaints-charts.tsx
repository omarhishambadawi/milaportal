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
import { MapPinned } from "lucide-react";

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
 * What the data does support is the one composition that matters: complaint
 * volume *split by whether it has been dealt with*. Stacked, the bar's full
 * length is the volume — the ranking the table gives — and the amber portion is
 * the part still owed to a customer. Forty resolved complaints and fifteen open
 * ones are different problems, and on a plain total bar they look like the same
 * one.
 *
 * ---------------------------------------------------------------------------
 * City, not branch
 * ---------------------------------------------------------------------------
 * A city is the level a regional manager can act at, and there are an order of
 * magnitude fewer of them than branches — so one panel carries the whole picture
 * rather than a top ten out of hundreds.
 *
 * The city is genuinely in the data and is not the branch field renamed. The
 * `complaints` table carries `branch_no` and no city at all; the RPC derives one
 * with `LEFT JOIN public.branches b ON b.branch_no = s.branch_no` and groups on
 * `b.city`, which is why this reads the `location_type = 'city'` rows rather
 * than relabelling the branch rows. A complaint whose branch is not in the
 * branch directory lands in that join's `COALESCE(b.city, '—')` bucket, and it
 * is plotted exactly as the RPC reports it — an unattributed complaint is a real
 * row, and dropping it quietly would make this panel disagree with the KPI strip
 * directly above it.
 *
 * Ranked horizontally rather than as columns because the categories are place
 * names: words, of unpredictable length, some of them Arabic, and a vertical
 * axis is the only one that can give them room. It also puts this panel in the
 * same visual family as the three ranked sales charts above it, using the same
 * measured axis (`use-ranked-axis`) and the same reveal.
 */

export interface ComplaintCityRow {
  name: string;
  total: number;
  resolved: number;
  open: number;
}

/** Resolved is done, open is owed. The page's own semantic pair, not new hues. */
const RESOLVED_COLOR = "var(--positive)";
const OPEN_COLOR = "var(--attention)";

/**
 * Ceiling on the number of cities plotted.
 *
 * The tail of a complaints ranking is cities with one or two, which carry no
 * decision and would squeeze the rows that do. The table beneath this chart
 * still lists every city, so nothing is hidden — only unplotted, and the
 * subtitle says so when the ceiling actually bites.
 */
const MAX_CITIES = 12;

const fmtTooltipCount = (value: number | string) =>
  formatCount(typeof value === "string" ? Number(value) : value);

const fmtAxisCount = (value: number | string) => {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? String(Math.round(n)) : "";
};

function ComplaintsCityChartImpl({ data }: { data: readonly ComplaintCityRow[] }) {
  const { ref, width } = usePanelWidth();
  const series = useMemo(
    () =>
      [...data]
        .sort((a, b) => b.total - a.total)
        .slice(0, MAX_CITIES)
        .map((r) => ({
          name: r.name,
          resolved: r.resolved,
          open: r.open,
          // The closing line of the tooltip. Precomputed per row because it is
          // per-row: the rate is this city's, not the period's.
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
      title="Complaints by city"
      subtitle={`Highest volume first · resolved against still open${
        data.length > MAX_CITIES ? ` · top ${MAX_CITIES}` : ""
      }`}
      icon={MapPinned}
    >
      <div ref={ref} className="w-full" style={{ height }}>
        {series.length === 0 ? (
          <ChartEmpty
            label="No complaints in this period"
            hint="Nothing was logged against a city in the selected range."
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
                    // city with three of them gets an axis reading 0, 0.75, 1.5.
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
 * `cmpCityData` is a `useMemo` in `use-dashboard-data`, so the reference is
 * stable across the ten other aggregation queries settling — and re-running a
 * Recharts layout plus a canvas label measurement for unchanged data is the most
 * expensive no-op available on this page.
 */
export const ComplaintsCityChart = memo(ComplaintsCityChartImpl);
