import { useMemo } from "react";
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
import { fmtSAR } from "@/lib/branches";
import {
  AXIS_TICK,
  BAR_CURSOR,
  CHART_MARGIN,
  ChartTooltip,
  GRID_OPACITY,
  GRID_STROKE,
  LEGEND_STYLE,
  POINT_CURSOR,
  TOOLTIP_WRAPPER,
  legendText,
} from "../chart-theme";
import { fmtAxisSAR } from "../chart-format";
import type { MonthRow } from "../monthly-growth";
import { AnalyticsCard } from "./analytics-card";
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

const fmtPct = (value: number | string) => {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
};

const fmtAxisPct = (value: number | string) => {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? `${Math.round(n)}%` : "";
};

const fmtCount = (value: number | string) => {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n.toLocaleString() : "—";
};

function ChartPanel({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ComponentProps<typeof AnalyticsCard>["icon"];
  children: React.ReactNode;
}) {
  return (
    <AnalyticsCard title={title} subtitle={subtitle} icon={icon}>
      <div className={`w-full ${CHART_PANEL_HEIGHT}`}>{children}</div>
    </AnalyticsCard>
  );
}

export function MonthlyGrowthCharts({ rows }: { rows: readonly MonthRow[] }) {
  const data = useMemo(
    () =>
      rows.map((r) => ({
        label: r.label,
        careRevenue: r.customerCare?.totalRevenue ?? null,
        telesalesRevenue: r.telesales?.totalRevenue ?? null,
        careOrders: r.customerCare?.totalOrders ?? null,
        telesalesOrders: r.telesales?.totalOrders ?? null,
        cash: r.combined.cashRevenue,
        wasfaty: r.combined.wasfatyRevenue,
        growth: r.combined.revenueGrowth,
      })),
    [rows],
  );

  const growthData = data.filter((d) => d.growth != null);

  return (
    <div className="grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
      <ChartPanel
        title="Monthly revenue trend"
        subtitle="Completed revenue per team, month by month"
        icon={TrendingUp}
      >
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
              content={<ChartTooltip format={fmtSAR} />}
              cursor={POINT_CURSOR}
              wrapperStyle={TOOLTIP_WRAPPER}
            />
            <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
            <Line
              type="monotone"
              dataKey="careRevenue"
              name="Customer Care"
              stroke="var(--color-chart-1)"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="telesalesRevenue"
              name="Telesales"
              stroke="var(--color-chart-3)"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              // Off deliberately: Feb and Mar have no Telesales, and joining
              // March to April would draw a line through months the team did
              // not exist for.
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel
        title="Revenue mix"
        subtitle="Cash against Wasfaty, both teams combined"
        icon={Layers}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={CHART_MARGIN} maxBarSize={48}>
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
              content={<ChartTooltip format={fmtSAR} />}
              cursor={BAR_CURSOR}
              wrapperStyle={TOOLTIP_WRAPPER}
            />
            <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
            <Bar
              dataKey="cash"
              name="Cash"
              stackId="mix"
              fill="var(--color-chart-4)"
              isAnimationActive={false}
            />
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
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel
        title="Month-over-month growth"
        subtitle="Combined completed revenue against the previous month"
        icon={ChartColumnIncreasing}
      >
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
              content={<ChartTooltip format={fmtPct} />}
              cursor={BAR_CURSOR}
              wrapperStyle={TOOLTIP_WRAPPER}
            />
            {/* The zero line is the whole point of this panel: it is what makes
                a bar below it read as a contraction rather than as a short bar. */}
            <ReferenceLine y={0} stroke={GRID_STROKE} strokeOpacity={0.9} />
            <Bar dataKey="growth" name="Growth" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {growthData.map((d, i) => (
                <Cell key={i} fill={(d.growth ?? 0) >= 0 ? "var(--positive)" : "var(--negative)"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel
        title="Order volume"
        subtitle="Completed orders per team, month by month"
        icon={Coins}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={CHART_MARGIN} maxBarSize={28}>
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
              tickFormatter={fmtCount}
              axisLine={false}
              tickLine={false}
              width={48}
              tickMargin={6}
            />
            <Tooltip
              content={<ChartTooltip format={fmtCount} />}
              cursor={BAR_CURSOR}
              wrapperStyle={TOOLTIP_WRAPPER}
            />
            <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
            <Bar
              dataKey="careOrders"
              name="Customer Care"
              fill="var(--color-chart-2)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
            <Bar
              dataKey="telesalesOrders"
              name="Telesales"
              fill="var(--color-chart-5)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>
    </div>
  );
}
