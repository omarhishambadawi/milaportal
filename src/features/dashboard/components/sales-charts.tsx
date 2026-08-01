import { memo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtSAR } from "@/lib/branches";
import { COLORS, STATUS_COLORS } from "../constants";
import {
  AXIS_TICK,
  BAR_CURSOR,
  CHART_MARGIN,
  ChartTooltip,
  GRID_OPACITY,
  GRID_STROKE,
  LEGEND_STYLE,
  PIE_LABEL,
  POINT_CURSOR,
  TOOLTIP_WRAPPER,
  legendText,
} from "../chart-theme";
import { fmtAxisSAR } from "../chart-format";
import { AnalyticsCard } from "./analytics-card";
import { HorizontalBarPanel } from "./horizontal-bar-panel";
import { CHART_PANEL_HEIGHT } from "./sales-charts-skeleton";

/**
 * The dashboard's six Recharts panels, in their own module so they can be
 * `lazy()`-loaded.
 *
 * Recharts is 364KB minified — by a wide margin the largest thing this app
 * ships that is not the XLSX writer, and the XLSX writer has been lazy for a
 * while. It was a static import of the dashboard route, so navigating to
 * /dashboard fetched it before React rendered anything at all: the KPI cards,
 * the stat tiles and the delivery matrix — none of which involve a chart — sat
 * behind a charting library.
 *
 * Split out, the route paints its numbers off an 87KB chunk and the charts
 * arrive when they arrive.
 *
 * Kept as one component rather than six, deliberately. Six lazy boundaries mean
 * six chunks, six waterfalls and six independently-arriving cards popping into
 * a grid at different moments — worse than one skeleton that resolves at once.
 *
 * The three ranked bar charts live in `HorizontalBarPanel`; they were three
 * copies of one chart differing only in a hard-coded axis width, which is what
 * clipped their labels. See that file.
 */

interface Named {
  name: string;
}

export interface SalesChartsData {
  dailyData: { date: string; total: number; completed: number }[];
  statusData: (Named & { value: number })[];
  teamData: (Named & { sales: number })[];
  agentSalesData: (Named & { sales: number })[];
  branchData: (Named & { sales: number })[];
  cityData: (Named & { sales: number })[];
}

/** A fixed-height panel, for the charts whose height does not follow row count. */
function ChartPanel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <AnalyticsCard title={title} subtitle={subtitle}>
      <div className={`w-full ${CHART_PANEL_HEIGHT}`}>{children}</div>
    </AnalyticsCard>
  );
}

function SalesChartsImpl({ data }: { data: SalesChartsData }) {
  return (
    <div className="grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
      <ChartPanel title="Daily sales trend" subtitle="All orders against completed">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.dailyData} margin={CHART_MARGIN}>
            <defs>
              <linearGradient id="dailyAll" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="dailyCompleted" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--positive)" stopOpacity={0.4} />
                <stop offset="100%" stopColor="var(--positive)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke={GRID_STROKE}
              strokeOpacity={GRID_OPACITY}
            />
            <XAxis
              dataKey="date"
              tick={AXIS_TICK}
              tickMargin={8}
              minTickGap={12}
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
            <Area
              type="monotone"
              dataKey="total"
              name="All"
              stroke="var(--color-chart-1)"
              strokeWidth={2}
              fill="url(#dailyAll)"
              activeDot={{ r: 4 }}
              isAnimationActive
              animationDuration={500}
            />
            <Area
              type="monotone"
              dataKey="completed"
              name="Completed"
              stroke="var(--positive)"
              strokeWidth={2}
              fill="url(#dailyCompleted)"
              activeDot={{ r: 4 }}
              isAnimationActive
              animationDuration={600}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel title="Orders by status" subtitle="Share of orders in the period">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data.statusData}
              dataKey="value"
              nameKey="name"
              outerRadius={80}
              label={PIE_LABEL}
              // Separates a slice from its neighbour with the card colour rather
              // than the default black hairline, which is a visible seam on dark.
              stroke="var(--color-card)"
              strokeWidth={2}
            >
              {data.statusData.map((s, i) => (
                <Cell key={i} fill={STATUS_COLORS[s.name] ?? COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
            {/* No heading: a pie tooltip's label and its single row name the same
                slice, so the heading was the word repeated twice. */}
            <Tooltip content={<ChartTooltip hideLabel />} wrapperStyle={TOOLTIP_WRAPPER} />
          </PieChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel title="Sales by team" subtitle="Completed sales per team">
        <TeamBarChart data={data.teamData} />
      </ChartPanel>

      <HorizontalBarPanel
        title="Top agents by sales"
        subtitle="Completed sales per agent"
        data={data.agentSalesData}
        color="var(--color-chart-3)"
      />

      <HorizontalBarPanel
        title="Sales by branch (top 10)"
        subtitle="Completed sales per branch"
        data={data.branchData}
        color="var(--color-chart-4)"
      />

      <HorizontalBarPanel
        title="Sales by city"
        subtitle="Completed sales per city"
        data={data.cityData}
        color="var(--color-chart-5)"
      />
    </div>
  );
}

/** The series this component actually reads. */
const SERIES_KEYS = [
  "dailyData",
  "statusData",
  "teamData",
  "agentSalesData",
  "branchData",
  "cityData",
] as const;

/**
 * Memoised at the boundary, with a comparator rather than the default.
 *
 * `useDashboardData` returns a fresh object literal on every render, so a plain
 * `memo` here would never once hit — the `data` prop is a new reference each
 * time even when nothing in it changed. The six series *inside* it are each
 * `useMemo`d and are stable, so comparing them by reference is both correct and
 * as cheap as the default shallow compare would have been.
 *
 * This matters because the route re-renders on every filter change and every
 * background refetch, and re-running six Recharts layouts is the most expensive
 * no-op on the page.
 */
export const SalesCharts = memo(
  SalesChartsImpl,
  (prev, next) => !SERIES_KEYS.some((k) => prev.data[k] !== next.data[k]),
);

// The Suspense fallback lives in ./sales-charts-skeleton so importing it does
// not pull Recharts back into the route's chunk.
