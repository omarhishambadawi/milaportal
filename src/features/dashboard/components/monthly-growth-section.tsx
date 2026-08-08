import { Suspense, lazy, useState } from "react";
import { Coins, Sparkles, Table2, TrendingUp, Users } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatCompactSAR, formatCount, formatGrowth } from "../format";
import {
  latestCompleteMonth,
  previousCompleteMonth,
  revenueDriver,
  type Insight,
  type MonthRow,
  type TeamMonthMetrics,
} from "../monthly-growth";
import { AnalyticsCard } from "./analytics-card";
import { AnalyticsTable, EmptyRow, Tbody, Td, Th, Thead } from "./analytics-table";
import { KpiTile } from "./kpi-tile";
import { SectionTitle } from "./section-title";

/**
 * Monthly performance — the executive view.
 *
 * The shape of this section is the point of it. An earlier cut rendered every
 * derived figure in three wide tables (eleven columns, then ten, then seven),
 * which is every number the analytics layer can produce and no answer to the
 * question the page is opened with. What management reads in ten seconds is:
 * how big was last month, which way is it moving, who moved it, and what drove
 * it. So that is the order — KPI strip, charts, team split and drivers, then a
 * compact trend table underneath as the supporting detail, then three insights.
 *
 * Everything is the dashboard's own chrome: `SectionTitle`, `AnalyticsCard`,
 * `AnalyticsTable`, `Card`, the chart theme, the `--positive`/`--negative`
 * tokens. Nothing is styled from scratch and no new visual language is
 * introduced, which is why it sits under the KPI cards without looking bolted
 * on.
 *
 * Two things it says out loud rather than implying: it is not scoped by the
 * date picker (its subject is the whole timeline), and its headline figures are
 * the last *complete* month, named in the strip. A month still running is in
 * the trend table, flagged, and nowhere else.
 */

const MonthlyGrowthCharts = lazy(() =>
  import("./monthly-growth-charts").then((m) => ({ default: m.MonthlyGrowthCharts })),
);

type Scope = "combined" | "customer_care" | "telesales";

const SCOPE_LABEL: Record<Scope, string> = {
  combined: "Combined",
  customer_care: "Customer Care",
  telesales: "Telesales",
};

const scopeMetrics = (row: MonthRow, scope: Scope): TeamMonthMetrics | null =>
  scope === "combined"
    ? row.combined
    : scope === "customer_care"
      ? row.customerCare
      : row.telesales;

/** The two team colours, matched to their lines on the revenue-trend chart. */
const TEAM_COLOR = {
  customerCare: "var(--color-chart-1)",
  telesales: "var(--color-chart-3)",
} as const;

const growthTone = (value: number | null) =>
  value == null
    ? "text-muted-foreground"
    : value >= 0
      ? "text-[var(--positive)]"
      : "text-[var(--negative)]";

/** A growth figure in its direction's colour. */
function Growth({ value, className }: { value: number | null; className?: string }) {
  return (
    <span className={cn("font-semibold tabular-nums", growthTone(value), className)}>
      {formatGrowth(value)}
    </span>
  );
}

/** Placeholder for the four chart panels while the Recharts chunk is in flight. */
function ChartsSkeleton() {
  return (
    <div className="grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <AnalyticsCard key={i} title="" loading>
          <div className="h-64 w-full animate-pulse rounded-lg bg-muted/50" />
        </AnalyticsCard>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function KpiStrip({ current, previous }: { current: MonthRow; previous: MonthRow | null }) {
  const now = current.combined;
  const then = previous?.combined ?? null;
  const versus = previous ? `vs ${previous.label}` : "No previous month";
  const aovGrowth =
    now.avgOrderValue != null && then?.avgOrderValue
      ? ((now.avgOrderValue - then.avgOrderValue) / then.avgOrderValue) * 100
      : null;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5">
      {/* Each tile names its own period: a level figure is stamped with the
          month it belongs to, a rate with the month it is measured against.
          The strip previously read `from SAR 445.3K` under the levels, which
          is the same comparison stated as a number the reader then has to
          attribute to a month themselves. */}
      <KpiTile
        label="Total revenue"
        value={formatCompactSAR(now.totalRevenue)}
        sub={current.label}
      />
      <KpiTile
        label="Revenue growth"
        value={formatGrowth(now.revenueGrowth)}
        valueTone={growthTone(now.revenueGrowth)}
        sub={versus}
      />
      <KpiTile label="Completed orders" value={formatCount(now.totalOrders)} sub={current.label} />
      <KpiTile
        label="Order growth"
        value={formatGrowth(now.orderGrowth)}
        valueTone={growthTone(now.orderGrowth)}
        sub={versus}
      />
      <KpiTile
        label="Avg order value"
        value={formatCompactSAR(now.avgOrderValue)}
        sub={aovGrowth == null ? undefined : `${formatGrowth(aovGrowth)} MoM`}
        subTone={growthTone(aovGrowth)}
      />
    </div>
  );
}

/** One team's month: revenue, its direction, and the orders behind it. */
function TeamTile({
  name,
  color,
  metrics,
}: {
  name: string;
  color: string;
  metrics: TeamMonthMetrics | null;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-muted/25 p-3 sm:p-3.5">
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate text-xs font-medium text-muted-foreground">{name}</span>
      </div>
      {metrics ? (
        <>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-lg font-semibold tabular-nums">
              {formatCompactSAR(metrics.totalRevenue)}
            </span>
            <Growth value={metrics.revenueGrowth} className="text-xs" />
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {formatCount(metrics.totalOrders)} orders
          </div>
        </>
      ) : (
        <div className="mt-1.5 text-sm text-muted-foreground/70">Not operating this month</div>
      )}
    </div>
  );
}

function TeamPerformance({ current }: { current: MonthRow }) {
  const care = current.customerCare;
  const telesales = current.telesales;
  const total = current.combined.totalRevenue;
  const careShare = care && total > 0 ? (care.totalRevenue / total) * 100 : null;
  const telesalesShare = telesales && total > 0 ? (telesales.totalRevenue / total) * 100 : null;

  return (
    <AnalyticsCard
      title="Team performance"
      subtitle={`Customer Care against Telesales · ${current.label}`}
      icon={Users}
    >
      <div className="grid gap-2 sm:grid-cols-2 sm:gap-3">
        <TeamTile name="Customer Care" color={TEAM_COLOR.customerCare} metrics={care} />
        <TeamTile name="Telesales" color={TEAM_COLOR.telesales} metrics={telesales} />
      </div>

      {careShare != null && telesalesShare != null && (
        <div className="mt-3">
          {/* Share of revenue as one bar rather than two more numbers: the
              split is the whole message, and a bar says it without being read. */}
          <div
            className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`Customer Care ${careShare.toFixed(1)}% of revenue, Telesales ${telesalesShare.toFixed(1)}%`}
          >
            <span
              style={{ width: `${careShare}%`, background: TEAM_COLOR.customerCare }}
              className="h-full"
            />
            <span
              style={{ width: `${telesalesShare}%`, background: TEAM_COLOR.telesales }}
              className="h-full"
            />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
            <span>Customer Care {careShare.toFixed(1)}%</span>
            <span>Telesales {telesalesShare.toFixed(1)}%</span>
          </div>
        </div>
      )}
    </AnalyticsCard>
  );
}

function ChannelTile({
  name,
  color,
  revenueGrowth,
  orderGrowth,
  avgOrderValue,
}: {
  name: string;
  color: string;
  revenueGrowth: number | null;
  orderGrowth: number | null;
  avgOrderValue: number | null;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-muted/25 p-3 sm:p-3.5">
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate text-xs font-medium text-muted-foreground">{name}</span>
      </div>
      <div className="mt-1.5 space-y-0.5 text-sm">
        <div className="flex items-baseline justify-between gap-2">
          <Growth value={revenueGrowth} />
          <span className="text-xs text-muted-foreground">revenue</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <Growth value={orderGrowth} />
          <span className="text-xs text-muted-foreground">orders</span>
        </div>
      </div>
      <div className="mt-2 border-t border-border/50 pt-1.5 text-[11px] text-muted-foreground tabular-nums">
        Avg order {formatCompactSAR(avgOrderValue)}
      </div>
    </div>
  );
}

function RevenueDrivers({ current, previous }: { current: MonthRow; previous: MonthRow | null }) {
  const now = current.combined;
  const driver = revenueDriver(now, previous?.combined ?? null);

  return (
    <AnalyticsCard
      title="Revenue drivers"
      subtitle={`What's driving monthly growth? · ${current.label}`}
      icon={Coins}
    >
      <div className="grid gap-2 sm:grid-cols-2 sm:gap-3">
        <ChannelTile
          name="Cash"
          color="var(--color-chart-4)"
          revenueGrowth={now.cashRevenueGrowth}
          orderGrowth={now.cashOrderGrowth}
          avgOrderValue={now.avgCashOrderValue}
        />
        <ChannelTile
          name="Wasfaty"
          color="var(--color-chart-1)"
          revenueGrowth={now.wasfatyRevenueGrowth}
          orderGrowth={now.wasfatyOrderGrowth}
          avgOrderValue={now.avgWasfatyOrderValue}
        />
      </div>

      {driver && (
        <p className="mt-3 text-sm text-muted-foreground">
          {driver.delta >= 0 ? "Growth is primarily driven by" : "The largest decline is in"}{" "}
          <span className="font-medium text-foreground">{driver.channel}</span> revenue.
        </p>
      )}
    </AnalyticsCard>
  );
}

function KeyInsights({ insights }: { insights: readonly Insight[] }) {
  if (insights.length === 0) return null;

  return (
    <AnalyticsCard title="Key insights" icon={Sparkles} className="mt-3">
      <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
        {insights.map((insight) => (
          <div
            key={insight.id}
            className="min-w-0 rounded-lg border border-border/60 bg-muted/25 p-3 sm:p-3.5"
          >
            <div
              className={cn(
                "truncate text-lg font-semibold tabular-nums sm:text-xl",
                insight.tone === "positive"
                  ? "text-[var(--positive)]"
                  : insight.tone === "negative"
                    ? "text-[var(--negative)]"
                    : "text-foreground",
              )}
            >
              {insight.value}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {insight.label}
            </div>
          </div>
        ))}
      </div>
    </AnalyticsCard>
  );
}

/* -------------------------------------------------------------------------- */

export function MonthlyGrowthSection({
  rows,
  insights,
  isLoading,
}: {
  rows: MonthRow[];
  insights: Insight[];
  isLoading: boolean;
}) {
  const [scope, setScope] = useState<Scope>("combined");

  const current = latestCompleteMonth(rows);
  const previous = previousCompleteMonth(rows);

  // A team scope shows only the months that team operated, rather than a column
  // of N/A down to April 2026. The absence is real and is stated in the team
  // comparison above; repeating it once per row is noise, not information.
  const trendRows = rows.filter((row) => scopeMetrics(row, scope) !== null);

  return (
    <div>
      <SectionTitle title="Monthly performance" icon={TrendingUp} />
      <p className="-mt-1 mb-3 text-xs text-muted-foreground">
        Completed orders only · Month-over-month performance · Full timeline, not the date range
        above
        {isLoading && <span className="ml-1 animate-pulse">· Loading current months…</span>}
      </p>

      {current && (
        <>
          {/* The reporting period, stated once above the strip. Without the
              second line the tiles are a set of figures and a set of
              percentages with no stated basis — the reader can work out that
              the growth is against June, but should not have to. */}
          <div className="mb-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {current.label} · latest complete month
            </div>
            {previous && (
              <div className="text-[11px] text-muted-foreground/80">
                Compared with {previous.label}
              </div>
            )}
          </div>
          <KpiStrip current={current} previous={previous} />
        </>
      )}

      <div className="mt-3">
        <Suspense fallback={<ChartsSkeleton />}>
          <MonthlyGrowthCharts rows={rows} />
        </Suspense>
      </div>

      {current && (
        <div className="mt-3 grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
          <TeamPerformance current={current} />
          <RevenueDrivers current={current} previous={previous} />
        </div>
      )}

      <AnalyticsCard
        title="Monthly trend"
        subtitle={SCOPE_LABEL[scope]}
        icon={Table2}
        className="mt-3"
        flush
        actions={
          <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
            <TabsList className="h-8">
              {(Object.keys(SCOPE_LABEL) as Scope[]).map((key) => (
                <TabsTrigger key={key} value={key} className="px-2.5 py-0.5 text-xs">
                  {SCOPE_LABEL[key]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      >
        <AnalyticsTable minWidth={520}>
          <Thead>
            <tr>
              <Th>Month</Th>
              <Th align="right">Revenue</Th>
              <Th align="right">MoM</Th>
              <Th align="right">Orders</Th>
              <Th align="right">Avg order</Th>
            </tr>
          </Thead>
          <Tbody>
            {trendRows.length === 0 && <EmptyRow colSpan={5} />}
            {trendRows.map((row) => {
              const m = scopeMetrics(row, scope)!;
              return (
                <tr key={row.month}>
                  <Td>
                    <span className="flex items-center gap-2 whitespace-nowrap font-medium">
                      {row.label}
                      {row.partial && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          In progress
                        </span>
                      )}
                    </span>
                  </Td>
                  <Td numeric className="font-medium">
                    {formatCompactSAR(m.totalRevenue)}
                  </Td>
                  <Td numeric>
                    <Growth value={m.revenueGrowth} />
                  </Td>
                  <Td numeric>{formatCount(m.totalOrders)}</Td>
                  <Td numeric className="text-muted-foreground">
                    {formatCompactSAR(m.avgOrderValue)}
                  </Td>
                </tr>
              );
            })}
          </Tbody>
        </AnalyticsTable>
      </AnalyticsCard>

      <KeyInsights insights={insights} />
    </div>
  );
}
