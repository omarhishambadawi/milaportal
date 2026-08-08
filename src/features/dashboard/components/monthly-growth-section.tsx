import { Suspense, lazy, useState } from "react";
import { CalendarRange, Coins, Lightbulb, Table2, TrendingUp } from "lucide-react";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatGrowth, type MonthRow, type TeamMonthMetrics } from "../monthly-growth";
import type { Insight } from "../monthly-growth";
import { AnalyticsCard } from "./analytics-card";
import { AnalyticsTable, EmptyRow, Tbody, Td, Th, Thead } from "./analytics-table";
import { SectionTitle } from "./section-title";

/**
 * Monthly comparison and growth analytics.
 *
 * Reads `useMonthlyGrowth` and renders it in the dashboard's own chrome —
 * `SectionTitle`, `AnalyticsCard`, `AnalyticsTable`, the shared chart theme.
 * Nothing here is styled from scratch, which is why it sits under the KPI cards
 * without looking bolted on.
 *
 * The one thing this section says that the rest of the page does not: it is not
 * scoped by the date picker. Its subject is the whole timeline, and it says so
 * in the subtitle rather than quietly ignoring a filter the user just moved.
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

/** Money, or an em dash when the team was not operating that month. */
const money = (value: number | null | undefined) => (value == null ? "—" : fmtSAR(value));

const count = (value: number | null | undefined) => (value == null ? "—" : value.toLocaleString());

/**
 * A growth rate, coloured by direction.
 *
 * `--positive` and `--negative` are the tokens the rest of the portal already
 * uses for exactly this, and both are defined per theme — so a contraction reads
 * as red on the light dashboard and on the dark one without a second palette.
 */
function Growth({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        "font-semibold",
        value >= 0 ? "text-[var(--positive)]" : "text-[var(--negative)]",
      )}
    >
      {formatGrowth(value)}
    </span>
  );
}

/** A team that did not exist that month. Distinct from a dash, which means
 *  "no previous month to compare with". */
const NA = <span className="text-muted-foreground/70">N/A</span>;

function MonthCell({ row }: { row: MonthRow }) {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span className="font-medium">{row.label}</span>
      {row.partial && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          In progress
        </span>
      )}
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

function Insights({ insights }: { insights: readonly Insight[] }) {
  if (insights.length === 0) return null;

  return (
    <AnalyticsCard
      title="Performance insights"
      subtitle="Generated from the figures below"
      icon={Lightbulb}
      className="mt-3"
    >
      <ul className="grid gap-2 sm:grid-cols-2">
        {insights.map((insight) => (
          <li
            key={insight.id}
            className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-sm"
          >
            <span
              aria-hidden
              className={cn(
                "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                insight.tone === "positive"
                  ? "bg-[var(--positive)]"
                  : insight.tone === "negative"
                    ? "bg-[var(--negative)]"
                    : "bg-muted-foreground/60",
              )}
            />
            <span className="min-w-0 leading-relaxed">{insight.text}</span>
          </li>
        ))}
      </ul>
    </AnalyticsCard>
  );
}

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

  const unreconciled = rows.some((r) => Math.abs(r.combined.unallocatedRevenue) > 0.005);

  const scopeTabs = (
    <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
      <TabsList className="h-8">
        {(Object.keys(SCOPE_LABEL) as Scope[]).map((key) => (
          <TabsTrigger key={key} value={key} className="px-2.5 py-0.5 text-xs">
            {SCOPE_LABEL[key]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  return (
    <div>
      <SectionTitle title="Monthly comparison & growth" icon={TrendingUp} />
      <p className="-mt-1 mb-3 text-xs text-muted-foreground">
        Completed orders only, whole months, both teams — the full timeline, so this section is not
        narrowed by the date range above. February–June 2026 is the historical baseline; July 2026
        onward is live completed-order data.
        {isLoading && <span className="ml-1 animate-pulse">Loading current months…</span>}
      </p>

      <Insights insights={insights} />

      {/* 1 — the headline comparison */}
      <AnalyticsCard
        title="Monthly comparison"
        subtitle="Customer Care against Telesales, and the two combined"
        icon={Table2}
        className="mt-3"
        flush
      >
        <AnalyticsTable minWidth={1180}>
          <Thead>
            <tr>
              <Th>Month</Th>
              <Th align="right">CC revenue</Th>
              <Th align="right">CC growth</Th>
              <Th align="right">CC orders</Th>
              <Th align="right">TS revenue</Th>
              <Th align="right">TS growth</Th>
              <Th align="right">TS orders</Th>
              <Th align="right">Combined revenue</Th>
              <Th align="right">Combined growth</Th>
              <Th align="right">Combined orders</Th>
              <Th align="right">Avg order value</Th>
            </tr>
          </Thead>
          <Tbody>
            {rows.length === 0 && <EmptyRow colSpan={11} />}
            {rows.map((row) => (
              <tr key={row.month}>
                <Td>
                  <MonthCell row={row} />
                </Td>
                <Td numeric>{row.customerCare ? money(row.customerCare.totalRevenue) : NA}</Td>
                <Td numeric>
                  {row.customerCare ? <Growth value={row.customerCare.revenueGrowth} /> : NA}
                </Td>
                <Td numeric>{row.customerCare ? count(row.customerCare.totalOrders) : NA}</Td>
                <Td numeric>{row.telesales ? money(row.telesales.totalRevenue) : NA}</Td>
                <Td numeric>
                  {row.telesales ? <Growth value={row.telesales.revenueGrowth} /> : NA}
                </Td>
                <Td numeric>{row.telesales ? count(row.telesales.totalOrders) : NA}</Td>
                <Td numeric className="font-semibold">
                  {money(row.combined.totalRevenue)}
                </Td>
                <Td numeric>
                  <Growth value={row.combined.revenueGrowth} />
                </Td>
                <Td numeric className="font-semibold">
                  {count(row.combined.totalOrders)}
                </Td>
                <Td numeric>{money(row.combined.avgOrderValue)}</Td>
              </tr>
            ))}
          </Tbody>
        </AnalyticsTable>
        <p className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
          <span className="font-medium">N/A</span> means the team was not operating that month —
          Telesales started in April 2026. <span className="font-medium">—</span> means there is no
          previous month to compare against.
        </p>
      </AnalyticsCard>

      {/* 2 — the per-month revenue analytics, per scope */}
      <AnalyticsCard
        title="Monthly revenue analytics"
        subtitle={`Cash, Wasfaty and totals — ${SCOPE_LABEL[scope]}`}
        icon={CalendarRange}
        className="mt-3"
        actions={scopeTabs}
        flush
      >
        <AnalyticsTable minWidth={1080}>
          <Thead>
            <tr>
              <Th>Month</Th>
              <Th align="right">Cash revenue</Th>
              <Th align="right">Wasfaty revenue</Th>
              <Th align="right">Total revenue</Th>
              <Th align="right">Revenue growth</Th>
              <Th align="right">Cash orders</Th>
              <Th align="right">Wasfaty orders</Th>
              <Th align="right">Total orders</Th>
              <Th align="right">Order growth</Th>
              <Th align="right">Avg order value</Th>
            </tr>
          </Thead>
          <Tbody>
            {rows.length === 0 && <EmptyRow colSpan={10} />}
            {rows.map((row) => {
              const m = scopeMetrics(row, scope);
              return (
                <tr key={row.month}>
                  <Td>
                    <MonthCell row={row} />
                  </Td>
                  {m ? (
                    <>
                      <Td numeric>{money(m.cashRevenue)}</Td>
                      <Td numeric>{money(m.wasfatyRevenue)}</Td>
                      <Td numeric className="font-semibold">
                        {money(m.totalRevenue)}
                      </Td>
                      <Td numeric>
                        <Growth value={m.revenueGrowth} />
                      </Td>
                      <Td numeric>{count(m.cashOrders)}</Td>
                      <Td numeric>{count(m.wasfatyOrders)}</Td>
                      <Td numeric className="font-semibold">
                        {count(m.totalOrders)}
                      </Td>
                      <Td numeric>
                        <Growth value={m.orderGrowth} />
                      </Td>
                      <Td numeric>{money(m.avgOrderValue)}</Td>
                    </>
                  ) : (
                    <Td colSpan={9} className="text-center text-muted-foreground/70">
                      {SCOPE_LABEL[scope]} was not operating this month
                    </Td>
                  )}
                </tr>
              );
            })}
          </Tbody>
        </AnalyticsTable>
        {unreconciled && (
          <p className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
            June 2026 Telesales was supplied with a total of 188,985.39 SAR against Cash + Wasfaty
            of 164,223.20 SAR. The supplied total is used — it is what the reported growth is
            measured on — and the 24,762.19 SAR difference is shown as{" "}
            <span className="font-medium">Unallocated</span> in the revenue mix chart rather than
            being folded into either channel.
          </p>
        )}
      </AnalyticsCard>

      {/* 3 — where the growth is actually coming from */}
      <AnalyticsCard
        title="Cash vs Wasfaty growth breakdown"
        subtitle={`Whether growth is volume or basket size — ${SCOPE_LABEL[scope]}`}
        icon={Coins}
        className="mt-3"
        actions={scopeTabs}
        flush
      >
        <AnalyticsTable minWidth={880}>
          <Thead>
            <tr>
              <Th>Month</Th>
              <Th align="right">Cash revenue Δ</Th>
              <Th align="right">Cash orders Δ</Th>
              <Th align="right">Avg cash order</Th>
              <Th align="right">Wasfaty revenue Δ</Th>
              <Th align="right">Wasfaty orders Δ</Th>
              <Th align="right">Avg Wasfaty order</Th>
            </tr>
          </Thead>
          <Tbody>
            {rows.length === 0 && <EmptyRow colSpan={7} />}
            {rows.map((row) => {
              const m = scopeMetrics(row, scope);
              return (
                <tr key={row.month}>
                  <Td>
                    <MonthCell row={row} />
                  </Td>
                  {m ? (
                    <>
                      <Td numeric>
                        <Growth value={m.cashRevenueGrowth} />
                      </Td>
                      <Td numeric>
                        <Growth value={m.cashOrderGrowth} />
                      </Td>
                      <Td numeric>{money(m.avgCashOrderValue)}</Td>
                      <Td numeric>
                        <Growth value={m.wasfatyRevenueGrowth} />
                      </Td>
                      <Td numeric>
                        <Growth value={m.wasfatyOrderGrowth} />
                      </Td>
                      <Td numeric>{money(m.avgWasfatyOrderValue)}</Td>
                    </>
                  ) : (
                    <Td colSpan={6} className="text-center text-muted-foreground/70">
                      {SCOPE_LABEL[scope]} was not operating this month
                    </Td>
                  )}
                </tr>
              );
            })}
          </Tbody>
        </AnalyticsTable>
      </AnalyticsCard>

      <div className="mt-3">
        <Suspense fallback={<ChartsSkeleton />}>
          <MonthlyGrowthCharts rows={rows} />
        </Suspense>
      </div>
    </div>
  );
}
