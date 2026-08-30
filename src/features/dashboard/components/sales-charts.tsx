import { memo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ChartColumn, ChartPie, Trophy, Building2, MapPinned, Users } from "lucide-react";

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
  TOOLTIP_MOTION,
  TOOLTIP_WRAPPER,
  legendText,
} from "../chart-theme";
import { fmtAxisSAR } from "../chart-format";
import { InViewChart } from "./in-view-chart";
import { AnalyticsCard } from "./analytics-card";
import { ChartEmpty } from "./chart-empty";
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

/**
 * A fixed-height panel, for the charts whose height does not follow row count.
 *
 * `empty` is handled here rather than at each call site because an empty
 * Recharts chart is not an empty panel — it is a set of axes labelled 0 to 0
 * with nothing between them, which reads as a chart that failed rather than as a
 * period with no orders in it. The panel keeps its height either way, so a
 * filter that empties one card does not resize the row it shares.
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
  icon?: LucideIcon;
  empty?: boolean;
  emptyHint?: string;
  children: React.ReactNode;
}) {
  return (
    <AnalyticsCard title={title} subtitle={subtitle} icon={icon}>
      <div className={`w-full ${CHART_PANEL_HEIGHT}`}>
        {empty ? <ChartEmpty hint={emptyHint} /> : children}
      </div>
    </AnalyticsCard>
  );
}

/**
 * "Sales by team", with a hover state you can actually see.
 *
 * A single `<Bar fill>` gives every bar one immutable paint, so the only hover
 * feedback was Recharts' grey cursor band — nearly invisible against the card.
 * Tracking the hovered index lets each `<Cell>` brighten itself and fade its
 * siblings, which is the BI-dashboard convention and reads instantly.
 */
function TeamBarChart({ data }: { data: (Named & { sales: number })[] }) {
  const [active, setActive] = useState<number | null>(null);

  return (
    <InViewChart identity={data}>
      {(motion) => (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={CHART_MARGIN}
            maxBarSize={64}
            onMouseLeave={() => setActive(null)}
          >
            <defs>
              <linearGradient id="teamBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-chart-2)" stopOpacity={1} />
                <stop offset="100%" stopColor="var(--color-chart-2)" stopOpacity={0.7} />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke={GRID_STROKE}
              strokeOpacity={GRID_OPACITY}
            />
            <XAxis
              dataKey="name"
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <YAxis
              tick={AXIS_TICK}
              tickFormatter={fmtAxisSAR}
              tickLine={false}
              axisLine={false}
              width={52}
              tickMargin={6}
            />
            <Tooltip
              content={<ChartTooltip format={fmtSAR} />}
              cursor={BAR_CURSOR}
              wrapperStyle={TOOLTIP_WRAPPER}
              {...TOOLTIP_MOTION}
            />
            <Bar
              dataKey="sales"
              name="Completed sales"
              fill="url(#teamBar)"
              radius={[6, 6, 0, 0]}
              {...motion.bar}
              onMouseEnter={(_, index: number) => setActive(index)}
            >
              {data.map((t, i) => {
                const isActive = active === i;
                const dimmed = active !== null && !isActive;
                return (
                  <Cell
                    key={t.name}
                    cursor="pointer"
                    fillOpacity={dimmed ? 0.35 : 1}
                    stroke={isActive ? "var(--color-chart-2)" : "transparent"}
                    strokeWidth={isActive ? 1.5 : 0}
                    style={{
                      transition: "opacity 220ms ease, filter 220ms ease, transform 220ms ease",
                      filter: isActive
                        ? "brightness(1.12) drop-shadow(0 6px 14px color-mix(in oklab, var(--color-chart-2) 45%, transparent))"
                        : "none",
                    }}
                  />
                );
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </InViewChart>
  );
}

function SalesChartsImpl({ data }: { data: SalesChartsData }) {
  return (
    <div className="grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
      <ChartPanel
        title="Daily sales trend"
        subtitle="All orders against completed"
        icon={ChartColumn}
        empty={data.dailyData.length === 0}
        emptyHint="No orders were logged in the selected range."
      >
        <InViewChart identity={data.dailyData}>
          {(motion) => (
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
                  {...TOOLTIP_MOTION}
                />
                <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
                <Area
                  type="monotone"
                  dataKey="total"
                  name="All"
                  stroke="var(--color-chart-1)"
                  strokeWidth={2}
                  fill="url(#dailyAll)"
                  activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--color-card)" }}
                  {...motion.area}
                />
                <Area
                  type="monotone"
                  dataKey="completed"
                  name="Completed"
                  stroke="var(--positive)"
                  strokeWidth={2}
                  fill="url(#dailyCompleted)"
                  activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--color-card)" }}
                  {...motion.area}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </InViewChart>
      </ChartPanel>

      <ChartPanel
        title="Orders by status"
        subtitle="Share of orders in the period"
        icon={ChartPie}
        empty={data.statusData.length === 0}
        emptyHint="No orders were logged in the selected range."
      >
        <InViewChart identity={data.statusData}>
          {(motion) => (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data.statusData}
                  dataKey="value"
                  nameKey="name"
                  // A donut rather than a full pie. The centre of a pie carries
                  // no information — every slice's angle is already readable at
                  // the rim — while the wedges converging on a point is what
                  // makes a small slice a sliver too thin to hold its own
                  // colour. The ring reads the same and gives every category a
                  // band of even thickness.
                  innerRadius={52}
                  outerRadius={80}
                  // A degree and a half of air between neighbours, so the
                  // boundary is a gap rather than a seam painted in card colour.
                  paddingAngle={1.5}
                  label={PIE_LABEL}
                  // Separates a slice from its neighbour with the card colour rather
                  // than the default black hairline, which is a visible seam on dark.
                  stroke="var(--color-card)"
                  strokeWidth={2}
                  // Recharts defaults a Pie to 1500ms behind a 400ms delay, which is
                  // nearly two seconds of spinning wedge on a page of half-second
                  // panels. The `pie` preset caps BOTH — the delay was the half the
                  // old `motion.bar` spread did not carry, and it left this the one
                  // panel that started after all the others.
                  {...motion.pie}
                >
                  {data.statusData.map((s, i) => (
                    <Cell key={i} fill={STATUS_COLORS[s.name] ?? COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
                {/* No heading: a pie tooltip's label and its single row name the same
                slice, so the heading was the word repeated twice. */}
                <Tooltip
                  content={<ChartTooltip hideLabel />}
                  wrapperStyle={TOOLTIP_WRAPPER}
                  {...TOOLTIP_MOTION}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </InViewChart>
      </ChartPanel>

      <ChartPanel
        title="Sales by team"
        subtitle="Completed sales per team"
        icon={Users}
        empty={data.teamData.length === 0}
        emptyHint="No completed sales were recorded in the selected range."
      >
        <TeamBarChart data={data.teamData} />
      </ChartPanel>

      <HorizontalBarPanel
        title="Top agents by sales"
        subtitle="Completed sales per agent"
        icon={Trophy}
        data={data.agentSalesData}
        color="var(--color-chart-3)"
      />

      <HorizontalBarPanel
        title="Sales by branch (top 10)"
        subtitle="Completed sales per branch"
        icon={Building2}
        data={data.branchData}
        color="var(--color-chart-4)"
      />

      <HorizontalBarPanel
        title="Sales by city"
        subtitle="Completed sales per city"
        icon={MapPinned}
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
