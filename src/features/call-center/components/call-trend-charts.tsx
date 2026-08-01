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
  Legend,
  ReferenceLine,
} from "recharts";
import { ChartCard } from "./chart-card";

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

const axisTick = { fontSize: 11, fill: "var(--color-muted-foreground)" };
const gridStroke = "var(--color-border)";

/** Shared shell for the custom tooltips, so all three read identically. */
function TooltipShell({ title, rows }: { title: string; rows: React.ReactNode }) {
  return (
    <div className="min-w-[168px] rounded-lg border border-border bg-popover px-3 py-2.5 shadow-lg">
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
 * Inbound / outbound / total, for both of the stacked volume charts.
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
 * The value of one stacked segment, drawn inside it.
 *
 * White text with a dark halo (`paint-order: stroke`), because there is no one
 * fill that works across both series in both themes: inbound sits at L≈0.72-0.78
 * and outbound at L≈0.40-0.62, so a fixed light or dark fill is illegible on one
 * of them. The halo is the map-label trick and survives any bar colour.
 *
 * Segments too small to hold a number are skipped rather than crowded — that is
 * what the tooltip is for.
 */
function SegmentValueLabel(props: any) {
  const { x, y, width, height, value } = props;
  const n = Number(value ?? 0);
  if (!n || height < 16 || width < 24) return null;
  return (
    <text
      x={x + width / 2}
      y={y + height / 2}
      textAnchor="middle"
      dominantBaseline="central"
      fill="#fff"
      stroke="rgba(0,0,0,0.45)"
      strokeWidth={3}
      strokeLinejoin="round"
      paintOrder="stroke"
      style={{ fontSize: 11, fontWeight: 600, pointerEvents: "none" }}
    >
      {n}
    </text>
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
 * render is what made the charts visibly redraw.
 */
export function CallTrendCharts({
  byDay,
  answerRate,
  averageRate,
  hasData,
  loading,
}: {
  byDay: DayRow[];
  answerRate: RatePoint[];
  /** The window's overall answer rate, drawn as the comparison line. */
  averageRate: number;
  hasData: boolean;
  loading: boolean;
}) {
  // Value labels only survive on a short window; past that they collide and the
  // tooltip is the better answer.
  const showLabels = byDay.length <= 14;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ChartCard
        title="Inbound vs outbound"
        subtitle="Calls per day, stacked by direction. Totals sit above each bar; hover for any segment too small to label."
        loading={loading}
        hasData={hasData}
        bodyClassName="h-72"
      >
        <ResponsiveContainer>
          <BarChart data={byDay} margin={{ top: 20, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              dataKey="date"
              tick={axisTick}
              tickFormatter={shortDate}
              tickLine={false}
              axisLine={false}
              minTickGap={8}
            />
            <YAxis
              tick={axisTick}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={36}
            />
            <Tooltip
              content={<VolumeTooltip formatTitle={shortDate} />}
              cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, paddingTop: 10 }}
              iconType="circle"
              iconSize={8}
            />
            <Bar dataKey="inbound" name="Inbound" fill="var(--color-chart-1)" stackId="a">
              <LabelList dataKey="inbound" content={SegmentValueLabel} />
            </Bar>
            <Bar
              dataKey="outbound"
              name="Outbound"
              fill="var(--color-chart-3)"
              radius={[6, 6, 0, 0]}
              stackId="a"
            >
              <LabelList dataKey="outbound" content={SegmentValueLabel} />
              {showLabels && (
                <LabelList
                  dataKey="total"
                  position="top"
                  offset={6}
                  style={{ fontSize: 11, fontWeight: 600, fill: "var(--color-muted-foreground)" }}
                />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Answer rate trend"
        subtitle={`Answered ÷ total calls, by day. Dashed line is the window average (${averageRate.toFixed(1)}%).`}
        loading={loading}
        hasData={hasData}
        bodyClassName="h-72"
      >
        <ResponsiveContainer>
          {/* Right margin leaves room for the reference line's own label. */}
          <AreaChart data={answerRate} margin={{ top: 22, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="answerRateFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              dataKey="date"
              tick={axisTick}
              tickFormatter={shortDate}
              tickLine={false}
              axisLine={false}
              minTickGap={8}
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
                          swatch="var(--color-chart-1)"
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
              stroke="var(--color-chart-1)"
              strokeWidth={2.5}
              fill="url(#answerRateFill)"
              dot={{ r: 3, fill: "var(--color-chart-1)", strokeWidth: 0 }}
              activeDot={{ r: 5 }}
            >
              {showLabels && (
                <LabelList
                  dataKey="rate"
                  position="top"
                  offset={10}
                  formatter={(v: any) => `${Number(v).toFixed(0)}%`}
                  style={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                />
              )}
            </Area>
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

/** Calls by hour of day, so a supervisor can see when the queue gets busy. */
export function HourlyDistributionChart({
  hourly12,
  loading,
  hasData,
}: {
  hourly12: Array<{ label: string; total: number; inbound: number; outbound: number }>;
  loading: boolean;
  hasData: boolean;
}) {
  return (
    <ChartCard
      title="Calls by hour"
      subtitle="Every hour of the day, stacked by direction. Hover for exact counts."
      loading={loading}
      hasData={hasData}
      bodyClassName="h-72"
    >
      <ResponsiveContainer>
        <BarChart data={hourly12} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={gridStroke} />
          <XAxis
            dataKey="label"
            tick={axisTick}
            // Every other hour: all 24 labels collide at this type size, and the
            // tooltip carries the exact hour anyway.
            interval={1}
            tickLine={false}
            axisLine={false}
            tickMargin={6}
          />
          <YAxis
            tick={axisTick}
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={36}
          />
          <Tooltip
            content={<VolumeTooltip />}
            cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 10 }} iconType="circle" iconSize={8} />
          <Bar dataKey="inbound" name="Inbound" fill="var(--color-chart-1)" stackId="h" />
          <Bar
            dataKey="outbound"
            name="Outbound"
            fill="var(--color-chart-3)"
            radius={[4, 4, 0, 0]}
            stackId="h"
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
