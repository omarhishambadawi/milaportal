import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtSAR } from "@/lib/branches";
import { fmtAxisSAR } from "@/features/dashboard/chart-format";
import {
  AXIS_TICK,
  CHART_MARGIN,
  ChartTooltip,
  GRID_OPACITY,
  GRID_STROKE,
  LEGEND_STYLE,
  POINT_CURSOR,
  TOOLTIP_WRAPPER,
  legendText,
} from "@/features/dashboard/chart-theme";
import type { TrendPoint } from "../monthly";

/**
 * The month's daily sales, as one area chart.
 *
 * Its own module so the Reports page can `lazy()` it: Recharts is the largest
 * dependency this app ships, and the Daily Report — which is what the page opens
 * on and what most visits are for — has no chart in it at all. Loading a
 * charting library to render a WhatsApp message would be the same mistake the
 * Dashboard already fixed for itself.
 *
 * Every axis, grid, tooltip and legend token is imported from the Dashboard's
 * chart theme rather than restyled here, so the one chart on this page reads as
 * the same system as the six on that one.
 */
export function MonthlyTrendChart({ data }: { data: readonly TrendPoint[] }) {
  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data as TrendPoint[]} margin={CHART_MARGIN}>
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
            name="All orders"
            stroke="var(--color-chart-1)"
            fill="url(#monthlyAll)"
            strokeWidth={2}
          />
          <Area
            type="monotone"
            dataKey="completed"
            name="Completed"
            stroke="var(--positive)"
            fill="url(#monthlyCompleted)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
