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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtSAR } from "@/lib/branches";
import { COLORS, STATUS_COLORS } from "../constants";
import {
  AXIS_TICK,
  BAR_CURSOR,
  ChartTooltip,
  GRID_STROKE,
  LEGEND_STYLE,
  PIE_LABEL,
  POINT_CURSOR,
  TOOLTIP_WRAPPER,
  legendText,
} from "../chart-theme";
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
 * arrive when they arrive. Nothing about the charts themselves changed; this is
 * a verbatim move plus a props interface.
 *
 * Kept as one component rather than six, deliberately. Six lazy boundaries mean
 * six chunks, six waterfalls and six independently-arriving cards popping into
 * a grid at different moments — worse than one skeleton that resolves at once.
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className={CHART_PANEL_HEIGHT}>{children}</CardContent>
    </Card>
  );
}

export function SalesCharts({ data }: { data: SalesChartsData }) {
  return (
    <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
      <Panel title="Daily sales trend">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.dailyData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
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
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis
              dataKey="date"
              tick={AXIS_TICK}
              tickMargin={6}
              axisLine={false}
              tickLine={false}
            />
            <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
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
      </Panel>

      <Panel title="Orders by status">
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
      </Panel>

      <Panel title="Sales by team">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.teamData}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="name" tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <Tooltip
              content={<ChartTooltip format={fmtSAR} />}
              cursor={BAR_CURSOR}
              wrapperStyle={TOOLTIP_WRAPPER}
            />
            <Bar
              dataKey="sales"
              name="Completed sales"
              fill="var(--color-chart-2)"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Top agents by sales">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.agentSalesData} layout="vertical">
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="name"
              width={130}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              content={<ChartTooltip format={fmtSAR} />}
              cursor={BAR_CURSOR}
              wrapperStyle={TOOLTIP_WRAPPER}
            />
            <Bar
              dataKey="sales"
              name="Completed sales"
              fill="var(--color-chart-3)"
              radius={[0, 4, 4, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Sales by branch (top 10)">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.branchData} layout="vertical">
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="name"
              width={80}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              content={<ChartTooltip format={fmtSAR} />}
              cursor={BAR_CURSOR}
              wrapperStyle={TOOLTIP_WRAPPER}
            />
            <Bar
              dataKey="sales"
              name="Completed sales"
              fill="var(--color-chart-4)"
              radius={[0, 4, 4, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Sales by city">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.cityData} layout="vertical">
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="name"
              width={90}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              content={<ChartTooltip format={fmtSAR} />}
              cursor={BAR_CURSOR}
              wrapperStyle={TOOLTIP_WRAPPER}
            />
            <Bar
              dataKey="sales"
              name="Completed sales"
              fill="var(--color-chart-5)"
              radius={[0, 4, 4, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </Panel>
    </div>
  );
}

// The Suspense fallback lives in ./sales-charts-skeleton so importing it does
// not pull Recharts back into the route's chunk.
