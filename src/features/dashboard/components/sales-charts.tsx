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

/**
 * Recharts renders its tooltip into a plain div with inline styles, so it does
 * not inherit `bg-popover` from anything. Left unset it defaults to white — a
 * white card with black text on top of a dark dashboard. Three of the six charts
 * had no `contentStyle` at all.
 */
const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: "1px solid var(--color-border)",
  background: "var(--color-popover)",
  color: "var(--color-popover-foreground)",
  fontSize: 12,
} as const;

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
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11 }}
              tickMargin={6}
              axisLine={false}
              tickLine={false}
            />
            <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
            <Tooltip formatter={(v: number | string) => fmtSAR(v)} contentStyle={TOOLTIP_STYLE} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
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
            <Pie data={data.statusData} dataKey="value" nameKey="name" outerRadius={80} label>
              {data.statusData.map((s, i) => (
                <Cell key={i} fill={STATUS_COLORS[s.name] ?? COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Legend />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
          </PieChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Sales by team">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.teamData}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number | string) => fmtSAR(v)} contentStyle={TOOLTIP_STYLE} />
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
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number | string) => fmtSAR(v)} contentStyle={TOOLTIP_STYLE} />
            <Bar dataKey="sales" fill="var(--color-chart-3)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Sales by branch (top 10)">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.branchData} layout="vertical">
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number | string) => fmtSAR(v)} contentStyle={TOOLTIP_STYLE} />
            <Bar dataKey="sales" fill="var(--color-chart-4)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Sales by city">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.cityData} layout="vertical">
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number | string) => fmtSAR(v)} contentStyle={TOOLTIP_STYLE} />
            <Bar dataKey="sales" fill="var(--color-chart-5)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Panel>
    </div>
  );
}

// The Suspense fallback lives in ./sales-charts-skeleton so importing it does
// not pull Recharts back into the route's chunk.
