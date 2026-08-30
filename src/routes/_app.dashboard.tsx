import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Suspense, lazy } from "react";
import { fmtSAR } from "@/lib/branches";
import {
  Banknote,
  CheckCircle2,
  CircleAlert,
  ClipboardPlus,
  Download,
  FileSpreadsheet,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Loader,
  Printer,
  Wallet,
  // Aliased, and not for tidiness. The TanStack router plugin splits the
  // component out of this file but leaves the route shell behind, and appends a
  // dev-only fast-refresh shim to that shell which runs `new Map()`. As a bare
  // `Map` the icon was still imported into the shell, where it shadowed the
  // global constructor for the whole module and turned that line into
  // "TypeError: Map is not a constructor".
  //
  // It only fires when this shell is the first to install the shim (it is
  // guarded by `window.__TSR_REACT_REFRESH__ ??=`), so a normal /dashboard page
  // load is unaffected — the route tree evaluates other shells first. What it
  // did break was loading this module on its own, which is what dev tooling
  // does. Aliasing removes the import from the shell entirely, since `MapIcon`
  // is only referenced in the split half. Same reason as `Route` below.
  Map as MapIcon,
  MessageSquareWarning,
  Route as RouteIcon,
  ShieldAlert,
  ReceiptText,
  FileCheck2,
  Truck,
} from "lucide-react";

import { DateRangePicker } from "@/components/date-range-picker";
import { ReportPrintFooter, ReportPrintHeader } from "@/components/print-chrome";
import { PRINT_WIDTH_PX } from "@/lib/print-width";
import { usePrintExport } from "@/lib/print-export";
import { ChartPrintContext } from "@/features/dashboard/chart-motion";
import { exportDashboard } from "@/features/dashboard/export";
import {
  ChartCardSkeleton,
  SalesChartsSkeleton,
} from "@/features/dashboard/components/sales-charts-skeleton";
import { SaudiMapSkeleton } from "@/features/dashboard/components/saudi-map-skeleton";
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
import { DashKpiCard } from "@/features/dashboard/components/dash-kpi-card";
import { DeliveryMatrix } from "@/features/dashboard/components/delivery-matrix";
import { DeliveryMethodsSection } from "@/features/dashboard/components/delivery-methods-section";
import { DASH_DELAY, Reveal } from "@/features/dashboard/components/reveal";
import { MonthlyGrowthSection } from "@/features/dashboard/components/monthly-growth-section";
import { useDashboardFilters } from "@/features/dashboard/hooks/use-dashboard-filters";
import { useDashboardData } from "@/features/dashboard/hooks/use-dashboard-data";
import { useDashboardExportData } from "@/features/dashboard/hooks/use-dashboard-export-data";
import { useMonthlyGrowth } from "@/features/dashboard/hooks/use-monthly-growth";

/**
 * Recharts, deferred.
 *
 * The library is 364KB minified — by a wide margin the largest thing this app
 * ships that is not the XLSX writer, and that has been lazy for a while. As a
 * static import of this route it was fetched before React rendered anything, so
 * the KPI cards, the stat tiles and the delivery matrix — none of which involve
 * a chart — waited behind a charting library. Now the numbers paint off this
 * route's own chunk and the charts arrive when they arrive.
 */
const SalesCharts = lazy(() =>
  import("@/features/dashboard/components/sales-charts").then((m) => ({ default: m.SalesCharts })),
);

/**
 * The heat map, deferred for the same reason as the charts above.
 *
 * At 19.7KB it was the single largest source in this route's chunk — larger than
 * the route component itself — and it sits below the charts, which are already
 * behind a lazy boundary. Loading it eagerly meant the KPI cards at the top of
 * the page waited on a map that is several screens down. `SaudiMapSkeleton`
 * holds its exact geometry while it arrives, so nothing reflows.
 */
const SaudiSalesMap = lazy(() =>
  import("@/components/saudi-sales-map").then((m) => ({ default: m.SaudiSalesMap })),
);

/**
 * The Complaints branch chart, deferred for the third time for the same reason.
 *
 * It is the only Recharts panel in the Complaints section — the rest is a KPI
 * strip and two tables — so a static import would put the charting library back
 * in this route's chunk and undo the split the two boundaries above it exist to
 * make. `ChartCardSkeleton` holds the card while it arrives.
 */
const ComplaintsBranchChart = lazy(() =>
  import("@/features/dashboard/components/complaints-charts").then((m) => ({
    default: m.ComplaintsBranchChart,
  })),
);

export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — MilaServ Portal" }] }),
  component: Dashboard,
});

function Dashboard() {
  const f = useDashboardFilters();
  const d = useDashboardData({
    from: f.from,
    to: f.to,
    effectiveTeam: f.effectiveTeam,
    effectiveAgent: f.effectiveAgent,
    dashFilters: f.dashFilters,
    cmpFilters: f.cmpFilters,
    enabled: f.canViewDashboard,
    viewerId: f.userId,
    // Agent roles (no `view_all_agents`) see only their own verification rows and
    // an anonymised agent ranking; every other analytic is unchanged for them.
    restrictAgentIdentity: !f.canViewAllAgents,
  });
  /**
   * Month-by-month growth, gated on `view_team_analytics`.
   *
   * That permission and not `view_dashboard`: the section compares Customer Care
   * with Telesales against a team-wide historical baseline, and for a viewer
   * whose rows RLS narrows to their own, the live months would be one agent's
   * work sitting in a table next to whole-team history. Same gate as the team
   * filter, for the same reason.
   */
  const growth = useMonthlyGrowth({ enabled: f.canViewDashboard && f.canViewTeamAnalytics });
  const { refetchExport, exportBusy } = useDashboardExportData({
    from: f.from,
    to: f.to,
    effectiveAgent: f.effectiveAgent,
    effectiveTeam: f.effectiveTeam,
    dashFilters: f.dashFilters,
    isAdmin: f.isAdmin,
    userId: f.userId,
  });

  /**
   * The PDF export.
   *
   * `window.print()` over the real DOM, which is the mechanism the Reports and
   * Calls pages already use and the right one here: the browser's own writer
   * renders the live document at print resolution, so text stays selectable,
   * charts stay vector, and there is no second rendering of the dashboard to
   * keep in step with the first. No PDF library, no canvas rasteriser, no
   * screenshot — and nothing added to the bundle.
   *
   * Three things make the output a report rather than a photograph of a web
   * page, and none of them costs the screen layout anything:
   *
   *   1. **The page is laid out at A4's printable width first**
   *      (`PRINT_WIDTH_PX`), before the writer is called, so every
   *      `ResponsiveContainer` measures the sheet instead of the monitor. See
   *      `usePrintExport` for the frame wait that needs.
   *   2. **Every chart is mounted and made still** for the duration, through
   *      `ChartPrintContext`. Panels are otherwise deferred until they scroll
   *      into view and a sheet of paper does not scroll — without this the
   *      export would carry empty cards for everything below the first screen,
   *      and an animated panel would print whichever frame it was part-way
   *      through, which for a bar growing from the baseline is no bar at all.
   *   3. **Controls drop out.** The filter row, this menu and the per-card tab
   *      strips are `print:hidden`; the state they were left in is already
   *      stated in the report's own masthead.
   *
   * The masthead and the running footer come from the shared `print-chrome`, so
   * a Dashboard export and a Monthly Report leave the building looking like two
   * documents from one organisation. Page geometry — A4, margins, break rules,
   * table density — is the `@media print` block in `styles.css`, which every
   * printable page in the portal shares.
   */
  const { printing, print } = usePrintExport();

  if (!f.canViewDashboard) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Dashboard.</p>
      </div>
    );
  }

  /** Who the figures are about. Stated on screen, and again on the printed sheet. */
  const scopeLabel = f.selectedAgentLabel
    ? `Performance for ${f.selectedAgentLabel}`
    : f.scopedToSelf
      ? "Your performance"
      : "Team performance";

  return (
    /* Every chart panel below reads this. See the export note above. */
    <ChartPrintContext.Provider value={printing}>
      {/* Pinned to the printable width for the duration of the export, so every
          chart inside measures the page rather than the monitor. `undefined`
          otherwise: the screen layout is never touched by the export. */}
      <div
        className="space-y-6 print:space-y-4"
        style={printing ? { width: PRINT_WIDTH_PX } : undefined}
      >
        <ReportPrintHeader title="Dashboard Report" period={`${scopeLabel} · ${f.dateLabel}`} />

        {/* The on-screen title bar. Hidden on paper: the masthead above states
            the same three things in the report's own voice, and the controls
            beside it stop being controls the moment they are printed. */}
        <Reveal
          delay={DASH_DELAY.header}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 print:hidden sm:flex sm:flex-wrap sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">Dashboard</h1>
            <p className="text-xs sm:text-sm text-muted-foreground truncate">
              {scopeLabel} · {f.dateLabel}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <DateRangePicker range={f.range} onChange={f.setRange} align="end" size="sm" />
            {f.canViewTeamAnalytics && (
              <Select
                value={f.teamFilter}
                onValueChange={(v) => {
                  f.setTeamFilter(v);
                  f.setAgentFilter("all");
                }}
              >
                <SelectTrigger className="h-9 w-[150px]">
                  <SelectValue placeholder="All teams" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All teams</SelectItem>
                  <SelectItem value="customer_care">Customer Care</SelectItem>
                  <SelectItem value="telesales">Telesales</SelectItem>
                </SelectContent>
              </Select>
            )}
            {f.canViewTeamAnalytics && f.canViewAllAgents && (
              <Select value={f.agentFilter} onValueChange={f.setAgentFilter}>
                <SelectTrigger className="h-9 w-[170px] sm:w-[200px]">
                  <SelectValue placeholder="All agents" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All agents</SelectItem>
                  {f.filteredAgents.map((a: any) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.full_name}
                      {a.agent_code ? ` (${a.agent_code})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {/* Scope toggle for the one tier `effectiveAgent` defers to `mineOnly`:
                users who may see team-wide figures but have no agent picker to narrow
                with (customer_care, call_center). It previously sat in the FALSE branch
                of a `canViewTeamAnalytics ?` ternary and re-tested `canViewTeamAnalytics
                &&`, so it could never render and `mineOnly` was frozen at false. */}
            {f.canViewTeamAnalytics && !f.canViewAllAgents && (
              <Button
                variant={f.mineOnly ? "default" : "outline"}
                size="sm"
                onClick={() => f.setMineOnly((v) => !v)}
              >
                {f.mineOnly ? "My data" : "All data"}
              </Button>
            )}
            {f.canExport && (
              /* One control, two documents. The workbook is the working export —
                 ten sheets of underlying rows, meant to be filtered and pivoted.
                 The PDF is the reading copy: this page as it stands, laid out for
                 A4. They answer different needs and neither replaces the other,
                 so the menu names both rather than the button picking one. */
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={exportBusy || printing}>
                    <Download className="h-4 w-4 mr-2" />
                    {exportBusy || printing ? "Preparing…" : "Export"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  {/* `items-start`, because the item is two lines: the base
                      style centres its icon, which against a name and a
                      description leaves the glyph floating between them. */}
                  <DropdownMenuItem
                    className="items-start gap-2.5 py-2"
                    onSelect={() => void print()}
                  >
                    <Printer className="mt-0.5 h-4 w-4" />
                    <span className="flex min-w-0 flex-col">
                      <span>PDF report</span>
                      <span className="text-xs text-muted-foreground">
                        This dashboard, laid out for A4
                      </span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="items-start gap-2.5 py-2"
                    onSelect={async () => {
                      const r = await refetchExport();
                      if (r.data)
                        await exportDashboard(r.data, {
                          from: f.from,
                          to: f.to,
                          agentLabel: f.selectedAgentLabel,
                          teamLabel: f.teamFilter,
                        });
                    }}
                  >
                    <FileSpreadsheet className="mt-0.5 h-4 w-4" />
                    <span className="flex min-w-0 flex-col">
                      <span>Excel workbook</span>
                      <span className="text-xs text-muted-foreground">
                        Ten sheets of underlying rows
                      </span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </Reveal>

        <Reveal delay={DASH_DELAY.kpis}>
          <SectionTitle title="Performance for selected period" icon={LayoutDashboard} />
          {/* The icons name the bucket, in the same tinted square the chart
              headers below use: cash taken at the counter, the Wasfaty
              prescription programme, and the two of them together. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <DashKpiCard
              label="Cash"
              icon={Banknote}
              tone="from-[var(--tint-cash)] to-transparent"
              stats={d.kpiByBucket.cash}
              loading={d.kpiLoading}
            />
            <DashKpiCard
              label="Wasfaty"
              icon={ClipboardPlus}
              tone="from-[var(--tint-wasfaty)] to-transparent"
              stats={d.kpiByBucket.wasfaty}
              loading={d.kpiLoading}
            />
            <DashKpiCard
              label="Total"
              icon={Wallet}
              tone="from-primary/10 to-transparent"
              highlight
              stats={d.kpiByBucket.total}
              loading={d.kpiLoading}
            />
          </div>
        </Reveal>

        {/* Monthly comparison & growth — the full timeline, not the picked range.
            Above the period-scoped panels below it because it is the question the
            page is opened with: is the month better than the last one. */}
        {f.canViewTeamAnalytics && (
          <Reveal delay={DASH_DELAY.monthly}>
            <MonthlyGrowthSection
              rows={growth.rows}
              insights={growth.insights}
              isLoading={growth.isLoading}
            />
          </Reveal>
        )}

        {/* Call Center Invoice Verification — details table (redundant KPI cards removed per spec) */}
        <Reveal delay={DASH_DELAY.verification}>
          <SectionTitle title="Call Center Invoice verification" icon={ReceiptText} />

          <AnalyticsCard
            title="Call Center Invoices Tracking"
            subtitle="Verification status per agent"
            icon={FileCheck2}
            className="mt-3"
            flush
          >
            <AnalyticsTable minWidth={640}>
              <Thead>
                <tr>
                  <Th>Agent</Th>
                  <Th align="right">Total orders</Th>
                  <Th align="right">Verified</Th>
                  <Th align="right">Non-verified</Th>
                  <Th align="right">Rate</Th>
                  <Th align="right">Verified value</Th>
                </tr>
              </Thead>
              <Tbody>
                {d.verifData.length === 0 && <EmptyRow colSpan={6} />}
                {d.verifData.map((r) => (
                  <tr key={r.name}>
                    <Td className="whitespace-nowrap font-medium">{r.name}</Td>
                    <Td numeric>{r.total}</Td>
                    <Td numeric className="font-semibold text-[var(--positive)]">
                      {r.verified}
                    </Td>
                    <Td numeric className="text-muted-foreground">
                      {r.nonVerified}
                    </Td>
                    <Td numeric>{r.rate.toFixed(0)}%</Td>
                    <Td numeric>{fmtSAR(r.verifiedValue)}</Td>
                  </tr>
                ))}
              </Tbody>
            </AnalyticsTable>
          </AnalyticsCard>
        </Reveal>

        {/* Sales charts — behind a lazy boundary; see sales-charts.tsx */}
        <Reveal delay={DASH_DELAY.charts}>
          <Suspense fallback={<SalesChartsSkeleton />}>
            <SalesCharts data={d} />
          </Suspense>
        </Reveal>

        {/* Geographic heat map */}
        <Reveal delay={DASH_DELAY.map}>
          <SectionTitle title="Geographic distribution" icon={MapIcon} />
          <div className="mt-3">
            <Suspense fallback={<SaudiMapSkeleton />}>
              <SaudiSalesMap cities={d.cityMapData} />
            </Suspense>
          </div>
        </Reveal>

        {/* Call center analytics moved to /call-center */}

        {/* Delivery methods.

            Was two tables that answered the same question twice — a five-column
            fulfillment mix over Delivery/Pickup/Total, and a four-column method
            table in which Store Pickup appeared again as one courier among four,
            so the reader had to hold the first in their head to read the second.
            See `delivery-methods-section.tsx`.

            The branch × method and city × method crosstabs are unchanged and sit
            under the same heading as its children. */}
        <Reveal delay={DASH_DELAY.delivery}>
          <DeliveryMethodsSection mix={d.fulfillmentMix} methods={d.deliveryData}>
            <div className="mt-3 grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
              <div className="min-w-0">
                {/* The separator here was mojibake — "أ—", a UTF-8 "×" decoded as
                    cp1256 — and had been rendering as Arabic alef + em dash. */}
                <DeliveryMatrix
                  title="Sales by branch × delivery method"
                  icon={Truck}
                  matrix={d.deliveryBranchMatrix}
                  methods={d.deliveryMethods}
                />
              </div>
              <div className="min-w-0">
                <DeliveryMatrix
                  title="Sales by city × delivery method"
                  icon={RouteIcon}
                  matrix={d.deliveryCityMatrix}
                  methods={d.deliveryMethods}
                />
              </div>
            </div>
          </DeliveryMethodsSection>
        </Reveal>

        {/* Complaints analytics.

            Summary, then the picture, then the detail. The strip answers "how
            many, and how many are done"; the chart answers "where is the
            backlog", which was previously only obtainable by reading twenty
            numbers out of the branch table; the two tables carry the exact
            figures for anyone who needs them. See `complaints-charts.tsx` for
            why the chart is that chart and not a trend line — the complaints
            RPCs return location and status and no date series, category or
            channel, and this page does not invent the ones it lacks. */}
        <Reveal delay={DASH_DELAY.complaints}>
          <SectionTitle title="Complaints" icon={MessageSquareWarning} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <StatCard
              label="Total complaints"
              icon={ListChecks}
              value={Number(d.cmpKpi?.total ?? 0)}
            />
            <StatCard
              label="In progress"
              icon={Loader}
              value={Number(d.cmpKpi?.in_progress ?? 0)}
              accent="text-[var(--attention)]"
            />
            <StatCard
              label="Resolved"
              icon={CheckCircle2}
              value={Number(d.cmpKpi?.resolved ?? 0)}
              accent="text-[var(--positive)]"
            />
            <StatCard
              label="Resolution rate"
              icon={Gauge}
              value={d.cmpKpi ? `${Number(d.cmpKpi.resolution_rate).toFixed(1)}%` : "—"}
            />
          </div>

          <div className="mt-3">
            <Suspense fallback={<ChartCardSkeleton height={340} />}>
              <ComplaintsBranchChart data={d.cmpBranchData} />
            </Suspense>
          </div>

          <div className="mt-3 grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
            <AnalyticsCard title="Complaints by branch (top 10)" icon={ShieldAlert} flush>
              <AnalyticsTable minWidth={420}>
                <Thead>
                  <tr>
                    <Th>Branch</Th>
                    <Th align="right">Total</Th>
                    <Th align="right">Resolved</Th>
                    <Th align="right">Open</Th>
                  </tr>
                </Thead>
                <Tbody>
                  {d.cmpBranchData.length === 0 && <EmptyRow colSpan={4} />}
                  {d.cmpBranchData.map((r) => (
                    <tr key={r.name}>
                      <Td className="font-medium">{r.name}</Td>
                      <Td numeric>{r.total}</Td>
                      <Td numeric className="text-[var(--positive)]">
                        {r.resolved}
                      </Td>
                      <Td numeric className="text-[var(--attention)]">
                        {r.open}
                      </Td>
                    </tr>
                  ))}
                </Tbody>
              </AnalyticsTable>
            </AnalyticsCard>

            <AnalyticsCard title="Complaints by city" icon={CircleAlert} flush>
              <AnalyticsTable minWidth={360}>
                <Thead>
                  <tr>
                    <Th>City</Th>
                    <Th align="right">Total</Th>
                    <Th align="right">Resolution rate</Th>
                  </tr>
                </Thead>
                <Tbody>
                  {d.cmpCityData.length === 0 && <EmptyRow colSpan={3} />}
                  {d.cmpCityData.map((r) => (
                    <tr key={r.name}>
                      <Td className="font-medium">{r.name}</Td>
                      <Td numeric>{r.total}</Td>
                      <Td numeric>{r.rate.toFixed(0)}%</Td>
                    </tr>
                  ))}
                </Tbody>
              </AnalyticsTable>
            </AnalyticsCard>
          </div>
        </Reveal>

        <ReportPrintFooter label={`Dashboard · ${scopeLabel} · ${f.dateLabel}`} />
      </div>
    </ChartPrintContext.Provider>
  );
}
