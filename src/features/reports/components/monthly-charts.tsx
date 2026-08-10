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
import { Banknote, Building2, ChartColumn, ChartPie, MapPinned, Truck, Users } from "lucide-react";
import { fmtSAR } from "@/lib/branches";
import { AnalyticsCard } from "@/features/dashboard/components/analytics-card";
import { HorizontalBarPanel } from "@/features/dashboard/components/horizontal-bar-panel";
import { COLORS, STATUS_COLORS } from "@/features/dashboard/constants";
import { fmtAxisSAR } from "@/features/dashboard/chart-format";
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
} from "@/features/dashboard/chart-theme";
import type { TrendPoint } from "../monthly";

/**
 * Every chart on the Monthly Report, in one lazily-loaded module.
 *
 * One boundary rather than seven, for the reason the Dashboard's own
 * `sales-charts.tsx` gives: seven lazy boundaries mean seven chunks, seven
 * waterfalls and seven cards popping into a grid at different moments — worse
 * than one skeleton that resolves at once. Recharts is the largest dependency
 * the app ships and the Daily Report, which is what the page opens on, has no
 * chart in it, so keeping the split itself is what matters.
 *
 * Nothing here fetches, derives or re-derives a figure. Every series arrives
 * shaped from `useMonthlyReport`, which builds them from the same buckets the
 * tables above them render. Every axis, grid, tooltip, legend and palette token
 * is imported from the Dashboard's chart theme rather than restyled, so these
 * read as the same system as the six on that page.
 */

interface Named {
  name: string;
}

export interface MonthlyChartData {
  /** Total against completed revenue, per team and for the month. */
  teamRevenue: { name: string; total: number; completed: number }[];
  trend: readonly TrendPoint[];
  topCities: (Named & { sales: number })[];
  topBranches: (Named & { sales: number })[];
  statusData: (Named & { value: number })[];
  deliveryRevenue: (Named & { sales: number })[];
  orderTypeRevenue: (Named & { sales: number })[];
}

/** Fixed-height panel, for the charts whose height does not follow row count. */
function ChartPanel({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: typeof ChartPie;
  children: React.ReactNode;
}) {
  return (
    <AnalyticsCard title={title} subtitle={subtitle} icon={icon} className="break-inside-avoid">
      {/* `min-w-0` on the sizing wrapper is what stops a Recharts panel from
          refusing to shrink inside a grid track and pushing the page into a
          horizontal scroll. */}
      <div className="h-[280px] w-full min-w-0">{children}</div>
    </AnalyticsCard>
  );
}

function EmptyPanel() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      No data
    </div>
  );
}

export function MonthlyCharts({ data }: { data: MonthlyChartData }) {
  return (
    <div className="grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2 print:grid-cols-1 print:gap-3">
      {/* 1 — Revenue by team ------------------------------------------------ */}
      <ChartPanel
        title="Revenue by team (SAR)"
        subtitle="All orders against completed, with the month's total"
        icon={Users}
      >
        {data.teamRevenue.length === 0 ? (
          <EmptyPanel />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.teamRevenue} margin={CHART_MARGIN} maxBarSize={48}>
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
              />
              <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
              <Bar
                dataKey="total"
                name="Total revenue"
                fill="var(--color-chart-1)"
                radius={[6, 6, 0, 0]}
              />
              <Bar
                dataKey="completed"
                name="Completed revenue"
                fill="var(--positive)"
                radius={[6, 6, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartPanel>

      {/* 2 — Daily revenue trend -------------------------------------------- */}
      <ChartPanel
        title="Daily revenue trend"
        subtitle="Total against completed, by day"
        icon={ChartColumn}
      >
        {data.trend.length === 0 ? (
          <EmptyPanel />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.trend as TrendPoint[]} margin={CHART_MARGIN}>
              <defs>
                <linearGradient id="monthlyAll" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="monthlyCompleted" x1="0" y1="0" x2="0" y2="1">
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
                name="Total revenue"
                stroke="var(--color-chart-1)"
                fill="url(#monthlyAll)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="completed"
                name="Completed revenue"
                stroke="var(--positive)"
                fill="url(#monthlyCompleted)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartPanel>

      {/* 3 — Revenue by city ------------------------------------------------ */}
      <HorizontalBarPanel
        title="Revenue by city (top 10)"
        subtitle="Completed revenue per city"
        icon={MapPinned}
        data={data.topCities}
        color="var(--color-chart-5)"
        barName="Completed revenue"
      />

      {/* 4 — Top branches --------------------------------------------------- */}
      <HorizontalBarPanel
        title="Top branches (top 10)"
        subtitle="Completed revenue per branch"
        icon={Building2}
        data={data.topBranches}
        color="var(--color-chart-4)"
        barName="Completed revenue"
      />

      {/* 5 — Order status distribution -------------------------------------- */}
      <ChartPanel
        title="Order status distribution"
        subtitle="Orders in the month, by status"
        icon={ChartPie}
      >
        {data.statusData.length === 0 ? (
          <EmptyPanel />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data.statusData}
                dataKey="value"
                nameKey="name"
                outerRadius={82}
                label={PIE_LABEL}
                stroke="var(--color-card)"
                strokeWidth={2}
              >
                {/* The status names and their colours are the Dashboard's own
                    mapping. Completed, Pending and Cancelled are the three the
                    brief names; any other status the RPC returns keeps its
                    palette slot rather than being folded into "other", which
                    would make this chart's total disagree with the table. */}
                {data.statusData.map((slice, index) => (
                  <Cell
                    key={slice.name}
                    fill={STATUS_COLORS[slice.name] ?? COLORS[index % COLORS.length]}
                  />
                ))}
              </Pie>
              <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
              <Tooltip content={<ChartTooltip hideLabel />} wrapperStyle={TOOLTIP_WRAPPER} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </ChartPanel>

      {/* 6 — Revenue share by delivery company ------------------------------ */}
      <ChartPanel
        title="Revenue share by delivery company"
        subtitle="Completed revenue per delivery method"
        icon={Truck}
      >
        {data.deliveryRevenue.length === 0 ? (
          <EmptyPanel />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data.deliveryRevenue}
                dataKey="sales"
                nameKey="name"
                outerRadius={82}
                innerRadius={40}
                label={PIE_LABEL}
                stroke="var(--color-card)"
                strokeWidth={2}
              >
                {data.deliveryRevenue.map((slice, index) => (
                  <Cell key={slice.name} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Legend iconType="circle" wrapperStyle={LEGEND_STYLE} formatter={legendText} />
              <Tooltip
                content={<ChartTooltip hideLabel format={fmtSAR} />}
                wrapperStyle={TOOLTIP_WRAPPER}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </ChartPanel>

      {/* 7 — Cash vs Wasfaty ------------------------------------------------ */}
      <ChartPanel
        title="Cash vs Wasfaty revenue"
        subtitle="Completed revenue by order type"
        icon={Banknote}
      >
        {data.orderTypeRevenue.length === 0 ? (
          <EmptyPanel />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.orderTypeRevenue} margin={CHART_MARGIN} maxBarSize={72}>
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
              />
              <Bar dataKey="sales" name="Completed revenue" radius={[6, 6, 0, 0]}>
                {data.orderTypeRevenue.map((row, index) => (
                  <Cell key={row.name} fill={COLORS[index % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartPanel>
    </div>
  );
}
