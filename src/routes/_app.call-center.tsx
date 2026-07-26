/**
 * Call Center Analytics — MilaServ Portal
 * Single unified executive dashboard. Queue-aware, order-joined,
 * Internal calls excluded, monthly default.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid,
  LineChart,
  Line,
  Legend,
} from "recharts";
import {
  Download,
  ShieldAlert,
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { DateRangePicker } from "@/components/date-range-picker";
import { fmtSAR } from "@/lib/branches";
import type { Team, Direction } from "@/features/call-center/types";
import { tooltipStyle } from "@/features/call-center/constants";
import { pct, hhmmss } from "@/features/call-center/utils";
import { exportCallCenter } from "@/features/call-center/export";
import { SectionHeader } from "@/features/call-center/components/section-header";
import { HeroKpi } from "@/features/call-center/components/hero-kpi";
import { Kpi } from "@/features/call-center/components/kpi";
import { ChartCard } from "@/features/call-center/components/chart-card";
import { useCallCenterFilters } from "@/features/call-center/hooks/use-call-center-filters";
import { useCallCenterAnalytics } from "@/features/call-center/hooks/use-call-center-analytics";
import { useRealtimeQueue } from "@/features/call-center/hooks/use-realtime-queue";

export const Route = createFileRoute("/_app/call-center")({
  head: () => ({ meta: [{ title: "Call Center Analytics — MilaServ Portal" }] }),
  component: CallCenterPage,
});

function CallCenterPage() {
  const f = useCallCenterFilters();
  const a = useCallCenterAnalytics({
    from: f.from,
    to: f.to,
    team: f.team,
    agentId: f.agentId,
    direction: f.direction,
    canAll: f.canAll,
    canView: f.canView,
    authLoading: f.authLoading,
    jobId: f.jobId,
    jobIdRef: f.jobIdRef,
    search: f.search,
  });
  const rt = useRealtimeQueue({ authLoading: f.authLoading, canView: f.canView });

  const {
    q,
    progress,
    ok,
    isLoading,
    errMsg,
    totals,
    rows,
    byDay,
    byHour,
    teamCompare,
    conv,
    hourly12,
    searchedAgents,
  } = a;

  // Permission gate sits below every hook: `authLoading` starts true, so an
  // early return placed above the hooks would run 15 hooks on the first render
  // and 13 on the render where auth resolves to "no access" — which React
  // rejects outright ("Rendered fewer hooks than expected"). Hooks first, then
  // the guard; the derivations above are pure and simply compute over empty
  // arrays on the render that bails out.
  if (!f.authLoading && !f.canView) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have access to Call Center Analytics.
        </p>
      </div>
    );
  }

  const doExport = () =>
    exportCallCenter({ ok, totals, conv, rows, byDay, hourly12, from: f.from, to: f.to });

  return (
    <div className="space-y-6 print:space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            Call Center Analytics
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground truncate">
            {f.team === "all"
              ? "All teams"
              : f.team === "customer_care"
                ? "Customer Care"
                : "Telesales"}{" "}
            · {f.from} → {f.to}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <DateRangePicker range={f.range} onChange={f.setRange} align="end" size="sm" />
          <Select
            value={f.team}
            onValueChange={(v) => {
              f.setTeam(v as Team);
              f.setAgentId("all");
            }}
          >
            <SelectTrigger className="h-9 w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teams</SelectItem>
              <SelectItem value="customer_care">Customer Care</SelectItem>
              <SelectItem value="telesales">Telesales</SelectItem>
            </SelectContent>
          </Select>
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

      {/* Progress bar — shows during any fetch so users get feedback on re-queries too */}
      {q.isFetching && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-foreground">
                {progress?.message ?? (q.data ? "Refreshing analytics…" : "Loading call records…")}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {progress?.percent ?? (q.data ? 60 : 0)}%
              </span>
            </div>
            <Progress value={progress?.percent ?? (q.data ? 60 : 5)} />
          </CardContent>
        </Card>
      )}

      {errMsg && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            {errMsg}
          </CardContent>
        </Card>
      )}

      {/* HERO KPIs */}
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

      {/* REALTIME QUEUE — powered by /queue/call_status + /queue/agent_status */}
      <SectionHeader>Realtime queue</SectionHeader>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi
          label="Waiting"
          value={rt.data?.ok ? rt.data.calls.waiting : 0}
          tone="warning"
          loading={rt.isPending}
          hint="In queue now"
        />
        <Kpi
          label="Active"
          value={rt.data?.ok ? rt.data.calls.active : 0}
          tone="success"
          loading={rt.isPending}
          hint="On call"
        />
        <Kpi
          label="Ringing"
          value={rt.data?.ok ? rt.data.calls.ringing : 0}
          loading={rt.isPending}
        />
        <Kpi
          label="Agents ready"
          value={rt.data?.ok ? rt.data.agents.ready : 0}
          tone="success"
          loading={rt.isPending}
        />
        <Kpi
          label="Agents busy"
          value={rt.data?.ok ? rt.data.agents.busy : 0}
          tone="secondary"
          loading={rt.isPending}
        />
        <Kpi
          label="Paused"
          value={rt.data?.ok ? rt.data.agents.paused : 0}
          loading={rt.isPending}
        />
      </div>

      {/* QUEUE STATS */}
      <SectionHeader>Queue statistics</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi
          label="Missed calls (queue)"
          value={totals?.missed ?? 0}
          tone="destructive"
          loading={isLoading}
          hint="Inbound not answered within ring window"
        />
        <Kpi
          label="Abandoned calls"
          value={totals?.abandoned ?? 0}
          tone="warning"
          loading={isLoading}
          hint="Inbound hung up before ring threshold"
        />
        <Kpi
          label="No-answer outbound"
          value={totals?.noAnswerOutbound ?? 0}
          loading={isLoading}
          hint="Customer did not pick up (not a missed call)"
        />
      </div>

      {/* DIRECTION */}
      <SectionHeader>Call direction</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Kpi
          label="Inbound calls"
          value={totals?.inbound ?? 0}
          tone="success"
          loading={isLoading}
          icon={PhoneIncoming}
        />
        <Kpi
          label="Outbound calls"
          value={totals?.outbound ?? 0}
          tone="secondary"
          loading={isLoading}
          icon={PhoneOutgoing}
        />
      </div>

      {/* TIME METRICS */}
      <SectionHeader>Time metrics</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi
          label="Average talking time"
          value={hhmmss(totals?.avgTalkSec)}
          loading={isLoading}
          icon={Clock}
        />
        <Kpi
          label="Average waiting time"
          value={hhmmss(totals?.avgWaitSec)}
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
          {/* TRENDS */}
          <SectionHeader>Call trends</SectionHeader>
          <div className="grid lg:grid-cols-2 gap-3">
            <ChartCard title="Inbound vs outbound" loading={isLoading} hasData={byDay.length > 0}>
              <ResponsiveContainer>
                <BarChart data={byDay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid
                    vertical={false}
                    strokeDasharray="3 3"
                    stroke="var(--color-border)"
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                  <Bar
                    dataKey="inbound"
                    name="Inbound"
                    fill="var(--color-chart-1)"
                    radius={[6, 6, 0, 0]}
                    stackId="a"
                  />
                  <Bar
                    dataKey="outbound"
                    name="Outbound"
                    fill="var(--color-chart-3)"
                    radius={[6, 6, 0, 0]}
                    stackId="a"
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Answer rate over time" loading={isLoading} hasData={byDay.length > 0}>
              <ResponsiveContainer>
                <LineChart
                  data={byDay.map((d) => ({
                    date: d.date,
                    rate: d.total ? (d.answered / d.total) * 100 : 0,
                  }))}
                  margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                >
                  <CartesianGrid
                    vertical={false}
                    strokeDasharray="3 3"
                    stroke="var(--color-border)"
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}%`}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: any) => [`${Number(v).toFixed(1)}%`, "Answer rate"]}
                  />
                  <Line
                    type="monotone"
                    dataKey="rate"
                    stroke="var(--color-chart-1)"
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: "var(--color-chart-1)" }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {/* HOURLY */}
          <SectionHeader>Hourly distribution</SectionHeader>
          <ChartCard
            title="Calls by hour"
            loading={isLoading}
            hasData={byHour.some((h) => h.total > 0)}
          >
            <ResponsiveContainer>
              <BarChart data={hourly12} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid
                  vertical={false}
                  strokeDasharray="3 3"
                  stroke="var(--color-border)"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  interval={0}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
                />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                <Bar
                  dataKey="inbound"
                  name="Inbound"
                  fill="var(--color-chart-1)"
                  radius={[6, 6, 0, 0]}
                  stackId="h"
                />
                <Bar
                  dataKey="outbound"
                  name="Outbound"
                  fill="var(--color-chart-3)"
                  radius={[6, 6, 0, 0]}
                  stackId="h"
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* TEAM COMPARE */}
          {teamCompare.length > 0 && (
            <>
              <SectionHeader>Team comparison</SectionHeader>
              <div className="grid lg:grid-cols-2 gap-3">
                {teamCompare.map((t) => (
                  <Card
                    key={t.team}
                    className="border-l-4"
                    style={{
                      borderLeftColor:
                        t.team === "customer_care"
                          ? "var(--color-chart-1)"
                          : "var(--color-chart-3)",
                    }}
                  >
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-semibold">
                        {t.team === "customer_care" ? "Customer Care" : "Telesales"}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <Kpi label="Calls" value={t.calls} loading={isLoading} />
                      <Kpi label="Answered" value={t.answered} tone="success" loading={isLoading} />
                      <Kpi label="Answer rate" value={pct(t.answerRate)} loading={isLoading} />
                      <Kpi label="Total talk" value={hhmmss(t.talkSeconds)} loading={isLoading} />
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}

          {/* AGENT PERFORMANCE */}
          <SectionHeader>Agent performance</SectionHeader>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Agents ({rows.length})</CardTitle>
              <Input
                placeholder="Search agent or ext…"
                value={f.search}
                onChange={(e) => f.setSearch(e.target.value)}
                className="h-8 w-48"
              />
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">Ext</th>
                    <th className="px-3 py-2">Agent</th>
                    <th className="px-3 py-2">Team</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Answered</th>
                    <th className="px-3 py-2 text-right">Missed*</th>
                    <th className="px-3 py-2 text-right">No-answer out</th>
                    <th className="px-3 py-2 text-right">In</th>
                    <th className="px-3 py-2 text-right">Out</th>
                    <th className="px-3 py-2 text-right">Answer %</th>
                    <th className="px-3 py-2 text-right">Talk</th>
                    <th className="px-3 py-2 text-right">Avg talk</th>
                    <th className="px-3 py-2 text-right">Avg ring (answered)</th>
                    <th className="px-3 py-2 text-right">Longest</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}>
                        <td colSpan={14} className="p-2">
                          <Skeleton className="h-6 w-full" />
                        </td>
                      </tr>
                    ))
                  ) : searchedAgents.length === 0 ? (
                    <tr>
                      <td colSpan={14} className="text-center text-muted-foreground py-6">
                        No agents matched.
                      </td>
                    </tr>
                  ) : (
                    searchedAgents.map((agent) => (
                      <tr key={agent.agentId} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{agent.ext}</td>
                        <td className="px-3 py-2 font-medium">{agent.name}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {agent.team === "customer_care" ? "Customer Care" : "Telesales"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{agent.total}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-success">
                          {agent.answered}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-destructive">
                          {agent.missed}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {agent.noAnswerOutbound}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{agent.inbound}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{agent.outbound}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {agent.answerRate.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {hhmmss(agent.talkSeconds)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {hhmmss(agent.avgTalkSec)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {hhmmss(agent.avgRingSec)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {hhmmss(agent.longestSec)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                *Missed = the agent's own ring went unanswered. Individual performance metric only —
                not summed into the platform Missed KPI (the queue auto-forwards to the next
                available agent).
              </div>
            </CardContent>
          </Card>

          {/* CONVERSION — canonical, scoped to the active team/agent filter */}
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
              label="Completion rate"
              value={pct(conv?.overall.completionRate)}
              tone="success"
              loading={isLoading}
              hint="Completed ÷ total orders"
            />
            <Kpi
              label="Revenue"
              value={conv ? fmtSAR(conv.overall.revenue) : "—"}
              loading={isLoading}
            />
          </div>
          <ChartCard
            title="Conversion rate per day"
            loading={isLoading}
            hasData={(conv?.perDay ?? []).length > 0}
          >
            <ResponsiveContainer>
              <LineChart
                data={conv?.perDay ?? []}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  vertical={false}
                  strokeDasharray="3 3"
                  stroke="var(--color-border)"
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  tickFormatter={(v) => `${v}%`}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: any) => [`${Number(v).toFixed(1)}%`, "Conversion"]}
                />
                <Line
                  type="monotone"
                  dataKey="rate"
                  stroke="var(--color-chart-1)"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: "var(--color-chart-1)" }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
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
                    <th className="px-3 py-2 text-right">Completed</th>
                    <th className="px-3 py-2 text-right">Conversion %</th>
                    <th className="px-3 py-2 text-right">Revenue</th>
                    <th className="px-3 py-2 text-right">Rev / call</th>
                  </tr>
                </thead>
                <tbody>
                  {(conv?.perAgent ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center text-muted-foreground py-6">
                        No telesales activity in range.
                      </td>
                    </tr>
                  ) : (
                    (conv?.perAgent ?? []).map((c) => (
                      <tr key={c.agentId} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{c.ext}</td>
                        <td className="px-3 py-2 font-medium">{c.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.answered}</td>
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

          {/* Satisfaction Survey section removed per product decision. */}
        </>
      )}
    </div>
  );
}
