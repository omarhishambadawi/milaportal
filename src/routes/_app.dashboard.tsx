import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend, AreaChart, Area } from "recharts";
import { fmtSAR } from "@/lib/branches";
import { Download, ShieldAlert } from "lucide-react";
import { DateRangePicker } from "@/components/date-range-picker";
import { SaudiSalesMap } from "@/components/saudi-sales-map";
import { COLORS, STATUS_COLORS } from "@/features/dashboard/constants";
import { exportDashboard } from "@/features/dashboard/export";
import { SectionTitle } from "@/features/dashboard/components/section-title";
import { StatCard } from "@/features/dashboard/components/stat-card";
import { DashKpiCard } from "@/features/dashboard/components/dash-kpi-card";
import { DeliveryMatrix } from "@/features/dashboard/components/delivery-matrix";
import { useDashboardFilters } from "@/features/dashboard/hooks/use-dashboard-filters";
import { useDashboardData } from "@/features/dashboard/hooks/use-dashboard-data";
import { useDashboardExportData } from "@/features/dashboard/hooks/use-dashboard-export-data";

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
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">You don't have access to Dashboard.</p></div>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">Dashboard</h1>
          <p className="text-xs sm:text-sm text-muted-foreground truncate">
            {f.selectedAgentLabel ? `Performance for ${f.selectedAgentLabel}` : f.scopedToSelf ? "Your performance" : "Team performance"} · {f.dateLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <DateRangePicker range={f.range} onChange={f.setRange} align="end" size="sm" />
          {f.canViewTeamAnalytics && (
            <Select value={f.teamFilter} onValueChange={(v) => { f.setTeamFilter(v); f.setAgentFilter("all"); }}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="All teams" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All teams</SelectItem>
                <SelectItem value="customer_care">Customer Care</SelectItem>
                <SelectItem value="telesales">Telesales</SelectItem>
              </SelectContent>
            </Select>
          )}
          {f.canViewTeamAnalytics && f.canViewAllAgents && (
            <Select value={f.agentFilter} onValueChange={f.setAgentFilter}>
              <SelectTrigger className="h-9 w-[170px] sm:w-[200px]"><SelectValue placeholder="All agents" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {f.filteredAgents.map((a: any) => (
                  <SelectItem key={a.id} value={a.id}>{a.full_name}{a.agent_code ? ` (${a.agent_code})` : ""}</SelectItem>
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
            <Button variant={f.mineOnly ? "default" : "outline"} size="sm" onClick={() => f.setMineOnly((v) => !v)}>
              {f.mineOnly ? "My data" : "All data"}
            </Button>
          )}
          {f.canExport && <Button variant="outline" size="sm" onClick={async () => {
            const r = await refetchExport();
            if (r.data) await exportDashboard(r.data, { from: f.from, to: f.to, agentLabel: f.selectedAgentLabel, teamLabel: f.teamFilter });
          }} disabled={exportBusy}>
            <Download className="h-4 w-4 mr-2" />{exportBusy ? "Preparing…" : "Export"}
          </Button>}
        </div>
      </div>

      <div>
        <SectionTitle title="Performance for selected period" />
        <div className="grid gap-3 sm:grid-cols-3">
          <DashKpiCard label="Cash" tone="from-[var(--tint-cash)] to-transparent" stats={d.kpiByBucket.cash} />
          <DashKpiCard label="Wasfaty" tone="from-[var(--tint-wasfaty)] to-transparent" stats={d.kpiByBucket.wasfaty} />
          <DashKpiCard label="Total" tone="from-primary/10 to-transparent" highlight stats={d.kpiByBucket.total} />
        </div>
      </div>

      {/* Call Center Invoice Verification — details table (redundant KPI cards removed per spec) */}
      <div>
        <SectionTitle title="Call Center Invoice verification" />

        <Card className="mt-3">
          <CardHeader><CardTitle className="text-base">Call Center Invoices Tracking</CardTitle></CardHeader>
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
                {d.verifData.length === 0 && <tr><td colSpan={6} className="text-center text-muted-foreground py-6">No data</td></tr>}
                {d.verifData.map((r) => (
                  <tr key={r.name} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{r.name}</td>
                    <td className="px-3 py-2 text-right">{r.total}</td>
                    <td className="px-3 py-2 text-right text-[var(--positive)] font-semibold">{r.verified}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{r.nonVerified}</td>
                    <td className="px-3 py-2 text-right">{r.rate.toFixed(0)}%</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmtSAR(r.verifiedValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* Sales charts */}
      <div className="grid lg:grid-cols-2 gap-3 sm:gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Daily sales trend</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={d.dailyData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="dailyAll" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="dailyCompleted" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#16a34a" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickMargin={6} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
                <Tooltip
                  formatter={(v: any) => fmtSAR(v)}
                  contentStyle={{ borderRadius: 8, border: "1px solid var(--color-border)", fontSize: 12 }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="total" name="All" stroke="var(--color-chart-1)" strokeWidth={2} fill="url(#dailyAll)" activeDot={{ r: 4 }} isAnimationActive animationDuration={500} />
                <Area type="monotone" dataKey="completed" name="Completed" stroke="#16a34a" strokeWidth={2} fill="url(#dailyCompleted)" activeDot={{ r: 4 }} isAnimationActive animationDuration={600} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Orders by status</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={d.statusData} dataKey="value" nameKey="name" outerRadius={80} label>
                  {d.statusData.map((s, i) => <Cell key={i} fill={STATUS_COLORS[s.name] ?? COLORS[i % COLORS.length]} />)}
                </Pie>
                <Legend />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Sales by team</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.teamData}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => fmtSAR(v)} />
                <Bar dataKey="sales" name="Completed sales" fill="var(--color-chart-2)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Top agents by sales</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.agentSalesData} layout="vertical">
                <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => fmtSAR(v)} />
                <Bar dataKey="sales" fill="var(--color-chart-3)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Sales by branch (top 10)</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.branchData} layout="vertical">
                <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => fmtSAR(v)} />
                <Bar dataKey="sales" fill="var(--color-chart-4)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Sales by city</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.cityData} layout="vertical">
                <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => fmtSAR(v)} />
                <Bar dataKey="sales" fill="var(--color-chart-5)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

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
          <CardHeader><CardTitle className="text-base">Delivery method performance</CardTitle></CardHeader>
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
                {d.deliveryData.length === 0 && <tr><td colSpan={4} className="text-center text-muted-foreground py-6">No data</td></tr>}
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
            <DeliveryMatrix title="Sales by branch × delivery method" matrix={d.deliveryBranchMatrix} methods={d.deliveryMethods} />
          </div>
          <div className="min-w-0">
            <DeliveryMatrix title="Sales by city × delivery method" matrix={d.deliveryCityMatrix} methods={d.deliveryMethods} />
          </div>
        </div>

      </div>

      {/* Complaints analytics */}
      <div>
        <SectionTitle title="Complaints" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <StatCard label="Total complaints" value={Number(d.cmpKpi?.total ?? 0)} />
          <StatCard label="In progress" value={Number(d.cmpKpi?.in_progress ?? 0)} accent="text-[var(--attention)]" />
          <StatCard label="Resolved" value={Number(d.cmpKpi?.resolved ?? 0)} accent="text-[var(--positive)]" />
          <StatCard label="Resolution rate" value={d.cmpKpi ? `${Number(d.cmpKpi.resolution_rate).toFixed(1)}%` : "—"} />
        </div>

        <div className="grid lg:grid-cols-2 gap-3 sm:gap-4 mt-3">
          <Card>
            <CardHeader><CardTitle className="text-base">Complaints by branch (top 10)</CardTitle></CardHeader>
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
                  {d.cmpBranchData.length === 0 && <tr><td colSpan={4} className="text-center text-muted-foreground py-6">No data</td></tr>}
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
            <CardHeader><CardTitle className="text-base">Complaints by city</CardTitle></CardHeader>
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
                  {d.cmpCityData.length === 0 && <tr><td colSpan={3} className="text-center text-muted-foreground py-6">No data</td></tr>}
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
