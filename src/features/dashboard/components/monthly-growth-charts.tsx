import { memo, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartColumnIncreasing, Coins, Layers, TrendingUp } from "lucide-react";
import {
  AXIS_TICK,
  BAR_CURSOR,
  CHART_MARGIN,
  ChartTooltip,
  GRID_OPACITY,
  GRID_STROKE,
  LEGEND_STYLE,
  POINT_CURSOR,
  TOOLTIP_MOTION,
  TOOLTIP_WRAPPER,
  legendText,
} from "../chart-theme";
import { fmtAxisSAR } from "../chart-format";
import { InViewChart } from "./in-view-chart";
import { formatCompactSAR, formatCount, formatGrowth } from "../format";
import type { MonthRow } from "../monthly-growth";
import { AnalyticsCard } from "./analytics-card";
import { ChartEmpty } from "./chart-empty";
import { CHART_PANEL_HEIGHT } from "./sales-charts-skeleton";

/**
 * The four monthly-growth panels, in their own module so the section can
 * `lazy()` them.
 *
 * Same reasoning as `sales-charts.tsx`: Recharts is the largest thing this app
 * ships, the dashboard route already pays for it once behind a Suspense
 * boundary, and the tables and insights in this section are readable without it.
 * Every axis, grid, tooltip and legend token is imported from the shared chart
 * theme rather than restyled, so these four read as the same system as the six
 * above them.
 *
 * Nulls are kept as nulls all the way into the series. A month before a team
 * existed is a gap in its line, never a point at zero — `connectNulls` is off
 * for exactly that reason.
 */

/**
 * Recharts hands every value over as `number | string`; the section's shared
 * formatters take numbers. These are the adapters, and nothing more — the
 * charts print figures the same way the tables above them do rather than
 * carrying a second opinion about decimals.
 */
const num = (value: number | string) => (typeof value === "string" ? Number(value) : value);
const finite = (value: number | string) => {
  const n = num(value);
  return Number.isFinite(n) ? n : null;
};

const fmtTooltipSAR = (value: number | string) => formatCompactSAR(finite(value));
const fmtTooltipPct = (value: number | string) => formatGrowth(finite(value));
const fmtTooltipCount = (value: number | string) => formatCount(finite(value));

/** Whole percentages on an axis; the tooltip carries the decimal. */
const fmtAxisPct = (value: number | string) => {
  const n = finite(value);
  return n == null ? "" : `${Math.round(n)}%`;
};

const fmtAxisCount = (value: number | string) => formatCount(finite(value));

/**
 * `empty` is the panel's business, not each chart's: an empty Recharts chart is
 * a pair of axes labelled 0 to 0, which reads as a failure rather than as a
 * timeline with nothing in it yet. Height is unchanged either way, so the grid
 * does not reflow when one panel has data and its neighbour does not.
 */
function ChartPanel({
  title,
  subtitle,
  icon,
  empty,
  emptyHint,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ComponentProps<typeof AnalyticsCard>["icon"];
  empty?: boolean;
  emptyHint?: string;
  children: React.ReactNode;
}) {
  return (
    <AnalyticsCard title={title} subtitle={subtitle} icon={icon}>
      <div className={`w-full ${CHART_PANEL_HEIGHT}`}>
        {empty ? <ChartEmpty label="No months to compare yet" hint={emptyHint} /> : children}
      </div>
    </AnalyticsCard>
  );
}

/** A month still running is drawn back, not drawn as if it had finished. */
const PARTIAL_OPACITY = 0.45;

function MonthlyGrowthChartsImpl({ rows }: { rows: readonly MonthRow[] }) {
  const data = useMemo(
    () =>
      rows.map((r, index) => {
        const previous = rows[index - 1];
        // The one sentence each tooltip closes with. Precomputed per point
        // because it differs per point — a growth bar is measured against
        // whichever month precedes it, and the last month may not be over.
        const progress = r.partial ? "In progress — partial month" : "";
        return {
          label: r.label,
          careRevenue: r.customerCare?.totalRevenue ?? null,
          telesalesRevenue: r.telesales?.totalRevenue ?? null,
          careOrders: r.customerCare?.totalOrders ?? null,
          telesalesOrders: r.telesales?.totalOrders ?? null,
          cash: r.combined.cashRevenue,
          wasfaty: r.combined.wasfatyRevenue,
          growth: r.combined.revenueGrowth,
          partial: r.partial,
          note: progress || undefined,
          growthNote:
            [previous ? `vs ${previous.label}` : null, progress || null]
              .filter(Boolean)
              .join(" · ") || undefined,
        };
      }),
    [rows],
  );

  const growthData = useMemo(() => data.filter((d) => d.growth != null), [data]);

  return (
    <div className="dash-print-2col grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
      <ChartPanel
        title="Monthly revenue trend"
        subtitle="Completed revenue per team, month by month"
        icon={TrendingUp}
        empty={data.length === 0}
        emptyHint="Completed revenue appears here once a month has closed."
      >
        <InViewChart identity={data}>
          {(motion) => (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={CHART_MARGIN}>
                <CartesianGrid
                  vertical={false}
                  strokeDasharray="3 3"
                  stroke={GRID_STROKE}
                  strokeOpacity={GRID_OPACITY}
                />
                <XAxis
                  dataKey="label"
                  tick={AXIS_TICK}
                  tickMargin={8}
                  minTickGap={8}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={AXIS_TICK}
                  tickFormatter={fmtAxisSAR}
                  axisLine={false}
                  tickLine={false}
                  width={52}
                  tickMargin={6}
                />
                <Tooltip
                  content={<ChartTooltip format={fmtTooltipSAR} footerKey="note" />}
                  cursor={POINT_CURSOR}
                  wrapperStyle={TOOLTIP_WRAPPER}
                  {...TOOLTIP_MOTION}
                />
                <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
                {/* Dots small and unfilled-looking at rest, decisive on hover. A
                  3px dot at every month on two series is fourteen marks competing
                  with the two lines they belong to; the reader wants the shape,
                  and the exact point only where the pointer is. `activeDot` takes
                  a card-coloured ring so it reads as lifted off the line. */}
                <Line
                  type="monotone"
                  dataKey="careRevenue"
                  name="Customer Care"
                  stroke="var(--color-chart-1)"
                  strokeWidth={2}
                  dot={{ r: 2, strokeWidth: 0, fill: "var(--color-chart-1)" }}
                  activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--color-card)" }}
                  connectNulls={false}
                  {...motion.line}
                />
                <Line
                  type="monotone"
                  dataKey="telesalesRevenue"
                  name="Telesales"
                  stroke="var(--color-chart-3)"
                  strokeWidth={2}
                  dot={{ r: 2, strokeWidth: 0, fill: "var(--color-chart-3)" }}
                  activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--color-card)" }}
                  // Off deliberately: Feb and Mar have no Telesales, and joining
                  // March to April would draw a line through months the team did
                  // not exist for.
                  connectNulls={false}
                  {...motion.line}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </InViewChart>
      </ChartPanel>

      <ChartPanel
        title="Revenue mix"
        subtitle="Cash against Wasfaty, both teams combined"
        icon={Layers}
        empty={data.length === 0}
        emptyHint="The Cash and Wasfaty split appears once a month has closed."
      >
        <InViewChart identity={data}>
          {(motion) => (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={CHART_MARGIN} maxBarSize={44} barCategoryGap="24%">
                <CartesianGrid
                  vertical={false}
                  strokeDasharray="3 3"
                  stroke={GRID_STROKE}
                  strokeOpacity={GRID_OPACITY}
                />
                <XAxis
                  dataKey="label"
                  tick={AXIS_TICK}
                  tickMargin={8}
                  minTickGap={8}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={AXIS_TICK}
                  tickFormatter={fmtAxisSAR}
                  axisLine={false}
                  tickLine={false}
                  width={52}
                  tickMargin={6}
                />
                <Tooltip
                  content={<ChartTooltip format={fmtTooltipSAR} footerKey="note" />}
                  cursor={BAR_CURSOR}
                  wrapperStyle={TOOLTIP_WRAPPER}
                  {...TOOLTIP_MOTION}
                />
                <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
                <Bar
                  dataKey="cash"
                  name="Cash"
                  stackId="mix"
                  fill="var(--color-chart-4)"
                  {...motion.bar}
                >
                  {data.map((d) => (
                    <Cell key={d.label} fillOpacity={d.partial ? PARTIAL_OPACITY : 1} />
                  ))}
                </Bar>
                {/* Cash and Wasfaty are the only order types there are
                  (`ORDER_TYPES`), so the mix is the whole of the mix. Where a
                  historical month's stated total exceeds its two channels, the
                  total stays authoritative everywhere it is reported and the
                  difference is simply not a segment — a bar labelled with a
                  category the business does not have is worse than a bar that is
                  marginally shorter than the total beside it. */}
                <Bar
                  dataKey="wasfaty"
                  name="Wasfaty"
                  stackId="mix"
                  fill="var(--color-chart-1)"
                  radius={[6, 6, 0, 0]}
                  {...motion.bar}
                >
                  {data.map((d) => (
                    <Cell key={d.label} fillOpacity={d.partial ? PARTIAL_OPACITY : 1} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </InViewChart>
      </ChartPanel>

      <ChartPanel
        title="Month-over-month growth"
        subtitle="Combined completed revenue against the previous month"
        icon={ChartColumnIncreasing}
        empty={growthData.length === 0}
        emptyHint="Growth needs two closed months to compare."
      >
        <InViewChart identity={growthData}>
          {(motion) => (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={growthData} margin={CHART_MARGIN} maxBarSize={48}>
                <CartesianGrid
                  vertical={false}
                  strokeDasharray="3 3"
                  stroke={GRID_STROKE}
                  strokeOpacity={GRID_OPACITY}
                />
                <XAxis
                  dataKey="label"
                  tick={AXIS_TICK}
                  tickMargin={8}
                  minTickGap={8}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={AXIS_TICK}
                  tickFormatter={fmtAxisPct}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tickMargin={6}
                />
                <Tooltip
                  content={<ChartTooltip format={fmtTooltipPct} footerKey="growthNote" />}
                  cursor={BAR_CURSOR}
                  wrapperStyle={TOOLTIP_WRAPPER}
                  {...TOOLTIP_MOTION}
                />
                {/* The zero line is the whole point of this panel: it is what makes
                  a bar below it read as a contraction rather than as a short bar. */}
                <ReferenceLine y={0} stroke={GRID_STROKE} strokeOpacity={0.9} />
                <Bar dataKey="growth" name="Revenue growth" radius={[4, 4, 0, 0]} {...motion.bar}>
                  {growthData.map((d) => (
                    <Cell
                      key={d.label}
                      fill={(d.growth ?? 0) >= 0 ? "var(--positive)" : "var(--negative)"}
                      /* A month still running is being compared with a whole one,
                       so its bar is the one figure on this panel that is not yet
                       a fact. Drawn back and outlined rather than omitted: the
                       month is genuinely there, it is just not finished, and the
                       tooltip says so in words for anyone who cannot see the
                       difference in tone. */
                      fillOpacity={d.partial ? PARTIAL_OPACITY : 1}
                      stroke={
                        d.partial
                          ? (d.growth ?? 0) >= 0
                            ? "var(--positive)"
                            : "var(--negative)"
                          : undefined
                      }
                      strokeWidth={d.partial ? 1 : 0}
                      strokeDasharray={d.partial ? "3 2" : undefined}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </InViewChart>
      </ChartPanel>

      <ChartPanel
        title="Order volume"
        subtitle="Completed orders per team, month by month"
        icon={Coins}
        empty={data.length === 0}
        emptyHint="Completed order counts appear once a month has closed."
      >
        <InViewChart identity={data}>
          {(motion) => (
            <ResponsiveContainer width="100%" height="100%">
              {/* `barGap` pairs the two teams within a month and `barCategoryGap`
                separates the months, so the eye compares the pair before it
                compares the row — which is the question the panel is asked. */}
              <BarChart
                data={data}
                margin={CHART_MARGIN}
                maxBarSize={26}
                barGap={3}
                barCategoryGap="26%"
              >
                <CartesianGrid
                  vertical={false}
                  strokeDasharray="3 3"
                  stroke={GRID_STROKE}
                  strokeOpacity={GRID_OPACITY}
                />
                <XAxis
                  dataKey="label"
                  tick={AXIS_TICK}
                  tickMargin={8}
                  minTickGap={8}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={AXIS_TICK}
                  tickFormatter={fmtAxisCount}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tickMargin={6}
                />
                <Tooltip
                  content={<ChartTooltip format={fmtTooltipCount} unit="orders" footerKey="note" />}
                  cursor={BAR_CURSOR}
                  wrapperStyle={TOOLTIP_WRAPPER}
                  {...TOOLTIP_MOTION}
                />
                <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
                <Bar
                  dataKey="careOrders"
                  name="Customer Care"
                  fill="var(--color-chart-2)"
                  radius={[4, 4, 0, 0]}
                  {...motion.bar}
                >
                  {data.map((d) => (
                    <Cell key={d.label} fillOpacity={d.partial ? PARTIAL_OPACITY : 1} />
                  ))}
                </Bar>
                <Bar
                  dataKey="telesalesOrders"
                  name="Telesales"
                  fill="var(--color-chart-5)"
                  radius={[4, 4, 0, 0]}
                  {...motion.bar}
                >
                  {data.map((d) => (
                    <Cell key={d.label} fillOpacity={d.partial ? PARTIAL_OPACITY : 1} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </InViewChart>
      </ChartPanel>
    </div>
  );
}

/**
 * Memoised on `rows`, and that is load-bearing now that these panels animate.
 *
 * The section owns the Combined / Customer Care / Telesales toggle, so every
 * click on it re-renders this subtree with the identical `rows` reference. Left
 * unmemoised that is four Recharts layouts recomputed for no new information —
 * and, with `isAnimationActive` on, a risk of the enter animation replaying on
 * a tab click. `rows` comes from `useMonthlyGrowth`'s `useMemo`, so comparing it
 * by reference is both correct and as cheap as the default shallow compare.
 */
export const MonthlyGrowthCharts = memo(
  MonthlyGrowthChartsImpl,
  (prev, next) => prev.rows === next.rows,
);
