import { memo } from "react";
import {
  Area,
  AreaChart,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid,
  LabelList,
  ReferenceLine,
} from "recharts";
import { ChartCard } from "./chart-card";
import type { PeakHour } from "@/lib/yeastar/metrics-engine";

interface DayRow {
  date: string;
  total: number;
  inbound: number;
  outbound: number;
}

interface RatePoint {
  date: string;
  rate: number;
}

/**
 * `2026-07-29` → `29 Jul`. Formatting only — the bucket itself is the engine's.
 *
 * Falls back to the raw key for the normalizer's `—` bucket (a call with no
 * usable timestamp), which must still render rather than throw.
 */
function shortDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const INBOUND = "var(--color-chart-1)";
const OUTBOUND = "var(--color-chart-3)";

/**
 * `3 PM` → `3p`, for the hourly axis only.
 *
 * Twenty-four labels is the whole point of the chart and also the thing that
 * breaks it: `12 AM` is about 34px at this type size, so a phone-width card can
 * fit six of them and Recharts renders all twenty-four on top of each other.
 * Two characters fit everywhere, and nothing is lost — the tooltip and the peak
 * badge both carry the unabbreviated hour.
 */
function compactHour(label: string): string {
  return label.replace(/\s*AM$/, "a").replace(/\s*PM$/, "p");
}

const axisTick = { fontSize: 11, fill: "var(--color-muted-foreground)" };
const gridStroke = "var(--color-border)";
const valueLabelStyle = {
  fontSize: 10,
  fontWeight: 600,
  fill: "var(--color-muted-foreground)",
} as const;

/**
 * Enter animation is off on every series here, deliberately and everywhere.
 *
 * Two reasons, and the second is the one that settles it. Recharts replays the
 * animation whenever the `data` prop changes identity, so on a background
 * refresh the whole chart re-draws from zero — on a month that is 62 bars
 * animating for no new information. And `Bar` gates its `LabelList` on
 * `isAnimationFinished`, so an animated bar renders its value only once the
 * transition has run and not at all if it never completes; the value labels are
 * the point of the redesign and cannot be conditional on that.
 */
const CHART_ANIMATION = false;

/** A colour key that reads as part of the card header rather than chart furniture. */
function LegendSwatch({ color, label, value }: { color: string; label: string; value?: number }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap text-xs">
      <span
        className="inline-block h-2 w-2 shrink-0 translate-y-[-1px] rounded-full"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span className="text-muted-foreground">{label}</span>
      {value != null && <span className="font-semibold tabular-nums text-foreground">{value}</span>}
    </span>
  );
}

/** Shared shell for the custom tooltips, so all three read identically. */
function TooltipShell({ title, rows }: { title: string; rows: React.ReactNode }) {
  return (
    <div className="min-w-[172px] rounded-lg border border-border bg-popover px-3 py-2.5 shadow-lg">
      <div className="mb-2 text-xs font-semibold text-foreground">{title}</div>
      <div className="space-y-1.5">{rows}</div>
    </div>
  );
}

function TooltipRow({
  swatch,
  label,
  value,
  strong,
}: {
  swatch?: string;
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 text-xs leading-none">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={swatch ? { background: swatch } : undefined}
        aria-hidden="true"
      />
      <span className={strong ? "flex-1 text-foreground" : "flex-1 text-muted-foreground"}>
        {label}
      </span>
      <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{value}</span>
    </div>
  );
}

/**
 * Inbound / outbound / total, for both of the volume charts.
 *
 * Reads as the queue panel does — one line per direction, then the total under
 * a rule:
 *
 *     1 PM
 *     Inbound   5
 *     Outbound  2
 *     Total     7
 */
function VolumeTooltip({ active, payload, label, formatTitle }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as { inbound: number; outbound: number; total?: number };
  const total = row.total ?? row.inbound + row.outbound;
  return (
    <TooltipShell
      title={formatTitle ? formatTitle(label) : String(label)}
      rows={
        <>
          {payload.map((p: any) => (
            <TooltipRow
              key={p.dataKey}
              swatch={p.color}
              label={p.name}
              value={String(p.value ?? 0)}
            />
          ))}
          <div className="mt-2 border-t border-border/60 pt-2">
            <TooltipRow label="Total" value={String(total)} strong />
          </div>
        </>
      }
    />
  );
}

/**
 * Daily volume and answer rate.
 *
 * Purely presentational — every number arrives pre-computed by the Metrics
 * Engine, including `answerRate`, `averageRate` and `hasData`. This component
 * previously derived the answer-rate series itself, which made it a second place
 * a KPI was defined; the engine owns it now. Do not reintroduce a calculation
 * here — axis and tooltip formatting is the limit.
 *
 * Both arrays are memoised upstream, which matters: Recharts replays its enter
 * animation whenever a `data` prop is a new reference, and rebuilding these per
 * render is what made the charts visibly redraw. `memo` on the export closes the
 * other half of that: a filter change elsewhere on the page no longer re-renders
 * either chart.
 *
 * ---------------------------------------------------------------------------
 * Why the direction chart is grouped rather than stacked
 * ---------------------------------------------------------------------------
 * It was a stacked bar with the segment value printed inside it in white with a
 * dark halo, because no single fill was legible across both series in both
 * themes. That is a workaround for the wrong chart: stacking answers "how many
 * calls that day", which the total label already answers, while the question the
 * card is titled after — inbound against outbound — is exactly the comparison
 * stacking makes hardest. Side-by-side bars put both series on the same
 * baseline, which is the only arrangement where two lengths can honestly be
 * compared, and it moves the labels out into the margin where ordinary
 * muted-foreground text is readable in either theme.
 */
export const CallTrendCharts = memo(function CallTrendCharts({
  byDay,
  answerRate,
  averageRate,
  totalInbound,
  totalOutbound,
  hasData,
  loading,
}: {
  byDay: DayRow[];
  answerRate: RatePoint[];
  /** The window's overall answer rate, drawn as the comparison line. */
  averageRate: number;
  /** Window totals for the header legend. From the engine — not summed here. */
  totalInbound: number;
  totalOutbound: number;
  hasData: boolean;
  loading: boolean;
}) {
  // Value labels only survive on a short window; past that they collide and the
  // tooltip is the better answer. Grouped bars halve the room each label has, so
  // the threshold is lower than the stacked version's.
  const showLabels = byDay.length <= 10;

  // Bar geometry has to follow the window or the chart looks wrong at one end of
  // the range: a week's worth of bars at month spacing reads as scattered
  // ticks, and a month's worth at week spacing comes out about four pixels wide.
  // Measured in the preview harness at the half-width the card actually gets.
  const dense = byDay.length > 10;
  const barGap = dense ? 1 : 3;
  const barCategoryGap = dense ? "6%" : "26%";
  const maxBarSize = dense ? 14 : 28;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ChartCard
        title="Inbound vs outbound"
        subtitle="Calls per day, side by side. Equal baselines, so the two are directly comparable."
        loading={loading}
        hasData={hasData}
        bodyClassName="h-[19rem]"
        actions={
          <div className="flex items-center gap-3">
            <LegendSwatch color={INBOUND} label="Inbound" value={totalInbound} />
            <LegendSwatch color={OUTBOUND} label="Outbound" value={totalOutbound} />
          </div>
        }
      >
        <ResponsiveContainer debounce={80}>
          <BarChart
            data={byDay}
            margin={{ top: 18, right: 8, left: 0, bottom: 4 }}
            barGap={barGap}
            barCategoryGap={barCategoryGap}
            maxBarSize={maxBarSize}
          >
            <defs>
              <linearGradient id="ccInboundBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={INBOUND} stopOpacity={1} />
                <stop offset="100%" stopColor={INBOUND} stopOpacity={0.65} />
              </linearGradient>
              <linearGradient id="ccOutboundBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={OUTBOUND} stopOpacity={1} />
                <stop offset="100%" stopColor={OUTBOUND} stopOpacity={0.65} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="2 5" stroke={gridStroke} />
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
              content={<VolumeTooltip formatTitle={shortDate} />}
              cursor={{ fill: "var(--color-muted)", opacity: 0.35 }}
            />
            <Bar
              dataKey="inbound"
              name="Inbound"
              fill="url(#ccInboundBar)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={CHART_ANIMATION}
            >
              {showLabels && (
                <LabelList dataKey="inbound" position="top" offset={5} style={valueLabelStyle} />
              )}
            </Bar>
            <Bar
              dataKey="outbound"
              name="Outbound"
              fill="url(#ccOutboundBar)"
              radius={[4, 4, 0, 0]}
              isAnimationActive={CHART_ANIMATION}
            >
              {showLabels && (
                <LabelList dataKey="outbound" position="top" offset={5} style={valueLabelStyle} />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Answer rate trend"
        subtitle="Answered ÷ total calls, by day. The dashed line is the window average."
        loading={loading}
        hasData={hasData}
        bodyClassName="h-[19rem]"
        actions={
          <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs">
            <span className="text-muted-foreground">Window average</span>
            <span className="font-semibold tabular-nums text-foreground">
              {averageRate.toFixed(1)}%
            </span>
          </span>
        }
      >
        <ResponsiveContainer debounce={80}>
          {/* Right margin leaves room for the reference line's own label. */}
          <AreaChart data={answerRate} margin={{ top: 22, right: 16, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id="answerRateFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={INBOUND} stopOpacity={0.28} />
                <stop offset="100%" stopColor={INBOUND} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="2 5" stroke={gridStroke} />
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
              cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }}
              content={({ active, payload, label }: any) =>
                active && payload?.length ? (
                  <TooltipShell
                    title={shortDate(String(label))}
                    rows={
                      <>
                        <TooltipRow
                          swatch={INBOUND}
                          label="Answer rate"
                          value={`${Number(payload[0].value ?? 0).toFixed(1)}%`}
                          strong
                        />
                        <div className="mt-2 border-t border-border/60 pt-2">
                          <TooltipRow label="Window average" value={`${averageRate.toFixed(1)}%`} />
                        </div>
                      </>
                    }
                  />
                ) : null
              }
            />
            {/*
              The average is the line a supervisor actually judges a day
              against, so it is drawn and captioned rather than left as an
              anonymous dash — otherwise it reads as chart furniture.
            */}
            <ReferenceLine
              y={averageRate}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="5 4"
              strokeWidth={1.5}
              strokeOpacity={0.9}
              label={{
                value: `Avg ${averageRate.toFixed(1)}%`,
                position: "insideTopRight",
                fill: "var(--color-muted-foreground)",
                fontSize: 11,
                fontWeight: 600,
              }}
            />
            <Area
              type="monotone"
              dataKey="rate"
              name="Answer rate"
              stroke={INBOUND}
              strokeWidth={2.5}
              fill="url(#answerRateFill)"
              dot={byDay.length <= 31 ? { r: 3, fill: INBOUND, strokeWidth: 0 } : false}
              activeDot={{ r: 5 }}
              isAnimationActive={CHART_ANIMATION}
            >
              {showLabels && (
                <LabelList
                  dataKey="rate"
                  position="top"
                  offset={10}
                  formatter={(v: any) => `${Number(v).toFixed(0)}%`}
                  style={valueLabelStyle}
                />
              )}
            </Area>
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
});

/**
 * Calls by hour of day — the page's headline analytic.
 *
 * Twenty-four fixed buckets, which is what lets this be an area chart rather
 * than bars: the x-axis is a continuous day, every bucket is present even when
 * empty, and the shape of the curve is the answer to the question the card
 * asks — when does the queue get busy. Stacked so the inbound and outbound
 * contributions to a peak stay visible, filled so the eye follows the envelope
 * rather than twenty-four separate tops.
 *
 * The peak is annotated instead of left to be found: it is the one hour anybody
 * reads this chart to identify. `peakHour` comes from the Metrics Engine — this
 * component does not scan the series for a maximum, because that is a
 * derivation and derivations live in one place.
 */
export const HourlyDistributionChart = memo(function HourlyDistributionChart({
  hourly12,
  peakHour,
  loading,
  hasData,
}: {
  hourly12: Array<{ label: string; total: number; inbound: number; outbound: number }>;
  /** Busiest hour in the window, or null when nothing was handled. */
  peakHour: PeakHour | null;
  loading: boolean;
  hasData: boolean;
}) {
  return (
    <ChartCard
      title="Calls by hour"
      subtitle="Every hour of the day, stacked by direction. The marked hour is the window's busiest."
      loading={loading}
      hasData={hasData}
      bodyClassName="h-[22rem] sm:h-[24rem]"
      actions={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <LegendSwatch color={INBOUND} label="Inbound" />
          <LegendSwatch color={OUTBOUND} label="Outbound" />
          {peakHour && (
            <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs">
              <span className="text-muted-foreground">Peak</span>
              <span className="font-semibold text-foreground">{peakHour.label}</span>
              <span className="tabular-nums text-muted-foreground">
                · {peakHour.total} call{peakHour.total === 1 ? "" : "s"}
              </span>
            </span>
          )}
        </div>
      }
    >
      <ResponsiveContainer debounce={80}>
        <AreaChart data={hourly12} margin={{ top: 24, right: 12, left: 0, bottom: 4 }}>
          <defs>
            <linearGradient id="ccHourInbound" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={INBOUND} stopOpacity={0.45} />
              <stop offset="100%" stopColor={INBOUND} stopOpacity={0.06} />
            </linearGradient>
            <linearGradient id="ccHourOutbound" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={OUTBOUND} stopOpacity={0.4} />
              <stop offset="100%" stopColor={OUTBOUND} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="2 5" stroke={gridStroke} />
          <XAxis
            dataKey="label"
            tick={axisTick}
            tickFormatter={compactHour}
            // Every third hour, abbreviated. A numeric interval rather than
            // `minTickGap`: on a category axis Recharts resolves the gap from
            // its own label measurement, which on this axis leaves all 24 in
            // place at every width. Eight short labels fit a phone and still
            // read as a clock at full width.
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
            content={<VolumeTooltip />}
            cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }}
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
            dataKey="inbound"
            name="Inbound"
            stackId="h"
            stroke={INBOUND}
            strokeWidth={2}
            fill="url(#ccHourInbound)"
            activeDot={{ r: 4 }}
            isAnimationActive={CHART_ANIMATION}
          />
          <Area
            type="monotone"
            dataKey="outbound"
            name="Outbound"
            stackId="h"
            stroke={OUTBOUND}
            strokeWidth={2}
            fill="url(#ccHourOutbound)"
            activeDot={{ r: 4 }}
            isAnimationActive={CHART_ANIMATION}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
});
