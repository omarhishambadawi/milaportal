import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid,
  LineChart,
  Line,
  Legend,
} from "recharts";
import { tooltipStyle } from "../constants";
import { ChartCard } from "./chart-card";

interface DayRow {
  date: string;
  inbound: number;
  outbound: number;
}

interface RatePoint {
  date: string;
  rate: number;
}

/**
 * Inbound-vs-outbound volume and answer rate over time.
 *
 * Purely presentational — every number arrives pre-computed by the Metrics
 * Engine, including `answerRate` and `hasData`. This component previously
 * derived the answer-rate series itself, which made it a second place a KPI
 * was defined; the engine owns it now. Do not reintroduce a calculation here.
 *
 * Both arrays are memoised upstream, which matters: Recharts replays its enter
 * animation whenever a `data` prop is a new reference, and rebuilding these per
 * render is what made the charts visibly redraw.
 */
export function CallTrendCharts({
  byDay,
  answerRate,
  hasData,
  loading,
}: {
  byDay: DayRow[];
  answerRate: RatePoint[];
  hasData: boolean;
  loading: boolean;
}) {
  return (
    <div className="grid lg:grid-cols-2 gap-3">
      <ChartCard title="Inbound vs outbound" loading={loading} hasData={hasData}>
        <ResponsiveContainer>
          <BarChart data={byDay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
            />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
            <Bar
              dataKey="inbound"
              name="Inbound"
              fill="var(--color-chart-1)"
              radius={[6, 6, 0, 0]}
              stackId="a"
            />
            <Bar
              dataKey="outbound"
              name="Outbound"
              fill="var(--color-chart-3)"
              radius={[6, 6, 0, 0]}
              stackId="a"
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Answer rate over time" loading={loading} hasData={hasData}>
        <ResponsiveContainer>
          <LineChart data={answerRate} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: any) => [`${Number(v).toFixed(1)}%`, "Answer rate"]}
            />
            <Line
              type="monotone"
              dataKey="rate"
              stroke="var(--color-chart-1)"
              strokeWidth={2.5}
              dot={{ r: 3, fill: "var(--color-chart-1)" }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

/** Calls by hour of day. Same chart on both dashboards. */
export function HourlyDistributionChart({
  hourly12,
  loading,
  hasData,
}: {
  hourly12: Array<{ label: string; inbound: number; outbound: number }>;
  loading: boolean;
  hasData: boolean;
}) {
  return (
    <ChartCard title="Calls by hour" loading={loading} hasData={hasData}>
      <ResponsiveContainer>
        <BarChart data={hourly12} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            interval={0}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
          <Bar
            dataKey="inbound"
            name="Inbound"
            fill="var(--color-chart-1)"
            radius={[6, 6, 0, 0]}
            stackId="h"
          />
          <Bar
            dataKey="outbound"
            name="Outbound"
            fill="var(--color-chart-3)"
            radius={[6, 6, 0, 0]}
            stackId="h"
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
