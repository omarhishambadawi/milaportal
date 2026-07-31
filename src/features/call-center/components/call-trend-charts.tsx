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
  total: number;
  answered: number;
  inbound: number;
  outbound: number;
}

/**
 * Inbound-vs-outbound volume and answer rate over time.
 *
 * Lifted unchanged from the combined Call Center page so the Customer Care and
 * Telesales dashboards render exactly the same charts rather than each growing
 * their own copy. Purely presentational — every number arrives pre-computed by
 * the analytics engine.
 */
export function CallTrendCharts({ byDay, loading }: { byDay: DayRow[]; loading: boolean }) {
  return (
    <div className="grid lg:grid-cols-2 gap-3">
      <ChartCard title="Inbound vs outbound" loading={loading} hasData={byDay.length > 0}>
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

      <ChartCard title="Answer rate over time" loading={loading} hasData={byDay.length > 0}>
        <ResponsiveContainer>
          <LineChart
            data={byDay.map((d) => ({
              date: d.date,
              rate: d.total ? (d.answered / d.total) * 100 : 0,
            }))}
            margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
          >
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
