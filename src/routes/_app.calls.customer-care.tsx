/**
 * Customer Care call analytics — QUEUE-driven.
 *
 * Customer Care traffic arrives on a queue, so every KPI here is about the
 * queue: how long callers waited, how many the queue never got answered, how
 * many hung up. Orders, revenue and conversion are deliberately absent — those
 * belong to Telesales, and mixing them into a queue dashboard is what made the
 * combined page misleading.
 *
 * The Yeastar integration, CDR retrieval, normalization and analytics engine
 * are shared with Telesales; only this presentation layer and the KPI selection
 * are separate.
 */
import { createFileRoute } from "@tanstack/react-router";
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
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { DateRangePicker } from "@/components/date-range-picker";
import type { Direction } from "@/features/call-center/types";
import { pct, hhmmss } from "@/features/call-center/utils";
import { exportCallCenter } from "@/features/call-center/export";
import { SectionHeader } from "@/features/call-center/components/section-header";
import { HeroKpi } from "@/features/call-center/components/hero-kpi";
import { Kpi } from "@/features/call-center/components/kpi";
import {
  CallTrendCharts,
  HourlyDistributionChart,
} from "@/features/call-center/components/call-trend-charts";
import { AgentPerformanceTable } from "@/features/call-center/components/agent-performance-table";
import { useCallCenterFilters } from "@/features/call-center/hooks/use-call-center-filters";
import { useCallCenterAnalytics } from "@/features/call-center/hooks/use-call-center-analytics";
import { useRealtimeQueue } from "@/features/call-center/hooks/use-realtime-queue";

export const Route = createFileRoute("/_app/calls/customer-care")({
  head: () => ({ meta: [{ title: "Customer Care Calls — MilaServ Portal" }] }),
  component: CustomerCarePage,
});

function CustomerCarePage() {
  const f = useCallCenterFilters({ team: "customer_care", withQueue: true });
  const a = useCallCenterAnalytics({
    from: f.from,
    to: f.to,
    team: "customer_care",
    agentId: f.agentId,
    direction: f.direction,
    queue: f.queue,
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
    hourly12,
    searchedAgents,
  } = a;

  // Hooks first, then the permission guard — an early return above them would
  // change the hook count between renders.
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
      conv: null,
      rows,
      byDay,
      hourly12,
      from: f.from,
      to: f.to,
      fileLabel: "customer-care",
    });

  return (
    <div className="space-y-6 print:space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Customer Care</h1>
          <p className="text-xs sm:text-sm text-muted-foreground truncate">
            Queue analytics · {f.from} → {f.to}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <DateRangePicker range={f.range} onChange={f.setRange} align="end" size="sm" />
          {f.queues.length > 0 && (
            <Select value={f.queue} onValueChange={f.setQueue}>
              <SelectTrigger className="h-9 w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All queues</SelectItem>
                {f.queues.map((qq) => (
                  <SelectItem key={qq.number} value={qq.number}>
                    {qq.name} ({qq.number})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
          label="Avg talk time"
          value={hhmmss(totals?.avgTalkSec)}
          loading={isLoading}
          icon={Clock}
          tone="secondary"
        />
      </div>

      {/* REALTIME QUEUE */}
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

      {/* QUEUE STATISTICS */}
      <SectionHeader>Queue statistics</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Kpi
          label="Queue calls"
          value={totals?.queueCalls ?? 0}
          loading={isLoading}
          hint="Reached a queue"
        />
        <Kpi
          label="Missed queue calls"
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
          label="Queue answer rate"
          value={pct(totals?.queueAnswerRate)}
          tone="success"
          loading={isLoading}
          hint="Answered ÷ calls offered to agents"
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
          label="Average queue wait"
          value={hhmmss(totals?.avgWaitSec)}
          loading={isLoading}
          icon={Clock}
          hint="Averaged over calls that reached a queue"
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
          <SectionHeader>Call trends</SectionHeader>
          <CallTrendCharts byDay={byDay} loading={isLoading} />

          <SectionHeader>Hourly distribution</SectionHeader>
          <HourlyDistributionChart
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
            mode="customer_care"
          />
        </>
      )}
    </div>
  );
}
