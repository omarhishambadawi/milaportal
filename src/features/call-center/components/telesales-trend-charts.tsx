import { useMemo } from "react";
import {
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid,
  LineChart,
  Line,
  BarChart,
  Bar,
} from "recharts";
import { fmtSAR } from "@/lib/branches";
import { tooltipStyle } from "../constants";
import { ChartCard } from "./chart-card";

interface DayRow {
  date: string;
  outbound: number;
  outboundAnswered: number;
  cancelledByAgent: number;
}

interface ConversionDayRow {
  date: string;
  rate: number;
  revenue: number;
}

/**
 * Sales-operation trends for Telesales.
 *
 * These replace the inbound-vs-outbound comparison, which said nothing useful
 * about a team that only dials out. Every series here answers a question a
 * sales manager actually asks: are we reaching customers, are agents cutting
 * calls short, are reached calls turning into orders and money.
 */
export function TelesalesTrendCharts({
  byDay,
  perDay,
  loading,
}: {
  byDay: DayRow[];
  perDay: ConversionDayRow[];
  loading: boolean;
}) {
  // Identity-stable: Recharts replays its enter animation whenever `data` is a
  // new reference, so rebuilding these each render made the charts visibly
  // redraw on every unrelated re-render.
  const contact = useMemo(
    () =>
      byDay.map((d) => ({
        date: d.date,
        rate: d.outbound ? (d.outboundAnswered / d.outbound) * 100 : 0,
      })),
    [byDay],
  );
  const cancel = useMemo(
    () =>
      byDay.map((d) => ({
        date: d.date,
        cancelled: d.cancelledByAgent,
        rate: d.outbound ? (d.cancelledByAgent / d.outbound) * 100 : 0,
      })),
    [byDay],
  );

  const axis = { fontSize: 11, fill: "var(--color-muted-foreground)" } as const;

  return (
    <div className="grid lg:grid-cols-2 gap-3">
      <ChartCard title="Lead contact rate" loading={loading} hasData={contact.length > 0}>
        <ResponsiveContainer>
          <LineChart data={contact} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} />
            <YAxis
              tick={axis}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: any) => [`${Number(v).toFixed(1)}%`, "Contacted"]}
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

      <ChartCard title="Agent cancelled calls" loading={loading} hasData={cancel.length > 0}>
        <ResponsiveContainer>
          <BarChart data={cancel} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} />
            <YAxis tick={axis} allowDecimals={false} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
              formatter={(v: any) => [v, "Cancelled"]}
            />
            <Bar dataKey="cancelled" fill="var(--color-destructive)" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Conversion rate per day" loading={loading} hasData={perDay.length > 0}>
        <ResponsiveContainer>
          <LineChart data={perDay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} />
            <YAxis tick={axis} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: any) => [`${Number(v).toFixed(1)}%`, "Conversion"]}
            />
            <Line
              type="monotone"
              dataKey="rate"
              stroke="var(--color-chart-2)"
              strokeWidth={2.5}
              dot={{ r: 3, fill: "var(--color-chart-2)" }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Revenue per day" loading={loading} hasData={perDay.length > 0}>
        <ResponsiveContainer>
          <BarChart data={perDay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} />
            <YAxis tick={axis} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
              formatter={(v: any) => [fmtSAR(Number(v)), "Revenue"]}
            />
            <Bar dataKey="revenue" fill="var(--color-chart-1)" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

/** Outbound call volume by hour — when the team actually dials. */
export function OutboundHourlyChart({
  hourly12,
  loading,
  hasData,
}: {
  hourly12: Array<{ label: string; outbound: number; answered: number }>;
  loading: boolean;
  hasData: boolean;
}) {
  return (
    <ChartCard title="Outbound calls by hour" loading={loading} hasData={hasData}>
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
          <Bar
            dataKey="outbound"
            name="Dialled"
            fill="var(--color-chart-3)"
            radius={[6, 6, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
