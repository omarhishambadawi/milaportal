import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Download, ShieldAlert } from "lucide-react";
import { DateRangePicker } from "@/components/date-range-picker";
import { SaudiSalesMap } from "@/components/saudi-sales-map";
import { exportDashboard } from "@/features/dashboard/export";
import { SalesChartsSkeleton } from "@/features/dashboard/components/sales-charts-skeleton";
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
        <SectionTitle title="Performance for selected period" />
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
        <SectionTitle title="Call Center Invoice verification" />

        <Card className="mt-3">
          <CardHeader>
            <CardTitle className="text-base">Call Center Invoices Tracking</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">Agent</th>
                  <th className="px-3 py-2 text-right">Total orders</th>
                  <th className="px-3 py-2 text-right">Verified</th>
                  <th className="px-3 py-2 text-right">Non-verified</th>
                  <th className="px-3 py-2 text-right">Rate</th>
                  <th className="px-3 py-2 text-right">Verified value</th>
                </tr>
              </thead>
              <tbody>
                {d.verifData.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-muted-foreground py-6">
                      No data
                    </td>
                  </tr>
                )}
                {d.verifData.map((r) => (
                  <tr key={r.name} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{r.name}</td>
                    <td className="px-3 py-2 text-right">{r.total}</td>
                    <td className="px-3 py-2 text-right text-[var(--positive)] font-semibold">
                      {r.verified}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{r.nonVerified}</td>
                    <td className="px-3 py-2 text-right">{r.rate.toFixed(0)}%</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {fmtSAR(r.verifiedValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* Sales charts — behind a lazy boundary; see sales-charts.tsx */}
      <Suspense fallback={<SalesChartsSkeleton />}>
        <SalesCharts data={d} />
      </Suspense>

      {/* Geographic heat map */}
      <div>
        <SectionTitle title="Geographic distribution" />
        <div className="mt-3">
          <SaudiSalesMap cities={d.cityMapData} />
        </div>
      </div>

      {/* Call center analytics moved to /call-center */}

      {/* Delivery method analysis */}
      <div>
        <SectionTitle title="Delivery methods" />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Delivery method performance</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">Method</th>
                  <th className="px-3 py-2 text-right">Orders</th>
                  <th className="px-3 py-2 text-right">Completed sales</th>
                  <th className="px-3 py-2 text-right">Completion rate</th>
                </tr>
              </thead>
              <tbody>
                {d.deliveryData.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center text-muted-foreground py-6">
                      No data
                    </td>
                  </tr>
                )}
                {d.deliveryData.map((dd) => (
                  <tr key={dd.name} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium">{dd.name}</td>
                    <td className="px-3 py-2 text-right">{dd.count}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmtSAR(dd.sales)}</td>
                    <td className="px-3 py-2 text-right">{dd.rate.toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <div className="grid lg:grid-cols-2 gap-3 sm:gap-4 mt-3 min-w-0">
          <div className="min-w-0">
            <DeliveryMatrix
              title="Sales by branch أ— delivery method"
              matrix={d.deliveryBranchMatrix}
              methods={d.deliveryMethods}
            />
          </div>
          <div className="min-w-0">
            <DeliveryMatrix
              title="Sales by city أ— delivery method"
              matrix={d.deliveryCityMatrix}
              methods={d.deliveryMethods}
            />
          </div>
        </div>
      </div>

      {/* Complaints analytics */}
      <div>
        <SectionTitle title="Complaints" />
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

        <div className="grid lg:grid-cols-2 gap-3 sm:gap-4 mt-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Complaints by branch (top 10)</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">Branch</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Resolved</th>
                    <th className="px-3 py-2 text-right">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {d.cmpBranchData.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center text-muted-foreground py-6">
                        No data
                      </td>
                    </tr>
                  )}
                  {d.cmpBranchData.map((r) => (
                    <tr key={r.name} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{r.name}</td>
                      <td className="px-3 py-2 text-right">{r.total}</td>
                      <td className="px-3 py-2 text-right text-[var(--positive)]">{r.resolved}</td>
                      <td className="px-3 py-2 text-right text-[var(--attention)]">{r.open}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Complaints by city</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">City</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Resolution rate</th>
                  </tr>
                </thead>
                <tbody>
                  {d.cmpCityData.length === 0 && (
                    <tr>
                      <td colSpan={3} className="text-center text-muted-foreground py-6">
                        No data
                      </td>
                    </tr>
                  )}
                  {d.cmpCityData.map((r) => (
                    <tr key={r.name} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{r.name}</td>
                      <td className="px-3 py-2 text-right">{r.total}</td>
                      <td className="px-3 py-2 text-right">{r.rate.toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
