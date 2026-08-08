import { Suspense, lazy } from "react";
import { Banknote, PackageCheck, PhoneCall, TrendingUp, Users2 } from "lucide-react";
import { fmtSAR } from "@/lib/branches";
import { AnalyticsCard } from "@/features/dashboard/components/analytics-card";
import {
  AnalyticsTable,
  EmptyRow,
  Tbody,
  Td,
  Th,
  Thead,
} from "@/features/dashboard/components/analytics-table";
import { SectionTitle } from "@/features/dashboard/components/section-title";
import { StatCard } from "@/features/dashboard/components/stat-card";
import type { useMonthlyReport } from "../hooks/use-monthly-report";

/**
 * The monthly management report.
 *
 * Ordered the way the question is asked: how much did we sell, who sold it, what
 * kind of orders were they, how did they reach the customer, how did the month
 * move, and how did the phones do. Every section is a compact table or a KPI row
 * — the reference workbook this replaces had eleven sheets of working-out, and
 * the portal does the working-out.
 *
 * Charts are deliberately singular. One trend line earns its place because "which
 * days were strong" is genuinely a shape question; everything else on this page
 * is a number somebody reads out, and a donut of two slices is a table with extra
 * steps.
 */

const MonthlyTrendChart = lazy(() =>
  import("./monthly-trend-chart").then((m) => ({ default: m.MonthlyTrendChart })),
);

type MonthlyData = ReturnType<typeof useMonthlyReport>;

const pct = (value: number) => `${value.toFixed(1)}%`;
const num = (value: number) => value.toLocaleString("en-US");

function minutes(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

export function MonthlyReportView({ data, label }: { data: MonthlyData; label: string }) {
  const { summary, teams, orderTypes, fulfillment, trend, trendHighlights, calls } = data;

  return (
    <div className="space-y-6 print:space-y-4">
      {/* Executive summary */}
      <div>
        <SectionTitle title={`Executive summary — ${label}`} icon={TrendingUp} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total Orders" value={num(summary.totalOrders)} />
          <StatCard
            label="Completed Orders"
            value={num(summary.completedOrders)}
            sub={`${pct(summary.completionRate)} completion rate`}
          />
          <StatCard label="Total Sales" value={fmtSAR(summary.totalSales)} />
          <StatCard
            label="Completed Sales"
            value={fmtSAR(summary.completedSales)}
            accent="text-[var(--positive)]"
          />
          <StatCard label="Cash Sales" value={fmtSAR(summary.cashSales)} sub="Completed" />
          <StatCard label="Wasfaty Sales" value={fmtSAR(summary.wasfatySales)} sub="Completed" />
          <StatCard
            label="Average Order Value"
            value={fmtSAR(summary.averageOrderValue)}
            sub="Completed sales ÷ completed orders"
          />
          <StatCard
            label="Completion Rate"
            value={pct(summary.completionRate)}
            sub={`${num(summary.totalOrders - summary.completedOrders)} not completed`}
          />
        </div>
      </div>

      {/* Team performance */}
      <div>
        <SectionTitle title="Team performance" icon={Users2} />
        <AnalyticsCard
          title="Customer Care vs Telesales"
          subtitle="Completed figures, with each team's share of the month's completed sales"
          icon={Users2}
          flush
        >
          <AnalyticsTable minWidth={760}>
            <Thead>
              <tr>
                <Th>Team</Th>
                <Th align="right">Orders</Th>
                <Th align="right">Completed</Th>
                <Th align="right">Rate</Th>
                <Th align="right">Completed sales</Th>
                <Th align="right">Cash</Th>
                <Th align="right">Wasfaty</Th>
                <Th align="right">AOV</Th>
                <Th align="right">Share</Th>
              </tr>
            </Thead>
            <Tbody>
              {teams.total.orders === 0 && <EmptyRow colSpan={9} />}
              {teams.total.orders > 0 &&
                teams.rows.map((row) => (
                  <tr key={row.team}>
                    <Td className="font-medium">{row.team}</Td>
                    <Td numeric>{num(row.orders)}</Td>
                    <Td numeric>{num(row.completedOrders)}</Td>
                    <Td numeric>{pct(row.completionRate)}</Td>
                    <Td numeric>{fmtSAR(row.completedSales)}</Td>
                    <Td numeric>{fmtSAR(row.cashSales)}</Td>
                    <Td numeric>{fmtSAR(row.wasfatySales)}</Td>
                    <Td numeric>{fmtSAR(row.averageOrderValue)}</Td>
                    <Td numeric>{pct(row.contribution)}</Td>
                  </tr>
                ))}
              {teams.total.orders > 0 && (
                <tr className="border-t border-border/60 font-semibold">
                  <Td className="font-semibold">Total</Td>
                  <Td numeric>{num(teams.total.orders)}</Td>
                  <Td numeric>{num(teams.total.completedOrders)}</Td>
                  <Td numeric>{pct(teams.total.completionRate)}</Td>
                  <Td numeric>{fmtSAR(teams.total.completedSales)}</Td>
                  <Td numeric>{fmtSAR(teams.total.cashSales)}</Td>
                  <Td numeric>{fmtSAR(teams.total.wasfatySales)}</Td>
                  <Td numeric>{fmtSAR(teams.total.averageOrderValue)}</Td>
                  <Td numeric>{pct(teams.total.contribution)}</Td>
                </tr>
              )}
            </Tbody>
          </AnalyticsTable>
        </AnalyticsCard>
      </div>

      {/* Cash vs Wasfaty, and how orders were fulfilled. Side by side because
          they answer the same question about the same completed population —
          what kind of order was it, and how did it reach the customer. */}
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <AnalyticsCard title="Cash vs Wasfaty" subtitle="Completed orders" icon={Banknote} flush>
          <AnalyticsTable minWidth={400}>
            <Thead>
              <tr>
                <Th>Type</Th>
                <Th align="right">Orders</Th>
                <Th align="right">%</Th>
                <Th align="right">Sales</Th>
                <Th align="right">%</Th>
              </tr>
            </Thead>
            <Tbody>
              {orderTypes.totalOrders === 0 && <EmptyRow colSpan={5} />}
              {orderTypes.totalOrders > 0 &&
                orderTypes.rows.map((row) => (
                  <tr key={row.label}>
                    <Td className="font-medium">{row.label}</Td>
                    <Td numeric>{num(row.orders)}</Td>
                    <Td numeric>{pct(row.ordersPercent)}</Td>
                    <Td numeric>{fmtSAR(row.sales)}</Td>
                    <Td numeric>{pct(row.salesPercent)}</Td>
                  </tr>
                ))}
              {orderTypes.totalOrders > 0 && (
                <tr className="border-t border-border/60 font-semibold">
                  <Td className="font-semibold">Total</Td>
                  <Td numeric>{num(orderTypes.totalOrders)}</Td>
                  <Td numeric>100%</Td>
                  <Td numeric>{fmtSAR(orderTypes.totalSales)}</Td>
                  <Td numeric>100%</Td>
                </tr>
              )}
            </Tbody>
          </AnalyticsTable>
        </AnalyticsCard>

        {/* The same `summarizeFulfillment` the Dashboard and the Orders filter
            read — El Shorouk, Azman and Branch Scooter are Delivery, Store
            Pickup is its own line, and nothing here re-decides that. */}
        <AnalyticsCard
          title="Delivery vs Store Pickup"
          subtitle="Completed orders, with the Cash/Wasfaty split of each"
          icon={PackageCheck}
          flush
        >
          <AnalyticsTable minWidth={400}>
            <Thead>
              <tr>
                <Th>Fulfillment</Th>
                <Th align="right">Orders</Th>
                <Th align="right">%</Th>
                <Th align="right">Cash</Th>
                <Th align="right">Wasfaty</Th>
              </tr>
            </Thead>
            <Tbody>
              {fulfillment.total.count === 0 && <EmptyRow colSpan={5} />}
              {fulfillment.total.count > 0 &&
                [
                  fulfillment.delivery,
                  fulfillment.pickup,
                  ...(fulfillment.unknown.count > 0 ? [fulfillment.unknown] : []),
                ].map((row) => (
                  <tr key={row.label}>
                    <Td className="font-medium">{row.label}</Td>
                    <Td numeric>{num(row.count)}</Td>
                    <Td numeric>{row.key === "unknown" ? "—" : pct(row.percent)}</Td>
                    <Td numeric>{num(row.cash)}</Td>
                    <Td numeric>{num(row.wasfaty)}</Td>
                  </tr>
                ))}
              {fulfillment.total.count > 0 && (
                <tr className="border-t border-border/60 font-semibold">
                  <Td className="font-semibold">Total</Td>
                  <Td numeric>{num(fulfillment.total.count)}</Td>
                  <Td numeric>{fulfillment.classified.count > 0 ? "100%" : "—"}</Td>
                  <Td numeric>{num(fulfillment.total.cash)}</Td>
                  <Td numeric>{num(fulfillment.total.wasfaty)}</Td>
                </tr>
              )}
            </Tbody>
          </AnalyticsTable>
        </AnalyticsCard>
      </div>

      {/* Sales trend */}
      <div>
        <SectionTitle title="Sales trend" icon={TrendingUp} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Best day"
            value={trendHighlights.best ? fmtSAR(trendHighlights.best.completed) : "—"}
            sub={trendHighlights.best?.date}
            accent="text-[var(--positive)]"
          />
          <StatCard
            label="Weakest trading day"
            value={trendHighlights.weakest ? fmtSAR(trendHighlights.weakest.completed) : "—"}
            sub={trendHighlights.weakest?.date}
          />
          <StatCard label="Average day" value={fmtSAR(trendHighlights.averageDay)} />
          <StatCard
            label="Days with no sales"
            value={num(trendHighlights.quietDays)}
            sub="Excluded from the averages"
          />
        </div>
        <AnalyticsCard
          title="Daily sales"
          subtitle="Total vs completed, by day"
          icon={TrendingUp}
          className="mt-3"
        >
          <Suspense fallback={<div className="h-[260px] animate-pulse rounded-md bg-muted/40" />}>
            <MonthlyTrendChart data={trend} />
          </Suspense>
        </AnalyticsCard>
      </div>

      {/* Call centre */}
      <div>
        <SectionTitle title="Call centre" icon={PhoneCall} />
        {data.callsUnavailable ? (
          <AnalyticsCard title="Call performance" icon={PhoneCall}>
            <p className="text-sm text-muted-foreground">
              Call analytics are unavailable for this period.
            </p>
          </AnalyticsCard>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total Calls" value={num(calls.totalCalls)} />
            <StatCard
              label="Answered"
              value={num(calls.answered)}
              sub={`${pct(calls.answerRate)} answer rate`}
              accent="text-[var(--positive)]"
            />
            {/* Missed and Abandoned come from `resolveQueueOutcomeSplit`, the
                shared classifier — never recomputed here, and the source is
                stated so the report and the Calls pages can be reconciled. */}
            <StatCard
              label="Missed"
              value={num(calls.missed)}
              sub={`${pct(calls.missedRate)} of inbound`}
            />
            <StatCard
              label="Abandoned"
              value={num(calls.abandoned)}
              sub={`${pct(calls.abandonedRate)} of inbound`}
            />
            <StatCard label="Average talk time" value={minutes(calls.avgTalkSec)} />
            <StatCard
              label="Missed / Abandoned source"
              value={calls.splitSource === "call_report" ? "Phone system" : "Call records"}
              sub={
                calls.splitSource === "call_report"
                  ? "Yeastar's own queue report"
                  : "Derived from CDR"
              }
            />
          </div>
        )}
      </div>

      {/* Branch & geography. Last because it is the section management reads
          only when something above it prompted the question. */}
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <AnalyticsCard title="Top cities by sales" icon={PackageCheck} flush>
          <AnalyticsTable minWidth={320}>
            <Thead>
              <tr>
                <Th>City</Th>
                <Th align="right">Completed sales</Th>
              </tr>
            </Thead>
            <Tbody>
              {data.cities.length === 0 && <EmptyRow colSpan={2} />}
              {data.cities.slice(0, 10).map((city) => (
                <tr key={city.name}>
                  <Td className="font-medium">{city.name}</Td>
                  <Td numeric>{fmtSAR(city.sales)}</Td>
                </tr>
              ))}
            </Tbody>
          </AnalyticsTable>
        </AnalyticsCard>

        <AnalyticsCard title="Top branches by sales" icon={PackageCheck} flush>
          <AnalyticsTable minWidth={320}>
            <Thead>
              <tr>
                <Th>Branch</Th>
                <Th align="right">Completed sales</Th>
              </tr>
            </Thead>
            <Tbody>
              {data.branches.length === 0 && <EmptyRow colSpan={2} />}
              {data.branches.slice(0, 10).map((branch) => (
                <tr key={branch.name}>
                  <Td className="font-medium">{branch.name}</Td>
                  <Td numeric>{fmtSAR(branch.sales)}</Td>
                </tr>
              ))}
            </Tbody>
          </AnalyticsTable>
        </AnalyticsCard>
      </div>
    </div>
  );
}
