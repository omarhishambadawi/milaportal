/**
 * Telesales call analytics — EXTENSION-driven.
 *
 * Telesales agents belong to no queue: they dial out from their extension. So
 * there is no queue wait, no queue status and no abandoned-queue metric here —
 * those numbers do not exist for this workflow, and showing them would be
 * inventing data. What matters instead is call outcomes (busy / failed / no
 * answer) and what the calls produced: orders, revenue and conversion.
 *
 * The Yeastar integration, CDR retrieval, normalization and analytics engine
 * are shared with Customer Care; only this presentation layer and the KPI
 * selection are separate.
 */
import { createFileRoute } from "@tanstack/react-router";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from "recharts";
import {
  Download,
  ShieldAlert,
  RefreshCw,
  PhoneOff,
  AlertTriangle,
  Printer,
  PhoneIncoming,
  PhoneOutgoing,
  Clock,
  Users,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangePicker } from "@/components/date-range-picker";
import { fmtSAR } from "@/lib/branches";
import type { Direction } from "@/features/call-center/types";
import { tooltipStyle } from "@/features/call-center/constants";
import { pct, hhmmss } from "@/features/call-center/utils";
import { exportCallCenter } from "@/features/call-center/export";
import { RefreshIndicator } from "@/features/call-center/components/fetch-progress";
import { SectionHeader } from "@/features/call-center/components/section-header";
import { HeroKpi } from "@/features/call-center/components/hero-kpi";
import { Kpi } from "@/features/call-center/components/kpi";
import { ChartCard } from "@/features/call-center/components/chart-card";
import {
  TelesalesTrendCharts,
  OutboundHourlyChart,
} from "@/features/call-center/components/telesales-trend-charts";
import { AgentPerformanceTable } from "@/features/call-center/components/agent-performance-table";
import { useCallCenterFilters } from "@/features/call-center/hooks/use-call-center-filters";
import { useCallCenterAnalytics } from "@/features/call-center/hooks/use-call-center-analytics";

// Telesales reviews a day's outbound work rather than a live queue, so a
// 60-second cadence keeps it current without extra load.
const TELESALES_REFRESH_MS = 60_000;

export const Route = createFileRoute("/_app/calls/telesales")({
  head: () => ({ meta: [{ title: "Telesales Calls — MilaServ Portal" }] }),
  component: TelesalesPage,
});

function TelesalesPage() {
  const f = useCallCenterFilters({ team: "telesales" });
  const a = useCallCenterAnalytics({
    from: f.from,
    to: f.to,
    team: "telesales",
    agentId: f.agentId,
    direction: f.direction,
    canAll: f.canAll,
    canView: f.canView,
    authLoading: f.authLoading,
    search: f.search,
    refreshMs: TELESALES_REFRESH_MS,
  });

  const {
    ok,
    isLoading,
    isRefreshing,
    refreshFailed,
    errMsg,
    refresh,
    totals,
    rows,
    byDay,
    byHour,
    conv,
    hourly12,
    searchedAgents,
  } = a;

  if (!f.authLoading && !f.canView) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have access to Call Analytics.
        </p>
      </div>
    );
  }

  const doExport = () =>
    exportCallCenter({
      ok,
      totals,
      conv,
      rows,
      byDay,
      hourly12,
      from: f.from,
      to: f.to,
      fileLabel: "telesales",
    });

  return (
    <div className="space-y-6 print:space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Telesales</h1>
          <p className="text-xs sm:text-sm text-muted-foreground truncate">
            Extension analytics · {f.from} → {f.to}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <RefreshIndicator refreshing={isRefreshing} failed={refreshFailed} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <DateRangePicker range={f.range} onChange={f.setRange} align="end" size="sm" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh()}
            disabled={isRefreshing}
            aria-label="Refresh analytics"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
          </Button>
          {f.canAll && (
            <Select value={f.agentId} onValueChange={f.setAgentId}>
              <SelectTrigger className="h-9 w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {f.filteredAgents.map((agent: any) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={f.direction} onValueChange={(v) => f.setDirection(v as Direction)}>
            <SelectTrigger className="h-9 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Both</SelectItem>
              <SelectItem value="Inbound">Inbound</SelectItem>
              <SelectItem value="Outbound">Outbound</SelectItem>
            </SelectContent>
          </Select>
          {f.canExport && (
            <>
              <Button variant="outline" size="sm" onClick={doExport} disabled={!ok}>
                <Download className="h-4 w-4 mr-2" />
                Excel
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!ok}>
                <Printer className="h-4 w-4 mr-2" />
                PDF
              </Button>
            </>
          )}
        </div>
      </div>

      {errMsg && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            {errMsg}
          </CardContent>
        </Card>
      )}

      {/* OVERVIEW */}
      <SectionHeader>Overview</SectionHeader>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <HeroKpi
          label="Total calls"
          value={totals?.total ?? 0}
          loading={isLoading}
          icon={Users}
          tone="primary"
        />
        <HeroKpi
          label="Answered calls"
          value={totals?.answered ?? 0}
          loading={isLoading}
          icon={PhoneIncoming}
          tone="success"
        />
        <HeroKpi
          label="Answer rate"
          value={pct(totals?.answerRate)}
          loading={isLoading}
          icon={TrendingUp}
          tone="success"
        />
        <HeroKpi
          label="Conversion rate"
          value={pct(conv?.overall.conversionRate)}
          loading={isLoading}
          icon={PhoneOutgoing}
          tone="secondary"
          hint="Total orders ÷ answered calls"
        />
      </div>

      {/* OUTBOUND ACTIVITY — the operation. Inbound is informational only:
          the only legitimate inbound telesales call is a transfer from
          Customer Care, so it is never a primary KPI here. */}
      <SectionHeader>Outbound activity</SectionHeader>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi
          label="Outbound calls"
          value={totals?.outbound ?? 0}
          tone="secondary"
          loading={isLoading}
          icon={PhoneOutgoing}
        />
        <Kpi
          label="Contacted"
          value={totals?.outboundAnswered ?? 0}
          tone="success"
          loading={isLoading}
          hint="Customer picked up"
        />
        <Kpi
          label="Lead contact rate"
          value={pct(totals?.leadContactRate)}
          tone="success"
          loading={isLoading}
          hint="Answered ÷ total outbound"
        />
        <Kpi
          label="Transferred in"
          value={totals?.inbound ?? 0}
          loading={isLoading}
          icon={PhoneIncoming}
          hint="Informational — transfers from Customer Care"
        />
      </div>

      {/* OUTCOMES — what happened when the far end was dialled */}
      <SectionHeader>Call outcomes</SectionHeader>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi
          label="No answer"
          value={totals?.noAnswerOutbound ?? 0}
          loading={isLoading}
          hint="Rang the full timeout without an answer"
        />
        <Kpi
          label="Agent cancelled"
          value={totals?.cancelledByAgent ?? 0}
          tone="destructive"
          loading={isLoading}
          hint="Agent hung up before the ring timeout expired"
        />
        <Kpi label="Busy" value={totals?.busy ?? 0} tone="warning" loading={isLoading} />
        <Kpi label="Failed" value={totals?.failed ?? 0} tone="destructive" loading={isLoading} />
      </div>

      {/* AGENT DISCIPLINE — lead-abuse signal */}
      <SectionHeader>Agent discipline</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Kpi
          label="Agent cancel rate"
          value={pct(totals?.agentCancelRate)}
          tone="destructive"
          loading={isLoading}
          hint="Cancelled ÷ total outbound"
        />
        <Kpi
          label="Avg ring before cancel"
          value={hhmmss(totals?.avgRingBeforeCancelSec)}
          loading={isLoading}
          icon={Clock}
          hint="How long the agent waited before hanging up"
        />
      </div>

      {/* TIME METRICS — no queue wait: telesales joins no queue */}
      <SectionHeader>Time metrics</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Kpi
          label="Average talking time"
          value={hhmmss(totals?.avgTalkSec)}
          loading={isLoading}
          icon={Clock}
        />
        <Kpi
          label="Total talk duration"
          value={hhmmss(totals?.talkSeconds)}
          loading={isLoading}
          icon={Clock}
        />
      </div>

      {ok && totals && totals.total === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <PhoneOff className="h-8 w-8" />
            No calls found for the selected filters.
          </CardContent>
        </Card>
      ) : (
        <>
          <SectionHeader>Sales trends</SectionHeader>
          <TelesalesTrendCharts byDay={byDay} perDay={conv?.perDay ?? []} loading={isLoading} />

          <SectionHeader>Hourly distribution</SectionHeader>
          <OutboundHourlyChart
            hourly12={hourly12}
            loading={isLoading}
            hasData={byHour.some((h) => h.total > 0)}
          />

          <SectionHeader>Agent performance</SectionHeader>
          <AgentPerformanceTable
            rows={searchedAgents}
            loading={isLoading}
            search={f.search}
            onSearch={f.setSearch}
            mode="telesales"
          />

          {/* CONVERSION — Orders is the source of truth for order metrics */}
          <SectionHeader>Conversion</SectionHeader>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <Kpi label="Answered calls" value={totals?.answered ?? 0} loading={isLoading} />
            <Kpi
              label="Total orders"
              value={conv?.overall.orders ?? 0}
              tone="primary"
              loading={isLoading}
            />
            <Kpi
              label="Completed"
              value={conv?.overall.completed ?? 0}
              tone="success"
              loading={isLoading}
            />
            <Kpi
              label="Conversion rate"
              value={pct(conv?.overall.conversionRate)}
              tone="secondary"
              loading={isLoading}
              hint="Orders ÷ answered calls"
            />
            <Kpi
              label="Revenue"
              value={conv ? fmtSAR(conv.overall.revenue) : "—"}
              loading={isLoading}
            />
            <Kpi
              label="Revenue per call"
              value={conv ? fmtSAR(conv.overall.revenuePerCall) : "—"}
              loading={isLoading}
            />
          </div>

          {/* REVENUE PER AGENT */}
          <ChartCard
            title="Revenue per agent"
            loading={isLoading}
            hasData={(conv?.perAgent ?? []).length > 0}
          >
            <ResponsiveContainer>
              <BarChart
                data={(conv?.perAgent ?? []).map((c) => ({ name: c.name, revenue: c.revenue }))}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  vertical={false}
                  strokeDasharray="3 3"
                  stroke="var(--color-border)"
                />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
                  formatter={(v: any) => [fmtSAR(Number(v)), "Revenue"]}
                />
                <Bar dataKey="revenue" fill="var(--color-chart-1)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Conversion by agent</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">Ext</th>
                    <th className="px-3 py-2">Agent</th>
                    <th className="px-3 py-2 text-right">Answered</th>
                    <th className="px-3 py-2 text-right">Orders</th>
                    <th className="px-3 py-2 text-right">Completed</th>
                    <th className="px-3 py-2 text-right">Conversion %</th>
                    <th className="px-3 py-2 text-right">Revenue</th>
                    <th className="px-3 py-2 text-right">Rev / call</th>
                  </tr>
                </thead>
                <tbody>
                  {(conv?.perAgent ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-center text-muted-foreground py-6">
                        No telesales activity in range.
                      </td>
                    </tr>
                  ) : (
                    (conv?.perAgent ?? []).map((c) => (
                      <tr key={c.agentId} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{c.ext}</td>
                        <td className="px-3 py-2 font-medium">{c.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.answered}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.ordersTotal}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-success">
                          {c.ordersCompleted}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {c.conversionRate.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtSAR(c.revenue)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtSAR(c.revenuePerCall)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
