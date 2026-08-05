import { memo, useMemo } from "react";
import {
  Area,
  AreaChart,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid,
  LabelList,
  Line,
  BarChart,
  Bar,
  ReferenceLine,
} from "recharts";
import { fmtSAR } from "@/lib/branches";
import { ChartCard } from "./chart-card";
import {
  INBOUND,
  OUTBOUND,
  axisTick,
  gridStroke,
  gridDash,
  valueLabelStyle,
  CHART_ANIMATION,
  CHART_RESIZE_DEBOUNCE,
  shortDate,
  compactHour,
  barGeometry,
  LegendSwatch,
  HeaderStat,
  TooltipShell,
  TooltipRow,
  SingleValueTooltip,
} from "./chart-primitives";
import type { PeakHour } from "@/lib/yeastar/metrics-engine";

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

/** Cancellation is the one series where a high value is bad news. */
const CANCEL = "var(--color-destructive)";
/** Money, kept distinct from both call-direction colours. */
const REVENUE = "var(--color-chart-4)";

/**
 * Sales-operation trends for Telesales.
 *
 * These replace the inbound-vs-outbound comparison, which said nothing useful
 * about a team that only dials out. Every series here answers a question a sales
 * manager actually asks: are we reaching customers, are agents cutting calls
 * short, are reached calls turning into orders and money.
 *
 * Drawn in the same vocabulary as Customer Care — same tooltip, same legend,
 * same axis type, same gradients — because a supervisor moving between the two
 * pages should be reading one interface. `memo` on the export means a filter
 * change elsewhere on the page no longer re-renders four charts.
 */
export const TelesalesTrendCharts = memo(function TelesalesTrendCharts({
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

  // A window average worth drawing, so a day can be judged against something
  // rather than read in isolation. Presentation-only: it summarises the series
  // already on screen and moves no KPI.
  const avgContact = useMemo(
    () => (contact.length ? contact.reduce((s, d) => s + d.rate, 0) / contact.length : 0),
    [contact],
  );

  const geom = barGeometry(byDay.length);
  const convGeom = barGeometry(perDay.length);
  const cardBody = "h-[19rem]";

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ChartCard
        title="Lead contact rate"
        subtitle="Answered ÷ dialled, by day. The dashed line is the window average."
        loading={loading}
        hasData={contact.length > 0}
        bodyClassName={cardBody}
        actions={<HeaderStat label="Window average" value={`${avgContact.toFixed(1)}%`} />}
      >
        <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE}>
          <AreaChart data={contact} margin={{ top: 22, right: 16, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id="tsContactFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={INBOUND} stopOpacity={0.28} />
                <stop offset="100%" stopColor={INBOUND} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray={gridDash} stroke={gridStroke} />
            <XAxis
              dataKey="date"
              tick={axisTick}
              tickFormatter={shortDate}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={12}
            />
            <YAxis
              tick={axisTick}
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v) => `${v}%`}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip
              cursor={{ stroke: gridStroke, strokeWidth: 1 }}
              content={
                <SingleValueTooltip
                  name="Contacted"
                  color={INBOUND}
                  format={(v: any) => `${Number(v ?? 0).toFixed(1)}%`}
                  formatTitle={shortDate}
                />
              }
            />
            <ReferenceLine
              y={avgContact}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="5 4"
              strokeWidth={1.5}
              strokeOpacity={0.9}
              label={{
                value: `Avg ${avgContact.toFixed(1)}%`,
                position: "insideTopRight",
                fill: "var(--color-muted-foreground)",
                fontSize: 11,
                fontWeight: 600,
              }}
            />
            <Area
              type="monotone"
              dataKey="rate"
              name="Contacted"
              stroke={INBOUND}
              strokeWidth={2.5}
              fill="url(#tsContactFill)"
              dot={contact.length <= 31 ? { r: 3, fill: INBOUND, strokeWidth: 0 } : false}
              activeDot={{ r: 5 }}
              isAnimationActive={CHART_ANIMATION}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Agent cancelled calls"
        subtitle="Calls the agent hung up before the ring timeout. A lead-abuse signal, not a customer outcome."
        loading={loading}
        hasData={cancel.length > 0}
        bodyClassName={cardBody}
        actions={<LegendSwatch color={CANCEL} label="Cancelled" />}
      >
        <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE}>
          <BarChart
            data={cancel}
            margin={{ top: 18, right: 8, left: 0, bottom: 4 }}
            barCategoryGap={geom.barCategoryGap}
            maxBarSize={geom.maxBarSize * 2}
          >
            <defs>
              <linearGradient id="tsCancelBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CANCEL} stopOpacity={0.9} />
                <stop offset="100%" stopColor={CANCEL} stopOpacity={0.55} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray={gridDash} stroke={gridStroke} />
            <XAxis
              dataKey="date"
              tick={axisTick}
              tickFormatter={shortDate}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={12}
            />
            <YAxis
              tick={axisTick}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={34}
              tickMargin={4}
            />
            <Tooltip
              cursor={{ fill: "var(--color-muted)", opacity: 0.35 }}
              content={({ active, payload, label }: any) =>
                active && payload?.length ? (
                  <TooltipShell
                    title={shortDate(String(label))}
                    rows={
                      <>
                        <TooltipRow
                          swatch={CANCEL}
                          label="Cancelled"
                          value={String(payload[0].payload.cancelled ?? 0)}
                          strong
                        />
                        <TooltipRow
                          label="Of dialled"
                          value={`${Number(payload[0].payload.rate ?? 0).toFixed(1)}%`}
                        />
                      </>
                    }
                  />
                ) : null
              }
            />
            <Bar
              dataKey="cancelled"
              name="Cancelled"
              fill="url(#tsCancelBar)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={CHART_ANIMATION}
            >
              {geom.showLabels && (
                <LabelList dataKey="cancelled" position="top" offset={5} style={valueLabelStyle} />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Conversion rate per day"
        subtitle="Orders ÷ answered calls. Orders are the source of truth, not the PBX."
        loading={loading}
        hasData={perDay.length > 0}
        bodyClassName={cardBody}
        actions={<LegendSwatch color={OUTBOUND} label="Conversion" />}
      >
        <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE}>
          <AreaChart data={perDay} margin={{ top: 22, right: 12, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id="tsConversionFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={OUTBOUND} stopOpacity={0.28} />
                <stop offset="100%" stopColor={OUTBOUND} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray={gridDash} stroke={gridStroke} />
            <XAxis
              dataKey="date"
              tick={axisTick}
              tickFormatter={shortDate}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={12}
            />
            <YAxis
              tick={axisTick}
              tickFormatter={(v) => `${v}%`}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip
              cursor={{ stroke: gridStroke, strokeWidth: 1 }}
              content={
                <SingleValueTooltip
                  name="Conversion"
                  color={OUTBOUND}
                  format={(v: any) => `${Number(v ?? 0).toFixed(1)}%`}
                  formatTitle={shortDate}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="rate"
              name="Conversion"
              stroke={OUTBOUND}
              strokeWidth={2.5}
              fill="url(#tsConversionFill)"
              dot={perDay.length <= 31 ? { r: 3, fill: OUTBOUND, strokeWidth: 0 } : false}
              activeDot={{ r: 5 }}
              isAnimationActive={CHART_ANIMATION}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Revenue per day"
        subtitle="Invoiced value of the orders those calls produced."
        loading={loading}
        hasData={perDay.length > 0}
        bodyClassName={cardBody}
        actions={<LegendSwatch color={REVENUE} label="Revenue" />}
      >
        <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE}>
          <BarChart
            data={perDay}
            margin={{ top: 18, right: 8, left: 0, bottom: 4 }}
            barCategoryGap={convGeom.barCategoryGap}
            maxBarSize={convGeom.maxBarSize * 2}
          >
            <defs>
              <linearGradient id="tsRevenueBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={REVENUE} stopOpacity={1} />
                <stop offset="100%" stopColor={REVENUE} stopOpacity={0.6} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray={gridDash} stroke={gridStroke} />
            <XAxis
              dataKey="date"
              tick={axisTick}
              tickFormatter={shortDate}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={12}
            />
            <YAxis
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              width={52}
              tickMargin={4}
              tickFormatter={(v) => compactMoney(Number(v))}
            />
            <Tooltip
              cursor={{ fill: "var(--color-muted)", opacity: 0.35 }}
              content={
                <SingleValueTooltip
                  name="Revenue"
                  color={REVENUE}
                  format={(v: any) => fmtSAR(Number(v ?? 0))}
                  formatTitle={shortDate}
                />
              }
            />
            <Bar
              dataKey="revenue"
              name="Revenue"
              fill="url(#tsRevenueBar)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={CHART_ANIMATION}
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
});

/**
 * `12500` → `12.5k`. Axis only — the tooltip carries the real currency value.
 *
 * A revenue axis rendered through `fmtSAR` produces labels wide enough to eat a
 * third of the plot area on a half-width card.
 */
function compactMoney(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(v);
}

/**
 * Outbound calls by hour — Telesales' headline analytic.
 *
 * The same treatment as Customer Care's Calls by Hour, and for the same reason:
 * twenty-four fixed buckets on a continuous axis, so the shape of the curve is
 * the answer to the question the card asks — when does the team actually dial.
 * It was a flat bar chart with all 24 labels overprinting each other.
 *
 * Two series rather than one, because "dialled" alone cannot tell a busy hour
 * from a productive one: the filled area is what went out, the line on top is
 * what got picked up, and the gap between them is the hour's contact rate read
 * at a glance.
 *
 * `peakHour` is the busiest DIALLING hour and comes from the shared
 * `resolvePeakHour` — this component does not scan the series for a maximum,
 * because that is a derivation and derivations live in one place.
 */
export const OutboundHourlyChart = memo(function OutboundHourlyChart({
  hourly12,
  peakHour,
  loading,
  hasData,
}: {
  hourly12: Array<{ label: string; outbound: number; answered: number }>;
  /** Busiest dialling hour in the window, or null when nothing went out. */
  peakHour: PeakHour | null;
  loading: boolean;
  hasData: boolean;
}) {
  return (
    <ChartCard
      title="Outbound calls by hour"
      subtitle="Every hour of the day. The filled area is what was dialled; the line is what got answered."
      loading={loading}
      hasData={hasData}
      bodyClassName="h-[22rem] sm:h-[24rem]"
      actions={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <LegendSwatch color={OUTBOUND} label="Dialled" />
          <LegendSwatch color={INBOUND} label="Answered" />
          {peakHour && (
            <HeaderStat label="Peak" value={`${peakHour.label} · ${peakHour.total} dialled`} />
          )}
        </div>
      }
    >
      <ResponsiveContainer debounce={CHART_RESIZE_DEBOUNCE}>
        <AreaChart data={hourly12} margin={{ top: 24, right: 12, left: 0, bottom: 4 }}>
          <defs>
            <linearGradient id="tsHourDialled" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={OUTBOUND} stopOpacity={0.45} />
              <stop offset="100%" stopColor={OUTBOUND} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray={gridDash} stroke={gridStroke} />
          <XAxis
            dataKey="label"
            tick={axisTick}
            tickFormatter={compactHour}
            // Every third hour, abbreviated. A numeric interval rather than
            // `minTickGap`: on a category axis Recharts resolves the gap from
            // its own label measurement, which leaves all 24 in place at every
            // width. Eight short labels fit a phone and still read as a clock.
            interval={2}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            tick={axisTick}
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={34}
            tickMargin={4}
          />
          <Tooltip
            cursor={{ stroke: gridStroke, strokeWidth: 1 }}
            content={({ active, payload, label }: any) =>
              active && payload?.length ? (
                <TooltipShell
                  title={String(label)}
                  rows={
                    <>
                      <TooltipRow
                        swatch={OUTBOUND}
                        label="Dialled"
                        value={String(payload[0]?.payload?.outbound ?? 0)}
                        strong
                      />
                      <TooltipRow
                        swatch={INBOUND}
                        label="Answered"
                        value={String(payload[0]?.payload?.answered ?? 0)}
                      />
                    </>
                  }
                />
              ) : null
            }
          />
          {peakHour && (
            <ReferenceLine
              x={peakHour.label}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="4 4"
              strokeOpacity={0.55}
              label={{
                value: `Peak · ${peakHour.total}`,
                position: "top",
                fill: "var(--color-muted-foreground)",
                fontSize: 11,
                fontWeight: 600,
              }}
            />
          )}
          <Area
            type="monotone"
            dataKey="outbound"
            name="Dialled"
            stroke={OUTBOUND}
            strokeWidth={2}
            fill="url(#tsHourDialled)"
            activeDot={{ r: 4 }}
            isAnimationActive={CHART_ANIMATION}
          />
          <Line
            type="monotone"
            dataKey="answered"
            name="Answered"
            stroke={INBOUND}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={CHART_ANIMATION}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
});
