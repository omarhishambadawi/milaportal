import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
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
  CircleAlert,
  Download,
  LayoutDashboard,
  Map,
  MessageSquareWarning,
  PackageCheck,
  PhoneCall,
  Route as RouteIcon,
  ShieldAlert,
  ShoppingCart,
  Truck,
} from "lucide-react";

import { DateRangePicker } from "@/components/date-range-picker";
import { SaudiSalesMap } from "@/components/saudi-sales-map";
import { exportDashboard } from "@/features/dashboard/export";
import { SalesChartsSkeleton } from "@/features/dashboard/components/sales-charts-skeleton";
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
import { useDashboardFilters } from "@/features/dashboard/hooks/use-dashboard-filters";
import { useDashboardData } from "@/features/dashboard/hooks/use-dashboard-data";
import { useDashboardExportData } from "@/features/dashboard/hooks/use-dashboard-export-data";

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
  });
  const { refetchExport, exportBusy } = useDashboardExportData({
    from: f.from,
    to: f.to,
    effectiveAgent: f.effectiveAgent,
    effectiveTeam: f.effectiveTeam,
    dashFilters: f.dashFilters,
    isAdmin: f.isAdmin,
    userId: f.userId,
  });

  if (!f.canViewDashboard) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Dashboard.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">Dashboard</h1>
          <p className="text-xs sm:text-sm text-muted-foreground truncate">
            {f.selectedAgentLabel
              ? `Performance for ${f.selectedAgentLabel}`
              : f.scopedToSelf
                ? "Your performance"
                : "Team performance"}{" "}
            · {f.dateLabel}
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
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const r = await refetchExport();
                if (r.data)
                  await exportDashboard(r.data, {
                    from: f.from,
                    to: f.to,
                    agentLabel: f.selectedAgentLabel,
                    teamLabel: f.teamFilter,
                  });
              }}
              disabled={exportBusy}
            >
              <Download className="h-4 w-4 mr-2" />
              {exportBusy ? "Preparing…" : "Export"}
            </Button>
          )}
        </div>
      </div>

      <div>
        <SectionTitle title="Performance for selected period" icon={LayoutDashboard} />
        <div className="grid gap-3 sm:grid-cols-3">
          <DashKpiCard
            label="Cash"
            tone="from-[var(--tint-cash)] to-transparent"
            stats={d.kpiByBucket.cash}
          />
          <DashKpiCard
            label="Wasfaty"
            tone="from-[var(--tint-wasfaty)] to-transparent"
            stats={d.kpiByBucket.wasfaty}
          />
          <DashKpiCard
            label="Total"
            tone="from-primary/10 to-transparent"
            highlight
            stats={d.kpiByBucket.total}
          />
        </div>
      </div>

      {/* Call Center Invoice Verification — details table (redundant KPI cards removed per spec) */}
      <div>
        <SectionTitle title="Call Center Invoice verification" icon={PhoneCall} />

        <AnalyticsCard
          title="Call Center Invoices Tracking"
          subtitle="Verification status per agent"
          icon={ShoppingCart}
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
      </div>

      {/* Sales charts — behind a lazy boundary; see sales-charts.tsx */}
      <Suspense fallback={<SalesChartsSkeleton />}>
        <SalesCharts data={d} />
      </Suspense>

      {/* Geographic heat map */}
      <div>
        <SectionTitle title="Geographic distribution" icon={Map} />
        <div className="mt-3">
          <SaudiSalesMap cities={d.cityMapData} />
        </div>
      </div>

      {/* Call center analytics moved to /call-center */}

      {/* Delivery method analysis */}
      <div>
        <SectionTitle title="Delivery methods" icon={Truck} />
        <AnalyticsCard
          title="Delivery method performance"
          subtitle="Orders and completed sales by method"
          icon={PackageCheck}
          flush
        >
          <AnalyticsTable minWidth={520}>
            <Thead>
              <tr>
                <Th>Method</Th>
                <Th align="right">Orders</Th>
                <Th align="right">Completed sales</Th>
                <Th align="right">Completion rate</Th>
              </tr>
            </Thead>
            <Tbody>
              {d.deliveryData.length === 0 && <EmptyRow colSpan={4} />}
              {d.deliveryData.map((dd) => (
                <tr key={dd.name}>
                  <Td className="font-medium">{dd.name}</Td>
                  <Td numeric>{dd.count}</Td>
                  <Td numeric>{fmtSAR(dd.sales)}</Td>
                  <Td numeric>{dd.rate.toFixed(0)}%</Td>
                </tr>
              ))}
            </Tbody>
          </AnalyticsTable>
        </AnalyticsCard>

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
      </div>

      {/* Complaints analytics */}
      <div>
        <SectionTitle title="Complaints" icon={MessageSquareWarning} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <StatCard label="Total complaints" value={Number(d.cmpKpi?.total ?? 0)} />
          <StatCard
            label="In progress"
            value={Number(d.cmpKpi?.in_progress ?? 0)}
            accent="text-[var(--attention)]"
          />
          <StatCard
            label="Resolved"
            value={Number(d.cmpKpi?.resolved ?? 0)}
            accent="text-[var(--positive)]"
          />
          <StatCard
            label="Resolution rate"
            value={d.cmpKpi ? `${Number(d.cmpKpi.resolution_rate).toFixed(1)}%` : "—"}
          />
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
      </div>
    </div>
  );
}
