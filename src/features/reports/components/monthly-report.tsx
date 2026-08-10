import { Suspense, lazy } from "react";
import { Banknote, BarChart3, PackageCheck, PhoneCall, TrendingUp, Users2 } from "lucide-react";
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
 * Ordered the way the question is asked: what did the month do, who did it, what
 * did it look like, how did the phones perform, and where did it happen. Every
 * section is a compact KPI row, a table or a chart — the reference workbook this
 * replaces had eleven sheets of working-out, and the portal does the working-out.
 *
 * Nothing here computes. Every figure arrives from `useMonthlyReport`, which
 * arranges figures the Dashboard's RPCs and the Calls module's analytics already
 * produced. A report that recomputed its own totals would be a second source of
 * truth for numbers management already reads on the dashboard.
 *
 * Print does not get a second layout. The export narrows the page to the paper's
 * own width (`PRINT_WIDTH_PX`) and the responsive classes already here do the
 * rest — at 703px the two-column grids are single-column and the KPI strip is
 * two across, which is exactly what lands on A4. Having print-only column counts
 * meant the layout being measured and the layout being printed could differ, and
 * a chart measured against one and rendered into the other is how the first
 * version came out clipped. See `@media print` in `styles.css` for the page
 * geometry and `print-width.ts` for why the width is applied before printing.
 */

const MonthlyCharts = lazy(() =>
  import("./monthly-charts").then((m) => ({ default: m.MonthlyCharts })),
);

type MonthlyData = ReturnType<typeof useMonthlyReport>;

const pct = (value: number) => `${value.toFixed(1)}%`;
const num = (value: number) => value.toLocaleString("en-US");

function minutes(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/**
 * A section that must not be split across a page break where it can be helped.
 *
 * `break-inside-avoid` on the wrapper keeps a heading with at least the start of
 * its content; the cards inside carry their own copy of the rule so a long
 * section still breaks *between* cards rather than through one.
 */
function ReportSection({
  title,
  icon,
  children,
  breakBefore,
}: {
  title: string;
  icon: typeof Users2;
  children: React.ReactNode;
  /** Start this section on a fresh page in the PDF. */
  breakBefore?: boolean;
}) {
  return (
    <section className={breakBefore ? "print:break-before-page" : undefined}>
      <SectionTitle title={title} icon={icon} />
      {children}
    </section>
  );
}

/** The KPI grid, one place so every row on this page has the same rhythm. */
function KpiGrid({ children }: { children: React.ReactNode }) {
  return (
    // At the printable width this resolves to two columns, which is the right
    // number: four across 186mm of A4 gives each card about 45mm, and
    // `1,234,567.89 SAR` at the card's figure size does not fit in 45mm — it
    // would truncate, and a truncated figure on a management report is a wrong
    // number rather than a tight one.
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 print:gap-2 [&>*]:break-inside-avoid">
      {children}
    </div>
  );
}

export function MonthlyReportView({
  data,
  label,
  /**
   * True while the page is laid out at the paper's width for an export.
   *
   * Only the tables read it, and only to drop their horizontal-scroll floor:
   * `AnalyticsTable` applies `minWidth` as an inline style, which no `print:`
   * class can override, so a 760px floor inside a 703px page was a table sliced
   * off at the right edge with a scrollbar printed under it. Nothing else about
   * the report changes — the charts are handled by the container width alone.
   */
  printing = false,
}: {
  data: MonthlyData;
  label: string;
  printing?: boolean;
}) {
  const { summary, teams, orderTypes, fulfillment, trendHighlights, calls, callCenter } = data;
  const [customerCare, telesales] = teams.rows;
  /** Screen keeps its scroll floor; paper has nowhere to scroll to. */
  const floor = (width: number) => (printing ? 0 : width);

  return (
    <div className="space-y-6 print:space-y-4">
      {/* ------------------------------------------------------------------ */}
      {/* KPI summary                                                        */}
      {/* ------------------------------------------------------------------ */}
      <ReportSection title={`KPI summary — ${label}`} icon={TrendingUp}>
        <KpiGrid>
          <StatCard label="Total Revenue (SAR)" value={fmtSAR(summary.totalSales)} />
          <StatCard
            label="Completed Revenue (SAR)"
            value={fmtSAR(summary.completedSales)}
            accent="text-[var(--positive)]"
          />
          <StatCard label="Total Orders" value={num(summary.totalOrders)} />
          <StatCard
            label="Completed Orders"
            value={num(summary.completedOrders)}
            sub={`${num(summary.totalOrders - summary.completedOrders)} not completed`}
          />
          <StatCard
            label="Overall Completion Rate"
            value={pct(summary.completionRate)}
            sub="Completed orders ÷ all orders"
          />
          <StatCard
            label="Avg Order Value (SAR)"
            value={fmtSAR(summary.averageOrderValue)}
            sub="Completed revenue ÷ completed orders"
          />
          {/* Total minus completed, by the RPC's own definition of completed —
              not a second count of cancelled and pending value. */}
          <StatCard
            label="Revenue Lost (non-completed)"
            value={fmtSAR(summary.revenueLost)}
            sub={`${pct(100 - summary.completionRate)} of orders`}
            accent="text-destructive"
          />
          <StatCard
            label="Top City by Revenue"
            value={data.topCity?.name ?? "—"}
            sub={data.topCity ? fmtSAR(data.topCity.sales) : undefined}
          />
        </KpiGrid>
      </ReportSection>

      {/* ------------------------------------------------------------------ */}
      {/* Team performance                                                   */}
      {/* ------------------------------------------------------------------ */}
      <ReportSection title="Team performance" icon={Users2}>
        {/* Completed performance per team, called out above the full table:
            these three figures per team are what a management summary quotes,
            and they are the same `orders_kpis` rows the table below expands. */}
        <div className="grid gap-3 lg:grid-cols-2 print:gap-2">
          {[customerCare, telesales].map((row) => (
            <AnalyticsCard
              key={row.team}
              title={row.team}
              subtitle="Completed performance"
              icon={Users2}
              className="break-inside-avoid"
            >
              <div className="grid grid-cols-3 gap-3">
                <Figure label="Completed Revenue" value={fmtSAR(row.completedSales)} />
                <Figure label="Completed Orders" value={num(row.completedOrders)} />
                <Figure label="Completion Rate" value={pct(row.completionRate)} />
              </div>
            </AnalyticsCard>
          ))}
        </div>

        <AnalyticsCard
          title="Customer Care vs Telesales"
          subtitle="Completed figures, with each team's share of the month's completed revenue"
          icon={Users2}
          flush
          className="mt-3 break-inside-avoid"
        >
          {/* Ten columns of currency is the one table that cannot hold its
              screen size on A4. Printing drops the 760px scroll floor and takes
              the type down a step; on screen both stay as they were and the card
              scrolls. */}
          <AnalyticsTable
            minWidth={floor(760)}
            className={
              printing ? "overflow-visible [&_table]:text-[10px] [&_th]:text-[9px]" : undefined
            }
          >
            <Thead>
              <tr>
                <Th>Team</Th>
                <Th align="right">Orders</Th>
                <Th align="right">Completed</Th>
                <Th align="right">Rate</Th>
                <Th align="right">Completed revenue</Th>
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
      </ReportSection>

      {/* ------------------------------------------------------------------ */}
      {/* Charts                                                             */}
      {/* ------------------------------------------------------------------ */}
      <ReportSection title="Charts" icon={BarChart3} breakBefore>
        <Suspense
          fallback={
            <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
              <div className="h-[344px] animate-pulse rounded-xl bg-muted/40" />
              <div className="h-[344px] animate-pulse rounded-xl bg-muted/40" />
            </div>
          }
        >
          <MonthlyCharts
            printing={printing}
            data={{
              teamRevenue: data.teamRevenue,
              trend: data.trend,
              topCities: data.topCities,
              topBranches: data.topBranches,
              statusData: data.statusData,
              deliveryRevenue: data.deliveryRevenue,
              orderTypeRevenue: data.orderTypeRevenue,
            }}
          />
        </Suspense>
      </ReportSection>

      {/* ------------------------------------------------------------------ */}
      {/* Call centre                                                        */}
      {/* ------------------------------------------------------------------ */}
      <ReportSection title="Call centre" icon={PhoneCall} breakBefore>
        {data.callsUnavailable ? (
          <AnalyticsCard title="Call performance" icon={PhoneCall} className="break-inside-avoid">
            <p className="text-sm text-muted-foreground">
              Call analytics are unavailable for this period.
            </p>
          </AnalyticsCard>
        ) : (
          <>
            {/* Volume per team and the Telesales conversion rate. Both come out
                of the Calls module's own analytics — `teamCompare` for the
                split, `conversion.overall` for the rate — so the extension
                mapping and the team classification are the ones every Calls
                page already uses. Conversion is Telesales-only by construction:
                an inbound care queue does not convert. */}
            <KpiGrid>
              <StatCard
                label="Customer Care — Total Calls"
                value={num(callCenter.customerCare.totalCalls)}
              />
              <StatCard
                label="Telesales — Total Calls"
                value={num(callCenter.telesales.totalCalls)}
              />
              <StatCard
                label="Telesales — Conversion Rate"
                value={
                  callCenter.telesales.conversionRate == null
                    ? "—"
                    : pct(callCenter.telesales.conversionRate)
                }
                sub="Orders ÷ answered calls"
              />
              <StatCard
                label="Overall — Total Calls"
                value={num(callCenter.overall.totalCalls)}
                sub="Whole network, both directions"
              />
            </KpiGrid>

            <div className="mt-3">
              <KpiGrid>
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
              </KpiGrid>
            </div>

            <p className="mt-2 text-[11px] text-muted-foreground">
              Missed / Abandoned split:{" "}
              {calls.splitSource === "call_report"
                ? "Yeastar's own queue report"
                : "derived from call records"}
              .
            </p>
          </>
        )}
      </ReportSection>

      {/* ------------------------------------------------------------------ */}
      {/* Order mix and fulfillment                                          */}
      {/* ------------------------------------------------------------------ */}
      <ReportSection title="Order mix" icon={Banknote} breakBefore>
        {/* Cash vs Wasfaty and how orders reached the customer, side by side:
            they answer the same question about the same completed population. */}
        <div className="grid min-w-0 gap-3 lg:grid-cols-2 print:gap-2">
          <AnalyticsCard
            title="Cash vs Wasfaty"
            subtitle="Completed orders"
            icon={Banknote}
            flush
            className="break-inside-avoid"
          >
            <AnalyticsTable
              minWidth={floor(400)}
              className={printing ? "overflow-visible" : undefined}
            >
              <Thead>
                <tr>
                  <Th>Type</Th>
                  <Th align="right">Orders</Th>
                  <Th align="right">%</Th>
                  <Th align="right">Revenue</Th>
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
            className="break-inside-avoid"
          >
            <AnalyticsTable
              minWidth={floor(400)}
              className={printing ? "overflow-visible" : undefined}
            >
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
      </ReportSection>

      {/* ------------------------------------------------------------------ */}
      {/* Trend highlights                                                   */}
      {/* ------------------------------------------------------------------ */}
      <ReportSection title="Revenue trend highlights" icon={TrendingUp}>
        <KpiGrid>
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
            label="Days with no revenue"
            value={num(trendHighlights.quietDays)}
            sub="Excluded from the averages"
          />
        </KpiGrid>
      </ReportSection>

      {/* ------------------------------------------------------------------ */}
      {/* Branch and geography                                               */}
      {/* ------------------------------------------------------------------ */}
      <ReportSection title="Branch & geography" icon={PackageCheck} breakBefore>
        <div className="grid min-w-0 gap-3 lg:grid-cols-2 print:gap-2">
          <AnalyticsCard
            title="Top cities by revenue"
            icon={PackageCheck}
            flush
            className="break-inside-avoid"
          >
            <AnalyticsTable
              minWidth={floor(320)}
              className={printing ? "overflow-visible" : undefined}
            >
              <Thead>
                <tr>
                  <Th>City</Th>
                  <Th align="right">Completed revenue</Th>
                </tr>
              </Thead>
              <Tbody>
                {data.cities.length === 0 && <EmptyRow colSpan={2} />}
                {data.topCities.map((city) => (
                  <tr key={city.name}>
                    <Td className="font-medium">{city.name}</Td>
                    <Td numeric>{fmtSAR(city.sales)}</Td>
                  </tr>
                ))}
              </Tbody>
            </AnalyticsTable>
          </AnalyticsCard>

          <AnalyticsCard
            title="Top branches by revenue"
            icon={PackageCheck}
            flush
            className="break-inside-avoid"
          >
            <AnalyticsTable
              minWidth={floor(320)}
              className={printing ? "overflow-visible" : undefined}
            >
              <Thead>
                <tr>
                  <Th>Branch</Th>
                  <Th align="right">Completed revenue</Th>
                </tr>
              </Thead>
              <Tbody>
                {data.branches.length === 0 && <EmptyRow colSpan={2} />}
                {data.topBranches.map((branch) => (
                  <tr key={branch.name}>
                    <Td className="font-medium">{branch.name}</Td>
                    <Td numeric>{fmtSAR(branch.sales)}</Td>
                  </tr>
                ))}
              </Tbody>
            </AnalyticsTable>
          </AnalyticsCard>
        </div>
      </ReportSection>
    </div>
  );
}

/** One labelled figure inside a card. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] uppercase tracking-wider text-muted-foreground sm:text-[11px]">
        {label}
      </div>
      <div className="mt-1 truncate text-base font-semibold sm:text-lg">{value}</div>
    </div>
  );
}
